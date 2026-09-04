// Fullscreen remote desktop viewer for réžia.
const params = new URLSearchParams(location.search);
const HALL = +(params.get('hall') || 0);

const stage = document.getElementById('stage');
const screen = document.getElementById('screen');
const statusEl = document.getElementById('status');
const chromeEl = document.getElementById('chrome');
const endBtn = document.getElementById('endBtn');
const fsBtn = document.getElementById('fsBtn');
const titleEl = document.getElementById('title');

let socket = null;
let ended = false;
let lastObjectUrl = null;
let hideTimer = null;
let screenW = 0;
let screenH = 0;
let gotFrame = false;
let frameWatch = null;
let pointerDown = false;
let lastSentClip = '';
const CLIP_MAX = 100000;

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || '';
}

function keepChromeVisible() {
  return statusEl.classList.contains('err') || !gotFrame;
}

function showChrome() {
  chromeEl.classList.remove('hidden');
  clearTimeout(hideTimer);
  if (keepChromeVisible()) return;
  hideTimer = setTimeout(() => {
    if (keepChromeVisible()) return;
    chromeEl.classList.add('hidden');
  }, 1800);
}

function hideChromeSoon() {
  if (keepChromeVisible()) return;
  chromeEl.classList.add('hidden');
}

function toJpegBlob(buf) {
  if (!buf) return null;
  if (buf instanceof Blob)
    return buf.type ? buf : new Blob([buf], { type: 'image/jpeg' });
  if (buf instanceof ArrayBuffer)
    return new Blob([buf], { type: 'image/jpeg' });
  if (ArrayBuffer.isView(buf))
    return new Blob([buf], { type: 'image/jpeg' });
  if (buf.type === 'Buffer' && buf.data)
    return new Blob([new Uint8Array(buf.data)], { type: 'image/jpeg' });
  if (Array.isArray(buf))
    return new Blob([new Uint8Array(buf)], { type: 'image/jpeg' });
  return new Blob([buf], { type: 'image/jpeg' });
}

function framePayload(payload) {
  return payload?.jpeg ?? payload;
}

function armFrameWatch() {
  clearTimeout(frameWatch);
  frameWatch = setTimeout(() => {
    if (!ended && !gotFrame)
      setStatus('Nepřišel žádný obraz z haly — helper možná snímá černou plochu nebo chybí', 'err');
    showChrome();
  }, 8000);
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Map a pointer on #stage to 0..1 of the hall desktop (letterbox clamps to edges). */
function normCoords(ev) {
  const rect = stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return { x: 0, y: 0 };
  const natW = screen.naturalWidth || screenW || rect.width;
  const natH = screen.naturalHeight || screenH || rect.height;
  const scale = Math.min(rect.width / natW, rect.height / natH);
  const drawW = Math.max(1, natW * scale);
  const drawH = Math.max(1, natH * scale);
  const ox = rect.left + (rect.width - drawW) / 2;
  const oy = rect.top + (rect.height - drawH) / 2;
  return {
    x: clamp01((ev.clientX - ox) / drawW),
    y: clamp01((ev.clientY - oy) / drawH),
  };
}

function sendInput(payload) {
  if (!socket || ended) return;
  socket.emit('remote:input', { hallId: HALL, ...payload });
}

function isAccel(ev) {
  return ev.ctrlKey || ev.metaKey;
}

function isPasteKey(ev) {
  return isAccel(ev) && !ev.altKey && !ev.shiftKey && (ev.code === 'KeyV' || ev.key === 'v' || ev.key === 'V');
}

function isCopyKey(ev) {
  return isAccel(ev) && !ev.altKey && (
    ev.code === 'KeyC' || ev.code === 'KeyX' ||
    ev.key === 'c' || ev.key === 'C' || ev.key === 'x' || ev.key === 'X'
  );
}

async function pasteFromLocal() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch {}
  if (!text) return;
  if (text.length > CLIP_MAX) text = text.slice(0, CLIP_MAX);
  lastSentClip = text;
  sendInput({ type: 'clipboard-set', text, paste: true });
}

function applyRemoteClipboard(text) {
  if (typeof text !== 'string' || !text || text === lastSentClip) return;
  navigator.clipboard.writeText(text).catch(() => {});
}

function isOnChromeButton(ev) {
  return !!ev.target?.closest?.('#chrome button');
}

function onPointerMove(ev) {
  if (ended) return;
  if (ev.clientY <= 12) showChrome();
  else if (!keepChromeVisible() && ev.clientY > 56) hideChromeSoon();
  if (isOnChromeButton(ev)) return;
  const p = normCoords(ev);
  sendInput({ type: 'move', x: p.x, y: p.y });
}

