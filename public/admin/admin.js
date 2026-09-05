// Central control room UI
import { api, fmtTime, fmtDateTime, teamLabel, esc, uploadFile } from '/assets/common.js';
import { playHorn, unlockHorn, loadHornConfig, setHornUrl } from '/assets/horn.js?v=5';

const view = document.getElementById('view');
const tabsEl = document.getElementById('tabs');
const socket = io();

// Check auth before rendering anything
const { user: me } = await api.get('/api/auth/me');
if (!me || !['admin', 'reziser'].includes(me.role)) {
  location.href = '/login/?next=' + encodeURIComponent(location.pathname + location.search);
  throw new Error('redirect');
}

const BASE_TABS = [
  ['monitor', '📺 Monitoring'],
  ['panel', '💡 Světelný panel'],
  ['scenarios', '🎬 Scénáře'],
  ['schedule', '📅 Rozvrh'],
  ['teams', '👥 Týmy'],
  ['groups', '🏆 Skupiny'],
  ['bracket', '🥇 Pavouk'],
  ['templates', '⏱ Šablony'],
  ['media', '🎬 Média'],
  ['branding', '🏷 Loga'],
  ['alerts', '📢 Zprávy'],
  ['settings', '⚙️ Nastavení']
];
const TABS = me.role === 'admin' ? [...BASE_TABS, ['users', '👤 Uživatelé']] : BASE_TABS;
let current = 'monitor';
let settings = {};
let agentStatus  = []; // per-hall notebook agent state (connected/obsConnected)
const previewHalls = new Set(); // hallIds currently subscribed for JPEG preview
const previewUrls = new Map(); // hallId -> object URL

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

function paintPreviewFrame(hallId, buf) {
  const img = document.getElementById('v-' + hallId);
  if (!img) return;
  const blob = toJpegBlob(buf);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  img.src = url;
  const prev = previewUrls.get(hallId);
  if (prev) URL.revokeObjectURL(prev);
  previewUrls.set(hallId, url);
  img.dataset.hasFrame = '1';
  const hint = img.closest('[data-hall]')?.querySelector('.preview-hint');
  if (hint) hint.textContent = '';
}

function teardownPreviews() {
  for (const id of [...previewHalls]) {
    socket.emit('remote:unsubscribe', { hallId: id });
  }
  previewHalls.clear();
  for (const url of previewUrls.values()) {
    try { URL.revokeObjectURL(url); } catch {}
  }
  previewUrls.clear();
}

function startPreview(hallId) {
  const id = +hallId;
  if (!id || previewHalls.has(id)) return;
  const img = document.getElementById('v-' + id);
  if (!img) return;
  previewHalls.add(id);
  img.dataset.hasFrame = '';
  socket.emit('remote:subscribe', { hallId: id, mode: 'preview' }, (r) => {
    if (r && !r.ok) {
      previewHalls.delete(id);
      const hint = img.closest('[data-hall]')?.querySelector('.preview-hint');
      if (hint && r.error && !/není připojen/i.test(r.error))
        hint.textContent = r.error;
    }
  });
}

socket.on('remote:frame', (payload) => {
  const hallId = +(payload?.hall || 0);
  const buf = payload?.jpeg ?? payload;
  if (!hallId || !previewHalls.has(hallId)) return;
  paintPreviewFrame(hallId, buf);
});

tabsEl.innerHTML = TABS.map(([id, label]) => `<button data-tab="${id}">${label}</button>`).join('');
tabsEl.querySelectorAll('button[data-tab]').forEach(b => b.onclick = () => { show(b.dataset.tab); closeSidebar(); });

document.getElementById('logoutBtn').textContent = `Odhlásit (${esc(me.username)})`;
document.getElementById('logoutBtn').onclick = async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login/';
};

const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('sidebarOverlay');

function openSidebar() { sidebar.classList.add('open'); overlay.classList.add('active'); }
function closeSidebar() { sidebar.classList.remove('open'); overlay.classList.remove('active'); }

function openPopup(url, name, features) {
  const win = window.open(url, name, features);
  if (!win) alert('Prohlížeč zablokoval vyskakovací okno — povol pop-up pro MultiMix.');
  else try { win.focus(); } catch {}
  return win;
}

function openLedWindow(hallId) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(1040 / dpr), h = Math.round(208 / dpr);
  openPopup(`/panel/?hall=${hallId}`, 'mm-led-' + hallId, `popup=yes,width=${w},height=${h},left=0,top=0`);
}

function openObsPanel(hallId) {
  openPopup(`/dock/?hall=${hallId}`, 'mm-dock-' + hallId, 'popup=yes,width=380,height=760,left=40,top=40');
}

document.getElementById('menuToggle').onclick = openSidebar;
document.getElementById('sidebarClose').onclick = closeSidebar;
overlay.onclick = closeSidebar;

function show(tab) {
  current = tab;
  tabsEl.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  view.classList.toggle('wide', tab === 'monitor');
  renders[tab]();
}

socket.on('match:update', () => { if (current === 'monitor') refreshMonitorScores(); });
socket.on('schedule:update', () => { if (['schedule', 'bracket'].includes(current)) renders[current](); });
socket.on('agent:update', sts => {
  agentStatus = sts;
  if (current === 'monitor') updateAgentBadges();
});

// Reflect each hall's notebook agent connection status + camera list live.
function updateAgentBadges() {
  for (const hall of document.querySelectorAll('[data-hall]')) {
    const hallId = +hall.dataset.hall;
    const badge  = hall.querySelector('.agent-badge');
    const a = agentStatus.find(s => +s.hall === hallId);
    const rejected = !!(a && a.tokenRejected);
    const online = !!(a && !rejected);

    if (badge) {
      if (rejected) {
        badge.textContent = '○ neplatný token';
        badge.className = 'badge finished agent-badge';
        badge.title = `Agent posílá ${a.tokenPrefix}… — přepiš %AppData%\\MultiMix\\agent-config.json ze /setup/${hallId}`;
      } else if (!online) {
        badge.textContent = '○ nepřipojen';
        badge.className = 'badge finished agent-badge';
        badge.title = `Otevři /setup/${hallId} na notebooku`;
      } else if (!a.obsConnected) {
        badge.textContent = '◑ agent · OBS čeká';
        badge.className = 'badge scheduled agent-badge';
        badge.title = 'Agent běží, čekám na OBS websocket';
      } else {
        badge.textContent = '● agent · OBS OK';
        badge.className = 'badge agent-ok agent-badge';
        badge.title = 'Notebook agent + OBS běží';
      }
    }

    const remoteBtn = hall.querySelector(`[data-remote="${hallId}"]`);
    if (remoteBtn) {
      remoteBtn.disabled = !online;
      remoteBtn.title = online
        ? 'Otevřít vzdálenou plochu v plném rozlišení'
        : (rejected ? 'Neplatný token agenta' : 'Agent musí být připojen');
    }

    const streamBtn = hall.querySelector(`[data-agentstream="${hallId}"]`);
    if (streamBtn) {
      const outputOn = !!(a?.outputActive);
      const ready  = !!(online && a.obsConnected);
      streamBtn.disabled   = !ready;
      streamBtn.dataset.on = outputOn ? '1' : '0';
      streamBtn.textContent = outputOn ? '⏹ Zastavit stream' : '▶ Spustit stream';
      streamBtn.className   = outputOn ? 'danger' : 'success';
      streamBtn.title = outputOn
        ? 'Zastavit vysílání v OBS na notebooku'
        : 'Spustit vysílání v OBS (cíl musí být nastavený ručně v OBS)';
    }

    const hint = hall.querySelector('.preview-hint');
    const img = document.getElementById('v-' + hallId);
    const hasFrames = img?.dataset.hasFrame === '1';
    if (hint && !hasFrames) {
      if (!online) hint.textContent = 'Čekám na agenta…';
      else hint.textContent = 'Čekám na obraz z notebooku…';
    }
    if (online && current === 'monitor') startPreview(hallId);
    if (!online && previewHalls.has(hallId)) {
      socket.emit('remote:unsubscribe', { hallId });
      previewHalls.delete(hallId);
    }
  }
}

// ---------- last monitor dropdowns (per hall, this browser only) ----------
const MONITOR_SEL_KEY = 'mmx_monitor_sel';

function loadMonitorSel() {
  try { return JSON.parse(localStorage.getItem(MONITOR_SEL_KEY) || '{}') || {}; }
  catch { return {}; }
}

function saveMonitorSel(hallId, field, value) {
  if (!hallId || !value) return;
  const all = loadMonitorSel();
  const prev = all[hallId] || {};
  all[hallId] = { ...prev, [field]: String(value) };
  localStorage.setItem(MONITOR_SEL_KEY, JSON.stringify(all));
}

function restoreSelect(sel, saved) {
  if (!sel || saved == null || saved === '') return;
  const ok = [...sel.options].some(o => o.value === String(saved));
  if (ok) sel.value = String(saved);
}

// ---------- scenario status tracking ----------
const scenarioStatus = new Map(); // hallId -> { stepIdx, total, type } | null
const automationPending = new Map(); // hallId -> { trigger, scenarioId, name, dueAt }
const AUTO_TRIGGER_LABEL = {
  period1: '1. poločas',
  period2: '2. poločas',
  overtime: 'prodloužení',
  timeout: 'timeout',
};

function stepTypeLabel(type) {
  return { spot: 'Spot', adbreak: 'Reklama', lineups: 'Soupisky', upcoming: 'Další zápasy', wait: 'Čekání' }[type] ?? type;
}

function updateScenarioStatusUI(hallId) {
  const statusEl = document.querySelector(`[data-scenario-status="${hallId}"]`);
  const stopBtn  = document.querySelector(`[data-stopscenario="${hallId}"]`);
  const state = scenarioStatus.get(hallId);
  if (statusEl) statusEl.textContent = state ? `Krok ${state.stepIdx + 1}/${state.total}: ${stepTypeLabel(state.type)}` : '';
  if (stopBtn)  stopBtn.style.display = state ? '' : 'none';
}

