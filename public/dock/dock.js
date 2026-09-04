import { api, fmtTime, teamLabel, esc, qs, clockSnap, clockMs, setHallToken } from '/assets/common.js';

const hallId = +(qs.get('hall') || 1);
const hallToken = qs.get('token') || '';
if (hallToken) setHallToken(hallToken);
const root = document.getElementById('app');
let match = null;
let snap = null;
let lastErr = '';

function tokenHint() {
  return 'Dock nemá platný token. V OBS: Docks → Custom Browser Docks a vlož URL z /setup/' + hallId
    + ' (musí obsahovat token). Z režie stačí být přihlášený.';
}

const socket = io({ auth: { hall: hallId, token: hallToken } });
socket.on(`hall:${hallId}:match`, m => { match = m; snap = clockSnap(m); render(); });
socket.on('schedule:update', () => { if (!match || match.status !== 'live') load(); });

function act(url, body) {
  return api.post(url, body).then(r => { lastErr = ''; return r; }).catch(e => {
    const m = String(e.message || e);
    lastErr = /401/.test(m) ? tokenHint() : ('Akce selhala: ' + m);
    render();
  });
}

function elapsed() {
  return clockMs(match, snap);
}

function perLabel(p) { return p <= 2 ? `${p}. poločas` : `Prodl. ${p - 2}`; }

async function load() {
  try {
    match = await api.get(`/api/halls/${hallId}/live`);
    lastErr = '';
  } catch (e) {
    match = null;
    const m = String(e.message || e);
    lastErr = /401/.test(m) ? tokenHint() : ('Načtení selhalo: ' + m);
  }
  if (match) snap = clockSnap(match);
  render();
}

// ---- mini number-picker modal ----
function askNumber(title) {
  return new Promise(resolve => {
    const bg = document.createElement('div');
    bg.className = 'mini-modal';
    bg.innerHTML = `<div class="mini-box">
      <h4>${esc(title)}</h4>
      <input type="number" id="pkn" placeholder="Číslo" min="1" max="99" inputmode="numeric">
      <div class="mini-row">
        <button id="pkSkip" class="btn-sm">Bez č.</button>
        <button id="pkOk" class="btn-goal">OK</button>
      </div>
    </div>`;
    const done = num => { bg.remove(); resolve(num ?? null); };
    bg.querySelector('#pkOk').onclick  = () => done(+bg.querySelector('#pkn').value || null);
    bg.querySelector('#pkSkip').onclick = () => done(null);
    bg.querySelector('#pkn').addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); done(+bg.querySelector('#pkn').value || null); }
      if (e.key === 'Escape') done(null);
    });
    document.body.appendChild(bg);
    setTimeout(() => bg.querySelector('#pkn').focus(), 40);
  });
}

async function doGoal(side) {
  const number = await askNumber('Střelec gólu');
  act(`/api/matches/${match.id}/score`, { side, delta: 1, player_id: null, number });
}

async function doEvent(type, side) {
  const number = await askNumber(type === 'penalty2' ? 'Číslo vyloučeného' : 'Číslo hráče');
  act(`/api/matches/${match.id}/event`, { type, side, player_id: null, number });
}

