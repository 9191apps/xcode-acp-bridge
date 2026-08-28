/* Xcode Observatory — level 2: conversation detail page
   Timeline is the hero: full-width pane + collapsible raw drawer. */
const detailEl = $("acp-detail");
const detailTitleEl = $("detail-title");
const detailStatusEl = $("detail-status");

let acpDetail = null;
let acpSelectedPid = null;
let acpSelectedSessionId = null;
let acpDetailRefreshTimer = null;
let acpSelectedEventId = null;
let acpSelectedRaw = null;
let acpDetailFetchSeq = 0;
let acpTimelineFetchSeq = 0;
let acpLiveModelFocused = false;
const acpLiveModelsCache = new Map();

/* Pane state (survives SSE re-renders) */
let rawHeight = 240;
let rawCollapsed = false;
let timelineFilter = "";
let acpDetailDragging = false;

/* ---- placeholder / not-found states -------------------------- */

function renderAcpPlaceholder() {
  const delBtn = $("btn-delete-conversation");
  if (delBtn) delBtn.hidden = true;
  detailEl.innerHTML = `
    <div class="empty-state">
      <div class="empty-glyph" aria-hidden="true">⌁</div>
      <p class="empty-title">Select a conversation</p>
      <p class="empty-hint">Go back to the conversation list and open one, or use /conversation.html?pid=NNN or ?session=ses_….</p>
      <a class="btn ghost" href="/">← Conversations</a>
    </div>`;
}

function renderAcpNotFound() {
  const delBtn = $("btn-delete-conversation");
  if (delBtn) delBtn.hidden = true;
  detailEl.innerHTML = `
    <div class="empty-state">
      <div class="empty-glyph" aria-hidden="true">✕</div>
      <p class="empty-title">Conversation not found</p>
      <p class="empty-hint">It may have been cleared, or the pid / session id is invalid.</p>
      <a class="btn ghost" href="/">← Conversations</a>
    </div>`;
}

/* ---- timeline helpers ---------------------------------------- */

function timelinePrimaryEventId(item) {
  return item.type === "chunks" ? item.eventIds.at(-1) : item.eventId;
}

function timelineSource(item) {
  if (item.type === "process") return { key: "bridge", label: "bridge" };
  if (item.dir === "c2a") return { key: "c2a", label: "Xcode → Agent" };
  if (item.dir === "a2c") return { key: "a2c", label: "Agent → Xcode" };
  return { key: "unknown", label: "?" };
}

function timelineBodyLabel(item) {
  if (item.type === "process") {
    if (acpDetail?.kind === "session" && item.kind === "process_start") {
      const route = item.route ?? "backend";
      return item.bridgePid != null ? `spawn ${route} · pid ${item.bridgePid}` : `spawn ${route}`;
    }
    return item.route ? `${item.kind} ${item.route}` : item.kind;
  }
  if (item.type === "rpc") {
    const injected = String(item.rpcId ?? "").startsWith("bridge-");
    const base =
      item.method === "rpc" || !item.method
        ? item.dir === "a2c"
          ? "result"
          : "rpc"
        : item.method;
    return injected ? `${base} (bridge)` : base;
  }
  if (item.type === "tool_call") {
    const base = `tool ${item.name}`;
    return item.updateCount > 0 ? `${base} +${item.updateCount} updates` : base;
  }
  if (item.type === "chunks") {
    return `${item.count} ${item.update}s`;
  }
  return item.type ?? "";
}

/* One-line content preview under the label, so long timelines
   can be scanned without clicking every row. */
function timelineImageCount(item) {
  if (typeof item?.imageCount === "number") return item.imageCount;
  if (typeof item?.raw === "string") return extractAcpImagesFromRaw(item.raw).length;
  return 0;
}