function updateAutomationUI(hallId) {
  const el = document.querySelector(`[data-automation-status="${hallId}"]`);
  if (!el) return;
  const pending = automationPending.get(+hallId);
  if (!pending) { el.innerHTML = ''; return; }
  const sec = Math.max(0, Math.ceil((pending.dueAt - Date.now()) / 1000));
  const label = AUTO_TRIGGER_LABEL[pending.trigger] || pending.trigger;
  el.innerHTML = `<span>Automaticky: ${esc(label)} za ${sec} s</span>
    <button data-cancelauto="${hallId}" style="margin-left:8px">Zrušit</button>`;
}

let automationTick = null;
function ensureAutomationTick() {
  if (automationTick) return;
  automationTick = setInterval(() => {
    for (const hallId of automationPending.keys()) updateAutomationUI(hallId);
  }, 500);
}

socket.on('scenario:start', ({ hallId, total, name }) => {
  scenarioStatus.set(hallId, { stepIdx: 0, total, type: '' });
  updateScenarioStatusUI(hallId);
  if (automationPending.has(+hallId)) {
    automationPending.delete(+hallId);
    updateAutomationUI(hallId);
  }
});
socket.on('scenario:step', ({ hallId, stepIdx, total, type }) => {
  scenarioStatus.set(hallId, { stepIdx, total, type });
  updateScenarioStatusUI(hallId);
});
socket.on('scenario:done', ({ hallId }) => {
  scenarioStatus.delete(hallId);
  updateScenarioStatusUI(hallId);
});
socket.on('automation:pending', (p) => {
  automationPending.set(+p.hallId, p);
  updateAutomationUI(p.hallId);
  ensureAutomationTick();
});
socket.on('automation:cancel', ({ hallId }) => {
  automationPending.delete(+hallId);
  updateAutomationUI(hallId);
});

function setSpotStopVisible(hallId, on) {
  const stopBtn = document.querySelector(`[data-overlayspot-stop="${hallId}"]`);
  if (stopBtn) stopBtn.style.display = on ? '' : 'none';
}
socket.on('spot:done', ({ hallId }) => setSpotStopVisible(hallId, false));
socket.on('spot:stop', ({ hallId }) => setSpotStopVisible(hallId, false));

// reflect ticker auto-hide (and any alert change) live, without wiping a half-typed message
socket.on('alerts:update', async () => {
  if (current !== 'alerts') return;
  const txt = document.getElementById('aText')?.value, lvl = document.getElementById('aLevel')?.value;
  await renders.alerts();
  if (txt) document.getElementById('aText').value = txt;
  if (lvl) document.getElementById('aLevel').value = lvl;
});

