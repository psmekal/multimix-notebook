// Train horn by default (BigSoundBank #0277 "US-Train2", CC0).
// A custom MP3 from Settings replaces both short and long blasts.

const BUILTIN = {
  'period-end':    '/assets/horn-long.mp3?v=5',
  'timeout-start': '/assets/horn.mp3?v=5',
  'timeout-warn':  '/assets/horn.mp3?v=5',
  'timeout-end':   '/assets/horn.mp3?v=5'
};

let customUrl = null;
const players = new Map();
let current = null;

function getPlayer(src) {
  let a = players.get(src);
  if (!a) {
    a = new Audio(src);
    a.preload = 'auto';
    players.set(src, a);
  }
  return a;
}

function stopCurrent() {
  if (!current) return;
  current.pause();
  current.currentTime = 0;
  current = null;
}

function sources() {
  if (customUrl) return [customUrl];
  return [...new Set(Object.values(BUILTIN))];
}

export function setHornUrl(url) {
  stopCurrent();
  customUrl = url || null;
  players.clear();
}

export async function loadHornConfig() {
  try {
    const r = await fetch('/api/horn', { cache: 'no-store', credentials: 'include' });
    if (!r.ok) return;
    const d = await r.json();
    setHornUrl(d.url || null);
  } catch {}
}

/** Call from a user gesture so Chrome allows playback. */
export function unlockHorn() {
  for (const src of sources()) {
    const a = getPlayer(src);
    a.muted = true;
    a.play().then(() => {
      a.pause();
      a.currentTime = 0;
      a.muted = false;
    }).catch(() => {});
  }
}

export function playHorn(kind = 'timeout-start') {
  const src = customUrl || BUILTIN[kind] || BUILTIN['timeout-start'];
  stopCurrent();
  const a = getPlayer(src);
  a.muted = false;
  a.volume = 1;
  a.currentTime = 0;
  current = a;
  a.play().catch(() => {});
}