function timelinePreview(item) {
  const trunc = (s) => {
    const flat = String(s).replace(/\s+/g, " ").trim();
    return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
  };
  if (item.type === "chunks") {
    const text = typeof item.text === "string" ? item.text : "";
    // Cheap first: collapse only a bounded head so huge aggregates stay fast.
    const flat = text.slice(0, 400).replace(/\s+/g, " ").trim();
    if (flat.length === 0) return `${item.count} ${item.update}s · no text`;
    return text.length > 160 ? `${flat.slice(0, 160)}…` : flat;
  }
  if (item.type === "tool_call") {
    return item.updateCount > 0
      ? `+${item.updateCount} update${item.updateCount === 1 ? "" : "s"}`
      : "";
  }
  if (item.type === "process") {
    return item.kind === "process_start" ? `spawn ${item.route ?? "backend"}` : item.kind;
  }
  if (item.type === "rpc") {
    if (typeof item.raw !== "string" || item.raw.length === 0) return "";
    let parsed;
    try {
      parsed = JSON.parse(item.raw);
    } catch {
      return "";
    }
    if (parsed === null || typeof parsed !== "object") return "";
    try {
      if (item.dir === "a2c" && "result" in parsed) {
        const res = parsed.result;
        if (res === null) return "result: null";
        if (typeof res === "string") return trunc(res);
        if (typeof res === "object") return trunc(JSON.stringify(res));
        return trunc(String(res));
      }
      const params = parsed.params;
      if (params == null) return "";
      if (typeof params === "string") return trunc(params);
      if (typeof params === "object") {
        const prompt = params.prompt;
        if (Array.isArray(prompt)) {
          let first = "";
          let last = "";
          let hasImage = false;
          for (const part of prompt) {
            if (!part || typeof part !== "object") continue;
            if (part.type === "image") hasImage = true;
            if (typeof part.text === "string" && part.text.trim()) {
              if (!first) first = part.text;
              last = part.text;
            }
          }
          const text = hasImage ? last : first;
          if (text) return trunc(text);
        }
        return trunc(JSON.stringify(params));
      }
      return trunc(String(params));
    } catch {
      return "";
    }
  }
  return "";
}

function timelineItemSearchText(item) {
  return [
    timelineBodyLabel(item),
    timelinePreview(item),
    timelineImageCount(item) > 0 ? "[image]" : "",
    item.type ?? "",
    item.method ?? "",
    item.name ?? "",
    item.route ?? "",
    item.kind ?? "",
    item.bridgePid != null ? `pid ${item.bridgePid}` : "",
  ].join(" ");
}

function timelineItemHtml(item, i, selected, match) {
  const eventId = timelinePrimaryEventId(item);
  const source = timelineSource(item);
  const selectedClass = selected ? "selected" : "";
  const filteredClass = match ? "" : "filtered-out";
  const timing = [];
  if (item.gapMs != null) timing.push(`+${fmtDuration(item.gapMs)}`);
  if (item.durationMs != null && item.durationMs > 0) timing.push(fmtDuration(item.durationMs));
  const timingHtml =
    timing.length > 0
      ? `<span class="timeline-timing">${escapeHtml(timing.join(" · "))}</span>`
      : "";
  const preview = timelinePreview(item);
  const previewHtml = preview
    ? `<span class="tl-preview">${escapeHtml(preview)}</span>`
    : "";
  const imageTag =
    timelineImageCount(item) > 0
      ? `<span class="tl-image-tag">[image]</span>`
      : "";
  const time = item.ts ?? item.firstTs ?? item.lastTs ?? "";
  const prev = acpDetail?.timeline?.[i - 1];
  const spawnBreak =
    acpDetail?.kind === "session" && prev != null && prev.bridgePid !== item.bridgePid
      ? "tl-spawn-break"
      : "";
  return `<li data-index="${i}" data-event-id="${escapeHtml(eventId ?? "")}" class="${selectedClass} ${filteredClass} ${spawnBreak}">
    <span class="tl-dot dir-${source.key}" aria-hidden="true"></span>
    <span class="tl-time">${escapeHtml(time ? fmtClock(time) : "")}</span>
    <span class="dir-tag dir-${source.key}">${escapeHtml(source.label)}</span>
    <span class="tl-main">
      <span class="tl-label-row">
        <span class="tl-label">${escapeHtml(timelineBodyLabel(item))}</span>
        ${imageTag}
      </span>
      ${previewHtml}
    </span>
    ${timingHtml}
  </li>`;
}

function clearAcpTimelineSelection() {
  acpSelectedEventId = null;
  acpSelectedRaw = null;
}

function showAcpSelectedTiming(item) {
  const el = $("acp-selected-timing");
  if (!el) return;
  const parts = [];
  if (item?.gapMs != null) parts.push(`距上一条 +${fmtDuration(item.gapMs)}`);
  if (item?.durationMs != null) parts.push(`自身 ${fmtDuration(item.durationMs)}`);
  if (item?.type === "chunks") {
    parts.push(`${item.count} chunks`);
  }
  el.textContent = parts.length > 0 ? parts.join(" · ") : "";
}

