// Hall control panel: timer, score, events, settings and overlay control
import { api, fmtTime, fmtDateTime, teamLabel, esc, qs, clockSnap, clockMs } from '/assets/common.js';

// Auth check: redirect to login if not logged in or not assigned to this hall
const { user: me } = await api.get('/api/auth/me');
if (!me) {
  location.href = '/login/?next=' + encodeURIComponent(location.pathname + location.search);
  throw new Error('redirect');
}

const myHalls = (me.halls || []).map(Number).filter(Number.isFinite);
const requested = qs.get('hall');
let hallId = requested ? +requested : NaN;

// Hall role: open the assigned hall when URL has no ?hall=, otherwise check access
if (me.role === 'hall') {
  if (!myHalls.length) {
    document.body.innerHTML = `<div style="text-align:center;margin-top:20vh">
      <p style="color:var(--red);font-size:18px">Nemáš přiřazenou žádnou halu.</p>
      <a href="/login/">Přihlásit se jiným účtem</a>
    </div>`;
    throw new Error('no access');
  }
  if (!requested) {
    location.replace('/hall/?hall=' + myHalls[0]);
    throw new Error('redirect');
  }
  if (!myHalls.includes(hallId)) {
    const halls = await api.get('/api/halls').catch(() => []);
    const links = myHalls.map(id => {
      const name = halls.find(h => h.id === id)?.name ?? id;
      return `<a href="/hall/?hall=${id}">${esc(String(name))}</a>`;
    }).join(' · ');
    document.body.innerHTML = `<div style="text-align:center;margin-top:20vh">
      <p style="color:var(--red);font-size:18px">Nemáš přístup k této hale.</p>
      <p>${links}</p>
      <a href="/login/">Přihlásit se jiným účtem</a>
    </div>`;
    throw new Error('no access');
  }
} else {
  hallId = requested ? +requested : 1;
}
const app = document.getElementById('app');
let match = null;
let snap = null;
let rosters = { home: [], away: [] };
let overlayVisible = true;

// configurable keyboard shortcuts (stored per browser)
const DEFAULT_KEYS = {
  startStop: ' ', minus1: 'ArrowLeft', plus1: 'ArrowRight', minus10: 'ArrowDown', plus10: 'ArrowUp',
  homeGoal: 'a', awayGoal: 'l'
};
let keymap = loadKeymap();
function loadKeymap() { try { return { ...DEFAULT_KEYS, ...JSON.parse(localStorage.getItem('mmx_keymap') || '{}') }; } catch { return { ...DEFAULT_KEYS }; } }
function saveKeymap() { localStorage.setItem('mmx_keymap', JSON.stringify(keymap)); }

const socket = io();
socket.on(`hall:${hallId}:match`, m => { match = m; snap = clockSnap(m); render(); });
socket.on('schedule:update', () => { if (!match || match.status !== 'live') load(); });

// --- Tournament system sync (read-only reference) ---
let tournamentMatch = null;
let tournamentClockTimer = null;

socket.on(`hall:${hallId}:tournament`, data => {
  tournamentMatch = data;
  renderTournament();
});

function tournamentClockMs(t) {
  if (!t || t.status !== 'live') return null;
  let ms = (t.clock_elapsed_seconds || 0) * 1000;
  if (t.clock_started_at && !t.clock_paused_at)
    ms += Date.now() - new Date(t.clock_started_at).getTime();
  return ms;
}

