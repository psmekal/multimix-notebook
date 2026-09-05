// Overlay: scoreboard, spots, scenarios, branding. Loaded as OBS browser source
// on the hall notebook; réžie controls playback via Socket.IO.
import { api, fmtTime, clockSnap, clockMs, timeoutMs, esc, qs, setHallToken, setTeamLogo } from '/assets/common.js?v=6';
import { playHorn, loadHornConfig, setHornUrl } from '/assets/horn.js?v=5';

const hallId = +(qs.get('hall') || 1);
const hallToken = qs.get('token') || '';
if (hallToken) setHallToken(hallToken);
const isDriver = qs.get('driver') === '1';
const $ = id => document.getElementById(id);
let match = null;
let snap = null;
let suspensions = [];
let overlayHidden = false;

const socket = io({ auth: { hall: hallId, token: hallToken } });
const overlayAck = () => ({ hall: hallId, token: hallToken });
socket.on(`hall:${hallId}:match`, m => {
  match = m && m.status === 'live' ? m : null;
  snap = clockSnap(match);
  refreshSusp().then(draw);
});
socket.on('schedule:update', load);
socket.on('alerts:update', loadAlerts);
socket.on(`hall:${hallId}:flash`, showFlash);
socket.on(`hall:${hallId}:overlay`, ({ visible }) => { overlayHidden = !visible; draw(); });
socket.on(`hall:${hallId}:horn`, ({ kind }) => { if (isDriver) playHorn(kind); });
socket.on('horn:update', d => setHornUrl(d.url));
socket.on('branding:update', loadBranding);

// On a long-running OBS browser source the WS can drop and reconnect (Cloudflare,
// flaky hall WAN), silently leaving the overlay on stale data — e.g. a logo's
// new corner or its "active" toggle never arrives. Re-pull all state on every
// (re)connect so live edits always take effect. (`connect` also fires on the
// initial connection; the explicit calls below stay for first paint speed.)
socket.on('connect', () => { load(); loadAlerts(); loadBranding(); loadHornConfig(); });

// ----- Spot video (réžia plays ad via overlay browser source) -----
const spotWrap  = document.getElementById('spot-wrap');
const spotVideo = document.getElementById('spot-video');
const adLayer   = document.getElementById('ad-layer');
const adA       = document.getElementById('ad-a');
const adB       = document.getElementById('ad-b');
const stingerV  = document.getElementById('stinger-video');
const mediaUrl  = f => location.origin + '/media-files/' + encodeURIComponent(f);

// Load a clip and start playback. Unmuted autoplay is often blocked (browser
// tab, OBS CEF); fall back to muted rather than leaving a blank overlay.
// Resolves true if playback started.
function playWhenReady(el, url, { muted = false } = {}) {
  return new Promise(resolve => {
    let settled = false;
    let timer = 0;
    const settle = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeEventListener('canplay', onCanPlay);
      el.removeEventListener('error', onError);
      resolve(!!ok);
    };
    const attempt = () => {
      el.muted = muted;
      const p = el.play();
      if (!p || typeof p.then !== 'function') { settle(true); return; }
      p.then(() => settle(true)).catch(() => {
        el.muted = true;
        const p2 = el.play();
        if (!p2 || typeof p2.then !== 'function') { settle(true); return; }
        p2.then(() => settle(true)).catch(err => {
          console.warn('overlay video play failed', el.id, url, err);
          settle(false);
        });
      });
    };
    const onCanPlay = () => attempt();
    const onError = () => {
      console.warn('overlay video error', el.id, url, el.error);
      settle(false);
    };
    el.addEventListener('canplay', onCanPlay, { once: true });
    el.addEventListener('error', onError, { once: true });
    timer = setTimeout(() => { if (!settled) attempt(); }, 2500);
    if ((el.currentSrc === url || el.src === url) && el.readyState >= 3) {
      try { el.currentTime = 0; } catch {}
      attempt();
      return;
    }
    el.src = url;
    el.load();
  });
}

function clearVideo(el) {
  el.pause();
  el.removeAttribute('src');
  try { el.load(); } catch {}
}

const stingerDurCache = new Map();

function getStingerDuration(filename) {
  if (!filename) return Promise.resolve(0);
  if (stingerDurCache.has(filename)) return Promise.resolve(stingerDurCache.get(filename));
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.src = mediaUrl(filename);
    let done = false;
    const finish = d => {
      if (done) return;
      done = true;
      const dur = Number.isFinite(d) && d > 0 ? d : 0;
      if (dur) stingerDurCache.set(filename, dur);
      v.removeAttribute('src');
      try { v.load(); } catch {}
      resolve(dur);
    };
    v.addEventListener('loadedmetadata', () => finish(v.duration), { once: true });
    v.addEventListener('error', () => finish(0), { once: true });
    setTimeout(() => finish(0), 4000);
  });
}