function acpImageByteLabel(data) {
  if (typeof data !== "string" || data.length === 0) return "";
  const bytes = Math.floor((data.replace(/\s+/g, "").length * 3) / 4);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderAcpImageThumb(image) {
  const src = acpImageDataUrl(image);
  const caption = acpImageCaption(image);
  const size = acpImageByteLabel(image.data);
  const capText = size ? `${caption} · ${size}` : caption;

  if (src) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "acp-image-thumb";
    btn.setAttribute("role", "listitem");
    btn.title = `Open ${capText}`;
    const frame = document.createElement("span");
    frame.className = "acp-image-frame";
    const img = document.createElement("img");
    img.src = src;
    img.alt = caption;
    img.loading = "lazy";
    frame.append(img);
    const cap = document.createElement("span");
    cap.className = "acp-image-cap";
    cap.textContent = capText;
    btn.append(frame, cap);
    btn.addEventListener("click", () => openAcpImageLightbox(src, capText));
    return btn;
  }

  const missing = document.createElement("div");
  missing.className = "acp-image-thumb is-missing";
  missing.setAttribute("role", "listitem");
  const frame = document.createElement("span");
  frame.className = "acp-image-frame acp-image-missing";
  frame.textContent = "no pixels";
  const cap = document.createElement("span");
  cap.className = "acp-image-cap";
  cap.textContent = capText;
  missing.append(frame, cap);
  return missing;
}

function renderAcpImageStrip(images) {
  const strip = document.createElement("div");
  strip.className = "acp-image-strip";
  const meta = document.createElement("p");
  meta.className = "acp-image-strip-meta";
  meta.textContent = images.length === 1 ? "1 image" : `${images.length} images`;
  const row = document.createElement("div");
  row.className = "acp-image-strip-row";
  row.setAttribute("role", "list");
  for (const image of images) row.append(renderAcpImageThumb(image));
  strip.append(meta, row);
  return strip;
}

function mountAcpEventPayload(rawSlot, raw, restNodes) {
  const wrap = document.createElement("div");
  wrap.className = "acp-event-payload";
  const images = extractAcpImagesFromRaw(raw);
  if (images.length > 0) wrap.append(renderAcpImageStrip(images));
  for (const node of restNodes) wrap.append(node);
  rawSlot.replaceChildren(wrap);
}

function showAcpTimelineRaw(raw, note) {
  const rawSlot = $("acp-timeline-raw");
  if (!rawSlot) return;
  if (note) {
    rawSlot.innerHTML = `<p class="acp-empty-hint">${escapeHtml(note)}</p>`;
    if (raw == null) return;
  }
  if (raw == null) {
    rawSlot.innerHTML = `<p class="acp-empty-hint">点击上方时间线某一行，原始 JSON-RPC 会显示在这里。</p>`;
    return;
  }
  if (raw.length === 0) {
    rawSlot.innerHTML = `<p class="acp-empty-hint">这条事件没有 payload（例如 process_end）。试试 session/prompt、tool_call 或 chunks 行。</p>`;
    return;
  }
  const pre = document.createElement("pre");
  pre.className = "json";
  pre.innerHTML = highlightJson(formatEventPayload(raw));
  mountAcpEventPayload(rawSlot, raw, [pre]);
}

function showAcpTimelineSelection(item) {
  showAcpSelectedTiming(item);
  const rawSlot = $("acp-timeline-raw");
  if (!rawSlot) return;
  if (item?.type === "chunks") {
    const text = typeof item.text === "string" ? item.text : "";
    const wrap = document.createElement("div");
    wrap.className = "chunk-aggregate";
    const heading = document.createElement("p");
    heading.className = "chunk-aggregate-meta";
    const dur = item.durationMs != null ? ` · ${fmtDuration(item.durationMs)}` : "";
    heading.textContent = `聚合文本 · ${item.count} ${item.update}${dur}${text.length === 0 ? "（无 text）" : ""}`;
    const pre = document.createElement("pre");
    pre.className = "chunk-aggregate-text";
    pre.textContent = text.length > 0 ? text : "(empty)";
    wrap.append(heading, pre);
    if (typeof item.raw === "string" && item.raw.length > 0) {
      const details = document.createElement("details");
      details.className = "chunk-last-raw";
      const summary = document.createElement("summary");
      summary.textContent = "最后一条 chunk 的原始 JSON";
      const rawPre = document.createElement("pre");
      rawPre.className = "json";
      rawPre.innerHTML = highlightJson(formatEventPayload(item.raw));
      details.append(summary, rawPre);
      wrap.append(details);
    }
    const raw = typeof item.raw === "string" ? item.raw : "";
    mountAcpEventPayload(rawSlot, raw, [wrap]);
    return;
  }
  showAcpTimelineRaw(typeof item?.raw === "string" ? item.raw : acpSelectedRaw ?? "");
}