function renderTournament() {
  const el = document.getElementById('tournamentPanel');
  if (!el) return;
  clearInterval(tournamentClockTimer);
  const t = tournamentMatch;
  if (!t) { el.style.display = 'none'; return; }
  el.style.display = '';

  function draw() {
    const ms = tournamentClockMs(t);
    const s = ms !== null ? Math.floor(ms / 1000) : null;
    const clockStr = s !== null ? `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}` : '--:--';
    const periodStr = t.current_period ? (t.current_period <= 2 ? `${t.current_period}. poločas` : `Prodl. ${t.current_period - 2}`) : '';
    const statusColor = t.status === 'live' ? 'var(--green)' : t.status === 'finished' ? 'var(--red)' : 'var(--muted)';
    el.innerHTML = `
      <h3 style="margin-top:0;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">
        Turnajový systém
        <span style="color:${statusColor};margin-left:6px;font-size:11px">${t.status === 'live' ? '● LIVE' : t.status === 'finished' ? 'HOTOVO' : t.status}</span>
      </h3>
      <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center;text-align:center">
        <div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:2px">${esc(t.home_name)}</div>
          <div style="font-size:28px;font-weight:700;color:${diffColor(t.home_score, match?.home_score)}">${t.home_score ?? '—'}</div>
        </div>
        <div>
          <div style="font-size:22px;font-weight:300;color:var(--muted)">:</div>
          <div style="font-size:12px;margin-top:4px;color:var(--muted)">${clockStr}</div>
          <div style="font-size:11px;color:var(--muted)">${periodStr}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:2px">${esc(t.away_name)}</div>
          <div style="font-size:28px;font-weight:700;color:${diffColor(t.away_score, match?.away_score)}">${t.away_score ?? '—'}</div>
        </div>
      </div>`;
  }

  draw();
  if (t.status === 'live' && t.clock_started_at && !t.clock_paused_at)
    tournamentClockTimer = setInterval(draw, 1000);
}

function diffColor(tVal, mVal) {
  if (tVal == null || mVal == null) return 'inherit';
  if (tVal !== mVal) return 'var(--red)';
  return 'inherit';
}

function periodLabel(p) { return p <= 2 ? `${p}. poločas` : `Prodloužení ${p - 2}`; }
function act(url, body) {
  return api.post(url, body).catch(e => {
    alert('Akce selhala: ' + (e.message || e));
    throw e;
  });
}
function elapsed(m = match) {
  return clockMs(m, m === match ? snap : clockSnap(m));
}

async function load() {
  const [liveMatch, halls, tState] = await Promise.all([
    api.get(`/api/halls/${hallId}/live`),
    api.get('/api/halls'),
    api.get(`/api/halls/${hallId}/tournament`).catch(() => null),
  ]);
  match = liveMatch;
  snap = clockSnap(match);
  overlayVisible = (halls.find(h => h.id === hallId)?.overlay_visible ?? 1) === 1;
  tournamentMatch = tState;
  render();
}

async function loadRosters() {
  rosters.home = match?.home_team_id ? await api.get(`/api/teams/${match.home_team_id}/players`) : [];
  rosters.away = match?.away_team_id ? await api.get(`/api/teams/${match.away_team_id}/players`) : [];
}

