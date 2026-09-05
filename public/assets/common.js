// Shared helpers for all UIs
let _hallToken = null;
export function setHallToken(token) { _hallToken = token || null; }

/** Swap a team crest; always drop the previous src so a leftover logo cannot linger. */
export function setTeamLogo(img, filename, teamId) {
  if (!img) return;
  if (!filename) {
    img.removeAttribute('src');
    delete img.dataset.src;
    img.style.display = 'none';
    return;
  }
  const url = `/media-files/${encodeURIComponent(filename)}?tid=${teamId || filename}`;
  if (img.dataset.src !== url) {
    img.dataset.src = url;
    img.src = url;
  }
  img.style.display = '';
}

export const api = {
  async req(method, url, body) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (_hallToken) headers['X-Hall-Token'] = _hallToken;
    const r = await fetch(url, {
      method,
      cache: 'no-store',
      credentials: 'include',
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    if (!r.ok) throw new Error(`${method} ${url}: ${r.status}`);
    return r.json();
  },
  get: u => api.req('GET', u),
  post: (u, b) => api.req('POST', u, b ?? {}),
  put: (u, b) => api.req('PUT', u, b),
  del: u => api.req('DELETE', u)
};

/** Upload a file in ~8 MB chunks so Cloudflare's 100 MB / 100 s limits don't drop it. */
export async function uploadFile(url, file, { onProgress } = {}) {
  const CHUNK = 8 * 1024 * 1024;
  const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const chunkCount = Math.max(1, Math.ceil(file.size / CHUNK));
  let last = null;
  for (let i = 0; i < chunkCount; i++) {
    const blob = file.slice(i * CHUNK, Math.min(file.size, (i + 1) * CHUNK));
    const fd = new FormData();
    fd.append('chunkIndex', String(i));
    fd.append('chunkCount', String(chunkCount));
    fd.append('uploadId', uploadId);
    fd.append('originalName', file.name);
    fd.append('file', blob, file.name);
    const headers = {};
    if (_hallToken) headers['X-Hall-Token'] = _hallToken;
    const r = await fetch(url, { method: 'POST', body: fd, credentials: 'include', cache: 'no-store', headers });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Nahrání selhalo (${r.status})`);
    last = data;
    if (onProgress) onProgress(i + 1, chunkCount);
  }
  return last;
}

export function fmtTime(ms) {
  const s = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Snapshot of server-computed elapsed so clients don't mix local vs server clocks. */
export function clockSnap(match) {
  if (!match) return null;
  return {
    elapsedMs: Math.max(0, match.elapsed_ms ?? 0),
    timeoutRemainingMs: Math.max(0, match.timeout_remaining_ms ?? 0),
    capturedAt: Date.now()
  };
}

/** Remaining timeout display in ms, counted down from the last match snapshot. */
export function timeoutMs(match, snap) {
  if (!match) return 0;
  if (snap) return Math.max(0, snap.timeoutRemainingMs - (Date.now() - snap.capturedAt));
  return Math.max(0, match.timeout_remaining_ms ?? 0);
}

/** Period clock in ms: never negative, never past the period length. */
export function clockMs(match, snap) {
  if (!match) return 0;
  let ms;
  if (snap) {
    ms = match.timer_running ? snap.elapsedMs + (Date.now() - snap.capturedAt) : snap.elapsedMs;
  } else {
    ms = match.timer_offset_ms || 0;
    if (match.timer_running && match.timer_started_at) ms += Date.now() - match.timer_started_at;
  }
  ms = Math.max(0, ms);
  const target = match.period_target_ms || 0;
  if (target > 0) ms = Math.min(ms, target);
  return ms;
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function teamLabel(m, side) {
  return m[`${side}_name`] || m[`${side}_placeholder`] || '???';
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const qs = new URLSearchParams(location.search);