// Fire `cb` once when `el` has `seconds` (or less) remaining. Also fires on
// `ended` so a clip shorter than the lead still starts the closer.
function onRemaining(el, seconds, cb) {
  let fired = false, raf = 0;
  const fire = () => {
    if (fired) return;
    fired = true;
    cancelAnimationFrame(raf);
    el.removeEventListener('timeupdate', tick);
    el.removeEventListener('ended', fire);
    cb();
  };
  const tick = () => {
    if (fired) return;
    const d = el.duration, t = el.currentTime;
    if (Number.isFinite(d) && d > 0 && d - t <= seconds + 0.02) { fire(); return; }
    raf = requestAnimationFrame(tick);
  };
  el.addEventListener('timeupdate', tick);
  el.addEventListener('ended', fire);
  raf = requestAnimationFrame(tick);
  return () => {
    fired = true;
    cancelAnimationFrame(raf);
    el.removeEventListener('timeupdate', tick);
    el.removeEventListener('ended', fire);
  };
}

// --- Single spot (with optional stinger on both ends) ---
let spotStinger = null, spotStingerCutPct = 50;
let spotCloseStarted = false;
let cancelSpotLead = null;

function cancelSpotWatch() {
  if (cancelSpotLead) { cancelSpotLead(); cancelSpotLead = null; }
}

function failSpot() {
  cancelSpotWatch();
  spotCloseStarted = false;
  spotStinger = null;
  stingerV.ontimeupdate = null; stingerV.onended = null;
  clearVideo(stingerV); stingerV.style.display = 'none'; stingerV.style.opacity = '';
  clearVideo(spotVideo); spotVideo.style.display = 'none';
  spotWrap.style.display = 'none';
  spotWrap.style.background = '#000';
  if (!scenarioActive) suppressScore(false);
  socket.emit('spot:ended', overlayAck());
}

function startSpotClosing() {
  if (spotCloseStarted) return;
  spotCloseStarted = true;
  cancelSpotWatch();
  if (!spotStinger) {
    spotWrap.style.display = 'none';
    clearVideo(spotVideo);
    if (!scenarioActive) suppressScore(false);
    socket.emit('spot:ended', overlayAck());
    return;
  }
  const s = spotStinger, cp = spotStingerCutPct;
  spotStinger = null;
  // Clip keeps playing under the wipe-in; hide it only at the cut.
  playStinger(s, cp,
    () => {
      spotVideo.style.display = 'none';
      clearVideo(spotVideo);
      spotWrap.style.background = 'transparent';
    },
    () => {
      spotWrap.style.display = 'none';
      spotWrap.style.background = '#000';
      if (!scenarioActive) suppressScore(false);
      socket.emit('spot:ended', overlayAck());
    }
  );
}

function armSpotClose() {
  cancelSpotWatch();
  if (!spotStinger || spotCloseStarted) return;
  const filename = spotStinger;
  getStingerDuration(filename).then(lead => {
    if (spotStinger !== filename || spotCloseStarted) return;
    cancelSpotLead = onRemaining(spotVideo, lead, startSpotClosing);
  });
}

socket.on('spot:play', async ({ hallId: targetHall, filename, transparent, stinger, cutPct }) => {
  if (+targetHall !== hallId) return;
  cancelSpotWatch();
  spotCloseStarted = false;
  spotStinger = stinger || null;
  spotStingerCutPct = cutPct || 50;
  if (stinger) getStingerDuration(stinger);
  await hideScoreThenWait();
  // Opening stinger must sit over a fully clear wrap — any visible sibling
  // (spot-video has CSS background #000) would show through the alpha instead
  // of the camera. The actual clip goes opaque at the cut so OBS paints it.
  spotVideo.style.display = 'none';
  adLayer.style.display = 'none';
  spotWrap.style.background = (stinger || transparent || scenarioActive) ? 'transparent' : '#000';
  spotWrap.style.display = 'block';
  await new Promise(r => requestAnimationFrame(r));
  if (stinger) {
    playStinger(stinger, cutPct,
      () => {
        spotWrap.style.background = '#000';
        spotVideo.style.display = 'block';
        playWhenReady(spotVideo, mediaUrl(filename)).then(ok => {
          if (!ok) failSpot();
          else armSpotClose();
        });
      },
      () => {}
    );
  } else {
    spotWrap.style.background = '#000';
    spotVideo.style.display = 'block';
    const ok = await playWhenReady(spotVideo, mediaUrl(filename));
    if (!ok) failSpot();
    else armSpotClose();
  }
});
socket.on('spot:stop', ({ hallId: targetHall }) => {
  if (+targetHall !== hallId) return;
  cancelSpotWatch();
  spotCloseStarted = false;
  spotStinger = null;
  stingerV.ontimeupdate = null; stingerV.onended = null;
  clearVideo(stingerV); stingerV.style.display = 'none'; stingerV.style.opacity = '';
  clearVideo(spotVideo); spotVideo.style.display = 'none';
  spotWrap.style.display = 'none';
  suppressScore(false);
});
spotVideo.addEventListener('ended', () => {
  if (spotCloseStarted) return;
  startSpotClosing();
});