function onPointerDown(ev) {
  if (ended || isOnChromeButton(ev)) return;
  ev.preventDefault();
  pointerDown = true;
  try { stage.setPointerCapture(ev.pointerId); } catch {}
  const p = normCoords(ev);
  sendInput({ type: 'move', x: p.x, y: p.y });
  sendInput({ type: 'down', button: ev.button || 0 });
}

function onPointerUp(ev) {
  if (ended) return;
  if (pointerDown) {
    sendInput({ type: 'up', button: ev.button || 0 });
    pointerDown = false;
  }
  try { stage.releasePointerCapture(ev.pointerId); } catch {}
}

async function endSession() {
  if (ended) return;
  ended = true;
  setStatus('Ukončuji…');
  try {
    if (socket) socket.emit('remote:unsubscribe', { hallId: HALL });
  } catch {}
  try { if (socket) socket.disconnect(); } catch {}
  if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
  window.close();
  setTimeout(() => { location.href = '/admin/'; }, 300);
}

async function enterFullscreen() {
  try {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen)
      await el.requestFullscreen();
  } catch {}
}

async function init() {
  if (!HALL) {
    setStatus('Chybí číslo haly', 'err');
    return;
  }
  titleEl.textContent = 'Vzdálené ovládání — Hala ' + HALL;

  try {
    const halls = await fetch('/api/halls', { credentials: 'same-origin' }).then(r => r.json());
    const h = Array.isArray(halls) ? halls.find(x => x.id === HALL) : null;
    if (h?.name) titleEl.textContent = 'Vzdálené ovládání — ' + h.name;
  } catch {}

  socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    setStatus('Spouštím relaci…');
    socket.emit('remote:subscribe', { hallId: HALL, mode: 'control' }, (r) => {
      if (r && !r.ok) setStatus(r.error || 'Chyba přihlášení', 'err');
      else {
        setStatus('Připojeno — čekám na obraz…', 'ok');
        armFrameWatch();
      }
    });
    enterFullscreen();
  });

  socket.on('disconnect', () => {
    if (!ended) setStatus('Odpojeno od serveru', 'err');
  });

  socket.on('remote:status', (st) => {
    if (st.event === 'error') {
      setStatus(st.message || 'Chyba helperu', 'err');
      showChrome();
      return;
    }
    if (st.screenWidth) screenW = st.screenWidth;
    if (st.screenHeight) screenH = st.screenHeight;
    if (st.event === 'clipboard') {
      applyRemoteClipboard(st.text);
      return;
    }
    if (st.capturing && !gotFrame) {
      setStatus('Snímám — čekám na obraz…', 'ok');
      armFrameWatch();
      showChrome();
    }
  });

  socket.on('remote:frame', (payload) => {
    const blob = toJpegBlob(framePayload(payload));
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    screen.src = url;
    if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
    lastObjectUrl = url;
    if (!gotFrame) {
      gotFrame = true;
      clearTimeout(frameWatch);
      setStatus('Živě', 'ok');
      showChrome();
    }
  });

  socket.on('remote:clipboard', (p) => applyRemoteClipboard(p?.text));

  screen.addEventListener('error', () => {
    if (!ended) setStatus('Snímek plochy se nepodařilo zobrazit', 'err');
    showChrome();
  });

  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerUp);
  stage.addEventListener('contextmenu', (ev) => ev.preventDefault());
  stage.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    sendInput({ type: 'wheel', delta: -Math.sign(ev.deltaY) * 120 });
  }, { passive: false });

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      endSession();
      return;
    }
    if (ev.key === 'F11') return;
    if (isPasteKey(ev)) {
      ev.preventDefault();
      pasteFromLocal();
      return;
    }
    ev.preventDefault();
    sendInput({ type: 'keydown', keyCode: ev.keyCode, vk: ev.keyCode, code: ev.code, key: ev.key });
  });
  window.addEventListener('keyup', (ev) => {
    if (ev.key === 'Escape' || ev.key === 'F11') return;
    if (isPasteKey(ev)) {
      ev.preventDefault();
      return;
    }
    ev.preventDefault();
    sendInput({ type: 'keyup', keyCode: ev.keyCode, vk: ev.keyCode, code: ev.code, key: ev.key });
    if (isCopyKey(ev)) setTimeout(() => sendInput({ type: 'clipboard-get' }), 120);
  });

  endBtn.onclick = (ev) => { ev.stopPropagation(); endSession(); };
  fsBtn.onclick = (ev) => { ev.stopPropagation(); enterFullscreen(); };
  window.addEventListener('beforeunload', () => {
    if (ended) return;
    try { socket?.emit('remote:unsubscribe', { hallId: HALL }); } catch {}
  });

  showChrome();
}

init();