const renders = {

  // ---------- Monitoring ----------
  async monitor() {
    teardownPreviews();
    const [halls, media, scenarios, services] = await Promise.all([
      api.get('/api/halls'), api.get('/api/media'), api.get('/api/scenarios'),
      api.get('/api/broadcast-services').catch(() => [])
    ]);
    settings = await api.get('/api/settings');
    agentStatus  = await api.get('/api/agent/status');
    const activeSvc = (services || []).find(s => s.active);
    if (!halls.length) {
      view.innerHTML = '<div class="panel">Nejdřív přidej haly v záložce <b>Nastavení</b>.</div>';
      return;
    }
    const spotOpts = media.filter(m => m.type === 'video')
      .map(m => `<option value="${m.id}">${esc(m.name || m.filename)}</option>`).join('');
    const scenarioOpts = scenarios.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    view.innerHTML = `<div class="monitors">${halls.map(h => `
      <div class="panel monitor grid" style="gap:8px;grid-template-columns:minmax(0,1fr)" data-hall="${h.id}">
        <div class="row">
          <b>${esc(h.name)}</b>
          <span class="muted" style="font-size:12px">Cíl: ${esc(activeSvc?.name || 'není vybrána cesta')}</span>
        </div>
        <img id="v-${h.id}" class="preview-img" alt="Náhled haly" draggable="false">
        <div class="preview-hint muted" style="font-size:12px">Čekám na obraz z notebooku…</div>
        <div id="m-${h.id}" class="muted">—</div>

        <div class="row" style="justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap">
          <span class="badge finished agent-badge">○ nepřipojen</span>
          <button data-obspanel="${h.id}" title="Kompaktní ovládání tabule — dříve Custom Browser Dock v OBS">🖥 OBS panel</button>
          <button data-remote="${h.id}" disabled title="Agent musí být připojen">🖥 Vzdálené ovládání</button>
          <button class="success" data-agentstream="${h.id}" data-on="0" disabled title="Spustit vysílání v OBS (cíl nastav ručně v OBS)">▶ Spustit stream</button>
        </div>
        <div class="row" style="gap:6px;flex-wrap:wrap">
          <select data-spotsel="${h.id}" style="flex:1;min-width:0">${spotOpts || '<option value="">žádné video</option>'}</select>
          <button data-overlayspot="${h.id}">▶ Spot</button>
          <button data-overlayspot-stop="${h.id}" class="danger" style="display:none">⏹ Stop</button>
        </div>
        <div class="row" style="gap:6px">
          <button data-lineups="${h.id}" style="flex:1">📋 Soupisky</button>
          <button data-lineups-stop="${h.id}">⏹</button>
        </div>
        <div class="row" style="gap:6px">
          <button data-upcoming="${h.id}" style="flex:1">📅 Další zápasy</button>
          <button data-upcoming-stop="${h.id}">⏹</button>
        </div>
        <div class="row" style="gap:6px;flex-wrap:wrap">
          <select data-scenariosel="${h.id}" style="flex:1;min-width:0">${scenarioOpts || '<option value="">žádné scénáře</option>'}</select>
          <button data-runscenario="${h.id}" ${!scenarioOpts ? 'disabled' : ''}>▶ Scénář</button>
          <button data-stopscenario="${h.id}" class="danger" style="display:none">⏹</button>
        </div>
        <div data-scenario-status="${h.id}" style="font-size:12px;color:var(--muted);min-height:16px"></div>
        <div data-automation-status="${h.id}" style="font-size:12px;color:var(--muted);min-height:16px"></div>
        <div class="row" style="gap:6px">
          <button data-reset="${h.id}" class="danger" style="flex:1">🔴 Reset overlay</button>
        </div>
        <div class="row" style="gap:6px">
          <a href="/hall/?hall=${h.id}" target="_blank">⚽ ovládání tabule</a>
          <a href="/dock/?hall=${h.id}" target="_blank">OBS panel</a>
          <a href="/overlay/?hall=${h.id}" target="_blank">overlay</a>
          <a href="/panel/?hall=${h.id}" target="_blank">světelný panel</a>
          <a href="/setup/${h.id}" target="_blank">⚙ setup</a>
        </div>
      </div>`).join('')}</div>`;

    for (const h of halls) startPreview(h.id);

    const savedSel = loadMonitorSel();
    view.querySelectorAll('[data-spotsel]').forEach(sel => {
      restoreSelect(sel, savedSel[sel.dataset.spotsel]?.spot);
      sel.onchange = () => saveMonitorSel(sel.dataset.spotsel, 'spot', sel.value);
    });
    view.querySelectorAll('[data-scenariosel]').forEach(sel => {
      restoreSelect(sel, savedSel[sel.dataset.scenariosel]?.scenario);
      sel.onchange = () => saveMonitorSel(sel.dataset.scenariosel, 'scenario', sel.value);
    });

    view.querySelectorAll('[data-obspanel]').forEach(b => b.onclick = () => openObsPanel(+b.dataset.obspanel));

    view.querySelectorAll('[data-remote]').forEach(b => b.onclick = () => {
      const id = b.dataset.remote;
      const w = screen.availWidth;
      const hgt = screen.availHeight;
      const win = window.open(
        `/admin/remote/?hall=${id}`,
        'mm-remote-' + id,
        `popup=yes,width=${w},height=${hgt},left=0,top=0`
      );
      if (!win) alert('Prohlížeč zablokoval vyskakovací okno — povol pop-up pro MultiMix.');
      else try { win.focus(); } catch {}
    });

    view.querySelectorAll('[data-agentstream]').forEach(b => b.onclick = async () => {
      const id      = b.dataset.agentstream;
      const stopping = b.dataset.on === '1';
      b.disabled    = true;
      b.textContent = stopping ? '⏳ Zastavuji...' : '⏳ Spouštím...';
      const r = await api.post(`/api/agent/${id}/${stopping ? 'stop-stream' : 'start-stream'}`, {});
      if (!r.ok) {
        alert('Chyba: ' + r.error);
        updateAgentBadges(); // reset button to actual state
      } else {
        // Optimistic update — agent:update event potvrdí později
        b.disabled    = false;
        b.dataset.on  = stopping ? '0' : '1';
        b.textContent = stopping ? '▶ Spustit stream' : '⏹ Zastavit stream';
        b.className   = stopping ? 'success' : 'danger';
      }
    });

    view.querySelectorAll('[data-overlayspot]').forEach(b => b.onclick = async () => {
      const id = b.dataset.overlayspot;
      const sel = view.querySelector(`[data-spotsel="${id}"]`);
      if (!sel || !sel.value) return alert('Vyber video ze seznamu');
      saveMonitorSel(id, 'spot', sel.value);
      const r = await api.post(`/api/overlay/${id}/spot`, { media_id: +sel.value });
      if (r.error) { alert('Spot: ' + r.error); return; }
      const stopBtn = view.querySelector(`[data-overlayspot-stop="${id}"]`);
      if (stopBtn) stopBtn.style.display = '';
    });
    view.querySelectorAll('[data-overlayspot-stop]').forEach(b => b.onclick = async () => {
      const id = b.dataset.overlayspotStop;
      await api.post(`/api/overlay/${id}/spot/stop`, {});
      b.style.display = 'none';
    });
    view.querySelectorAll('[data-reset]').forEach(b => b.onclick = async () => {
      const id = b.dataset.reset;
      await Promise.all([
        api.post(`/api/overlay/${id}/spot/stop`, {}),
        api.post(`/api/overlay/${id}/lineups/stop`, {}),
        api.post(`/api/overlay/${id}/upcoming/stop`, {}),
        api.post(`/api/halls/${id}/overlay`, { visible: false }),
      ]);
      const stopBtn = view.querySelector(`[data-overlayspot-stop="${id}"]`);
      if (stopBtn) stopBtn.style.display = 'none';
    });
    view.querySelectorAll('[data-lineups]').forEach(b => b.onclick = async () => {
      const r = await api.post(`/api/overlay/${b.dataset.lineups}/lineups`, {});
      if (r.error) alert('Soupisky: ' + r.error);
    });
    view.querySelectorAll('[data-lineups-stop]').forEach(b => b.onclick = async () => {
      await api.post(`/api/overlay/${b.dataset.lineupsStop}/lineups/stop`, {});
    });
    view.querySelectorAll('[data-upcoming]').forEach(b => b.onclick = async () => {
      const r = await api.post(`/api/overlay/${b.dataset.upcoming}/upcoming`, {});
      if (r.error) alert('Další zápasy: ' + r.error);
    });
    view.querySelectorAll('[data-upcoming-stop]').forEach(b => b.onclick = async () => {
      await api.post(`/api/overlay/${b.dataset.upcomingStop}/upcoming/stop`, {});
    });

    view.querySelectorAll('[data-runscenario]').forEach(b => b.onclick = async () => {
      const hallId = b.dataset.runscenario;
      const sel = view.querySelector(`[data-scenariosel="${hallId}"]`);
      if (!sel || !sel.value) return alert('Vyber scénář ze seznamu');
      saveMonitorSel(hallId, 'scenario', sel.value);
      try {
        const r = await api.post(`/api/scenarios/${sel.value}/run?hallId=${hallId}`, {});
        if (r.error) alert('Scénář: ' + r.error);
      } catch (e) {
        alert('Scénář: ' + e.message);
      }
    });
    view.querySelectorAll('[data-stopscenario]').forEach(b => b.onclick = async () => {
      const hallId = b.dataset.stopscenario;
      await api.post(`/api/overlay/${hallId}/spot/stop`, {}); // stops scenario + clears all overlay
    });

    view.querySelectorAll('[data-automation-status]').forEach(el => {
      el.onclick = async (e) => {
        const btn = e.target.closest('[data-cancelauto]');
        if (!btn) return;
        await api.post(`/api/overlay/${btn.dataset.cancelauto}/automation/cancel`, {});
      };
    });

    // Restore running scenario status and pending automation countdowns
    for (const [hallId] of scenarioStatus) updateScenarioStatusUI(hallId);
    for (const hallId of automationPending.keys()) updateAutomationUI(hallId);

    updateAgentBadges();
    refreshMonitorScores();
  },

  // ---------- Světelný panel ----------
  async panel() {
    teardownPreviews();
    const halls = await api.get('/api/halls');
    if (!halls.length) {
      view.innerHTML = '<div class="panel">Nejdřív přidej haly v záložce <b>Nastavení</b>.</div>';
      return;
    }
    view.innerHTML = `
      <div class="panel" style="margin-bottom:14px">
        <b>Světelný panel 1040×208</b>
        <p class="muted" style="margin:8px 0 0">Živý výstup na 2. monitor notebooku. Ovládání zůstává na 1. monitoru.
          Tlačítko <b>Otevřít okno</b> otevře přesnou velikost 1040×208 — přetáhni ho na panel a stiskni F11 (nebo dvojklik) na celou obrazovku.
          Panel nezávisí na overlayi ve streamu: tresty, timeouty a poločas běží pořád, i když je overlay skrytý.</p>
      </div>
      <div class="led-previews">${halls.map(h => `
        <div class="panel grid" style="gap:8px">
          <div class="row" style="justify-content:space-between;align-items:center">
            <b>${esc(h.name)}</b>
            <button class="primary" data-ledopen="${h.id}">Otevřít okno</button>
          </div>
          <div class="led-frame">
            <iframe src="/panel/?hall=${h.id}" title="Světelný panel ${esc(h.name)}"></iframe>
          </div>
        </div>`).join('')}</div>`;
    view.querySelectorAll('[data-ledopen]').forEach(b => b.onclick = () => openLedWindow(+b.dataset.ledopen));
  },

  // ---------- Rozvrh ----------
  async schedule() {
    const [matches, halls, teams, groups, templates] = await Promise.all([
      api.get('/api/matches'), api.get('/api/halls'), api.get('/api/teams'), api.get('/api/groups'), api.get('/api/templates')]);
    const stBadge = s => ({ scheduled: 'naplánován', live: 'ŽIVĚ', finished: 'ukončen' }[s]);
    view.innerHTML = `
      <div class="row" style="margin-bottom:12px"><button class="primary" id="addMatch">+ Nový zápas</button></div>
      <div class="panel"><table><thead><tr>
        <th>Čas</th><th>Hala</th><th>Fáze</th><th>Domácí</th><th>Hosté</th><th>Skóre</th><th>Stav</th><th></th>
      </tr></thead><tbody>
      ${matches.map(m => `<tr>
        <td>${fmtDateTime(m.scheduled_at)}</td>
        <td>${esc(m.hall_name ?? '—')}</td>
        <td>${m.stage === 'group' ? 'skupina' : esc(m.round)}</td>
        <td>${esc(teamLabel(m, 'home'))}</td>
        <td>${esc(teamLabel(m, 'away'))}</td>
        <td>${m.status === 'scheduled' ? '—' : `${m.home_score}:${m.away_score}`}</td>
        <td><span class="badge ${m.status}">${stBadge(m.status)}</span></td>
        <td class="row">
          <button data-edit="${m.id}">✎</button>
          <button class="danger" data-del="${m.id}">✕</button>
        </td></tr>`).join('')}
      </tbody></table></div>`;
    document.getElementById('addMatch').onclick = () => matchForm(null, { halls, teams, groups, templates });
    view.querySelectorAll('[data-edit]').forEach(b => b.onclick = () =>
      matchForm(matches.find(m => m.id === +b.dataset.edit), { halls, teams, groups, templates }));
    view.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      if (confirm('Smazat zápas?')) api.del(`/api/matches/${b.dataset.del}`).then(renders.schedule);
    });
  },

  // ---------- Týmy ----------
  async teams() {
    const [teams, groups] = await Promise.all([api.get('/api/teams'), api.get('/api/groups')]);
    const groupOpts = sel => `<option value="">— bez skupiny —</option>` +
      groups.map(g => `<option value="${g.id}" ${g.id === sel ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
    view.innerHTML = `
      <div class="panel grid" style="margin-bottom:14px">
        <div class="row">
          <input id="tName" placeholder="Název týmu">
          <input id="tShort" placeholder="Zkratka" style="width:90px">
          <select id="tGroup">${groupOpts(null)}</select>
          <button class="primary" id="tAdd">+ Přidat tým</button>
        </div>
      </div>
      <div class="grid">${teams.map(t => `
        <div class="panel" data-team="${t.id}">
          <div class="row" style="justify-content:space-between">
            <span class="row">
              ${t.logo ? `<img src="/media-files/${esc(t.logo)}" style="height:28px">` : ''}
              <b>${esc(t.name)}</b> <span class="muted">(${esc(t.short_name)}) ${t.group_name ? '· ' + esc(t.group_name) : ''}</span>
            </span>
            <span class="row">
              <label class="muted" title="Barva pásu">Pás <input type="color" data-cbg="${t.id}" value="${esc(t.color_bg || '#1d3fb8')}"></label>
              <label class="muted" title="Barva textu">Text <input type="color" data-ctxt="${t.id}" value="${esc(t.color_text || '#ffffff')}"></label>
              <label class="muted">Logo <input type="file" data-logo="${t.id}" accept="image/*" style="width:180px"></label>
              <button data-roster="${t.id}">Soupiska</button>
              <button class="danger" data-delteam="${t.id}">✕</button>
            </span>
          </div>
          <div id="roster-${t.id}"></div>
        </div>`).join('')}</div>`;
    document.getElementById('tAdd').onclick = async () => {
      const name = document.getElementById('tName').value.trim();
      if (!name) return;
      await api.post('/api/teams', { name, short_name: document.getElementById('tShort').value.trim(),
        group_id: +document.getElementById('tGroup').value || null });
      renders.teams();
    };
    view.querySelectorAll('[data-delteam]').forEach(b => b.onclick = () => {
      if (confirm('Smazat tým včetně soupisky?')) api.del(`/api/teams/${b.dataset.delteam}`).then(renders.teams);
    });
    view.querySelectorAll('[data-roster]').forEach(b => b.onclick = () => toggleRoster(+b.dataset.roster));
    view.querySelectorAll('[data-cbg]').forEach(c => c.onchange = () =>
      api.put(`/api/teams/${c.dataset.cbg}`, { color_bg: c.value }));
    view.querySelectorAll('[data-ctxt]').forEach(c => c.onchange = () =>
      api.put(`/api/teams/${c.dataset.ctxt}`, { color_text: c.value }));
    view.querySelectorAll('[data-logo]').forEach(inp => inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      try {
        await uploadFile(`/api/teams/${inp.dataset.logo}/logo`, f);
        await renders.teams();
      } catch (e) {
        alert(e.message || 'Nahrání loga selhalo');
      }
    });
  },

  // ---------- Skupiny ----------
  async groups() {
    const groups = await api.get('/api/groups');
    view.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <input id="gName" placeholder="Název skupiny (např. Skupina A)">
        <button class="primary" id="gAdd">+ Přidat skupinu</button>
      </div>
      <div class="grid" id="gList"></div>`;
    document.getElementById('gAdd').onclick = async () => {
      const name = document.getElementById('gName').value.trim();
      if (name) { await api.post('/api/groups', { name }); renders.groups(); }
    };
    const list = document.getElementById('gList');
    for (const g of groups) {
      const standings = await api.get(`/api/groups/${g.id}/standings`);
      list.insertAdjacentHTML('beforeend', `
        <div class="panel">
          <div class="row" style="justify-content:space-between">
            <h3 style="margin:4px 0">${esc(g.name)}</h3>
            <button class="danger" data-delgroup="${g.id}">✕</button>
          </div>
          <table><thead><tr><th>#</th><th>Tým</th><th>Z</th><th>V</th><th>R</th><th>P</th><th>Skóre</th><th>Body</th></tr></thead>
          <tbody>${standings.map((s, i) => `<tr>
            <td>${i + 1}</td><td>${esc(s.name)}</td><td>${s.played}</td><td>${s.wins}</td><td>${s.draws}</td>
            <td>${s.losses}</td><td>${s.goals_for}:${s.goals_against}</td><td><b>${s.points}</b></td>
          </tr>`).join('')}</tbody></table>
        </div>`);
    }
    list.querySelectorAll('[data-delgroup]').forEach(b => b.onclick = () => {
      if (confirm('Smazat skupinu?')) api.del(`/api/groups/${b.dataset.delgroup}`).then(renders.groups);
    });
  },

  // ---------- Pavouk ----------
  async bracket() {
    const [matches, teams] = await Promise.all([api.get('/api/bracket'), api.get('/api/teams')]);
    const rounds = ['OF', 'QF', 'SF', 'F'].map(r => matches.filter(m => m.round === r)).filter(r => r.length);
    view.innerHTML = `
      <div class="panel grid" style="margin-bottom:14px">
        <div class="row">
          <label>Počet účastníků:</label>
          <select id="bSize"><option>4</option><option>8</option><option>16</option></select>
          <button class="primary" id="bGen">Vygenerovat pavouka</button>
          <span class="muted">Smaže nic — přidá nové zápasy play-off. Týmy/placeholdery vybereš v dalším kroku.</span>
        </div>
      </div>
      ${rounds.length ? `<div class="bracket">${rounds.map(rm => `
        <div class="round">
          <h3 style="text-align:center">${{ OF: 'Osmifinále', QF: 'Čtvrtfinále', SF: 'Semifinále', F: 'Finále' }[rm[0].round]}</h3>
          ${rm.sort((a, b) => a.bracket_slot - b.bracket_slot).map(m => `
            <div class="bmatch">
              <div class="row"><span>${esc(teamLabel(m, 'home'))}</span><b>${m.status !== 'scheduled' ? m.home_score : ''}</b></div>
              <div class="row"><span>${esc(teamLabel(m, 'away'))}</span><b>${m.status !== 'scheduled' ? m.away_score : ''}</b></div>
              <div class="muted" style="font-size:12px">${fmtDateTime(m.scheduled_at)} ${m.hall_name ? '· ' + esc(m.hall_name) : ''}</div>
            </div>`).join('')}
        </div>`).join('')}</div>` : '<div class="panel muted">Pavouk zatím nevygenerován.</div>'}`;
    document.getElementById('bGen').onclick = async () => {
      const n = +document.getElementById('bSize').value;
      const entries = [];
      for (let i = 0; i < n; i++) entries.push({ placeholder: `Nasazený ${i + 1}` });
      await api.post('/api/bracket/generate', { entries });
      renders.bracket();
    };
  },

  // ---------- Šablony nastavení ----------
  async templates() {
    const tpls = await api.get('/api/templates');
    view.innerHTML = `
      <div class="panel grid" style="margin-bottom:14px">
        <h3 style="margin:0">Nová šablona</h3>
        <div class="row">
          <input id="tplName" placeholder="Název (např. Házená 2×30)" style="flex:1">
          <label>Poločas (min)</label><input id="tplLen" type="number" step="0.5" value="30" style="width:80px">
          <label>Poločasů</label><input id="tplPeriods" type="number" value="2" style="width:60px">
          <label>Timeouty</label><input id="tplTo" type="number" value="3" style="width:60px">
          <label>Vyloučení (s)</label><input id="tplSus" type="number" value="120" style="width:70px">
          <button class="primary" id="tplAdd">+ Přidat</button>
        </div>
        <span class="muted">Šablony se nabízejí při zakládání zápasu; po spuštění zápasu jdou hodnoty doladit v panelu haly.</span>
      </div>
      <div class="panel"><table><thead><tr>
        <th>Název</th><th>Poločas</th><th>Poločasů</th><th>Timeouty</th><th>Vyloučení</th><th></th>
      </tr></thead><tbody>
      ${tpls.map(t => `<tr data-tpl="${t.id}">
        <td><input value="${esc(t.name)}" data-f="name" style="width:200px"></td>
        <td><input type="number" step="0.5" value="${t.period_length_min}" data-f="period_length_min" style="width:70px"> min</td>
        <td><input type="number" value="${t.periods}" data-f="periods" style="width:55px"></td>
        <td><input type="number" value="${t.timeouts}" data-f="timeouts" style="width:55px"></td>
        <td><input type="number" value="${t.suspension_s}" data-f="suspension_s" style="width:65px"> s</td>
        <td class="row"><button data-savetpl="${t.id}">💾</button><button class="danger" data-deltpl="${t.id}">✕</button></td>
      </tr>`).join('')}</tbody></table></div>`;
    document.getElementById('tplAdd').onclick = async () => {
      const name = document.getElementById('tplName').value.trim();
      if (!name) return;
      await api.post('/api/templates', {
        name, period_length_min: +document.getElementById('tplLen').value || 30,
        periods: +document.getElementById('tplPeriods').value || 2,
        timeouts: +document.getElementById('tplTo').value || 0,
        suspension_s: +document.getElementById('tplSus').value || 120
      });
      renders.templates();
    };
    view.querySelectorAll('[data-savetpl]').forEach(b => b.onclick = () => {
      const tr = view.querySelector(`tr[data-tpl="${b.dataset.savetpl}"]`);
      const g = f => tr.querySelector(`[data-f="${f}"]`).value;
      api.put(`/api/templates/${b.dataset.savetpl}`, {
        name: g('name'), period_length_min: +g('period_length_min'), periods: +g('periods'),
        timeouts: +g('timeouts'), suspension_s: +g('suspension_s')
      });
    });
    view.querySelectorAll('[data-deltpl]').forEach(b => b.onclick = () => {
      if (confirm('Smazat šablonu?')) api.del(`/api/templates/${b.dataset.deltpl}`).then(renders.templates);
    });
  },

  // ---------- Média ----------
  async media() {
    const [items, halls] = await Promise.all([api.get('/api/media'), api.get('/api/halls')]);
    settings = await api.get('/api/settings');
    const videos = items.filter(m => m.type === 'video');
    const stingerOpts = `<option value="">— žádný —</option>` + videos.map(m =>
      `<option value="${m.id}" ${String(m.id) === String(settings.stinger_media_id) ? 'selected' : ''}>${esc(m.name || m.filename)}</option>`).join('');
    const weightOpts = sel => Array.from({ length: 10 }, (_, i) => i + 1)
      .map(w => `<option value="${w}" ${w === (sel || 5) ? 'selected' : ''}>${w}</option>`).join('');
    view.innerHTML = `
      <div class="panel grid" style="margin-bottom:14px">
        <div class="row">
          <input type="file" id="mFile" accept="video/*,image/*">
          <button class="primary" id="mUpload">Nahrát</button>
          <span id="mUploadStatus" class="muted">Videa „v rotaci" lze přehrát ze scénáře nebo ručně z Monitoringu (▶ Spot).</span>
        </div>
        <div class="row">
          <label>Přehrát spot teď na hale:</label>
          <select id="mHall">${halls.map(h => `<option value="${h.id}">${esc(h.name)}</option>`).join('')}</select>
          <span class="muted">u řádku spotu klikni „▶ Přehrát"</span>
        </div>
      </div>

      <div class="panel grid" style="margin-bottom:14px">
        <b>🎬 Reklamní bloky</b>
        <span class="muted">Reklamy se vybírají náhodně podle váhy (vyšší váha = častější zobrazení). Při „Reklamě" na hale se spustí stinger → spoty → stinger.</span>
        <div class="row" style="flex-wrap:wrap;gap:14px">
          <label>Stinger (přechod): <select id="adStinger">${stingerOpts}</select></label>
          <label title="Ve kterém % přehrávání stingeru se skrytě přepne na reklamu (bod plného překrytí)">Střih v: <input type="number" id="adCutPct" min="5" max="95" value="${esc(settings.stinger_cut_pct || '50')}" style="width:56px"> % stingeru</label>
          <button class="primary" id="adSave">Uložit</button>
        </div>
      </div>

      <div class="panel"><table style="table-layout:fixed;width:100%"><thead><tr><th style="width:80px">Pořadí</th><th>Název</th><th style="width:55px">Typ</th><th style="width:65px">V rotaci</th><th style="width:65px">Reklama</th><th style="width:80px">Váha</th><th style="width:65px">Kampaň</th><th style="width:170px"></th></tr></thead><tbody>
      ${items.map((m, i) => `<tr>
        <td class="row" style="flex-wrap:nowrap">
          <button data-move="up" data-id="${m.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button data-move="down" data-id="${m.id}" ${i === items.length - 1 ? 'disabled' : ''}>↓</button>
        </td>
        <td style="max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><a href="/media-files/${m.filename}" target="_blank" title="${esc(m.name)}">${esc(m.name)}</a></td>
        <td>${m.type}</td>
        <td><input type="checkbox" data-rot="${m.id}" ${m.in_rotation ? 'checked' : ''}></td>
        <td>${m.type === 'video' ? `<input type="checkbox" data-isad="${m.id}" ${m.is_ad ? 'checked' : ''}>` : ''}</td>
        <td>${m.type === 'video' ? `<select data-weight="${m.id}" ${m.is_ad ? '' : 'disabled'}>${weightOpts(m.weight)}</select>` : ''}</td>
        <td>${m.type === 'video' ? `<input type="checkbox" data-adactive="${m.id}" ${m.ad_active ? 'checked' : ''} ${m.is_ad ? '' : 'disabled'}>` : ''}</td>
        <td class="row" style="flex-wrap:nowrap">
          ${m.type === 'video' ? `<button class="success" data-play="${m.id}">▶ Přehrát</button>` : ''}
          <button class="danger" data-delmedia="${m.id}">✕</button>
        </td>
      </tr>`).join('')}</tbody></table></div>`;

    document.getElementById('adSave').onclick = async () => {
      await api.put('/api/settings', {
        stinger_media_id: document.getElementById('adStinger').value,
        stinger_cut_pct: document.getElementById('adCutPct').value
      });
      alert('Uloženo');
    };
    const putAd = (id, patch) => {
      const m = items.find(i => i.id === +id);
      api.put(`/api/media/${id}`, { name: m.name, ...patch });
    };
    view.querySelectorAll('[data-isad]').forEach(c => c.onchange = () => { putAd(c.dataset.isad, { is_ad: c.checked }); renders.media(); });
    view.querySelectorAll('[data-weight]').forEach(s => s.onchange = () => putAd(s.dataset.weight, { weight: +s.value }));
    view.querySelectorAll('[data-adactive]').forEach(c => c.onchange = () => putAd(c.dataset.adactive, { ad_active: c.checked }));
    document.getElementById('mUpload').onclick = async () => {
      const f = document.getElementById('mFile').files[0];
      const status = document.getElementById('mUploadStatus');
      const btn = document.getElementById('mUpload');
      if (!f) { status.textContent = 'Vyber soubor'; return; }
      btn.disabled = true;
      status.textContent = 'Nahrávám…';
      try {
        await uploadFile('/api/media/upload', f, {
          onProgress: (done, total) => {
            status.textContent = total > 1
              ? `Nahrávám… ${done}/${total} (${Math.round(done / total * 100)} %)`
              : 'Nahrávám…';
          }
        });
        await renders.media();
      } catch (e) {
        status.textContent = e.message || 'Nahrání selhalo';
        btn.disabled = false;
      }
    };
    view.querySelectorAll('[data-rot]').forEach(c => c.onchange = () => {
      const m = items.find(i => i.id === +c.dataset.rot);
      api.put(`/api/media/${m.id}`, { name: m.name, in_rotation: c.checked });
    });
    view.querySelectorAll('[data-move]').forEach(b => b.onclick = () =>
      api.post(`/api/media/${b.dataset.id}/move`, { dir: b.dataset.move }).then(renders.media));
    view.querySelectorAll('[data-play]').forEach(b => b.onclick = async () => {
      try {
        const r = await api.post(`/api/overlay/${document.getElementById('mHall').value}/spot`, { media_id: +b.dataset.play });
        if (r.error) alert('Spot: ' + r.error);
      } catch (e) {
        alert('Spot: ' + e.message);
      }
    });
    view.querySelectorAll('[data-delmedia]').forEach(b => b.onclick = () => {
      if (confirm('Smazat soubor?')) api.del(`/api/media/${b.dataset.delmedia}`).then(renders.media);
    });
  },

  // ---------- Loga (branding) ----------
  async branding() {
    const items = await api.get('/api/branding');
    const corners = { tl: 'vlevo nahoře', tr: 'vpravo nahoře', bl: 'vlevo dole', br: 'vpravo dole' };
    const cornerOpts = sel => Object.entries(corners).map(([v, l]) =>
      `<option value="${v}" ${v === sel ? 'selected' : ''}>${l}</option>`).join('');
    view.innerHTML = `
      <div class="panel grid" style="margin-bottom:14px">
        <div class="row">
          <input type="file" id="bFile" accept="image/*,video/*">
          <button class="primary" id="bUpload">Nahrát logo</button>
          <span id="bUploadStatus" class="muted">Obrázek (PNG s průhledností je ideál) nebo malé video. Loga jsou stále zapnutá, nezávisle na scoreboardu.</span>
        </div>
        <span class="muted">Víc log ve stejném rohu se střídá po ~8 s. Dolní rohy mohou kolidovat se skóre/lištou — doporučeny horní.</span>
      </div>
      <div class="panel"><table><thead><tr><th>Náhled</th><th>Název</th><th>Roh</th><th>Velikost (% výšky)</th><th>Zapnuto</th><th></th></tr></thead><tbody>
      ${items.map(b => `<tr data-b="${b.id}">
        <td>${b.type === 'video'
          ? `<video src="/media-files/${esc(b.filename)}" muted style="height:42px;background:#000"></video>`
          : `<img src="/media-files/${esc(b.filename)}" style="height:42px;background:#0003">`}</td>
        <td>${esc(b.name)}</td>
        <td><select data-f="corner">${cornerOpts(b.corner)}</select></td>
        <td><input type="number" data-f="size_pct" value="${b.size_pct}" style="width:70px" min="3" max="40"> %</td>
        <td><input type="checkbox" data-f="active" ${b.active ? 'checked' : ''}></td>
        <td class="row"><button data-saveb="${b.id}">💾</button><button class="danger" data-delb="${b.id}">✕</button></td>
      </tr>`).join('')}</tbody></table></div>`;
    document.getElementById('bUpload').onclick = async () => {
      const f = document.getElementById('bFile').files[0];
      const status = document.getElementById('bUploadStatus');
      const btn = document.getElementById('bUpload');
      if (!f) { status.textContent = 'Vyber soubor'; return; }
      btn.disabled = true;
      status.textContent = 'Nahrávám…';
      try {
        await uploadFile('/api/branding/upload', f, {
          onProgress: (done, total) => {
            status.textContent = total > 1
              ? `Nahrávám… ${done}/${total} (${Math.round(done / total * 100)} %)`
              : 'Nahrávám…';
          }
        });
        await renders.branding();
      } catch (e) {
        status.textContent = e.message || 'Nahrání selhalo';
        btn.disabled = false;
      }
    };
    view.querySelectorAll('[data-saveb]').forEach(b => b.onclick = () => {
      const tr = view.querySelector(`tr[data-b="${b.dataset.saveb}"]`);
      api.put(`/api/branding/${b.dataset.saveb}`, {
        corner: tr.querySelector('[data-f="corner"]').value,
        size_pct: +tr.querySelector('[data-f="size_pct"]').value || 10,
        active: tr.querySelector('[data-f="active"]').checked
      });
    });
    view.querySelectorAll('[data-delb]').forEach(b => b.onclick = () => {
      if (confirm('Smazat logo?')) api.del(`/api/branding/${b.dataset.delb}`).then(renders.branding);
    });
  },

  // ---------- Zprávy ----------
  async alerts() {
    const items = await api.get('/api/alerts?all=1');
    view.innerHTML = `
      <div class="panel grid" style="margin-bottom:14px">
        <div class="row">
          <input id="aText" placeholder="Text zprávy / alertu" style="flex:1">
          <select id="aLevel"><option value="info">Info</option><option value="warning">Upozornění</option><option value="important">Důležité</option></select>
          <button class="primary" id="aAdd">Zveřejnit</button>
        </div>
        <span class="muted">Aktivní zprávy se zobrazují v overlayi všech hal a na veřejném webu.</span>
      </div>
      <div class="panel"><table>
      <thead><tr><th>Zpráva</th><th>Typ</th><th>Stav</th><th></th></tr></thead><tbody>
      ${items.map(a => {
        const lvl = { info: ['Info', '#2f81f7'], warning: ['Upozornění', '#d29922'], important: ['Důležité', '#da3633'] }[a.level] || [a.level, '#8a98a6'];
        return `<tr style="${a.active ? '' : 'opacity:.45'}">
        <td>${esc(a.text)}</td>
        <td><span class="badge" style="background:${lvl[1]}">${lvl[0]}</span></td>
        <td>${a.active ? '<span class="badge live">Zobrazuje se</span>' : '<span class="badge finished">Skrytá</span>'}</td>
        <td class="row">
          <button data-toggle="${a.id}" data-active="${a.active}">${a.active ? 'Skrýt' : 'Zobrazit znovu'}</button>
          <button class="danger" data-delalert="${a.id}">✕ Smazat</button>
        </td>
      </tr>`; }).join('')}</tbody></table></div>`;
    document.getElementById('aAdd').onclick = async () => {
      const text = document.getElementById('aText').value.trim();
      if (text) { await api.post('/api/alerts', { text, level: document.getElementById('aLevel').value }); renders.alerts(); }
    };
    view.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () =>
      api.put(`/api/alerts/${b.dataset.toggle}`, { active: b.dataset.active !== '1' }).then(renders.alerts));
    view.querySelectorAll('[data-delalert]').forEach(b => b.onclick = () => {
      if (confirm('Smazat zprávu?')) api.del(`/api/alerts/${b.dataset.delalert}`).then(renders.alerts);
    });
  },

  // ---------- Nastavení ----------
  async settings() {
    const [halls, st, courts, services] = await Promise.all([
      api.get('/api/halls'), api.get('/api/settings'),
      api.get('/api/tournament/courts').catch(() => []),
      api.get('/api/broadcast-services').catch(() => [])
    ]);
    settings = st;
    const activeSvc = (services || []).find(s => s.active);
    const courtOpts = courts.length
      ? `<option value="">— nepropojeno —</option>` + courts.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')
      : `<option value="">— nejdříve uložte Supabase URL a klíč —</option>`;
    view.innerHTML = `
      <div class="panel grid" style="margin-bottom:14px">
        <h3 style="margin:0">Turnaj</h3>
        <div class="row"><label style="width:180px">Název turnaje</label><input id="sName" value="${esc(st.tournament_name)}" style="flex:1"></div>
        <div class="row"><label style="width:180px">Délka poločasu (min)</label><input id="sPeriod" value="${esc(st.period_length_min)}" style="width:80px"></div>
        <div class="row"><label style="width:180px">Body výhra/remíza/prohra</label>
          <input id="sPw" value="${esc(st.points_win)}" style="width:60px">
          <input id="sPd" value="${esc(st.points_draw)}" style="width:60px">
          <input id="sPl" value="${esc(st.points_loss)}" style="width:60px"></div>
        <div class="row"><button class="primary" id="sSave">Uložit</button></div>
      </div>
      <div class="panel grid" style="margin-bottom:14px">
        <h3 style="margin:0">Propojení s turnajovým systémem (Supabase)</h3>
        <div class="row"><label style="width:180px">Supabase URL</label><input id="tUrl" value="${esc(st.tournament_supabase_url || '')}" style="flex:1" placeholder="https://xxxx.supabase.co"></div>
        <div class="row"><label style="width:180px">Anon klíč</label><input id="tKey" value="${esc(st.tournament_supabase_anon_key || '')}" style="flex:1" type="password"></div>
        <div class="row">
          <button class="primary" id="tSave">Uložit a obnovit hřiště</button>
          <span id="tStatus" class="muted" style="margin-left:10px"></span>
        </div>
      </div>
      <div class="panel grid" style="margin-bottom:14px">
        <h3 style="margin:0">Zvuková trubka</h3>
        <p class="muted" style="margin:0">Vlastní MP3 pro konec poločasu a timeout. Bez souboru hraje výchozí vlaková trubka. Zvuk jde ze světelného panelu a do streamu, ne z ovládání haly.</p>
        <div class="row" style="align-items:center;gap:10px;flex-wrap:wrap">
          <span id="hornState">${st.horn_filename ? 'Nahráno: vlastní MP3' : 'Výchozí vlaková trubka'}</span>
          <label class="primary" style="padding:6px 12px;cursor:pointer">
            Nahrát MP3
            <input id="hornFile" type="file" accept="audio/mpeg,.mp3" hidden>
          </label>
          <button type="button" id="hornPlay">Vyzkoušet</button>
          <button type="button" id="hornReset" ${st.horn_filename ? '' : 'disabled'}>Obnovit výchozí</button>
          <span id="hornStatus" class="muted"></span>
        </div>
      </div>
      <div class="panel grid" style="margin-bottom:14px">
        <h3 style="margin:0">Vysílací cesty</h3>
        <p class="muted" style="margin:0">Aktivní cesta je RTMP server, na který jde stream ze všech hal. YouTube zůstává jako výchozí; další služby přidej s vlastní RTMP adresou.</p>
        <table>
          <thead><tr><th>Aktivní</th><th>Název</th><th>RTMP adresa</th><th></th></tr></thead>
          <tbody>
          ${(services || []).map(s => `<tr data-svc="${s.id}">
            <td><input type="radio" name="activeSvc" data-activate="${s.id}" ${s.active ? 'checked' : ''} title="Nastavit jako aktivní"></td>
            <td><input value="${esc(s.name)}" data-f="name"></td>
            <td><input value="${esc(s.rtmp_url)}" data-f="rtmp_url" style="width:100%;min-width:240px"></td>
            <td class="row">
              <button data-savesvc="${s.id}">💾</button>
              ${s.builtin ? '' : `<button class="danger" data-delsvc="${s.id}">✕</button>`}
            </td>
          </tr>`).join('')}
          </tbody>
        </table>
        <div class="row">
          <input id="svcName" placeholder="Název služby">
          <input id="svcUrl" placeholder="rtmp://server/live" style="flex:1">
          <button class="primary" id="svcAdd">+ Přidat cestu</button>
        </div>
      </div>
      <div class="panel grid">
        <h3 style="margin:0">Haly</h3>
        <table><thead><tr><th>Název</th><th>Stream key</th><th>Vysílací klíč</th><th>YT video ID</th><th>Hřiště</th><th>Agent / setup</th><th></th></tr></thead>
        <tbody id="hRows">
        ${halls.map(h => `<tr data-hall="${h.id}">
          <td><input value="${esc(h.name)}" data-f="name"></td>
          <td><input value="${esc(h.stream_key)}" data-f="stream_key"></td>
          <td><input value="${esc(h.yt_stream_key)}" data-f="yt_stream_key" type="password"></td>
          <td><input value="${esc(h.yt_video_id)}" data-f="yt_video_id" style="width:140px"></td>
          <td><select data-f="tournament_court_id" style="width:160px">${courtOpts}</select></td>
          <td class="muted" style="font-size:11px;max-width:200px">
            <a href="/dock/?hall=${h.id}" target="_blank">🖥 OBS panel</a>
            · <a href="/setup/${h.id}" target="_blank">⚙ setup</a>
            ${me.role === 'admin' ? `<br><button type="button" data-regentoken="${h.id}" style="margin-top:4px;font-size:11px">🔄 Nový agent token</button>` : ''}
            <span data-tokhint="${h.id}" style="display:block;margin-top:2px;word-break:break-all">${h.agent_token ? esc(h.agent_token.slice(0, 12)) + '…' : '—'}</span>
          </td>
          <td class="row"><button data-savehall="${h.id}">💾</button><button class="danger" data-delhall="${h.id}">✕</button></td>
        </tr>`).join('')}</tbody></table>
        <div class="row">
          <input id="hName" placeholder="Název haly">
          <input id="hKey" placeholder="stream key (např. hall1)">
          <button class="primary" id="hAdd">+ Přidat halu</button>
        </div>
        <span class="muted">OBS vysílá přímo na aktivní cestu (${esc(activeSvc?.name || '—')}) — cíl nastav ručně v OBS. Agent posílá jen náhled plochy. Po změně agent tokenu znovu sestav instalátor:
          <code>node tools/build-installer.mjs --hall N --server https://…</code></span>
      </div>`;
    // Set current court selection per hall
    for (const h of halls) {
      const sel = view.querySelector(`tr[data-hall="${h.id}"] [data-f="tournament_court_id"]`);
      if (sel && h.tournament_court_id) sel.value = h.tournament_court_id;
    }
    document.getElementById('sSave').onclick = () => api.put('/api/settings', {
      tournament_name: document.getElementById('sName').value,
      period_length_min: document.getElementById('sPeriod').value,
      points_win: document.getElementById('sPw').value,
      points_draw: document.getElementById('sPd').value,
      points_loss: document.getElementById('sPl').value
    });
    document.getElementById('tSave').onclick = async () => {
      const status = document.getElementById('tStatus');
      status.textContent = 'Ukládám…';
      await api.put('/api/settings', {
        tournament_supabase_url: document.getElementById('tUrl').value.trim(),
        tournament_supabase_anon_key: document.getElementById('tKey').value.trim()
      });
      status.textContent = 'Uloženo — načítám hřiště…';
      await renders.settings();
    };
    const hornState = document.getElementById('hornState');
    const hornStatus = document.getElementById('hornStatus');
    const setHornUi = (custom) => {
      hornState.textContent = custom ? 'Nahráno: vlastní MP3' : 'Výchozí vlaková trubka';
      document.getElementById('hornReset').disabled = !custom;
    };
    document.getElementById('hornFile').onchange = async e => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      hornStatus.textContent = 'Nahrávám…';
      const fd = new FormData();
      fd.append('file', file, file.name);
      const r = await fetch('/api/horn/upload', { method: 'POST', body: fd, credentials: 'include' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { hornStatus.textContent = d.error || 'Nahrání selhalo'; return; }
      setHornUrl(d.url || null);
      setHornUi(!!d.url);
      hornStatus.textContent = 'Uloženo';
    };
    document.getElementById('hornPlay').onclick = () => {
      unlockHorn();
      playHorn('timeout-start');
    };
    document.getElementById('hornReset').onclick = async () => {
      if (!confirm('Vrátit výchozí vlakovou trubku?')) return;
      await api.del('/api/horn');
      setHornUrl(null);
      setHornUi(false);
      hornStatus.textContent = 'Výchozí zvuk obnoven';
    };
    loadHornConfig();
    document.getElementById('hAdd').onclick = async () => {
      const name = document.getElementById('hName').value.trim(), key = document.getElementById('hKey').value.trim();
      if (name && key) { await api.post('/api/halls', { name, stream_key: key }); renders.settings(); }
    };
    view.querySelectorAll('[data-savehall]').forEach(b => b.onclick = () => {
      const tr = view.querySelector(`tr[data-hall="${b.dataset.savehall}"]`);
      const get = f => tr.querySelector(`[data-f="${f}"]`).value;
      const hall = halls.find(h => h.id === +b.dataset.savehall);
      api.put(`/api/halls/${hall.id}`, { name: get('name'), stream_key: get('stream_key'),
        yt_stream_key: get('yt_stream_key'), yt_video_id: get('yt_video_id'),
        tournament_court_id: get('tournament_court_id') });
    });
    document.getElementById('svcAdd').onclick = async () => {
      const name = document.getElementById('svcName').value.trim();
      const rtmp_url = document.getElementById('svcUrl').value.trim();
      if (!name || !rtmp_url) return alert('Vyplň název a RTMP adresu');
      const r = await api.post('/api/broadcast-services', { name, rtmp_url });
      if (r.error) return alert(r.error);
      renders.settings();
    };
    view.querySelectorAll('[data-savesvc]').forEach(b => b.onclick = async () => {
      const tr = view.querySelector(`tr[data-svc="${b.dataset.savesvc}"]`);
      const get = f => tr.querySelector(`[data-f="${f}"]`).value;
      const r = await api.put(`/api/broadcast-services/${b.dataset.savesvc}`, { name: get('name'), rtmp_url: get('rtmp_url') });
      if (r.error) return alert(r.error);
    });
    view.querySelectorAll('[data-delsvc]').forEach(b => b.onclick = async () => {
      if (!confirm('Smazat vysílací cestu?')) return;
      const r = await api.del(`/api/broadcast-services/${b.dataset.delsvc}`);
      if (r.error) return alert(r.error);
      renders.settings();
    });
    view.querySelectorAll('[data-activate]').forEach(el => el.onchange = async () => {
      if (!el.checked) return;
      const r = await api.post(`/api/broadcast-services/${el.dataset.activate}/activate`, {});
      if (r.error) { alert(r.error); renders.settings(); return; }
      renders.settings();
    });
    view.querySelectorAll('[data-delhall]').forEach(b => b.onclick = () => {
      if (confirm('Smazat halu?')) api.del(`/api/halls/${b.dataset.delhall}`).then(renders.settings);
    });
    view.querySelectorAll('[data-regentoken]').forEach(b => b.onclick = async () => {
      if (!confirm('Vygenerovat nový agent token? Stávající notebook se odpojí — bude potřeba nový instalátor.')) return;
      const r = await api.post(`/api/halls/${b.dataset.regentoken}/regenerate-agent-token`, {});
      const hint = view.querySelector(`[data-tokhint="${b.dataset.regentoken}"]`);
      if (hint && r.agent_token) hint.textContent = r.agent_token.slice(0, 12) + '…';
      alert('Nový token uložen. Znovu sestav multimix-setup-hala-' + b.dataset.regentoken + '.exe');
    });
  },

  // ---------- Používatelia (admin only) ----------
  async users() {
    const [users, halls] = await Promise.all([api.get('/api/users'), api.get('/api/halls')]);
    const roleLabel = { admin: 'Admin', reziser: 'Režisér', hall: 'Hala' };
    view.innerHTML = `
      <div class="panel grid">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin:0">Správa uživatelů</h3>
          <button class="primary" id="uAdd">+ Nový uživatel</button>
        </div>
        <table>
          <thead><tr><th>Jméno</th><th>Role</th><th>Haly</th><th></th></tr></thead>
          <tbody id="uBody">
          ${users.map(u => `
            <tr data-uid="${u.id}">
              <td><b>${esc(u.username)}</b></td>
              <td><span class="badge ${u.role === 'admin' ? 'live' : u.role === 'reziser' ? 'scheduled' : 'finished'}">${roleLabel[u.role] ?? u.role}</span></td>
              <td class="muted" id="uhalls-${u.id}">…</td>
              <td class="row" style="gap:6px;justify-content:flex-end">
                <button data-edit="${u.id}">Upravit</button>
                <button class="danger" data-del="${u.id}" ${u.id === me.id ? 'disabled title="Nemůžeš smazat sebe"' : ''}>Smazat</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    // Load hall assignments for each user
    for (const u of users) {
      api.get(`/api/users/${u.id}/halls`).then(hids => {
        const el = document.getElementById(`uhalls-${u.id}`);
        if (!el) return;
        const names = hids.map(id => halls.find(h => h.id === id)?.name ?? id).join(', ');
        el.textContent = names || (u.role === 'hall' ? '(žádná)' : '—');
      });
    }

    view.querySelector('#uAdd').onclick = () => openUserModal(null, halls);
    view.querySelectorAll('[data-edit]').forEach(b => openUserModal(users.find(u => u.id === +b.dataset.edit), halls, b));
    view.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm(`Smazat uživatele "${users.find(u => u.id === +b.dataset.del)?.username}"?`)) return;
      await api.del(`/api/users/${b.dataset.del}`);
      renders.users();
    });
  },

  // ---------- Scénáře ----------
  async scenarios() {
    const [media, halls, scenList, st] = await Promise.all([
      api.get('/api/media'), api.get('/api/halls'), api.get('/api/scenarios'), api.get('/api/settings')
    ]);
    settings = st;
    const videos = media.filter(m => m.type === 'video');
    const STEP_LABELS = { spot: 'Spot', adbreak: 'Reklama', lineups: 'Soupisky', upcoming: 'Další zápasy', wait: 'Čekání' };
    const videoOpts = videos.map(v => `<option value="${v.id}">${esc(v.name || v.filename)}</option>`).join('');
    const autoScenSelect = (key) => {
      const cur = String(settings[key] || '');
      return `<select id="${key}" style="min-width:180px;flex:1">
        <option value="">— vypnuto —</option>
        ${scenList.map(s => `<option value="${s.id}" ${String(s.id) === cur ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
      </select>`;
    };
    const autoRow = (label, idKey, delayKey, fallback) => `
      <div class="row" style="flex-wrap:wrap;gap:8px;align-items:center">
        <label style="min-width:280px">${label}</label>
        ${autoScenSelect(idKey)}
        <label>zpoždění <input type="number" id="${delayKey}" min="0" max="600" value="${esc(settings[delayKey] ?? fallback)}" style="width:64px"> s</label>
      </div>`;

    view.innerHTML = `
      <div class="panel grid" style="margin-bottom:12px">
        <b>Automatické spouštění</b>
        <p class="muted" style="margin:0">Scénář se nespouští při doběhnutí hodin, ale až když obsluha potvrdí konec poločasu tlačítkem, aby skóre zůstalo chvíli na obrazovce.</p>
        ${autoRow('Po 1. poločasu (tlačítko poločas ▶)', 'auto_scen_period1_id', 'auto_scen_period1_delay', '30')}
        ${autoRow('Po 2. poločasu (poločas ▶ nebo Ukončit zápas)', 'auto_scen_period2_id', 'auto_scen_period2_delay', '15')}
        ${autoRow('Po prodloužení', 'auto_scen_overtime_id', 'auto_scen_overtime_delay', '15')}
        ${autoRow('Při timeoutu', 'auto_scen_timeout_id', 'auto_scen_timeout_delay', '0')}
        <div class="row"><button class="primary" id="autoScenSave">Uložit automatiku</button></div>
      </div>
      <div class="panel grid" style="margin-bottom:12px">
        <div class="row" style="gap:8px">
          <input id="newScenName" placeholder="Název nového scénáře" style="flex:1">
          <button class="primary" id="addScen">+ Přidat scénář</button>
        </div>
      </div>
      <div id="scenList"></div>`;

    document.getElementById('autoScenSave').onclick = async () => {
      await api.put('/api/settings', {
        auto_scen_period1_id: document.getElementById('auto_scen_period1_id').value,
        auto_scen_period1_delay: document.getElementById('auto_scen_period1_delay').value,
        auto_scen_period2_id: document.getElementById('auto_scen_period2_id').value,
        auto_scen_period2_delay: document.getElementById('auto_scen_period2_delay').value,
        auto_scen_overtime_id: document.getElementById('auto_scen_overtime_id').value,
        auto_scen_overtime_delay: document.getElementById('auto_scen_overtime_delay').value,
        auto_scen_timeout_id: document.getElementById('auto_scen_timeout_id').value,
        auto_scen_timeout_delay: document.getElementById('auto_scen_timeout_delay').value,
      });
      alert('Uloženo');
    };

    function stepParamsHtml(type, p) {
      if (type === 'spot')
        return `<select class="p-media">${videoOpts || '<option value="">žádné video</option>'}</select>`;
      if (type === 'adbreak')
        return `<label style="font-size:13px">Počet spotů:</label>
          <input type="number" class="p-count" value="${p.count ?? 1}" min="1" max="20" style="width:60px">`;
      if (type === 'lineups' || type === 'upcoming')
        return `<label style="font-size:13px">Trvání:</label>
          <input type="number" class="p-duration" value="${p.duration_s ?? 30}" min="5" max="300" style="width:70px">
          <span style="font-size:13px">s</span>`;
      if (type === 'wait')
        return `<label style="font-size:13px">Sekund:</label>
          <input type="number" class="p-seconds" value="${p.seconds ?? 5}" min="1" max="300" style="width:70px">`;
      return '';
    }

    function collectParams(ed, type) {
      if (type === 'spot')    return { media_id: +(ed.querySelector('.p-media')?.value) || null };
      if (type === 'adbreak') {
        return { count: +(ed.querySelector('.p-count')?.value || 1) };
      }
      if (type === 'lineups' || type === 'upcoming') return { duration_s: +(ed.querySelector('.p-duration')?.value || 30) };
      if (type === 'wait')    return { seconds: +(ed.querySelector('.p-seconds')?.value || 5) };
      return {};
    }

    async function renderSteps(scenarioId, box) {
      const steps = await api.get(`/api/scenarios/${scenarioId}/steps`);

      function stepRow(step) {
        const p = JSON.parse(step?.params || '{}');
        const type = step?.type ?? 'spot';
        const isNew = !step;
        return `<div class="step-editor" data-stepid="${step?.id ?? ''}" style="background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:6px">
          <div class="row" style="gap:6px;flex-wrap:wrap;align-items:center">
            <select class="step-type" style="min-width:130px">
              ${Object.entries(STEP_LABELS).map(([v, l]) => `<option value="${v}" ${type === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
            <div class="step-params" style="flex:1;display:flex;gap:6px;align-items:center;flex-wrap:wrap">${stepParamsHtml(type, p)}</div>
            ${!isNew ? `<button class="btn-mv" data-mv="up" data-sid="${step.id}">↑</button>
                        <button class="btn-mv" data-mv="down" data-sid="${step.id}">↓</button>
                        <button class="danger btn-delstep" data-sid="${step.id}">✕</button>` : ''}
            ${isNew ? `<button class="primary btn-addstep">+ Přidat</button>` : ''}
          </div>
        </div>`;
      }

      box.innerHTML = `<div style="border-top:1px solid var(--border);padding-top:10px;margin-top:6px">
        <div id="steplist-${scenarioId}">${steps.map(s => stepRow(s)).join('')}</div>
        <div style="margin-top:8px;color:var(--muted);font-size:13px">Přidat krok:</div>
        ${stepRow(null)}
      </div>`;

      // restore select values for existing steps (media_id)
      box.querySelectorAll('[data-stepid]').forEach((ed, i) => {
        if (!ed.dataset.stepid || !steps[i]) return;
        const p = JSON.parse(steps[i].params || '{}');
        const ms = ed.querySelector('.p-media');
        if (ms && p.media_id) ms.value = String(p.media_id);
      });

      // type change → swap params
      box.querySelectorAll('.step-editor').forEach(ed => {
        ed.querySelector('.step-type').onchange = e => {
          ed.querySelector('.step-params').innerHTML = stepParamsHtml(e.target.value, {});
        };
      });

      // save existing step on change
      box.querySelectorAll('[data-stepid]').forEach(ed => {
        if (!ed.dataset.stepid) return;
        const saveStep = () => {
          const type = ed.querySelector('.step-type').value;
          api.put(`/api/scenario-steps/${ed.dataset.stepid}`, { type, params: collectParams(ed, type) });
        };
        ed.querySelector('.step-type').addEventListener('change', saveStep);
        ed.querySelectorAll('input, select:not(.step-type)').forEach(i => { i.onchange = saveStep; i.onblur = saveStep; });
      });

      box.querySelector('.btn-addstep')?.addEventListener('click', async () => {
        const ed = box.querySelector('.btn-addstep').closest('.step-editor');
        const type = ed.querySelector('.step-type').value;
        await api.post(`/api/scenarios/${scenarioId}/steps`, { type, params: collectParams(ed, type) });
        await renderSteps(scenarioId, box);
      });

      box.querySelectorAll('.btn-delstep').forEach(b => b.onclick = async () => {
        await api.del(`/api/scenario-steps/${b.dataset.sid}`);
        await renderSteps(scenarioId, box);
      });

      box.querySelectorAll('.btn-mv').forEach(b => b.onclick = async () => {
        const cur = await api.get(`/api/scenarios/${scenarioId}/steps`);
        const idx = cur.findIndex(s => s.id === +b.dataset.sid);
        const swap = b.dataset.mv === 'up' ? idx - 1 : idx + 1;
        if (idx < 0 || swap < 0 || swap >= cur.length) return;
        await Promise.all([
          api.put(`/api/scenario-steps/${cur[idx].id}`, { step_order: cur[swap].step_order }),
          api.put(`/api/scenario-steps/${cur[swap].id}`, { step_order: cur[idx].step_order })
        ]);
        await renderSteps(scenarioId, box);
      });
    }

    async function renderList() {
      const list = await api.get('/api/scenarios');
      const el = document.getElementById('scenList');
      if (!el) return;
      if (!list.length) { el.innerHTML = '<div class="panel muted">Zatím žádné scénáře.</div>'; return; }
      el.innerHTML = list.map(s => `
        <div class="panel grid" style="margin-bottom:10px" data-scen="${s.id}">
          <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
            <b>${esc(s.name)}</b>
            <div class="row" style="gap:6px">
              <select data-runsel="${s.id}" style="min-width:110px">
                ${halls.map(h => `<option value="${h.id}">${esc(h.name)}</option>`).join('')}
              </select>
              <button class="success" data-run="${s.id}">▶ Spustit</button>
              <button data-editscen="${s.id}">✎ Kroky</button>
              <button class="danger" data-delscen="${s.id}">✕</button>
            </div>
          </div>
          <div id="steps-${s.id}" style="display:none"></div>
        </div>`).join('');

      el.querySelectorAll('[data-run]').forEach(b => b.onclick = async () => {
        const sid = b.dataset.run;
        const hallId = el.querySelector(`[data-runsel="${sid}"]`)?.value;
        if (!hallId) return;
        try {
          const r = await api.post(`/api/scenarios/${sid}/run?hallId=${hallId}`, {});
          if (r.error) alert('Chyba: ' + r.error);
          else { b.textContent = '✓'; setTimeout(() => { b.textContent = '▶ Spustit'; }, 2000); }
        } catch (e) {
          alert('Chyba: ' + e.message);
        }
      });

      el.querySelectorAll('[data-delscen]').forEach(b => b.onclick = async () => {
        if (!confirm('Smazat scénář?')) return;
        await api.del(`/api/scenarios/${b.dataset.delscen}`);
        renderList();
      });

      el.querySelectorAll('[data-editscen]').forEach(b => b.onclick = async () => {
        const sid = +b.dataset.editscen;
        const box = document.getElementById(`steps-${sid}`);
        if (box.style.display !== 'none') { box.style.display = 'none'; return; }
        box.style.display = '';
        await renderSteps(sid, box);
      });
    }

    document.getElementById('addScen').onclick = async () => {
      const inp = document.getElementById('newScenName');
      const name = inp.value.trim();
      if (!name) return;
      await api.post('/api/scenarios', { name });
      inp.value = '';
      await renderList();
    };

    await renderList();
  }
};

// ---------- user modal ----------
function openUserModal(user, halls, triggerBtn) {
  if (triggerBtn) {
    triggerBtn.onclick = () => _openModal(user, halls);
  } else {
    _openModal(user, halls);
  }
}
async function _openModal(user, halls) {
  const assignedHalls = user ? await api.get(`/api/users/${user.id}/halls`) : [];
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal grid" style="min-width:380px">
    <h3 style="margin:0">${user ? 'Upravit uživatele' : 'Nový uživatel'}</h3>
    <div class="field"><label>Jméno</label><input id="muName" value="${esc(user?.username ?? '')}"></div>
    <div class="field"><label>Heslo ${user ? '(nech prázdné = bez změny)' : ''}</label><input id="muPwd" type="password" placeholder="${user ? 'nové heslo…' : 'heslo'}"></div>
    <div class="field"><label>Role</label>
      <select id="muRole">
        <option value="admin" ${user?.role === 'admin' ? 'selected' : ''}>Admin</option>
        <option value="reziser" ${user?.role === 'reziser' ? 'selected' : ''}>Režisér</option>
        <option value="hall" ${(!user || user?.role === 'hall') ? 'selected' : ''}>Hala</option>
      </select>
    </div>
    <div id="muHallsWrap"><label style="font-size:13px;color:var(--muted)">Přístup k halám</label>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">
        ${halls.map(h => `<label style="display:flex;gap:4px;align-items:center">
          <input type="checkbox" value="${h.id}" ${assignedHalls.includes(h.id) ? 'checked' : ''}> ${esc(h.name)}
        </label>`).join('')}
      </div>
    </div>
    <div class="row" style="justify-content:flex-end">
      <button id="muCancel">Zrušit</button>
      <button class="primary" id="muSave">Uložit</button>
    </div>
  </div>`;
  document.body.appendChild(bg);

  const roleEl = bg.querySelector('#muRole');
  const hallsWrap = bg.querySelector('#muHallsWrap');
  const toggleHalls = () => { hallsWrap.style.display = roleEl.value === 'hall' ? '' : 'none'; };
  roleEl.onchange = toggleHalls;
  toggleHalls();

  bg.querySelector('#muCancel').onclick = () => bg.remove();
  bg.querySelector('#muSave').onclick = async () => {
    const body = {
      username: bg.querySelector('#muName').value.trim(),
      role: roleEl.value
    };
    const pwd = bg.querySelector('#muPwd').value;
    if (pwd) body.password = pwd;
    if (!body.username) return;
    const saved = user ? await api.put(`/api/users/${user.id}`, body) : await api.post('/api/users', { ...body, password: pwd });
    if (saved.error) { alert(saved.error); return; }
    const halls = [...bg.querySelectorAll('#muHallsWrap input:checked')].map(c => +c.value);
    await api.put(`/api/users/${saved.id}/halls`, { halls });
    bg.remove();
    renders.users();
  };
}

// ---------- helpers ----------
// Lower CSS order = higher on the Monitoring grid.
// 0:00 stopped and halls without a live match first (videos), then remaining time to period end.
function monitorOrder(m) {
  if (!m) return 0;
  const elapsed = m.elapsed_ms ?? 0;
  if (!m.timer_running && elapsed < 500) return 0;
  return Math.max(0, (m.period_target_ms || 0) - elapsed) + 1;
}

async function refreshMonitorScores() {
  const halls = await api.get('/api/halls');
  const lives = await Promise.all(halls.map(h => api.get(`/api/halls/${h.id}/live`)));
  halls.forEach((h, i) => {
    const box = document.getElementById(`m-${h.id}`);
    if (!box) return;
    const m = lives[i];
    box.innerHTML = m
      ? `<b>${esc(teamLabel(m, 'home'))} ${m.home_score} : ${m.away_score} ${esc(teamLabel(m, 'away'))}</b> · ${m.period}. pol · ${fmtTime(m.elapsed_ms)}`
      : 'Žádný živý zápas';
    const card = box.closest('.monitor');
    if (!card) return;
    const next = String(monitorOrder(m));
    if (card.style.order !== next) card.style.order = next;
  });
}

async function toggleRoster(teamId) {
  const box = document.getElementById(`roster-${teamId}`);
  if (box.innerHTML) { box.innerHTML = ''; return; }
  const players = await api.get(`/api/teams/${teamId}/players`);
  box.innerHTML = `
    <table style="margin-top:8px"><tbody>
    ${players.map(p => `<tr><td style="width:60px">#${p.number ?? ''}</td><td>${esc(p.name)}</td>
      <td class="muted">${esc(p.position)}</td>
      <td style="width:40px"><button class="danger" data-delp="${p.id}">✕</button></td></tr>`).join('')}
    </tbody></table>
    <div class="row" style="margin-top:8px">
      <input placeholder="Č." style="width:60px" id="pNum-${teamId}">
      <input placeholder="Jméno hráče" id="pName-${teamId}">
      <input placeholder="Post" style="width:110px" id="pPos-${teamId}">
      <button class="primary" id="pAdd-${teamId}">+ Přidat</button>
    </div>`;
  box.querySelectorAll('[data-delp]').forEach(b => b.onclick = async () => {
    await api.del(`/api/players/${b.dataset.delp}`); box.innerHTML = ''; toggleRoster(teamId);
  });
  document.getElementById(`pAdd-${teamId}`).onclick = async () => {
    const name = document.getElementById(`pName-${teamId}`).value.trim();
    if (!name) return;
    await api.post(`/api/teams/${teamId}/players`, {
      number: +document.getElementById(`pNum-${teamId}`).value || null,
      name, position: document.getElementById(`pPos-${teamId}`).value.trim()
    });
    box.innerHTML = ''; toggleRoster(teamId);
  };
}

function matchForm(m, { halls, teams, groups, templates = [] }) {
  const teamOpts = sel => `<option value="">— TBD —</option>` +
    teams.map(t => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal grid">
    <h3 style="margin:0">${m ? 'Upravit zápas' : 'Nový zápas'}</h3>
    <div class="row"><label style="width:110px">Čas</label>
      <input type="datetime-local" id="fTime" value="${m?.scheduled_at?.slice(0, 16) ?? ''}"></div>
    <div class="row"><label style="width:110px">Hala</label>
      <select id="fHall"><option value="">—</option>${halls.map(h =>
        `<option value="${h.id}" ${h.id === m?.hall_id ? 'selected' : ''}>${esc(h.name)}</option>`).join('')}</select></div>
    <div class="row"><label style="width:110px">Fáze</label>
      <select id="fStage"><option value="group" ${m?.stage === 'group' ? 'selected' : ''}>Skupina</option>
        <option value="playoff" ${m?.stage === 'playoff' ? 'selected' : ''}>Play-off</option></select>
      <select id="fGroup"><option value="">— skupina —</option>${groups.map(g =>
        `<option value="${g.id}" ${g.id === m?.group_id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div>
    <div class="row"><label style="width:110px">Domácí</label><select id="fHome">${teamOpts(m?.home_team_id)}</select></div>
    <div class="row"><label style="width:110px">Hosté</label><select id="fAway">${teamOpts(m?.away_team_id)}</select></div>
    ${m ? '' : `<div class="row"><label style="width:110px">Šablona</label>
      <select id="fTpl">${templates.map((t, i) =>
        `<option value="${t.id}" ${i === 0 ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      <span class="muted">délka poločasu / timeouty / vyloučení</span></div>`}
    <div class="row" style="justify-content:flex-end">
      <button id="fCancel">Zrušit</button><button class="primary" id="fSave">Uložit</button></div>
  </div>`;
  document.body.appendChild(bg);
  bg.querySelector('#fCancel').onclick = () => bg.remove();
  bg.querySelector('#fSave').onclick = async () => {
    const body = {
      ...m,
      scheduled_at: bg.querySelector('#fTime').value || null,
      hall_id: +bg.querySelector('#fHall').value || null,
      stage: bg.querySelector('#fStage').value,
      group_id: +bg.querySelector('#fGroup').value || null,
      home_team_id: +bg.querySelector('#fHome').value || null,
      away_team_id: +bg.querySelector('#fAway').value || null
    };
    if (m) await api.put(`/api/matches/${m.id}`, body);
    else await api.post('/api/matches', { ...body, template_id: +bg.querySelector('#fTpl')?.value || null });
    bg.remove();
    renders.schedule();
  };
}

show('monitor');
