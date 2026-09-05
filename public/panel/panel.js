// LED score panel 1040×208: live match display for a second monitor.
// Same Socket.IO contract as the OBS overlay; no spots/ticker/branding.
import { api, fmtTime, clockSnap, clockMs, timeoutMs, esc, qs, setHallToken, setTeamLogo } from '/assets/common.js?v=6';
import { playHorn, unlockHorn, loadHornConfig, setHornUrl } from '/assets/horn.js?v=5';

const hallId = +(qs.get('hall') || 1);
const hallToken = qs.get('token') || '';
if (hallToken) setHallToken(hallToken);
const $ = id => document.getElementById(id);

let match = null;
let snap = null;
let suspensions = [];
let overlayHidden = false;

const socket = io({ auth: { hall: hallId, token: hallToken } });
// Horn only on the real LED window — not in réžia iframe previews.
const hornEnabled = window.self === window.top;
socket.on(`hall:${hallId}:match`, m => {
  match = m && m.status === 'live' ? m : null;
  snap = clockSnap(match);
  refreshSusp().then(draw);
});
socket.on('schedule:update', load);
socket.on(`hall:${hallId}:flash`, showFlash);
socket.on(`hall:${hallId}:overlay`, ({ visible }) => { overlayHidden = !visible; draw(); });
socket.on('connect', () => { load(); if (hornEnabled) loadHornConfig(); });
socket.on('horn:update', d => { if (hornEnabled) setHornUrl(d.url); });
if (hornEnabled) {
  socket.on(`hall:${hallId}:horn`, ({ kind }) => playHorn(kind));
  document.addEventListener('pointerdown', unlockHorn, { once: true });
  document.addEventListener('keydown', unlockHorn, { once: true });
  loadHornConfig();
}

async function load() {
  const m = await api.get(`/api/halls/${hallId}/live`);
  match = m && m.status === 'live' ? m : null;
  snap = clockSnap(match);
  const st = await api.get(`/api/halls/${hallId}/overlay-state`);
  overlayHidden = !st.overlay_visible;
  await refreshSusp();
  draw();
}

async function refreshSusp() {
  suspensions = match ? await api.get(`/api/matches/${match.id}/suspensions`) : [];
}

function elapsed() {
  return clockMs(match, snap);
}

