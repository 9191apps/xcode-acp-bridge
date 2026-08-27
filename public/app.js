/* Xcode Observatory dashboard — shared helpers
   Loaded by both the list page (index.html) and the
   conversation detail page (conversation.html). */
const $ = (id) => document.getElementById(id);

/* ---- formatting helpers ------------------------------------ */

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtClock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtFull(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${fmtClock(iso)}`;
}

function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const n = Math.max(0, Math.round(ms));
  if (n < 1000) return `${n}ms`;
  if (n < 60_000) {
    const seconds = n / 1000;
    return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(n / 60_000);
  const seconds = Math.round((n % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function dash(value) {
  return value == null || value === "" ? "—" : escapeHtml(value);
}

function middleElide(value, head = 14, tail = 12) {
  const s = String(value ?? "");
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function projectName(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return "—";
  const base = cwd.split("/").filter((part) => part.length > 0).at(-1);
  return base ? escapeHtml(base) : "—";
}

/* ---- JSON syntax highlighting ------------------------------- */

function highlightJson(raw) {
  if (raw == null || raw === "") return escapeHtml(raw ?? "");
  const text = String(raw);
  let out = "";
  let i = 0;
  const n = text.length;
  const push = (s, cls) => {
    out += cls ? `<span class="${cls}">${escapeHtml(s)}</span>` : escapeHtml(s);
  };
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') {
        if (text[j] === "\\") j++;
        j++;
      }
      j = Math.min(j + 1, n);
      const token = text.slice(i, j);
      let k = j;
      while (k < n && /\s/.test(text[k])) k++;
      if (text[k] === ":") {
        push(token, "j-key");
        let k2 = k;
        while (k2 < n && (text[k2] === ":" || /\s/.test(text[k2]))) k2++;
        out += escapeHtml(text.slice(k, k2));
        i = k2;
      } else {
        push(token, "j-str");
        i = j;
      }
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[0-9eE+\-.]/.test(text[j])) j++;
      const token = text.slice(i, j);
      if (/^-?\d/.test(token) && Number.isFinite(Number(token))) push(token, "j-num");
      else push(token, null);
      i = j;
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[a-zA-Z]/.test(text[j])) j++;
      const token = text.slice(i, j);
      push(token, token === "true" || token === "false" || token === "null" ? "j-lit" : null);
      i = j;
      continue;
    }
    out += escapeHtml(ch);
    i++;
  }
  return out;
}

/* ---- copy buttons (event delegation) ------------------------ */

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy-src]");
  if (!btn) return;
  const target = document.querySelector(btn.dataset.copySrc);
  if (!target) return;
  // data-full carries the unabridged value when the visible text is elided.
  const text = target.dataset.full ?? target.innerText;
  const original = btn.textContent;
  const done = () => {
    btn.classList.add("ok");
    btn.textContent = "copied";
    setTimeout(() => {
      btn.classList.remove("ok");
      btn.textContent = original;
    }, 1100);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => {});
  } else {
    done();
  }
});

/* ---- live indicator (page-safe: only touches present nodes) - */

/** EventSource fires `onerror` on every auto-reconnect tick; debounce so the
 * chip does not flicker RECONNECT on brief CONNECTING blips. */
let liveOfflineTimer = null;

function setLive(ok) {
  const chip = $("live-chip");
  const txt = $("live-text");
  if (!chip || !txt) return;
  if (ok) {
    if (liveOfflineTimer != null) {
      clearTimeout(liveOfflineTimer);
      liveOfflineTimer = null;
    }
    chip.classList.toggle("offline", false);
    txt.textContent = "LIVE";
    return;
  }
  if (liveOfflineTimer != null) return;
  liveOfflineTimer = setTimeout(() => {
    liveOfflineTimer = null;
    chip.classList.toggle("offline", true);
    txt.textContent = "RECONNECT";
  }, 1500);
}

/* ---- ACP image content blocks (prompt / tool results) -------- */

const ACP_SAFE_IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|bmp)$/i;
const ACP_BASE64_BODY = /^[A-Za-z0-9+/=\s]+$/;

function extractAcpImages(value) {
  const out = [];
  const walk = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object") return;
    if (node.type === "image") {
      const data = typeof node.data === "string" && node.data.length > 0 ? node.data : null;
      const url =
        typeof node.url === "string" && node.url.length > 0
          ? node.url
          : typeof node.uri === "string" && node.uri.length > 0
            ? node.uri
            : null;
      const mimeType =
        typeof node.mimeType === "string" && node.mimeType.length > 0
          ? node.mimeType
          : typeof node.mime_type === "string" && node.mime_type.length > 0
            ? node.mime_type
            : "application/octet-stream";
      out.push({ mimeType, data, url });
      return;
    }
    for (const child of Object.values(node)) walk(child);
  };
  walk(value);
  return out;
}

function extractAcpImagesFromRaw(raw) {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    return extractAcpImages(JSON.parse(raw));
  } catch {
    return [];
  }
}

function acpImageDataUrl(image) {
  if (!image || !ACP_SAFE_IMAGE_MIME.test(image.mimeType)) return null;
  if (typeof image.data !== "string" || image.data.length === 0) return null;
  if (!ACP_BASE64_BODY.test(image.data)) return null;
  return `data:${image.mimeType};base64,${image.data.replace(/\s+/g, "")}`;
}

function acpImageCaption(image) {
  if (image?.url) {
    try {
      const path = String(image.url).split(/[?#]/, 1)[0];
      const leaf = path.split("/").filter(Boolean).at(-1);
      if (leaf) return decodeURIComponent(leaf);
    } catch {
      // keep mime fallback
    }
  }
  return image?.mimeType || "image";
}

function redactAcpImageData(value) {
  if (Array.isArray(value)) return value.map(redactAcpImageData);
  if (value === null || typeof value !== "object") return value;
  if (value.type === "image" && typeof value.data === "string") {
    return { ...value, data: `<base64 ${value.data.length} chars>` };
  }
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    next[key] = redactAcpImageData(child);
  }
  return next;
}

function formatEventPayload(raw) {
  if (raw == null || raw.length === 0) return raw;
  try {
    return JSON.stringify(redactAcpImageData(JSON.parse(raw)), null, 2);
  } catch {
    return raw;
  }
}