async function render() {
  if (!match) return renderPicker();
  await loadRosters();
  const m = match;
  const dots = side => {
    const used = m[`${side}_timeouts`] || 0, max = m.timeouts_allowed || 0;
    return Array.from({ length: max }, (_, i) => `<span class="to-dot ${i < used ? 'used' : ''}"></span>`).join('');
  };
  app.innerHTML = `
    <div class="row" style="justify-content:space-between;margin:6px 0">
      <h2 style="margin:0">${esc(m.hall_name || 'Hala ' + hallId)} <span class="badge live">ŽIVĚ</span></h2>
      <div class="row">
        <button id="btnOverlay" class="${overlayVisible ? 'success' : ''}" title="Skryje overlay ve streamu i světelný panel">${overlayVisible ? '👁 Overlay ZAP' : '🚫 Overlay VYP'}</button>
        <button id="btnLed">💡 Světelný panel</button>
        <button id="btnConfig">⚙ Nastavení</button>
        <button id="btnKeys">⌨ Zkratky</button>
        <a href="/setup/${hallId}" target="_blank" style="display:inline-flex;align-items:center"><button>📥 Agent</button></a>
      </div>
    </div>
    <div class="panel scoreboard">
      <div>
        <div class="teamname">${esc(teamLabel(m, 'home'))}</div>
        <div class="score" id="hs">${m.home_score}</div>
        <div class="to-dots">${dots('home')}</div>
      </div>
      <div>
        <div class="timer" id="timer">${fmtTime(elapsed(m))}</div>
        <div class="muted" id="perLabel">${periodLabel(m.period)} · cíl ${fmtTime(m.period_target_ms)}</div>
      </div>
      <div>
        <div class="teamname">${esc(teamLabel(m, 'away'))}</div>
        <div class="score" id="as">${m.away_score}</div>
        <div class="to-dots">${dots('away')}</div>
      </div>
    </div>
    <div class="cols">
      <button class="bigbtn ${m.timer_running ? 'danger' : 'success'}" id="btnTimer">
        ${m.timer_running ? '⏸ STOP ČAS' : '▶ START ČAS'}</button>
      <div class="grid" style="gap:6px">
        <div class="row" style="justify-content:center">
          <button data-adj="-10000">−10s</button>
          <button data-adj="-1000">−1s</button>
          <button data-adj="1000">+1s</button>
          <button data-adj="10000">+10s</button>
        </div>
        <div class="row" style="justify-content:center">
          <button id="btnPrevPer">◀ poločas</button>
          <button id="btnNextPer">poločas ▶</button>
          <button id="btnOvertime" class="warn">+ Prodloužení</button>
        </div>
      </div>
    </div>
    <div class="cols">
      ${['home', 'away'].map(side => `
      <div class="panel grid" style="gap:8px">
        <div class="muted" style="text-align:center">${esc(teamLabel(m, side))}</div>
        <button class="bigbtn primary" data-goal="${side}">+1 GÓL <small style="opacity:.7">[${esc(keyName(keymap[side + 'Goal']))}]</small></button>
        <button data-ungoal="${side}">−1 (oprava)</button>
        <button class="evbtn" data-ev="penalty2" data-side="${side}">${Math.round((m.suspension_ms||120000)/1000)}s vyloučení</button>
        <div class="row">
          <button class="evbtn warn" style="flex:1" data-ev="yellow" data-side="${side}">ŽK</button>
          <button class="evbtn danger" style="flex:1" data-ev="red" data-side="${side}">ČK</button>
          <button class="evbtn" style="flex:1;background:#2f6fdb;border-color:#2f6fdb" data-ev="blue" data-side="${side}">Modrá</button>
        </div>
        <div class="row">
          <button class="evbtn" style="flex:1" data-timeout="${side}" ${(m[`${side}_timeouts`]||0) >= (m.timeouts_allowed||0) ? 'disabled' : ''}>Timeout (${m[`${side}_timeouts`]||0}/${m.timeouts_allowed||0})</button>
          <button data-timeout-undo="${side}" title="Vrátit timeout">↶</button>
        </div>
      </div>`).join('')}
    </div>
    <div class="panel">
      <h3 style="margin-top:0">Aktivní vyloučení</h3>
      <div id="susp" class="muted">…</div>
    </div>
    <div class="panel">
      <h3 style="margin-top:0">Události</h3>
      <div id="events" class="muted">…</div>
    </div>
    <button class="bigbtn danger" id="btnFinish">UKONČIT ZÁPAS</button>
    <div id="tournamentPanel" class="panel" style="display:none;margin-top:8px"></div>`;

  document.getElementById('btnTimer').onclick = toggleTimer;
  document.getElementById('btnPrevPer').onclick = () => changePeriod(Math.max(1, m.period - 1));
  document.getElementById('btnNextPer').onclick = () => changePeriod(m.period + 1);
  document.getElementById('btnOvertime').onclick = () => changePeriod(Math.max(3, m.period + 1));
  document.getElementById('btnConfig').onclick = openConfig;
  document.getElementById('btnKeys').onclick = openKeys;
  document.getElementById('btnOverlay').onclick = toggleOverlay;
  document.getElementById('btnLed').onclick = openLedPanel;
  document.getElementById('btnFinish').onclick = () => {
    if (confirm('Opravdu ukončit zápas?')) act(`/api/matches/${m.id}/finish`).then(load);
  };
  app.querySelectorAll('[data-adj]').forEach(b => b.onclick = () =>
    act(`/api/matches/${m.id}/timer`, { action: 'adjust', delta: +b.dataset.adj }));
  app.querySelectorAll('[data-goal]').forEach(b => b.onclick = () =>
    pickPlayer(b.dataset.goal, 'Střelec gólu').then(p =>
      act(`/api/matches/${m.id}/score`, { side: b.dataset.goal, delta: 1, ...p })));
  app.querySelectorAll('[data-ungoal]').forEach(b => b.onclick = () =>
    act(`/api/matches/${m.id}/score`, { side: b.dataset.ungoal, delta: -1 }));
  app.querySelectorAll('[data-ev]').forEach(b => b.onclick = () =>
    pickPlayer(b.dataset.side, 'Číslo hráče').then(p =>
      act(`/api/matches/${m.id}/event`, { type: b.dataset.ev, side: b.dataset.side, ...p })));
  app.querySelectorAll('[data-timeout]').forEach(b => b.onclick = () =>
    act(`/api/matches/${m.id}/event`, { type: 'timeout', side: b.dataset.timeout }));
  app.querySelectorAll('[data-timeout-undo]').forEach(b => b.onclick = () =>
    act(`/api/matches/${m.id}/timeout-undo`, { side: b.dataset.timeoutUndo }));

  renderSusp();
  renderEvents();
  renderTournament();
}