function ensureAcpImageLightbox() {
  let root = $("acp-image-lightbox");
  if (root) return root;
  root = document.createElement("div");
  root.id = "acp-image-lightbox";
  root.hidden = true;
  root.innerHTML = `
    <button type="button" class="acp-lightbox-scrim" aria-label="Close image"></button>
    <figure class="acp-lightbox-frame">
      <img alt="">
      <figcaption></figcaption>
      <button type="button" class="acp-lightbox-close">close</button>
    </figure>
  `;
  document.body.append(root);
  root.querySelector(".acp-lightbox-scrim").addEventListener("click", closeAcpImageLightbox);
  root.querySelector(".acp-lightbox-close").addEventListener("click", closeAcpImageLightbox);
  return root;
}

function openAcpImageLightbox(src, caption) {
  const root = ensureAcpImageLightbox();
  const img = root.querySelector("img");
  const cap = root.querySelector("figcaption");
  img.src = src;
  img.alt = caption;
  cap.textContent = caption;
  root.hidden = false;
  document.body.classList.add("acp-lightbox-open");
}

function closeAcpImageLightbox() {
  const root = $("acp-image-lightbox");
  if (!root || root.hidden) return;
  root.hidden = true;
  const img = root.querySelector("img");
  if (img) img.removeAttribute("src");
  document.body.classList.remove("acp-lightbox-open");
}

/* ---- resizable raw drawer ------------------------------------ */

function applySplitLayout() {
  const rawEl = $("acp-detail-raw");
  if (rawEl) {
    rawEl.classList.toggle("collapsed", rawCollapsed);
    if (rawCollapsed) rawEl.style.removeProperty("height");
    else rawEl.style.setProperty("height", `${rawHeight}px`);
  }
  document.querySelectorAll(".js-raw-toggle").forEach((el) => {
    el.textContent = rawCollapsed ? "▸ Raw" : "▾ Raw";
  });
}

function toggleRawCollapse() {
  rawCollapsed = !rawCollapsed;
  applySplitLayout();
}

function startRowDrag(e) {
  e.preventDefault();
  const splitterEl = e.currentTarget;
  splitterEl.classList.add("dragging");
  document.body.classList.add("dragging-row");
  acpDetailDragging = true;
  const startY = e.clientY;
  const startRaw = rawHeight;
  try {
    splitterEl.setPointerCapture?.(e.pointerId);
  } catch {
    // synthetic events / unsupported environment — move listeners still work
  }
  const onMove = (ev) => {
    const h = startRaw + (ev.clientY - startY);
    const maxH = detailEl ? Math.round(detailEl.clientHeight * 0.6) : 600;
    rawHeight = Math.min(Math.max(h, 140), Math.max(maxH, 140));
    applySplitLayout();
  };
  const onUp = () => {
    splitterEl.classList.remove("dragging");
    document.body.classList.remove("dragging-row");
    acpDetailDragging = false;
    splitterEl.removeEventListener("pointermove", onMove);
    splitterEl.removeEventListener("pointerup", onUp);
    splitterEl.removeEventListener("pointercancel", onUp);
  };
  splitterEl.addEventListener("pointermove", onMove);
  splitterEl.addEventListener("pointerup", onUp);
  splitterEl.addEventListener("pointercancel", onUp);
}

/* ---- detail rendering ---------------------------------------- */