// --- Ad break (stinger transition + weighted ads, orchestrated client-side) ---
let adBreakActive = false;
let scenarioActive = false; // true while a scenario is playing — blocks per-step score restores
const stage = document.getElementById('stage');

socket.on('adbreak:play', ({ hallId: targetHall, stinger, ads, cutPct }) => {
  if (+targetHall !== hallId) return;
  runAdBreak(stinger, ads || [], cutPct || 50);
});
socket.on('adbreak:stop', ({ hallId: targetHall }) => {
  if (+targetHall !== hallId) return;
  endAdBreak();
});

// Play the stinger on top; fire onCut when it reaches its full-cover point
// (cutPct % of its duration) so the underlying source can switch hidden behind
// it, then onEnd once the stinger has wiped away.
let stingerEndTimer = 0;
function playStinger(filename, cutPct, onCut, onEnd) {
  let cutFired = false, endFired = false;
  clearTimeout(stingerEndTimer);
  const frac = Math.min(0.95, Math.max(0.05, (cutPct || 50) / 100));
  const fireCut = () => { if (!cutFired) { cutFired = true; onCut && onCut(); } };
  const fireEnd = () => {
    if (endFired) return;
    endFired = true;
    clearTimeout(stingerEndTimer);
    fireCut(); // safety, in case timeupdate missed it
    stingerV.ontimeupdate = null; stingerV.onended = null;
    stingerV.removeEventListener('loadeddata', skipOpaqueLeadIn);
    stingerV.style.display = 'none';
    stingerV.style.opacity = '';
    clearVideo(stingerV);
    onEnd && onEnd();
  };
  // libvpx-vp9 often encodes the first keyframe fully opaque (alpha≈255) even
  // when the rest of the clip is correct. Skip ~2 frames so the camera isn't
  // covered by a solid flash before the wipe-in.
  const skipOpaqueLeadIn = () => {
    try { if (stingerV.currentTime < 0.05) stingerV.currentTime = 0.05; } catch {}
  };
  stingerV.ontimeupdate = () => {
    if (stingerV.duration && stingerV.currentTime >= stingerV.duration * frac) fireCut();
  };
  stingerV.onended = fireEnd;
  stingerV.muted = true;
  stingerV.style.opacity = '0';
  stingerV.style.display = 'block';
  stingerV.addEventListener('loadeddata', skipOpaqueLeadIn, { once: true });
  playWhenReady(stingerV, mediaUrl(filename), { muted: true }).then(ok => {
    if (!ok) { fireEnd(); return; }
    if (Number.isFinite(stingerV.duration) && stingerV.duration > 0) {
      stingerDurCache.set(filename, stingerV.duration);
    }
    stingerV.style.opacity = '1';
    const wait = (Number.isFinite(stingerV.duration) ? stingerV.duration * frac * 1000 : 2000) + 150;
    setTimeout(fireCut, wait);
    // OBS CEF sometimes never fires `ended`; without this, closing stinger
    // never reports spot:ended and the réžia Stop button stays on.
    const endWait = (Number.isFinite(stingerV.duration) ? stingerV.duration * 1000 : 4000) + 400;
    stingerEndTimer = setTimeout(fireEnd, endWait);
  });
}