function toggleTimer() {
  if (!match) return;
  act(`/api/matches/${match.id}/timer`, { action: match.timer_running ? 'stop' : 'start' });
}
function changePeriod(period) {
  if (!match) return;
  act(`/api/matches/${match.id}/period`, { period });
}
async function toggleOverlay() {
  overlayVisible = !overlayVisible;
  await api.post(`/api/halls/${hallId}/overlay`, { visible: overlayVisible });
  const b = document.getElementById('btnOverlay');
  if (b) { b.textContent = overlayVisible ? '👁 Overlay ZAP' : '🚫 Overlay VYP'; b.className = overlayVisible ? 'success' : ''; }
}

function openLedPanel() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(1040 / dpr), h = Math.round(208 / dpr);
  const win = window.open(
    `/panel/?hall=${hallId}`,
    'mm-led-' + hallId,
    `popup=yes,width=${w},height=${h},left=0,top=0`
  );
  if (!win) alert('Prohlížeč zablokoval vyskakovací okno — povol pop-up pro MultiMix.');
  else try { win.focus(); } catch {}
}

// ----- settings (editable live) -----
function openConfig() {
  const m = match;
  const otMs = (() => { try { return JSON.parse(m.period_lengths || '[]')[2] || 0; } catch { return 0; } })();
  modal(`<h3 style="margin:0">Nastavení zápasu</h3>
    <div class="row"><label style="width:200px">Délka poločasu (min)</label>
      <input id="cfgLen" type="number" step="0.5" value="${(m.period_length_ms/60000)}" style="width:90px"></div>
    <div class="row"><label style="width:200px">Délka prodloužení (min)</label>
      <input id="cfgOt" type="number" step="0.5" value="${otMs ? otMs/60000 : ''}" placeholder="stejná" style="width:90px"></div>
    <div class="row"><label style="width:200px">Počet timeoutů (na tým)</label>
      <input id="cfgTo" type="number" value="${m.timeouts_allowed}" style="width:90px"></div>
    <div class="row"><label style="width:200px">Délka vyloučení (s)</label>
      <input id="cfgSus" type="number" value="${Math.round(m.suspension_ms/1000)}" style="width:90px"></div>
    <div class="row" style="justify-content:flex-end"><button data-close>Zrušit</button><button class="primary" id="cfgSave">Uložit</button></div>`,
    bg => {
      bg.querySelector('#cfgSave').onclick = async () => {
        const lenMs = Math.round((+bg.querySelector('#cfgLen').value || 30) * 60000);
        const otMin = +bg.querySelector('#cfgOt').value || 0;
        const period_lengths = otMin ? JSON.stringify([null, null, otMin * 60000, otMin * 60000, otMin * 60000]) : '';
        await act(`/api/matches/${m.id}/config`, {
          period_length_ms: lenMs,
          period_lengths,
          timeouts_allowed: +bg.querySelector('#cfgTo').value || 0,
          suspension_ms: Math.round((+bg.querySelector('#cfgSus').value || 120) * 1000)
        });
        bg.remove();
      };
    });
}