function chipHtml(key, value, opts = {}) {
  const full = value == null || value === "" ? "" : String(value);
  const id = `acp-meta-${opts.id ?? key.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  const display = opts.elide ? middleElide(full, opts.head, opts.tail) : full;
  const valCls = [
    "chip-val",
    opts.mono ? "chip-mono" : "",
    opts.model ? "chip-model-val" : "",
  ].filter(Boolean).join(" ");
  const tip = opts.title ?? full;
  const chipCls = [
    "chip",
    opts.wide ? "chip-wide" : "",
    opts.grow ? "chip-grow" : "",
  ].filter(Boolean).join(" ");
  return `<span class="${chipCls}">
    <b>${escapeHtml(key)}</b>
    <span class="${valCls}" id="${id}" title="${escapeHtml(tip)}"${
      full ? ` data-full="${escapeHtml(full)}"` : ""
    }>${dash(display)}</span>
    ${
      full && opts.copy !== false
        ? `<button type="button" class="meta-copy" data-copy-src="#${id}" title="Copy ${escapeHtml(key)}">⧉</button>`
        : ""
    }
  </span>`;
}

const TIMELINE_STICKY_BOTTOM_PX = 64;

function captureTimelineScroll() {
  const ol = detailEl.querySelector("ol.timeline");
  if (!ol) return null;
  const gap = ol.scrollHeight - ol.scrollTop - ol.clientHeight;
  return { top: ol.scrollTop, pinBottom: gap <= TIMELINE_STICKY_BOTTOM_PX };
}

function restoreTimelineScroll(snap) {
  const ol = detailEl.querySelector("ol.timeline");
  if (!ol || snap == null) return;
  ol.scrollTop = snap.pinBottom ? ol.scrollHeight : snap.top;
}

function renderTimelinePane() {
  if (!acpDetail) return;
  const pane = detailEl.querySelector(".acp-detail-timeline");
  if (!pane) return;
  const timeline = acpDetail.timeline ?? [];
  const filterText = timelineFilter.trim().toLowerCase();
  let shown = 0;
  const rows = timeline
    .map((item, i) => {
      const match = !filterText || timelineItemSearchText(item).toLowerCase().includes(filterText);
      if (match) shown++;
      const selected =
        acpSelectedEventId != null && timelinePrimaryEventId(item) === acpSelectedEventId;
      return timelineItemHtml(item, i, selected, match);
    })
    .join("");
  const count = $("acp-tl-count");
  if (count) {
    count.textContent = filterText ? `${shown}/${timeline.length} shown` : `${timeline.length} items`;
  }
  const ol = pane.querySelector("ol.timeline");
  // Empty <ol> is a fresh shell (full-page re-render); skip restore here so
  // the caller can put the previous scroll back after layout.
  const snap = ol && ol.childElementCount > 0 ? captureTimelineScroll() : null;
  if (ol) ol.innerHTML = rows;
  restoreTimelineScroll(snap);
}

function renderAcpDetail() {
  if (!acpDetail) return;
  const d = acpDetail;
  const timeline = d.timeline ?? [];
  const rawIds = timeline.map((item) =>
    item.type === "chunks" ? item.eventIds.join(", ") : item.eventId,
  );
  const scrollSnap = captureTimelineScroll();

  if (detailTitleEl) {
    if (d.kind === "session" && d.acpSessionId) {
      detailTitleEl.textContent = `Session ${middleElide(d.acpSessionId, 10, 8)}`;
      detailTitleEl.title = d.acpSessionId;
    } else {
      detailTitleEl.textContent = `Conversation ${d.bridgePid}`;
      detailTitleEl.title = "";
    }
  }
  const delBtn = $("btn-delete-conversation");
  if (delBtn) {
    delBtn.hidden = false;
    delBtn.disabled = false;
  }
  if (detailStatusEl) {
    const kind = d.status === "live" ? "live" : d.status === "error" ? "error" : "ok";
    detailStatusEl.className = `pill pill-${kind}`;
    detailStatusEl.textContent = d.status;
    if (d.status === "stale") {
      detailStatusEl.title = "bridge process is gone (no clean end); model changes apply on next resume";
    }
  }

  const modelChip =
    d.route && (d.status === "live" || d.acpSessionId)
      ? `<span class="chip chip-model">
          <b>model</b>
          <select id="acp-live-model"></select>
          <button id="acp-live-model-refresh" class="copy-btn" type="button" title="Re-fetch the model list from the backend (bypasses cache)">refresh</button>
          <button id="acp-live-model-retry" class="copy-btn" type="button" title="Re-submit the currently shown model (retry after a failed live apply)">retry</button>
          <span id="acp-live-model-status" class="hint"></span>
        </span>`
      : chipHtml("model", d.model, { model: true });

  const sessionChip = `<span class="chip">
    <b>sessionId</b>
    <span class="chip-val" id="acp-meta-sessionid" title="${escapeHtml(d.acpSessionId ?? "")}"${
      d.acpSessionId ? ` data-full="${escapeHtml(d.acpSessionId)}"` : ""
    }>${dash(d.acpSessionId ? middleElide(d.acpSessionId, 14, 12) : "")}</span>
    ${
      d.acpSessionId
        ? `<button type="button" class="meta-copy" data-copy-src="#acp-meta-sessionid" title="Copy sessionId">⧉</button>
           <button id="acp-resume" class="copy-btn" type="button" title="Open a Terminal to resume this conversation in the ACP backend (\`${escapeHtml(d.route ?? "backend")}\`)">resume</button>`
        : ""
    }
  </span>`;

  const pidChip =
    d.kind === "session" && Array.isArray(d.spawns)
      ? `<span class="chip chip-spawns">
          <b>spawns</b>
          <span class="spawn-chips">${d.spawns
            .map((s) => {
              const live = s.status === "live" ? " live" : "";
              return `<a class="spawn-chip${live}" href="/conversation.html?pid=${s.bridgePid}" title="Open spawn pid ${s.bridgePid}">pid ${s.bridgePid}</a>`;
            })
            .join("")}</span>
        </span>`
      : chipHtml("bridgePid", d.bridgePid);

  detailEl.innerHTML = `
    <div class="acp-detail-header">
      <div class="detail-chips">
        ${pidChip}
        ${chipHtml("route", d.route)}
        ${modelChip}
        ${sessionChip}
        ${chipHtml("active", `${fmtClock(d.startedAt)} → ${fmtClock(d.lastActivityAt)}`, {
          id: "activity",
          title: `${fmtFull(d.startedAt)} → ${fmtFull(d.lastActivityAt)}`,
          copy: false,
        })}
        ${chipHtml("duration", fmtDuration(d.durationMs), { copy: false })}
        ${chipHtml("cwd", d.cwd, { grow: true, elide: true, head: 20, tail: 24 })}
      </div>
    </div>
    <div class="acp-detail-timeline">
      <div class="tl-toolbar">
        <h4>Timeline</h4>
        <span class="section-count" id="acp-tl-count"></span>
        <input type="search" id="acp-tl-filter" placeholder="Filter events…" aria-label="Filter timeline events" autocomplete="off" />
        <details class="raw-events">
          <summary>Raw event ids</summary>
          <ul>${rawIds.map((id) => `<li>${escapeHtml(id)}</li>`).join("")}</ul>
        </details>
        <button id="acp-raw-toggle" class="btn ghost sm js-raw-toggle" type="button" title="Collapse / expand the raw JSON drawer">▾ Raw</button>
      </div>
      <ol class="timeline"></ol>
    </div>
    <div class="splitter splitter-row" id="splitter-row" role="separator" aria-orientation="horizontal" title="Drag to resize · double-click to collapse raw"></div>
    <div class="acp-detail-raw" id="acp-detail-raw">
      <div class="raw-head">
        <h4>Selected event <span id="acp-selected-source"></span></h4>
        <p id="acp-selected-timing" class="acp-selected-timing"></p>
        <button id="acp-raw-copy" class="copy-btn" type="button" title="Copy raw JSON payload">copy</button>
        <button id="acp-raw-toggle-2" class="copy-btn js-raw-toggle" type="button" title="Collapse / expand">▾</button>
      </div>
      <div id="acp-timeline-raw"></div>
    </div>
  `;

  const liveEl = $("acp-live-model");
  if (liveEl) bindAcpLiveModel(liveEl, d);
  const resumeBtn = $("acp-resume");
  if (resumeBtn) bindAcpResumeOpencode(resumeBtn, d);

  renderTimelinePane();

  const splitterRow = $("splitter-row");
  if (splitterRow) {
    splitterRow.addEventListener("pointerdown", startRowDrag);
    splitterRow.addEventListener("dblclick", toggleRawCollapse);
  }
  const filterEl = $("acp-tl-filter");
  if (filterEl) {
    filterEl.value = timelineFilter;
    filterEl.addEventListener("input", () => {
      timelineFilter = filterEl.value;
      renderTimelinePane();
    });
  }
  document.querySelectorAll(".js-raw-toggle").forEach((el) => {
    el.addEventListener("click", toggleRawCollapse);
  });
  const copyBtn = $("acp-raw-copy");
  if (copyBtn) copyBtn.addEventListener("click", copySelectedRaw);

  applySplitLayout();

  const sourceEl = $("acp-selected-source");
  if (acpSelectedEventId != null) {
    const selectedItem = timeline.find(
      (item) => timelinePrimaryEventId(item) === acpSelectedEventId,
    );
    if (sourceEl && selectedItem) {
      const source = timelineSource(selectedItem);
      sourceEl.innerHTML = `<span class="dir-tag dir-${source.key}">${escapeHtml(source.label)}</span>`;
    }
    if (selectedItem) showAcpTimelineSelection(selectedItem);
    else {
      showAcpSelectedTiming(null);
      showAcpTimelineRaw(acpSelectedRaw ?? "");
    }
  } else {
    showAcpSelectedTiming(null);
    showAcpTimelineRaw(null);
  }

  restoreTimelineScroll(scrollSnap);
}

function copySelectedRaw() {
  const btn = $("acp-raw-copy");
  if (!btn) return;
  const text = acpSelectedRaw ?? "";
  const done = () => {
    btn.classList.add("ok");
    btn.textContent = "copied";
    setTimeout(() => {
      btn.classList.remove("ok");
      btn.textContent = "copy";
    }, 1100);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => {});
  } else {
    done();
  }
}

async function selectAcpTimelineItem(item) {
  const eventId = timelinePrimaryEventId(item);
  if (!eventId) return;
  const seq = ++acpTimelineFetchSeq;
  acpSelectedEventId = eventId;
  detailEl.querySelectorAll(".timeline li").forEach((row) => {
    row.classList.toggle("selected", row.dataset.eventId === eventId);
  });
  const sourceEl = $("acp-selected-source");
  if (sourceEl) {
    const source = timelineSource(item);
    sourceEl.innerHTML = `<span class="dir-tag dir-${source.key}">${escapeHtml(source.label)}</span>`;
  }

  if (item.type === "chunks") {
    acpSelectedRaw = typeof item.raw === "string" ? item.raw : "";
    showAcpTimelineSelection(item);
    return;
  }

  if (typeof item.raw === "string") {
    acpSelectedRaw = item.raw;
    showAcpTimelineSelection(item);
    return;
  }

  showAcpSelectedTiming(item);
  showAcpTimelineRaw(null, "加载中…");
  const res = await fetch(`/api/acp-events/${encodeURIComponent(eventId)}`);
  if (seq !== acpTimelineFetchSeq) return;
  if (!res.ok) {
    acpSelectedRaw = "";
    showAcpTimelineRaw(
      null,
      `加载失败 HTTP ${res.status}。请重启 bun run start 后再点一次对话。`,
    );
    return;
  }
  const event = await res.json();
  if (seq !== acpTimelineFetchSeq) return;
  acpSelectedRaw = event.raw ?? "";
  showAcpTimelineSelection({ ...item, raw: acpSelectedRaw });
}

function conversationWritePid(d) {
  return d?.liveBridgePid ?? d?.representativeBridgePid ?? d?.bridgePid ?? acpSelectedPid;
}

async function modelsForRoute(route, { refresh = false } = {}) {
  if (!route) return [];
  const url = `/api/acp-models?route=${encodeURIComponent(route)}${refresh ? "&refresh=1" : ""}`;
  const data = await fetch(url).then((r) => r.json());
  const models = data.models ?? [];
  acpLiveModelsCache.set(route, models);
  return models;
}

function fillLiveModelSelect(selectEl, models, current) {
  selectEl.innerHTML = [
    `<option value="">(backend default)</option>`,
    ...models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`),
  ].join("");
  selectEl.value = current ?? "";
}