// ---- main render ----
function render() {
  if (!match) { renderNoMatch(); return; }
  const m = match;
  const tl = side => esc(teamLabel(m, side));
  const dots = side => {
    const used = m[`${side}_timeouts`] || 0, max = m.timeouts_allowed || 0;
    return Array.from({ length: max }, (_, i) =>
      `<span class="todot${i < used ? ' used' : ''}"></span>`).join('');
  };
  const susMs = Math.round((m.suspension_ms || 120000) / 1000);

  root.innerHTML = `
    ${lastErr ? `<div class="err">${esc(lastErr)}</div>` : ''}
    <div class="sb">
      <div>
        <div class="sb-name">${tl('home')}</div>
        <div class="sb-score" id="hs">${m.home_score}</div>
        <div class="todots">${dots('home')}</div>
      </div>
      <div>
        <div class="sb-clock" id="timer">${fmtTime(elapsed())}</div>
        <div class="sb-per" id="perLbl">${perLabel(m.period)}</div>
      </div>
      <div>
        <div class="sb-name">${tl('away')}</div>
        <div class="sb-score" id="as">${m.away_score}</div>
        <div class="todots">${dots('away')}</div>
      </div>
    </div>

    <button id="btnTimer" class="${m.timer_running ? 'btn-stop' : 'btn-start'}">
      ${m.timer_running ? '⏸ STOP ČAS' : '▶ START ČAS'}</button>

    <div class="row">
      <button data-adj="-10000">−10s</button>
      <button data-adj="-1000">−1s</button>
      <button data-adj="1000">+1s</button>
      <button data-adj="10000">+10s</button>
    </div>
    <div class="row">
      <button id="btnPrev">◀ poločas</button>
      <button id="btnNext">poločas ▶</button>
      <button id="btnOt" class="btn-susp">+Prodl.</button>
    </div>

    <div class="teams">
      ${['home', 'away'].map(side => `
      <div class="team-col">
        <div class="team-hdr">${tl(side)}</div>
        <button class="btn-goal" data-goal="${side}">+1 GÓL</button>
        <button class="btn-sm" data-ungoal="${side}">−1 oprava</button>
        <button class="btn-susp" data-ev="penalty2" data-side="${side}">${susMs}s vylouč.</button>
        <div class="cards">
          <button class="btn-yellow" data-ev="yellow" data-side="${side}">ŽK</button>
          <button class="btn-red"    data-ev="red"    data-side="${side}">ČK</button>
          <button class="btn-blue"   data-ev="blue"   data-side="${side}">Mod</button>
        </div>
        <div class="row">
          <button class="btn-to" data-timeout="${side}" style="flex:1" ${(m[`${side}_timeouts`] || 0) >= (m.timeouts_allowed || 0) ? 'disabled' : ''}>
            TO ${m[`${side}_timeouts`] || 0}/${m.timeouts_allowed || 0}</button>
          <button class="btn-undo" data-timeout-undo="${side}" title="Vrátit timeout">↶</button>
        </div>
      </div>`).join('')}
    </div>

    <div class="susp-box">
      <div class="susp-hdr">Aktivní vyloučení</div>
      <div id="suspList"><span style="color:var(--muted);font-size:11px">…</span></div>
    </div>

    <div class="status-bar">Hala ${hallId}${m.hall_name ? ' · ' + esc(m.hall_name) : ''}</div>`;

  // wire up all buttons
  root.querySelector('#btnTimer').onclick = () =>
    act(`/api/matches/${m.id}/timer`, { action: m.timer_running ? 'stop' : 'start' });
  root.querySelector('#btnPrev').onclick = () =>
    act(`/api/matches/${m.id}/period`, { period: Math.max(1, m.period - 1) });
  root.querySelector('#btnNext').onclick = () =>
    act(`/api/matches/${m.id}/period`, { period: m.period + 1 });
  root.querySelector('#btnOt').onclick = () =>
    act(`/api/matches/${m.id}/period`, { period: Math.max(3, m.period + 1) });

  root.querySelectorAll('[data-adj]').forEach(b => b.onclick = () =>
    act(`/api/matches/${m.id}/timer`, { action: 'adjust', delta: +b.dataset.adj }));
  root.querySelectorAll('[data-goal]').forEach(b => b.onclick = () => doGoal(b.dataset.goal));
  root.querySelectorAll('[data-ungoal]').forEach(b => b.onclick = () =>
    act(`/api/matches/${m.id}/score`, { side: b.dataset.ungoal, delta: -1 }));
  root.querySelectorAll('[data-ev]').forEach(b => b.onclick = () => doEvent(b.dataset.ev, b.dataset.side));
  root.querySelectorAll('[data-timeout]').forEach(b => b.onclick = () =>
    act(`/api/matches/${m.id}/event`, { type: 'timeout', side: b.dataset.timeout }));
  root.querySelectorAll('[data-timeout-undo]').forEach(b => b.onclick = () =>
    act(`/api/matches/${m.id}/timeout-undo`, { side: b.dataset.timeoutUndo }));

  renderSusp();
}

async function renderSusp() {
  const box = document.getElementById('suspList');
  if (!box || !match) return;
  const list = await api.get(`/api/matches/${match.id}/suspensions-admin`).catch(() => []);
  const active = list.filter(s => s.remaining_ms > 0);
  if (!active.length) {
    box.innerHTML = '<span style="color:var(--muted);font-size:11px">Žádné</span>';
    return;
  }
  const tl = side => esc(teamLabel(match, side));
  box.innerHTML = active.map(s => `
    <div class="susp-item">
      <span>${tl(s.side)}${s.player_number ? ' #' + s.player_number : ''} — <b>${fmtTime(s.remaining_ms)}</b></span>
      <button data-delsusp="${s.id}">✕</button>
    </div>`).join('');
  box.querySelectorAll('[data-delsusp]').forEach(b => b.onclick = () =>
    api.del(`/api/events/${b.dataset.delsusp}`).then(renderSusp));
}

function renderNoMatch() {
  root.innerHTML = `
    ${lastErr ? `<div class="err">${esc(lastErr)}</div>` : ''}
    <div class="no-match">
    <div class="icon">📋</div>
    <div>Žádný aktivní zápas</div>
    <div style="font-size:10px;color:var(--muted);margin-top:4px">Hala ${hallId}</div>
  </div>`;
}

// ---- intervals ----
setInterval(() => {
  const el = document.getElementById('timer');
  if (!match || !el) return;
  el.textContent = fmtTime(elapsed());
}, 200);

setInterval(() => {
  if (match) renderSusp();
}, 1000);

load();