// ----- keyboard shortcuts config -----
const KEY_LABELS = { startStop: 'Start / Stop', minus1: '−1 s', plus1: '+1 s', minus10: '−10 s', plus10: '+10 s',
  homeGoal: 'Gól domácí', awayGoal: 'Gól hosté' };
function keyName(k) { return k === ' ' ? 'Mezerník' : k; }
function openKeys() {
  modal(`<h3 style="margin:0">Klávesové zkratky (časomíra)</h3>
    <div class="muted">Klikni na pole a stiskni klávesu.</div>
    ${Object.keys(KEY_LABELS).map(k => `<div class="row"><label style="width:140px">${KEY_LABELS[k]}</label>
      <button class="keybind" data-key="${k}">${keyName(keymap[k])}</button></div>`).join('')}
    <div class="row" style="justify-content:space-between">
      <button id="keysReset">Výchozí</button>
      <button class="primary" data-close>Hotovo</button></div>`,
    bg => {
      bg.querySelectorAll('.keybind').forEach(b => b.onclick = () => {
        b.textContent = '…'; b.classList.add('warn');
        const handler = ev => {
          ev.preventDefault();
          keymap[b.dataset.key] = ev.key; saveKeymap();
          b.textContent = keyName(ev.key); b.classList.remove('warn');
          window.removeEventListener('keydown', handler, true);
        };
        window.addEventListener('keydown', handler, true);
      });
      bg.querySelector('#keysReset').onclick = () => { keymap = { ...DEFAULT_KEYS }; saveKeymap(); bg.remove(); openKeys(); };
    });
}

// global shortcuts for timer + quick goals (ignored while typing in a field).
// goal shortcuts add a goal instantly without the player dialog (fastest entry).
const normKey = s => (s && s.length === 1 ? s.toLowerCase() : s);
window.addEventListener('keydown', e => {
  if (!match || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  const k = normKey(e.key), id = match.id;
  const is = name => k === normKey(keymap[name]);
  const timer = delta => act(`/api/matches/${id}/timer`, { action: 'adjust', delta });
  if (is('startStop')) { e.preventDefault(); toggleTimer(); }
  else if (is('minus1')) { e.preventDefault(); timer(-1000); }
  else if (is('plus1')) { e.preventDefault(); timer(1000); }
  else if (is('minus10')) { e.preventDefault(); timer(-10000); }
  else if (is('plus10')) { e.preventDefault(); timer(10000); }
  else if (is('homeGoal')) { e.preventDefault(); goalWithNumber('home'); }
  else if (is('awayGoal')) { e.preventDefault(); goalWithNumber('away'); }
});

// open the number prompt, then add the goal (Enter confirms; Enter alone = no number)
function goalWithNumber(side) {
  if (!match) return;
  pickPlayer(side, 'Střelec gólu').then(p => act(`/api/matches/${match.id}/score`, { side, delta: 1, ...p }));
}

// generic modal helper
function modal(html, init) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal grid" style="gap:10px;min-width:440px">${html}</div>`;
  bg.addEventListener('click', e => { if (e.target === bg || e.target.dataset?.close !== undefined && e.target.hasAttribute('data-close')) bg.remove(); });
  document.body.appendChild(bg);
  init?.(bg);
  return bg;
}