// Odometer-style digit animation (same as overlay).
function setDigits(el, text, dur, pop = false) {
  const prev = el.dataset.v ?? '';
  if (prev === String(text)) return;
  const first = !el.dataset.v;
  el.dataset.v = String(text);
  const max = Math.max(prev.length, String(text).length);
  const o = prev.padStart(max, ' '), n = String(text).padStart(max, ' ');
  el.innerHTML = '';
  for (let i = 0; i < max; i++) {
    const ch = document.createElement('span');
    ch.className = 'dig';
    ch.textContent = n[i];
    el.appendChild(ch);
    if (!first && o[i] !== n[i]) {
      ch.animate(
        [{ transform: 'translateY(70%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }],
        { duration: dur, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }
  if (pop && !first) {
    el.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.35)', offset: .35 }, { transform: 'scale(1)' }],
      { duration: dur * 1.2, easing: 'ease-out' });
  }
}

function setSide(side, prefix) {
  const name = match[`${side}_name`] || match[`${side}_short`] || match[`${side}_placeholder`] || '???';
  const bug = $('bug');
  bug.style.setProperty(`--${side}`, match[`${side}_color_bg`] || '#1d3fb8');
  bug.style.setProperty(`--${side}-text`, match[`${side}_color_text`] || '#ffffff');
  $(`${prefix}Name`).textContent = name;
  setTeamLogo($(`${prefix}Logo`), match[`${side}_logo`], match[`${side}_team_id`]);
}

const suspEls = new Map();

function suspHost(side) {
  if (side === 'home') return $('suspHome');
  if (side === 'away') return $('suspAway');
  return null;
}

function renderSusp() {
  const current = new Set(suspensions.map(s => s.id));
  for (const [id, el] of suspEls) {
    if (!current.has(id)) {
      suspEls.delete(id);
      el.animate(
        [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(10px)' }],
        { duration: 350, easing: 'ease-in' }).onfinish = () => el.remove();
    }
  }
  for (const s of suspensions) {
    const host = suspHost(s.side);
    if (!host) continue;
    let el = suspEls.get(s.id);
    if (!el) {
      el = document.createElement('span');
      el.className = 'susp-chip';
      host.appendChild(el);
      el.animate(
        [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 400, easing: 'cubic-bezier(.2,.8,.2,1)' });
      suspEls.set(s.id, el);
    } else if (el.parentElement !== host) {
      host.appendChild(el);
    }
    el.innerHTML = `⏱ ${s.player_number ? `<b>#${esc(s.player_number)}</b> ` : ''}${fmtTime(s.remaining_ms)}`;
  }
}

function clearSusp() {
  suspensions = [];
  renderSusp();
}

function perLabel(p) { return p <= 2 ? `P${p}` : `PR${p - 2}`; }

function renderDots(side, prefix) {
  const used = match[`${side}_timeouts`] || 0, max = match.timeouts_allowed || 0;
  $(`${prefix}Todots`).innerHTML = Array.from({ length: max }, (_, i) =>
    `<span class="d ${i < used ? 'used' : ''}"></span>`).join('');
}

let bugVisible = false;
function applyVisibility() {
  const show = !!match && !overlayHidden;
  if (show === bugVisible) return;
  bugVisible = show;
  $('bugWrap').style.opacity = 1;
  const clock = $('clock'), wh = document.querySelector('.wing.home'), wa = document.querySelector('.wing.away');
  const ease = 'cubic-bezier(.2,.8,.2,1)';
  if (show) {
    clock.animate([{ opacity: 0, transform: 'translateY(48px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 460, easing: ease, fill: 'both' });
    for (const w of [wh, wa]) w.animate(
      [{ opacity: 0, transform: 'scaleX(0)' }, { opacity: 1, transform: 'scaleX(1)' }],
      { duration: 480, delay: 360, easing: ease, fill: 'both' });
  } else {
    for (const w of [wh, wa]) w.animate(
      [{ opacity: 1, transform: 'scaleX(1)' }, { opacity: 0, transform: 'scaleX(0)' }],
      { duration: 320, easing: 'ease-in', fill: 'both' });
    clock.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(48px)' }],
      { duration: 360, delay: 280, easing: 'ease-in', fill: 'both' });
  }
  for (const id of ['suspHome', 'suspAway', 'flash']) $(id).style.opacity = show ? 1 : 0;
}

function timeoutLeft() {
  return timeoutMs(match, snap);
}

function beginTimeoutClock(ms) {
  const left = Math.max(0, ms || 0);
  if (!snap) snap = clockSnap(match) || { elapsedMs: 0, timeoutRemainingMs: 0, capturedAt: Date.now() };
  snap.timeoutRemainingMs = left;
  snap.capturedAt = Date.now();
  paintClock();
}

function paintClock() {
  const clock = $('clock');
  const timeEl = $('time');
  if (!clock || !timeEl) return;
  if (!match) {
    clock.classList.remove('timeout');
    return;
  }
  const left = timeoutLeft();
  if (left > 0) {
    clock.classList.add('timeout');
    setDigits(timeEl, fmtTime(left), 160);
  } else {
    if (clock.classList.contains('timeout')) {
      clock.classList.remove('timeout');
      const el = $('flash');
      if (el.querySelector('.flash-to')) {
        clearTimeout(el._t);
        flashOut(el);
      }
    }
    setDigits(timeEl, fmtTime(elapsed()), 160);
  }
}

function restoreTimeoutBanner() {
  const left = timeoutLeft();
  if (left > 0 && match?.timeout_side && !$('flash').querySelector('.flash-to'))
    showFlash({ type: 'timeout', side: match.timeout_side });
}

function draw() {
  if (!match) { paintClock(); applyVisibility(); clearSusp(); return; }
  setSide('home', 'h');
  setSide('away', 'a');
  renderDots('home', 'h');
  renderDots('away', 'a');
  setDigits($('hScore'), match.home_score, 700, true);
  setDigits($('aScore'), match.away_score, 700, true);
  setDigits($('per'), perLabel(match.period), 300);
  paintClock();
  restoreTimeoutBanner();
  renderSusp();
  applyVisibility();
}

const CARD_MS = 6000;
const TIMEOUT_MS = 60000;
function teamShort(side) { return match ? (match[`${side}_short`] || match[`${side}_name`] || '') : ''; }
function flashIn(node) {
  node?.animate([{ opacity: 0, transform: 'translateY(8px) scale(.9)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }],
    { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
function flashOut(el) {
  const c = el.firstElementChild;
  if (!c) { el.innerHTML = ''; return; }
  c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350 }).onfinish = () => { el.innerHTML = ''; };
}
function showFlash({ type, side, number }) {
  const el = $('flash');
  clearTimeout(el._t);
  const team = esc(teamShort(side));
  const inner = type === 'timeout'
    ? `<div class="flash-to">TIMEOUT${team ? ' · ' + team : ''}</div>`
    : `<div class="flash-stack"><div class="flash-card fc-${type}">${number ? '#' + esc(number) : ''}</div>${team ? `<div class="flash-team">${team}</div>` : ''}</div>`;
  el.innerHTML = `<div class="flash-anim">${inner}</div>`;
  flashIn(el.firstElementChild);
  const dur = type === 'timeout' ? (timeoutLeft() || TIMEOUT_MS) : CARD_MS;
  if (type === 'timeout' && !timeoutLeft()) beginTimeoutClock(dur);
  el._t = setTimeout(() => flashOut(el), dur);
}

document.addEventListener('dblclick', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  else document.exitFullscreen?.();
});

const PANEL_W = 1040, PANEL_H = 208;
let lastDpr = 0;

// Mixed-DPI (4K 150% + FHD 100%): Chrome often keeps one devicePixelRatio for the
// window even after you drag it. Compensate so the LED gets 1040×208 device pixels.
function applyStageScale() {
  if (window !== window.top) return;
  const dpr = window.devicePixelRatio || 1;
  if (dpr === lastDpr) return;
  lastDpr = dpr;
  document.body.style.width = (PANEL_W / dpr) + 'px';
  document.body.style.height = (PANEL_H / dpr) + 'px';
  const stage = $('stage');
  stage.style.transformOrigin = 'top left';
  stage.style.transform = dpr === 1 ? 'none' : `scale(${1 / dpr})`;
}

function lockViewport() {
  if (window !== window.top) return;
  lastDpr = 0;
  applyStageScale();
  const dpr = window.devicePixelRatio || 1;
  const dw = Math.round(PANEL_W / dpr) - innerWidth;
  const dh = Math.round(PANEL_H / dpr) - innerHeight;
  if (dw || dh) window.resizeBy(dw, dh);
}
applyStageScale();
lockViewport();
setTimeout(lockViewport, 80);
setTimeout(lockViewport, 400);
setInterval(applyStageScale, 250);

if (qs.get('debug') === '1') {
  const el = $('dprDebug');
  el.style.display = 'block';
  const tick = () => {
    const dpr = window.devicePixelRatio || 1;
    el.textContent =
      `okno CSS ${innerWidth}×${innerHeight}\n` +
      `DPR ${dpr}  →  fyzicky ${Math.round(innerWidth * dpr)}×${Math.round(innerHeight * dpr)}\n` +
      `screen ${screen.width}×${screen.height}  @${screenX},${screenY}`;
  };
  tick();
  setInterval(tick, 250);
}

setInterval(() => { if (match) paintClock(); }, 250);
setInterval(async () => { await refreshSusp(); if (match) renderSusp(); }, 1000);

load();
