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

function setLive(ok) {
  const chip = $("live-chip");
  const txt = $("live-text");
  if (!chip || !txt) return;
  chip.classList.toggle("offline", !ok);
  txt.textContent = ok ? "LIVE" : "RECONNECT";
}

/* ---- small helpers used by both pages ------------------------ */

function formatEventPayload(raw) {
  if (raw == null || raw.length === 0) return raw;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