// player / number picker; ENTER submits. resolves { player_id, number }
function pickPlayer(side, title) {
  const players = rosters[side];
  return new Promise(resolve => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal grid" style="gap:8px">
      <h3 style="margin:0">${title} (volitelné)</h3>
      ${players.length ? `<div class="row">${players.map(p =>
        `<button data-pid="${p.id}" data-num="${p.number ?? ''}">#${p.number ?? '?'} ${esc(p.name)}</button>`).join('')}</div>` : ''}
      <div class="row">
        <input type="number" id="pkNum" placeholder="Číslo hráče" style="width:130px;font-size:18px" min="1" max="99">
        <button class="primary" id="pkOk">OK (Enter)</button>
        <button data-skip="1">Bez hráče</button>
      </div></div>`;
    const done = v => { bg.remove(); resolve(v); };
    const ok = () => done({ player_id: null, number: +bg.querySelector('#pkNum').value || null });
    bg.onclick = e => {
      if (e.target === bg || e.target.dataset?.skip) return done({ player_id: null, number: null });
      if (e.target.dataset?.pid) return done({ player_id: +e.target.dataset.pid, number: +e.target.dataset.num || null });
      if (e.target.id === 'pkOk') return ok();
    };
    bg.querySelector('#pkNum').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); ok(); }
      if (e.key === 'Escape') done({ player_id: null, number: null });
    });
    document.body.appendChild(bg);
    setTimeout(() => bg.querySelector('#pkNum').focus(), 50);
  });
}

async function renderSusp() {
  const box = document.getElementById('susp');
  if (!box) return;
  const list = await api.get(`/api/matches/${match.id}/suspensions-admin`);
  const active = list.filter(s => s.remaining_ms > 0);
  box.innerHTML = active.length ? active.map(s => `
    <div class="row" style="justify-content:space-between">
      <span>${esc(teamLabel(match, s.side))} ${s.player_number ? '· #' + s.player_number : ''}
        — zbývá <b>${fmtTime(s.remaining_ms)}</b></span>
      <button class="danger" data-delsusp="${s.id}">✕ zrušit</button>
    </div>`).join('') : 'Žádná aktivní vyloučení.';
  box.querySelectorAll('[data-delsusp]').forEach(b => b.onclick = () =>
    api.del(`/api/events/${b.dataset.delsusp}`).then(() => { renderSusp(); renderEvents(); }));
}

async function renderEvents() {
  const box = document.getElementById('events');
  if (!box) return;
  const evs = await api.get(`/api/matches/${match.id}/events`);
  const names = { goal: 'Gól', penalty2: 'Vyloučení', yellow: 'ŽK', red: 'ČK', blue: 'Modrá', timeout: 'Timeout' };
  box.innerHTML = evs.length ? evs.slice(0, 14).map(e => `
    <div class="row" style="justify-content:space-between">
      <span>${fmtTime(e.match_time_ms)} (${e.period}.) — <b>${names[e.type] || e.type}</b>
        ${esc(teamLabel(match, e.side))}
        ${e.player_name ? `· #${e.player_number ?? ''} ${esc(e.player_name)}` : e.player_number ? `· #${e.player_number}` : ''}</span>
      <button data-del="${e.id}">✕</button>
    </div>`).join('') : 'Zatím žádné události.';
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = () =>
    api.del(`/api/events/${b.dataset.del}`).then(() => { renderEvents(); renderSusp(); }));
}

async function renderPicker() {
  const matches = await api.get(`/api/matches?hall_id=${hallId}&status=scheduled`);
  app.innerHTML = `
    <div class="row" style="justify-content:space-between;margin:6px 0">
      <h2 style="margin:0">Panel haly ${hallId}</h2>
      <div class="row">
        <button id="btnLed">💡 Světelný panel</button>
        <a href="/setup/${hallId}" target="_blank"><button>📥 Stáhnout agenta</button></a>
      </div>
    </div>
    <div class="panel grid">
      <h3 style="margin:0">Vyber zápas ke spuštění</h3>
      ${matches.length ? matches.map(m => `
        <div class="row" style="justify-content:space-between">
          <span><b>${esc(teamLabel(m, 'home'))}</b> vs <b>${esc(teamLabel(m, 'away'))}</b>
            <span class="muted">· ${fmtDateTime(m.scheduled_at)} · ${m.period_length_ms/60000}min/${m.timeouts_allowed}TO</span></span>
          <button class="primary" data-start="${m.id}">Spustit</button>
        </div>`).join('') : '<span class="muted">Žádné naplánované zápasy pro tuto halu.</span>'}
    </div>`;
  app.querySelectorAll('[data-start]').forEach(b => b.onclick = () =>
    api.post(`/api/matches/${b.dataset.start}/start`).then(load));
  document.getElementById('btnLed').onclick = openLedPanel;
}

// local timer tick: display only (server stops the clock at period end)
setInterval(() => {
  if (!match || !document.getElementById('timer')) return;
  document.getElementById('timer').textContent = fmtTime(elapsed());
}, 200);

setInterval(() => {
  if (document.getElementById('susp') && match) renderSusp();
}, 1000);

load();