// Play ads back-to-back with no gap using two preloaded video elements.
// Resolves `leadSeconds` before the last ad ends so the closing stinger can
// overlap the still-playing clip; falls back to `ended` if the lead is 0.
function playAdsSeamless(ads, leadSeconds = 0) {
  const leadP = Promise.resolve(leadSeconds);
  return new Promise(resolve => {
    let idx = 0, cur = adA, nxt = adB;
    let settled = false;
    let unwatch = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (unwatch) { unwatch(); unwatch = null; }
      resolve();
    };
    const watchLead = el => {
      leadP.then(lead => {
        if (!(lead > 0) || settled) return;
        unwatch = onRemaining(el, lead, finish);
      });
    };
    const advance = () => {
      if (settled) return;
      idx++;
      if (idx >= ads.length || !adBreakActive) { finish(); return; }
      [cur, nxt] = [nxt, cur];
      cur.style.display = 'block'; nxt.style.display = 'none';
      playWhenReady(cur, mediaUrl(ads[idx].filename)).then(ok => {
        if (!ok) { finish(); return; }
        if (!ads[idx + 1]) watchLead(cur);
      });
      if (ads[idx + 1]) nxt.src = mediaUrl(ads[idx + 1].filename);
    };
    adA.onended = advance; adB.onended = advance;
    cur.style.display = 'block'; nxt.style.display = 'none';
    if (ads[1]) nxt.src = mediaUrl(ads[1].filename);
    playWhenReady(cur, mediaUrl(ads[0].filename)).then(ok => {
      if (!ok) { finish(); return; }
      if (!ads[1]) watchLead(cur);
    });
  });
}

async function runAdBreak(stinger, ads, cutPct) {
  if (!ads.length || adBreakActive) return;
  adBreakActive = true;
  const leadP = stinger ? getStingerDuration(stinger) : Promise.resolve(0);
  await hideScoreThenWait();                    // animate score out first, then start the break
  if (!adBreakActive) return;                   // stopped during the wait
  if (stage) stage.style.display = 'none';     // hide scoreboard + branding during the break
  spotVideo.style.display = 'none';
  adLayer.style.display = 'none';
  spotWrap.style.background = 'transparent';
  spotWrap.style.display = 'block';

  let adsDone;
  const adsDonePromise = new Promise(r => (adsDone = r));

  // OPENING: stinger over camera; at cut, opaque ads so OBS actually paints them
  if (stinger) {
    await new Promise(res => playStinger(stinger, cutPct,
      () => {
        spotWrap.style.background = '#000';
        adLayer.style.display = 'block';
        playAdsSeamless(ads, leadP).then(adsDone);
      },
      res));
  } else {
    spotWrap.style.background = '#000';
    adLayer.style.display = 'block';
    playAdsSeamless(ads, leadP).then(adsDone);
  }

  await adsDonePromise;                         // last ad is within stinger-length of ending
  if (!adBreakActive) return;

  // CLOSING: stinger over the still-playing last ad; at cut, hide ads so
  // remaining alpha reveals the camera.
  if (stinger) {
    await new Promise(res => playStinger(stinger, cutPct,
      () => {
        adLayer.style.display = 'none';
        spotWrap.style.background = 'transparent';
      },
      res));
  }
  endAdBreak();
}

function endAdBreak({ silent = false } = {}) {
  adBreakActive = false;
  for (const v of [adA, adB, stingerV]) { v.onended = null; v.ontimeupdate = null; clearVideo(v); v.style.display = 'none'; }
  adA.style.display = 'block'; // reset default buffer visibility for next break
  adB.style.display = 'none';
  adLayer.style.display = 'none';
  spotWrap.style.display = 'none';
  spotWrap.style.background = '#000';
  if (!scenarioActive) {
    if (stage) stage.style.display = '';
    suppressScore(false);
    draw();
  }
  if (!silent) socket.emit('adbreak:ended', overlayAck());
}

async function load() {
  match = await api.get(`/api/halls/${hallId}/live`);
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

// Odometer-style digit animation: only characters that changed roll in.
// dur ~700ms for score (slow, noticeable), ~160ms for the clock (subtle,
// finished well within the second).
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
  const name = match[`${side}_name`] || match[`${side}_placeholder`] || '???';
  // team colours drive CSS vars so the plates keep their glossy gradient
  const bug = $('bug');
  bug.style.setProperty(`--${side}`, match[`${side}_color_bg`] || '#1d3fb8');
  bug.style.setProperty(`--${side}-text`, match[`${side}_color_text`] || '#ffffff');
  $(`${prefix}Name`).textContent = name;
  setTeamLogo($(`${prefix}Logo`), match[`${side}_logo`], match[`${side}_team_id`]);
}