function bindAcpLiveModel(selectEl, d) {
  selectEl.addEventListener("focusin", () => {
    acpLiveModelFocused = true;
  });
  selectEl.addEventListener("focusout", () => {
    acpLiveModelFocused = false;
  });
  fillLiveModelSelect(selectEl, acpLiveModelsCache.get(d.route) ?? [], d.model);
  void modelsForRoute(d.route).then((models) => {
    if ($("acp-live-model") !== selectEl) return;
    fillLiveModelSelect(selectEl, models, d.model);
  });
  const submit = async (model) => {
    const statusEl = $("acp-live-model-status");
    if (statusEl) statusEl.textContent = "";
    if (!model) {
      selectEl.value = d.model ?? "";
      if (statusEl) statusEl.textContent = "pick a model to switch";
      return;
    }
    try {
      const res = await fetch(`/api/acp-conversations/${conversationWritePid(d)}/model`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      if (res.ok) return;
      selectEl.value = d.model ?? "";
      let msg = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body && typeof body.error === "string") msg = body.error;
      } catch {
        // keep HTTP status
      }
      if (statusEl) statusEl.textContent = msg;
    } catch (err) {
      selectEl.value = d.model ?? "";
      if (statusEl) statusEl.textContent = err instanceof Error ? err.message : String(err);
    }
  };
  selectEl.addEventListener("change", () => void submit(selectEl.value));
  const retryBtn = $("acp-live-model-retry");
  if (retryBtn) {
    retryBtn.addEventListener("click", () => void submit(selectEl.value));
  }
  const refreshBtn = $("acp-live-model-refresh");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      const statusEl = $("acp-live-model-status");
      refreshBtn.disabled = true;
      if (statusEl) statusEl.textContent = "refreshing…";
      try {
        const models = await modelsForRoute(d.route, { refresh: true });
        if ($("acp-live-model") !== selectEl) return;
        fillLiveModelSelect(selectEl, models, selectEl.value);
        if (statusEl) statusEl.textContent = "";
      } catch (err) {
        if (statusEl) statusEl.textContent = err instanceof Error ? err.message : String(err);
      } finally {
        refreshBtn.disabled = false;
      }
    });
  }
}

