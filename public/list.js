/* Xcode Observatory — level 1: conversation list page */
const acpConversationListEl = $("acp-conversation-list");
const acpNextRouteEl = $("acp-next-route");
const acpNextModelEl = $("acp-next-model");
const acpModelStatusEl = $("acp-model-status");
const acpEmpty = $("acp-empty");
const tableWrap = $("acp-table-wrap");
const listFilterEl = $("list-filter");
const listCountEl = $("list-count");

let acpSessionGroups = [];
let listFilter = "";

const SCROLL_KEY = "obs-list-scroll";
const EXPAND_KEY = "obs-session-expand";

/* ---- expand state ------------------------------------------- */

function loadExpandedIds() {
  try {
    const raw = sessionStorage.getItem(EXPAND_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function saveExpandedIds(ids) {
  try {
    sessionStorage.setItem(EXPAND_KEY, JSON.stringify([...ids]));
  } catch {
    // sessionStorage unavailable — ignore
  }
}

let expandedSessionIds = loadExpandedIds();

function toggleSessionExpand(sessionId) {
  if (expandedSessionIds.has(sessionId)) expandedSessionIds.delete(sessionId);
  else expandedSessionIds.add(sessionId);
  saveExpandedIds(expandedSessionIds);
  renderAcpConversations();
}

/* ---- conversations ------------------------------------------ */

function conversationStatusPill(status) {
  const kind = status === "live" ? "live" : status === "error" ? "error" : "ok";
  const title =
    status === "stale"
      ? ` title="bridge process is gone (no clean end); model changes apply on next resume"`
      : "";
  return `<span class="pill pill-${kind}"${title}>${escapeHtml(status)}</span>`;
}

function conversationSearchText(c) {
  return [
    c.route ?? "",
    c.model ?? "",
    c.status ?? "",
    projectName(c.cwd),
    c.cwd ?? "",
    c.acpSessionId ?? "",
    c.mcpXcodeSessionId ?? "",
    String(c.bridgePid),
  ].join(" ").toLowerCase();
}

function parentSearchText(g) {
  return [
    g.route ?? "",
    g.model ?? "",
    g.status ?? "",
    projectName(g.cwd),
    g.cwd ?? "",
    g.acpSessionId ?? "",
    String(g.representativeBridgePid),
  ].join(" ").toLowerCase();
}

function groupSpawnCount(g) {
  return g.kind === "session" ? g.spawns.length : 1;
}

function totalSpawnCount(groups) {
  return groups.reduce((n, g) => n + groupSpawnCount(g), 0);
}

function spawnCellsHtml(c) {
  return `
    <td class="col-time" title="${escapeHtml(fmtFull(c.startedAt))}">${escapeHtml(fmtClock(c.startedAt))}</td>
    <td>${dash(c.route)}</td>
    <td class="col-model">${dash(c.model)}</td>
    <td>${projectName(c.cwd)}</td>
    <td class="num">${escapeHtml(c.promptCount)}</td>
    <td class="num">${escapeHtml(c.toolCallCount ?? 0)}</td>
    <td class="col-ms">${escapeHtml(fmtDuration(c.durationMs))}</td>
    <td>${conversationStatusPill(c.status)}</td>`;
}

function sessionParentRowHtml(g, expanded, showExpand) {
  const n = g.spawns.length;
  const shortId = middleElide(g.acpSessionId, 8, 6);
  const expandBtn = showExpand
    ? `<button type="button" class="session-expand" data-session-toggle="${escapeHtml(g.acpSessionId)}" aria-expanded="${expanded ? "true" : "false"}" aria-label="${expanded ? "Collapse" : "Expand"} session spawns">${expanded ? "▼" : "▶"}</button>`
    : "";
  return `<tr class="session-parent" data-session="${escapeHtml(g.acpSessionId)}" data-pid="${g.representativeBridgePid}">
    <td class="col-time" title="${escapeHtml(fmtFull(g.startedAt))}">
      ${expandBtn}
      <span>${escapeHtml(fmtClock(g.startedAt))}</span>
      <span class="session-id-chip" title="${escapeHtml(g.acpSessionId)}">${escapeHtml(shortId)}</span>
      <span class="session-spawns-label">${n} spawn${n === 1 ? "" : "s"}</span>
    </td>
    <td>${dash(g.route)}</td>
    <td class="col-model">${dash(g.model)}</td>
    <td>${projectName(g.cwd)}</td>
    <td class="num">${escapeHtml(g.promptCount)}</td>
    <td class="num">${escapeHtml(g.toolCallCount ?? 0)}</td>
    <td class="col-ms">${escapeHtml(fmtDuration(g.durationMs))}</td>
    <td>${conversationStatusPill(g.status)}</td>
  </tr>`;
}

function sessionChildRowHtml(c) {
  const tip = `${c.route ?? "—"} · pid ${c.bridgePid}`;
  return `<tr class="session-child" data-pid="${c.bridgePid}" title="${escapeHtml(tip)}">${spawnCellsHtml(c)}
  </tr>`;
}

function singletonRowHtml(c) {
  return `<tr data-pid="${c.bridgePid}">${spawnCellsHtml(c)}
  </tr>`;
}

function renderAcpConversations() {
  const q = listFilter.trim().toLowerCase();
  const filterActive = q.length > 0;
  const htmlParts = [];
  let shownSessions = 0;
  let shownSpawns = 0;

  for (const g of acpSessionGroups) {
    if (g.kind === "singleton") {
      const match = !filterActive || conversationSearchText(g.spawn).includes(q);
      if (!match) continue;
      htmlParts.push(singletonRowHtml(g.spawn));
      shownSessions += 1;
      shownSpawns += 1;
      continue;
    }

    const parentMatch = parentSearchText(g).includes(q);
    const matchingSpawns = filterActive
      ? g.spawns.filter((s) => conversationSearchText(s).includes(q))
      : g.spawns;
    const childHit = filterActive && matchingSpawns.length > 0;
    const groupVisible = !filterActive || parentMatch || childHit;
    if (!groupVisible) continue;

    const n = g.spawns.length;
    const showExpand = n > 1;
    const storedOpen = expandedSessionIds.has(g.acpSessionId);
    const open = showExpand && (storedOpen || (filterActive && childHit));
    const childrenToShow =
      !open
        ? []
        : filterActive && !parentMatch
          ? matchingSpawns
          : g.spawns;

    htmlParts.push(sessionParentRowHtml(g, open, showExpand));
    for (const spawn of childrenToShow) {
      htmlParts.push(sessionChildRowHtml(spawn));
    }
    shownSessions += 1;
    shownSpawns += !filterActive || parentMatch ? n : matchingSpawns.length;
  }

  const html = htmlParts.join("");
  const has = acpSessionGroups.length > 0;
  tableWrap.classList.toggle("hidden", !has);
  acpEmpty.classList.toggle("hidden", has);
  if (listCountEl) {
    const totalSessions = acpSessionGroups.length;
    const totalSpawns = totalSpawnCount(acpSessionGroups);
    listCountEl.textContent = filterActive
      ? `${shownSessions}/${totalSessions} sessions (${shownSpawns}/${totalSpawns} spawns)`
      : `${totalSessions} sessions (${totalSpawns} spawns)`;
  }
  if (acpConversationListEl.innerHTML === html) return;
  acpConversationListEl.innerHTML = html;
}

/* ---- route / model selects ----------------------------------- */

async function loadAcpModels() {
  const route = acpNextRouteEl.value;
  if (!route) return;
  const data = await fetch(`/api/acp-models?route=${encodeURIComponent(route)}`).then((r) => r.json());
  const models = data.models ?? [];
  acpNextModelEl.innerHTML = [
    `<option value="">(backend default)</option>`,
    ...models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`),
  ].join("");
  acpNextModelEl.value = data.current ?? "";
  acpModelStatusEl.textContent = data.warning
    ? `model list: ${data.warning}`
    : data.source === "observed"
      ? "model list from last observed session"
      : "";
}

async function loadAcpRoute() {
  const data = await fetch("/api/acp-route").then((r) => r.json());
  acpNextRouteEl.innerHTML = (data.routes ?? [])
    .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
    .join("");
  acpNextRouteEl.value = data.route;
  await loadAcpModels();
}

async function loadAcpConversations() {
  const res = await fetch("/api/acp-conversation-sessions");
  if (!res.ok) {
    console.error(`acp-conversation-sessions failed: ${res.status} (restart dashboard if 404)`);
    return;
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    console.error("acp-conversation-sessions returned non-array", data);
    return;
  }
  acpSessionGroups = data;
  expandedSessionIds = loadExpandedIds();
  renderAcpConversations();
}

/* ---- event wiring ------------------------------------------- */

acpConversationListEl.addEventListener("click", (e) => {
  const toggle = e.target.closest("[data-session-toggle]");
  if (toggle && acpConversationListEl.contains(toggle)) {
    e.preventDefault();
    e.stopPropagation();
    toggleSessionExpand(toggle.getAttribute("data-session-toggle"));
    return;
  }
  const tr = e.target.closest("tr[data-pid]");
  if (!tr || !acpConversationListEl.contains(tr)) return;
  const pid = Number(tr.dataset.pid);
  if (Number.isNaN(pid)) return;
  // remember list scroll position so Back restores it
  try {
    sessionStorage.setItem(SCROLL_KEY, String(tableWrap.scrollTop));
  } catch {
    // sessionStorage unavailable — ignore
  }
  location.href = `/conversation.html?pid=${pid}`;
});

listFilterEl.addEventListener("input", () => {
  listFilter = listFilterEl.value;
  renderAcpConversations();
});

acpNextRouteEl.addEventListener("change", async () => {
  await fetch("/api/acp-route", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ route: acpNextRouteEl.value }),
  });
  await loadAcpRoute();
});

acpNextModelEl.addEventListener("change", async () => {
  await fetch("/api/acp-route", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      route: acpNextRouteEl.value,
      model: acpNextModelEl.value || null,
    }),
  });
  await loadAcpRoute();
});

$("btn-clear").addEventListener("click", async () => {
  await fetch("/api/acp-events/clear", { method: "POST" });
  acpSessionGroups = [];
  renderAcpConversations();
});

$("btn-export").addEventListener("click", () => {
  window.location.href = "/api/acp-events/export";
});

/* ---- live feed ---------------------------------------------- */

let acpListRefreshTimer = null;
const acpEs = new EventSource("/acp-events");
acpEs.onopen = () => setLive(true);
acpEs.onerror = () => setLive(false);
acpEs.addEventListener("acp", () => {
  if (acpListRefreshTimer != null) clearTimeout(acpListRefreshTimer);
  acpListRefreshTimer = setTimeout(() => {
    acpListRefreshTimer = null;
    loadAcpConversations();
  }, 400);
});

/* ---- init ---------------------------------------------------- */

async function init() {
  await loadAcpRoute();
  await loadAcpConversations();
  setLive(true);
  try {
    const saved = sessionStorage.getItem(SCROLL_KEY);
    if (saved != null) tableWrap.scrollTop = Number(saved);
  } catch {
    // ignore
  }
}
void init();