// ===== penalty chips: keyed by event id so countdowns update in place and
// chips animate in (rise from the bug) and out (sink) =====
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
        [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(16px)' }],
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
        [{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'translateY(0)' }],
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
  $(`${prefix}Todots`).innerHTML = Array.from({ length: max }, (_, i) => `<span class="d ${i < used ? 'used' : ''}"></span>`).join('');
}

// staged show/hide: phase 1 the clock rises from below, phase 2 the team+score
// wings unfold out to the sides (reverse order on hide)
let bugVisible = false;
// Temporarily hide the scoreboard during full-screen actions (ad break, spots,
// lineups). Restoring respects overlayHidden, so it only comes back if it was on.
let scoreSuppressed = false;
function suppressScore(on) {
  if (!on && scenarioActive) return; // scenario keeps score/logos hidden until scenario:end
  scoreSuppressed = on;
  applyVisibility();
  // Sponsor logos in the corners are independent of the score bug — fade them
  // out/in alongside it so nothing lingers over a full-screen action.
  for (const c of ['tl', 'tr', 'bl', 'br']) {
    const el = $('brand-' + c);
    if (!el) continue;
    el.style.transition = 'opacity 320ms ease';
    el.style.opacity = on ? '0' : '1';
  }
}
// Hide the score and resolve once its out-animation has finished (~640ms,
// see applyVisibility hide branch), so the action shows on a clean screen.
// If the score was already off, resolves immediately.
function hideScoreThenWait() {
  const wasVisible = bugVisible;
  suppressScore(true);
  return new Promise(res => wasVisible ? setTimeout(res, 660) : res());
}
function applyVisibility() {
  const show = !!match && !overlayHidden && !scoreSuppressed;
  if (show === bugVisible) return;
  bugVisible = show;
  $('bugWrap').style.opacity = 1;
  const clock = $('clock'), wh = document.querySelector('.wing.home'), wa = document.querySelector('.wing.away');
  const ease = 'cubic-bezier(.2,.8,.2,1)';
  if (show) {
    clock.animate([{ opacity: 0, transform: 'translateY(72px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 460, easing: ease, fill: 'both' });
    for (const w of [wh, wa]) w.animate(
      [{ opacity: 0, transform: 'scaleX(0)' }, { opacity: 1, transform: 'scaleX(1)' }],
      { duration: 480, delay: 360, easing: ease, fill: 'both' });
  } else {
    for (const w of [wh, wa]) w.animate(
      [{ opacity: 1, transform: 'scaleX(1)' }, { opacity: 0, transform: 'scaleX(0)' }],
      { duration: 320, easing: 'ease-in', fill: 'both' });
    clock.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(72px)' }],
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

// TIMEOUT / card announcement, centred above the score with the team name.
// Cards linger a few seconds; the timeout stays up for the whole minute.
const CARD_MS = 6000;
const TIMEOUT_MS = 60000;
function teamShort(side) { return match ? (match[`${side}_short`] || match[`${side}_name`] || '') : ''; }
function flashIn(node) {
  node?.animate([{ opacity: 0, transform: 'translateY(10px) scale(.9)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }],
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

// ===== ticker engine =====
// Each message scrolls TICKER_LOOPS times, then auto-hides itself (PUT active=0).
// Adding/removing a message never restarts the in-progress pass: the change is
// applied at the next pass boundary. New messages lead (prepended). Only the
// Only the authoritative overlay instance (OBS browser source with ?driver=1)
// writes ticker auto-hide back to the server, so preview tabs can't cut short.
const TICKER_LOOPS = 3;
const SLIDE_MS = 450;
const SPEED = +qs.get('speed') || 220; // px/s (?speed= override for testing)

let desiredActive = [];          // [{id,text}] active alerts known from server
let queue = [];                  // [{id,text,remaining}] in display order
const exhausted = new Set();     // ids this instance already ran out (avoid re-adding)
let tickerRunning = false;
let tickerInit = false;
let curScroll = null;

async function loadAlerts() {
  desiredActive = await api.get('/api/alerts'); // active only, newest first
  // on first load, treat messages already active as "seen" so the overlay only
  // animates NEW messages, not ones that were already running when it opened
  if (!tickerInit) { tickerInit = true; for (const a of desiredActive) exhausted.add(a.id); }
  // forget exhausted ids once the server no longer lists them (so a manual
  // re-activation later shows the message again from scratch)
  const activeIds = new Set(desiredActive.map(a => a.id));
  for (const id of [...exhausted]) if (!activeIds.has(id)) exhausted.delete(id);
  if (!tickerRunning) runTicker();
}

function reconcileQueue() {
  const active = new Map(desiredActive.map(a => [a.id, a]));
  // drop items the user hid/deleted, refresh edited text/level
  queue = queue.filter(q => active.has(q.id));
  for (const q of queue) { const a = active.get(q.id); q.text = a.text; q.level = a.level; }
  // prepend newly-activated messages (newest first), skipping already-exhausted
  const inQueue = new Set(queue.map(q => q.id));
  const fresh = desiredActive
    .filter(a => !inQueue.has(a.id) && !exhausted.has(a.id))
    .map(a => ({ id: a.id, text: a.text, level: a.level, remaining: TICKER_LOOPS }));
  queue = [...fresh, ...queue];
}

async function runTicker() {
  if (tickerRunning) return;
  tickerRunning = true;
  reconcileQueue();
  if (!queue.length) { tickerRunning = false; return; }
  await slideTicker(true);
  while (true) {
    reconcileQueue();
    const items = queue.filter(q => q.remaining > 0);
    if (!items.length) break;
    await scrollOnce(items);
    for (const it of items) {
      if (--it.remaining <= 0) {
        exhausted.add(it.id);
        if (isDriver) api.post(`/api/halls/${hallId}/alerts/${it.id}/dismiss`, {}).catch(() => {});
      }
    }
    queue = queue.filter(q => q.remaining > 0);
  }
  await slideTicker(false);
  tickerRunning = false;
  if (desiredActive.some(a => !exhausted.has(a.id))) runTicker(); // arrived during slide-down
}

function slideTicker(up) {
  return new Promise(resolve => {
    const ticker = $('ticker');
    if (up) ticker.style.display = 'block';
    const frames = up ? [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }]
                      : [{ transform: 'translateY(0)' }, { transform: 'translateY(100%)' }];
    ticker.animate(frames, { duration: SLIDE_MS, easing: up ? 'cubic-bezier(.2,.8,.2,1)' : 'ease-in', fill: 'forwards' })
      .onfinish = () => { if (!up) ticker.style.display = 'none'; resolve(); };
  });
}

// one left-to-right pass; resolves when the text has fully cleared the left edge.
// items: [{text, level}] rendered as per-level coloured segments
const TK_ICON = { warning: '⚠ ', important: '‼ ' };
function scrollOnce(items) {
  return new Promise(resolve => {
    const text = $('tickerText');
    if (window.__ticker) window.__ticker.push({ t: Date.now(), text: items.map(i => i.text).join(' ••• ') });
    text.innerHTML = items.map(i =>
      `<span class="tk tk-${i.level || 'info'}">${TK_ICON[i.level] || ''}${esc(i.text)}</span>`
    ).join('<span class="tk-sep">•••</span>');
    void text.offsetWidth; // force layout before measuring
    const w = text.offsetWidth;                       // unscaled layout px
    const dist = ($('ticker').offsetWidth || 1920) + w + 40;
    curScroll = text.animate(
      [{ transform: 'translateX(0)' }, { transform: `translateX(${-dist}px)` }],
      { duration: dist / SPEED * 1000, easing: 'linear' });
    curScroll.onfinish = resolve;
  });
}

// ===== persistent logos (tournament / sponsors), always on, per corner =====
// Multiple active logos in the same corner rotate; independent of the scoreboard.
let branding = [];
let brandTick = 0;
async function loadBranding() {
  branding = (await api.get('/api/branding')).filter(b => b.active);
  renderBranding();
}
function brandMarkup(it) {
  const hpx = Math.round((it.size_pct || 10) / 100 * 1080);
  const src = `/media-files/${esc(it.filename)}`;
  return it.type === 'video'
    ? `<video src="${src}" autoplay muted loop playsinline style="height:${hpx}px"></video>`
    : `<img src="${src}" style="height:${hpx}px">`;
}
// Animated "pop" from the centre: grow from tiny → 110% → settle at 100% on
// show, and the reverse (100% → 110% → tiny, fading out) on hide.
const BRAND_DUR = 480;
const BRAND_IN = [
  { transform: 'scale(.1)', opacity: 0, offset: 0 },
  { transform: 'scale(1.1)', opacity: 1, offset: .7 },
  { transform: 'scale(1)', opacity: 1, offset: 1 }
];
const BRAND_OUT = [
  { transform: 'scale(1)', opacity: 1, offset: 0 },
  { transform: 'scale(1.1)', opacity: 1, offset: .3 },
  { transform: 'scale(.1)', opacity: 0, offset: 1 }
];
function brandShow(el, it) {
  el.innerHTML = brandMarkup(it);
  const c = el.firstElementChild;
  c.style.transformOrigin = 'center center';
  c.animate(BRAND_IN, { duration: BRAND_DUR, easing: 'cubic-bezier(.2,.7,.3,1)' });
}
function brandHide(el, after) {
  const c = el.firstElementChild;
  if (!c) { el.innerHTML = ''; after && after(); return; }
  c.style.transformOrigin = 'center center';
  c.animate(BRAND_OUT, { duration: BRAND_DUR, easing: 'cubic-bezier(.6,0,.8,.3)' })
    .onfinish = () => { el.innerHTML = ''; after && after(); };
}
function renderBranding() {
  const byCorner = { tl: [], tr: [], bl: [], br: [] };
  for (const b of branding) (byCorner[b.corner] || byCorner.tl).push(b);
  for (const c of ['tl', 'tr', 'bl', 'br']) {
    const el = $('brand-' + c), items = byCorner[c];
    const it = items.length ? items[items.length > 1 ? brandTick % items.length : 0] : null;
    const key = it ? it.id + ':' + it.size_pct : '';
    if (el._key === key) continue;       // no change for this corner
    el._key = key;
    // pop the old logo out (if any), then pop the new one in (if any)
    brandHide(el, () => { if (it) brandShow(el, it); });
  }
}
// ===== upcoming matches panel =====
socket.on('upcoming:show', d => { if (+d.hallId === hallId) showUpcoming(d.matches); });
socket.on('upcoming:hide', d => { if (+d.hallId === hallId) hideUpcoming(); });

const ROUND_LABELS = { OF: 'Osmifinále', QF: 'Čtvrtfinále', SF: 'Semifinále', F: 'Finále', '3rd': 'O 3. místo' };

function stageLabel(m) {
  if (m.stage === 'playoff') return ROUND_LABELS[m.round] || m.round || 'Playoff';
  return m.group_name ? 'Skupina ' + m.group_name : 'Základní skupina';
}

function fmtScheduled(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
}

function upTeam(m, side) {
  const name = m[`${side}_name`] || m[`${side}_placeholder`] || '???';
  const logo = m[`${side}_logo`];
  const color = m[`${side}_color_bg`] || '#1d3fb8';
  const logoEl = logo
    ? `<img class="up-team-logo" src="/media-files/${esc(logo)}">`
    : `<div class="up-team-logo-empty"></div>`;
  return `<div class="up-team">${logoEl}<span class="up-team-name">${esc(name)}</span></div>
    <div class="up-team-stripe" style="background:${esc(color)}"></div>`;
}

function buildUpCard(m) {
  const card = document.createElement('div');
  card.className = 'up-card';
  card.innerHTML = `
    <div class="up-card-top">
      <span class="up-stage">${esc(stageLabel(m))}</span>
      <span class="up-time">${esc(fmtScheduled(m.scheduled_at))}</span>
    </div>
    <div class="up-teams">
      ${upTeam(m, 'home')}
      <div class="up-vs"><div class="up-vs-line"></div><div class="up-vs-text">vs</div><div class="up-vs-line"></div></div>
      ${upTeam(m, 'away')}
    </div>`;
  return card;
}

async function showUpcoming(matches) {
  if (scenarioActive) { spotWrap.style.display = 'none'; if (stage) stage.style.display = ''; }
  await hideScoreThenWait();
  const el = $('upcoming');
  $('up-hall').textContent = matches[0]?.hall_name || '';
  const cards = $('up-cards');
  cards.innerHTML = '';
  matches.forEach(m => cards.appendChild(buildUpCard(m)));
  el.classList.add('on');
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, easing: 'ease-out', fill: 'both' });
  [...cards.children].forEach((c, i) =>
    c.animate(
      [{ opacity: 0, transform: 'translateY(32px) scale(.96)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }],
      { duration: 440, delay: 160 + i * 100, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' }
    )
  );
}

function hideUpcoming() {
  const el = $('upcoming');
  if (!el.classList.contains('on')) { if (!scenarioActive) suppressScore(false); return; }
  el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, easing: 'ease-in', fill: 'both' })
    .onfinish = () => el.classList.remove('on');
  if (!scenarioActive) suppressScore(false);
}

// ===== pre-match lineups: full-screen split panel triggered from réžia =====
socket.on('lineups:show', d => { if (+d.hallId === hallId) showLineups(d); });
socket.on('lineups:hide', d => { if (+d.hallId === hallId) hideLineups(); });

function fillLineupSide(side, t) {
  const root = $(`lu${side}List`).parentElement; // .lu-team
  root.style.setProperty('--lu-bg', t.color_bg || '#15171b');
  root.style.setProperty('--lu-text', t.color_text || '#fff');
  root.style.setProperty('--lu-accent', t.color_text || '#ffd24d');
  $(`lu${side}Name`).textContent = t.name || '';
  setTeamLogo($(`lu${side}Logo`), t.logo, t.id);
  const list = $(`lu${side}List`);
  list.innerHTML = (t.players || []).slice(0, 14).map(p =>
    `<div class="lu-row"><span class="lu-num">${p.number ?? '–'}</span>` +
    `<span class="lu-pname">${esc(p.name)}</span>` +
    `${p.position ? `<span class="lu-pos">${esc(p.position)}</span>` : ''}</div>`
  ).join('') || '<div class="lu-row"><span class="lu-pname">—</span></div>';
}

async function showLineups(d) {
  if (scenarioActive) { spotWrap.style.display = 'none'; if (stage) stage.style.display = ''; }
  await hideScoreThenWait();
  fillLineupSide('Home', d.home);
  fillLineupSide('Away', d.away);
  const el = $('lineups');
  el.classList.add('on');
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, easing: 'ease-out', fill: 'both' });
  // stagger the rows of each side rising in
  const rows = el.querySelectorAll('.lu-row');
  rows.forEach((r, i) => r.animate(
    [{ opacity: 0, transform: 'translateY(22px)' }, { opacity: 1, transform: 'translateY(0)' }],
    { duration: 420, delay: 250 + i * 55, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' }));
}

function hideLineups() {
  const el = $('lineups');
  if (!el.classList.contains('on')) { if (!scenarioActive) suppressScore(false); return; }
  el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, easing: 'ease-in', fill: 'both' })
    .onfinish = () => el.classList.remove('on');
  if (!scenarioActive) suppressScore(false);
}

// --- Scenario orchestration (server-driven multi-step sequences) ---
socket.on('scenario:begin', ({ hallId: targetHall, stinger, cutPct }) => {
  if (+targetHall !== hallId) return;
  scenarioActive = true;
  suppressScore(true);
  if (stage) stage.style.display = 'none';
  if (stinger) {
    // stingerV lives inside spotWrap — must make spotWrap visible, else Chromium
    // throttles/blocks video playback in display:none containers and ended never fires
    spotVideo.style.display = 'none';
    adLayer.style.display = 'none';
    spotWrap.style.background = 'transparent';
    spotWrap.style.display = 'block';
    playStinger(stinger, cutPct,
      () => { socket.emit('scenario:ready', overlayAck()); },
      () => {}
    );
  } else {
    socket.emit('scenario:ready', overlayAck());
  }
});

socket.on('scenario:end', ({ hallId: targetHall, stinger, cutPct }) => {
  if (+targetHall !== hallId) return;
  scenarioActive = false;
  if (stinger) {
    spotVideo.style.display = 'none';
    adLayer.style.display = 'none';
    spotWrap.style.background = 'transparent';
    spotWrap.style.display = 'block';
    playStinger(stinger, cutPct,
      () => { suppressScore(false); if (stage) stage.style.display = ''; draw(); },
      () => { spotWrap.style.display = 'none'; spotWrap.style.background = '#000'; socket.emit('scenario:closed', overlayAck()); }
    );
  } else {
    suppressScore(false);
    if (stage) stage.style.display = '';
    draw();
    socket.emit('scenario:closed', overlayAck());
  }
});

socket.on('scenario:abort', ({ hallId: targetHall }) => {
  if (+targetHall !== hallId) return;
  scenarioActive = false;
  if (adBreakActive) endAdBreak({ silent: true });
  cancelSpotWatch();
  spotCloseStarted = false;
  spotStinger = null;
  stingerV.ontimeupdate = null; stingerV.onended = null;
  clearVideo(stingerV); stingerV.style.display = 'none'; stingerV.style.opacity = '';
  clearVideo(spotVideo); spotVideo.style.display = 'none';
  spotWrap.style.display = 'none'; spotWrap.style.background = '#000';
  suppressScore(false);
  if (stage) stage.style.display = '';
  draw();
});

setInterval(() => { brandTick++; renderBranding(); }, 8000); // rotate sponsors

setInterval(() => { if (match) paintClock(); }, 250);
setInterval(async () => { await refreshSusp(); if (match) renderSusp(); }, 1000);

load();
loadAlerts();
loadBranding();
loadHornConfig();