function bindAcpResumeOpencode(btn, d) {
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const res = await fetch(`/api/acp-conversations/${conversationWritePid(d)}/resume`, { method: "POST" });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body && typeof body.error === "string") msg = body.error;
        } catch {
          // keep HTTP status
        }
        alert(`Resume failed: ${msg}`);
      }
    } catch (err) {
      alert(`Resume failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---- data loading -------------------------------------------- */

function hasOpenConversation() {
  return acpSelectedSessionId != null || acpSelectedPid != null;
}

function refreshAcpDetail() {
  if (acpSelectedSessionId) {
    loadAcpSessionDetail(acpSelectedSessionId);
    return;
  }
  if (acpSelectedPid != null) loadAcpDetail(acpSelectedPid);
}

async function loadAcpDetail(pid) {
  const seq = ++acpDetailFetchSeq;
  const res = await fetch(`/api/acp-conversations/${pid}`);
  if (seq !== acpDetailFetchSeq) return;
  if (!res.ok) {
    if (acpSelectedPid === pid && acpSelectedSessionId == null) renderAcpNotFound();
    return;
  }
  if (acpSelectedPid !== pid || acpSelectedSessionId != null) return;
  acpDetail = await res.json();
  if (seq !== acpDetailFetchSeq) return;
  renderAcpDetail();
}

async function loadAcpSessionDetail(sessionId) {
  const seq = ++acpDetailFetchSeq;
  const res = await fetch(`/api/acp-sessions/${encodeURIComponent(sessionId)}`);
  if (seq !== acpDetailFetchSeq) return;
  if (!res.ok) {
    if (acpSelectedSessionId === sessionId) renderAcpNotFound();
    return;
  }
  if (acpSelectedSessionId !== sessionId) return;
  acpDetail = await res.json();
  if (seq !== acpDetailFetchSeq) return;
  if (typeof acpDetail.bridgePid === "number") acpSelectedPid = acpDetail.bridgePid;
  renderAcpDetail();
}

async function deleteOpenConversation() {
  const d = acpDetail;
  const pids =
    d?.kind === "session" && Array.isArray(d.spawns) && d.spawns.length > 0
      ? d.spawns.map((s) => s.bridgePid)
      : acpSelectedPid != null
        ? [acpSelectedPid]
        : [];
  if (pids.length === 0) return;
  const live = d?.status === "live";
  const extra = live
    ? "\n\nThis conversation is still live; new events may recreate it. Xcode is not stopped."
    : "";
  const prompt =
    pids.length > 1
      ? `Delete all Observatory records for this session (${pids.length} spawns)?`
      : "Delete this Observatory record?";
  if (!confirm(prompt + extra)) return;
  const delBtn = $("btn-delete-conversation");
  if (delBtn) delBtn.disabled = true;
  try {
    for (const pid of pids) {
      const res = await fetch(`/api/acp-conversations/${pid}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        alert(`Delete failed: HTTP ${res.status}`);
        if (delBtn) delBtn.disabled = false;
        return;
      }
    }
    location.href = "/";
  } catch (err) {
    alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    if (delBtn) delBtn.disabled = false;
  }
}

/* ---- event wiring ------------------------------------------- */

detailEl.addEventListener("click", (e) => {
  const li = e.target.closest(".timeline li[data-index]");
  if (!li || !detailEl.contains(li)) return;
  const item = acpDetail?.timeline?.[Number(li.dataset.index)];
  if (!item) return;
  selectAcpTimelineItem(item);
});

/* ---- live feed ---------------------------------------------- */

const acpEs = new EventSource("/acp-events");
acpEs.onopen = () => setLive(true);
acpEs.onerror = () => {
  setLive(false);
};
acpEs.addEventListener("acp", async () => {
  if (!hasOpenConversation()) return;
  // Keep the open raw pane stable while the user is inspecting a timeline row.
  if (acpSelectedEventId != null) return;
  if (acpLiveModelFocused || acpDetailDragging) return;
  if (acpDetailRefreshTimer != null) {
    clearTimeout(acpDetailRefreshTimer);
  }
  acpDetailRefreshTimer = setTimeout(() => {
    acpDetailRefreshTimer = null;
    if (!hasOpenConversation() || acpSelectedEventId != null || acpLiveModelFocused || acpDetailDragging) return;
    refreshAcpDetail();
  }, 400);
});

/* ---- init ---------------------------------------------------- */

function init() {
  const params = new URLSearchParams(location.search);
  const sessionId = params.get("session");
  const pid = Number(params.get("pid"));
  const delBtn = $("btn-delete-conversation");
  if (delBtn) delBtn.addEventListener("click", () => void deleteOpenConversation());

  if (sessionId) {
    acpSelectedSessionId = sessionId;
    if (detailTitleEl) {
      detailTitleEl.textContent = `Session ${middleElide(sessionId, 10, 8)}`;
      detailTitleEl.title = sessionId;
    }
    loadAcpSessionDetail(sessionId);
    setLive(true);
    return;
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    renderAcpPlaceholder();
    setLive(true);
    return;
  }
  acpSelectedPid = pid;
  if (detailTitleEl) detailTitleEl.textContent = `Conversation ${pid}`;
  loadAcpDetail(pid);
  setLive(true);
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const box = $("acp-image-lightbox");
  if (!box || box.hidden) return;
  e.preventDefault();
  closeAcpImageLightbox();
});
init();
