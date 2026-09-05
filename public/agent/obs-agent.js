'use strict';
// MultiMix OBS Agent – runs on the hall notebook.
// Connects OUTBOUND to the central server (no inbound port needed).
// Controls local OBS over obs-websocket on localhost only.
// Bundled into a standalone .exe via pkg (no Node.js install required).
const { io }   = require('socket.io-client');
const WebSocket = require('ws');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const net      = require('net');
const http     = require('http');
const https    = require('https');
const { spawn } = require('child_process');

const AGENT_VERSION = '__VERSION__';

// When bundled with pkg, process.execPath = path to the .exe itself
const BASE_DIR = path.dirname(process.execPath);

function appDataDir() {
  return process.env.APPDATA ||
    path.join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Roaming');
}

function looksLikeHtml(raw) {
  const s = String(raw || '').replace(/^\uFEFF/, '').trimStart().slice(0, 80).toLowerCase();
  return s.startsWith('<!doctype') || s.startsWith('<html') || s.includes('<form');
}

function looksLikeAgentConfig(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const token = String(obj.token || '');
  return token.length >= 16 && (obj.hall != null || obj.server);
}

function configSearchDirs() {
  const dirs = [BASE_DIR];
  const appData = appDataDir();
  // Correct install dir: %AppData%\MultiMix  (== ...\AppData\Roaming\MultiMix)
  const correct = path.join(appData, 'MultiMix');
  // Old setup page wrongly said %AppData%\Roaming\MultiMix → nested Roaming\Roaming
  const mistaken = path.join(appData, 'Roaming', 'MultiMix');
  for (const d of [correct, mistaken]) {
    if (!dirs.some(x => path.resolve(x).toLowerCase() === path.resolve(d).toLowerCase())) dirs.push(d);
  }
  return dirs;
}

function listCandidateConfigFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter(n => /^agent-config.*\.json$/i.test(n) || /^config\.json$/i.test(n))
    .map(n => path.join(dir, n));
}

function parseAgentConfigFile(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (e) {
    console.error('[Agent] Nelze číst ' + filePath + ': ' + e.message);
    return null;
  }
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  if (looksLikeHtml(raw)) {
    console.error('[Agent] Soubor ' + filePath + ' není JSON — vypadá jako HTML přihlašovací stránka.');
    console.error('[Agent] Stáhni agent-config.json ze stránky /setup/ AŽ PO přihlášení (ne anonymně).');
    return null;
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    console.error('[Agent] Soubor ' + filePath + ' není platný JSON: ' + e.message);
    return null;
  }
  if (!looksLikeAgentConfig(parsed)) {
    console.warn('[Agent] Soubor ' + filePath + ' není konfigurace agenta (chybí token) — přeskakuji');
    return null;
  }
  let mtime = 0;
  try { mtime = fs.statSync(filePath).mtimeMs; } catch {}
  return { cfg: parsed, cfgPath: filePath, mtime };
}

function loadAgentConfig() {
  const found = [];
  for (const dir of configSearchDirs()) {
    for (const filePath of listCandidateConfigFiles(dir)) {
      const parsed = parseAgentConfigFile(filePath);
      if (parsed) found.push(parsed);
    }
  }
  if (!found.length) return { cfg: {}, cfgPath: null };
  found.sort((a, b) => b.mtime - a.mtime);
  const best = found[0];
  if (found.length > 1) {
    console.warn('[Agent] Nalezeno více konfiguračních souborů, beru nejnovější:');
    for (const f of found) {
      const pfx = String(f.cfg.token || '').slice(0, 8);
      console.warn('         ' + f.cfgPath + ' (token ' + pfx + '…, hala ' + f.cfg.hall + ')');
    }
  }
  return best;
}

function writeCanonicalConfig(cfg) {
  const dest = path.join(appDataDir(), 'MultiMix', 'agent-config.json');
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const body = JSON.stringify({
      hall: cfg.hall,
      server: cfg.server,
      token: cfg.token,
      downloadedAt: cfg.downloadedAt || cfg.installedAt || new Date().toISOString(),
    }, null, 2);
    fs.writeFileSync(dest, body, 'utf8');
    if (BASE_DIR && path.resolve(BASE_DIR).toLowerCase() !== path.resolve(path.dirname(dest)).toLowerCase()) {
      try { fs.writeFileSync(path.join(BASE_DIR, 'agent-config.json'), body, 'utf8'); } catch {}
    }
    return dest;
  } catch (e) {
    console.warn('[Agent] Nepodařilo se zapsat kanonický agent-config.json: ' + e.message);
    return null;
  }
}

// ----- CLI args + agent-config.json (config wins — fixes stale desktop shortcuts) -----
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return (i >= 0 && argv[i + 1]) ? argv[i + 1] : def;
}
const loaded = loadAgentConfig();
let fileCfg = loaded.cfg || {};
let loadedCfgPath = loaded.cfgPath || null;

function looksLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || /^\d+\.\d+\.\d+\.\d+$/.test(h);
}

/** Public hostnames always use HTTPS (Cloudflare 301s http:// → https://). */
function normalizeServerUrl(raw) {
  let s = String(raw || '').trim().replace(/\/$/, '');
  if (!s) return s;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : 'http://' + s);
    if (!looksLocalHost(u.hostname) && u.protocol === 'http:') u.protocol = 'https:';
    return u.origin;
  } catch {
    return s;
  }
}

function requestFollow(url, hops, cb) {
  if (hops > 5) { cb(new Error('Příliš mnoho přesměrování')); return; }
  const fullUrl = String(url);
  const mod = fullUrl.startsWith('https') ? https : http;
  mod.get(fullUrl, res => {
    const loc = res.headers.location;
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc) {
      const next = /^https?:\/\//i.test(loc) ? loc : new URL(loc, fullUrl).href;
      res.resume();
      requestFollow(next, hops + 1, cb);
      return;
    }
    cb(null, res);
  }).on('error', err => cb(err));
}

const HALL     = +(fileCfg.hall != null ? fileCfg.hall : arg('hall', '1'));
const rawServer = String(fileCfg.server || arg('server', 'http://localhost:3000'));
const SERVER   = normalizeServerUrl(rawServer) || rawServer;
if (SERVER !== rawServer.replace(/\/$/, '')) {
  fileCfg.server = SERVER;
  const written = writeCanonicalConfig(fileCfg);
  if (written) console.warn('[Agent] server URL opraveno na HTTPS: ' + SERVER);
}
const OBS_PORT = +arg('obs-port', '4461');
const OBS_PASS = arg('obs-pass', 'multimix');
const cliToken = String(arg('token', '') || '');
const AGENT_TOKEN = String(fileCfg.token || cliToken || '');
const LAUNCH   = argv.includes('--launch'); // ignored — agent never starts OBS
const CANONICAL_CFG = path.join(appDataDir(), 'MultiMix', 'agent-config.json');
if (loadedCfgPath && path.resolve(loadedCfgPath).toLowerCase() !== path.resolve(CANONICAL_CFG).toLowerCase()) {
  const written = writeCanonicalConfig(fileCfg);
  if (written) {
    console.warn('[Agent] Konfigurace byla mimo kanonické místo. Zkopírována do: ' + written);
    loadedCfgPath = written;
  }
}

const OBS_PATHS = [
  path.join(BASE_DIR, 'obs', 'bin', '64bit', 'obs64.exe'), // portable, next to agent.exe
  'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
  'C:\\Program Files (x86)\\obs-studio\\bin\\64bit\\obs64.exe',
];

// Remote logging — all console output is forwarded to the central server.
const _log = console.log.bind(console);
const _err = console.error.bind(console);
let _logSocket = null; // assigned after socket is created below
function remoteLog(level, args) {
  const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  (level === 'error' ? _err : _log)(msg);
  try { if (_logSocket) _logSocket.emit('agent:log', { hall: HALL, msg, ts: Date.now() }); } catch {}
}
console.log   = (...a) => remoteLog('log',   a);
console.error = (...a) => remoteLog('error', a);
console.warn  = (...a) => remoteLog('warn',  a);

const tokenPrefix = AGENT_TOKEN ? AGENT_TOKEN.slice(0, 8) : '(prázdný)';
console.log(`MultiMix Agent | Hala ${HALL} | ${SERVER} | OBS :${OBS_PORT} | token ${tokenPrefix}…`);
if (loadedCfgPath) {
  console.log('[Agent] Zdroj pravdy: ' + loadedCfgPath);
} else {
  console.warn('[Agent] Nenalezen agent-config.json. Očekávaná cesta: ' + CANONICAL_CFG);
}
if (cliToken && fileCfg.token && cliToken !== fileCfg.token) {
  console.warn('[Agent] Zástupce obsahuje starý --token (' + cliToken.slice(0, 8) + '…) — ignoruji ho, beru soubor.');
  console.warn('[Agent] Uprav zástupce: Cíl má být jen multimix-agent.exe (bez --token a bez --launch).');
} else if (cliToken && !fileCfg.token) {
  console.warn('[Agent] Token ze zástupce (--token ' + cliToken.slice(0, 8) + '…). Lepší je agent-config.json vedle exe.');
} else if (fileCfg.token) {
  console.log('[Agent] Token z konfiguračního souboru (' + tokenPrefix + '…)');
}
if (!AGENT_TOKEN) {
  console.warn('[Agent] Chybí token — server spojení odmítne.');
  console.warn('[Agent] Stáhni agent-config.json z ' + SERVER.replace(/\/$/, '') + '/setup/' + HALL);
  console.warn('[Agent] a ulož ho jako ' + CANONICAL_CFG + ' (ne jako config.json).');
}

// ----- OBS WebSocket helpers -----
const sha256b64 = s => crypto.createHash('sha256').update(s).digest('base64');
// Scenes=2, Outputs=6, SceneItems=7, MediaInputs=8
const EVENT_SUBS = (1 << 2) | (1 << 6) | (1 << 7) | (1 << 8);

let obsWs = null;
let obsConnected = false;
const obsPending = new Map();
let obsReqId = 0;
let obsRetry = null;

function obsConnect() {
  clearTimeout(obsRetry);
  try { obsWs = new WebSocket(`ws://127.0.0.1:${OBS_PORT}`); }
  catch { obsRetry = setTimeout(obsConnect, 3000); return; }
  obsWs.onerror = () => {};
  obsWs.onclose = () => {
    obsConnected = false;
    for (const p of obsPending.values()) p.reject(new Error('OBS odpojeno'));
    obsPending.clear();
    reportStatus();
    obsRetry = setTimeout(obsConnect, 3000);
  };
  obsWs.onmessage = ev => handleObs(JSON.parse(ev.data));
}

function handleObs(m) {
  if (m.op === 0) {
    const auth = m.d.authentication;
    const msg = { rpcVersion: 1, eventSubscriptions: EVENT_SUBS };
    if (auth) msg.authentication = sha256b64(sha256b64(OBS_PASS + auth.salt) + auth.challenge);
    obsWs.send(JSON.stringify({ op: 1, d: msg }));
  } else if (m.op === 2) {
    obsConnected = true;
    console.log('[OBS] Pripojené');
    reportStatus();
    getCameras().then(cameras => socket.emit('agent:cameras', { hall: HALL, cameras })).catch(() => {});
    obsCall('GetStreamStatus').then(r => {
      socket.emit('agent:stream-state', { hall: HALL, active: !!r.outputActive });
    }).catch(() => {});
    setDefaultVolumes();
  } else if (m.op === 5) {
    socket.emit('agent:obs-event', { hall: HALL, eventType: m.d.eventType, eventData: m.d.eventData || {} });
    if (m.d.eventType === 'StreamStateChanged') {
      socket.emit('agent:stream-state', { hall: HALL, active: !!m.d.eventData?.outputActive });
    }
    if (m.d.eventType === 'SceneCreated') {
      muteDesktopAudio();
    }
  } else if (m.op === 7) {
    const p = obsPending.get(m.d.requestId);
    if (!p) return;
    obsPending.delete(m.d.requestId);
    if (m.d.requestStatus && m.d.requestStatus.result) p.resolve(m.d.responseData || {});
    else p.reject(new Error((m.d.requestStatus && m.d.requestStatus.comment) || 'OBS request failed'));
  }
}

function obsCall(requestType, requestData) {
  if (!requestData) requestData = {};
  return new Promise((resolve, reject) => {
    if (!obsConnected) return reject(new Error('OBS není připojeno'));
    const requestId = 'r' + (++obsReqId);
    obsPending.set(requestId, { resolve, reject });
    obsWs.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    setTimeout(() => {
      if (obsPending.has(requestId)) { obsPending.delete(requestId); reject(new Error('OBS timeout')); }
    }, 8000);
  });
}

async function getCameras() {
  const TEMP = '__mm_cam_enum__';
  let createdTemp = false;
  try {
    const list = await obsCall('GetInputList');
    let inputName = ((list.inputs || []).find(i => i.inputKind === 'dshow_input') || {}).inputName;

    if (!inputName) {
      // No existing dshow source — create a temporary one just for enumeration.
      const scene = await obsCall('GetCurrentProgramScene');
      await obsCall('CreateInput', {
        sceneName: scene.currentProgramSceneName,
        inputName: TEMP,
        inputKind: 'dshow_input',
        inputSettings: {}
      });
      inputName = TEMP;
      createdTemp = true;
    }

    const r = await obsCall('GetInputPropertiesListPropertyItems', {
      inputName: inputName, propertyName: 'video_device_id'
    });
    return (r.propertyItems || []).map(i => ({ id: i.itemValue, name: i.itemName }));
  } catch { return []; } finally {
    if (createdTemp) await obsCall('RemoveInput', { inputName: TEMP }).catch(() => {});
  }
}

async function setMicMute(muted) {
  try {
    const list = await obsCall('GetInputList');
    for (const inp of (list.inputs || [])) {
      if (inp.inputKind === 'wasapi_input_capture') {
        await obsCall('SetInputMute', { inputName: inp.inputName, inputMuted: muted }).catch(() => {});
      }
    }
  } catch {}
}

async function muteDesktopAudio() {
  try {
    const list = await obsCall('GetInputList');
    for (const inp of (list.inputs || [])) {
      if (inp.inputKind === 'wasapi_output_capture') {
        await obsCall('SetInputMute',   { inputName: inp.inputName, inputMuted: true }).catch(() => {});
        await obsCall('SetInputVolume', { inputName: inp.inputName, inputVolumeDb: -5 }).catch(() => {});
      }
    }
  } catch {}
}

async function setDefaultVolumes() {
  try {
    const list = await obsCall('GetInputList');
    for (const inp of (list.inputs || [])) {
      if (inp.inputKind === 'wasapi_output_capture' || inp.inputKind === 'wasapi_input_capture') {
        await obsCall('SetInputVolume', { inputName: inp.inputName, inputVolumeDb: -5 }).catch(() => {});
      }
    }
  } catch {}
}

function reportStatus() {
  socket.emit('agent:status', { hall: HALL, obsConnected });
}

// ----- Socket.IO → central server -----
const socket = io(SERVER, {
  auth: { type: 'agent', hall: HALL, token: AGENT_TOKEN },
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionDelay: 2000,
  reconnectionDelayMax: 15000,
});
_logSocket = socket; // enable remote logging

socket.on('connect', () => {
  console.log('[Server] Připojen, verze agenta: ' + AGENT_VERSION);
  socket.emit('agent:version', { hall: HALL, version: AGENT_VERSION });
  reportStatus();
  if (obsConnected) getCameras().then(c => socket.emit('agent:cameras', { hall: HALL, cameras: c })).catch(() => {});
  ensureRemoteHelper().then(() => {
    if (!remoteProc && !remoteStopping) spawnRemoteHelper();
  }).catch(() => {});
});

socket.on('connect_error', err => {
  const msg = (err && err.message) || String(err);
  if (/neplatn[ýy] token/i.test(msg)) {
    console.error('[Server] ' + msg);
    console.error('[Agent] Načtený soubor: ' + (loadedCfgPath || '(žádný)'));
    console.error('[Agent] Token v souboru začíná na: ' + tokenPrefix + ' (délka ' + AGENT_TOKEN.length + ')');
    console.error('[Agent] Přepiš ' + CANONICAL_CFG);
    console.error('[Agent] souborem staženým z ' + SERVER.replace(/\/$/, '') + '/setup/' + HALL);
    console.error('[Agent] Název MUSÍ být agent-config.json (ne config.json). Pak restartuj agenta.');
    try { socket.io.reconnection(false); } catch {}
    return;
  }
  if (/xhr poll|websocket error|timeout|transport/i.test(msg)) {
    console.error('[Server] Dočasný výpadek spojení (' + msg + '), zkouším znovu…');
    return;
  }
  console.error('[Server] Chyba připojení:', msg);
});

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const fullUrl = url.startsWith('http') ? url : (SERVER.replace(/\/$/, '') + url);
    const file = fs.createWriteStream(dest);
    requestFollow(fullUrl, 0, (err, res) => {
      if (err) { try { fs.unlinkSync(dest); } catch {} reject(err); return; }
      if (res.statusCode !== 200) {
        try { fs.unlinkSync(dest); } catch {}
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', e => { try { fs.unlinkSync(dest); } catch {} reject(e); });
    });
  });
}

function httpGetText(url) {
  return new Promise((resolve, reject) => {
    const fullUrl = url.startsWith('http') ? url : (SERVER.replace(/\/$/, '') + url);
    requestFollow(fullUrl, 0, (err, res) => {
      if (err) return reject(err);
      if (res.statusCode !== 200) {
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  });
}

let remoteHelperJob = null;
async function ensureRemoteHelper() {
  if (remoteHelperJob) return remoteHelperJob;
  remoteHelperJob = (async () => {
    const verUrl = '/downloads/multimix-remote-version.txt';
    const localVer = path.join(BASE_DIR, 'multimix-remote.version');
    try {
      const remoteVer = String(await httpGetText(verUrl) || '').trim();
      if (!remoteVer) return;
      let local = '';
      try { local = fs.readFileSync(localVer, 'utf8').trim(); } catch {}
      const missing = !fs.existsSync(REMOTE_EXE);
      if (!missing && local === remoteVer) return;
      console.log('[Remote] Stahuji helper ' + remoteVer + (missing ? ' (chybí)' : ' (aktualizace)') + '...');
      killRemoteHelperForUpdate();
      const tmp = REMOTE_EXE + '.new';
      await downloadFile('/downloads/multimix-remote.exe', tmp);
      try { if (fs.existsSync(REMOTE_EXE)) fs.unlinkSync(REMOTE_EXE); } catch {}
      fs.renameSync(tmp, REMOTE_EXE);
      fs.writeFileSync(localVer, remoteVer, 'utf8');
      console.log('[Remote] Helper uložen');
    } catch (e) {
      console.warn('[Remote] Helper se nepodařilo aktualizovat: ' + e.message);
    }
  })().finally(() => { remoteHelperJob = null; });
  return remoteHelperJob;
}

socket.on('agent:update-available', async ({ url, version, remoteUrl }) => {
  console.log('[Update] Nová verzia dostupná: ' + version + ', stahuji...');
  const dest = process.execPath + '.new';
  const remoteDest = path.join(BASE_DIR, 'multimix-remote.exe.new');
  try {
    await downloadFile(url, dest);
    if (remoteUrl) {
      try {
        await downloadFile(remoteUrl, remoteDest);
        console.log('[Update] Remote helper stažen');
      } catch (e) {
        console.warn('[Update] Remote helper se nepodařilo stáhnout:', e.message);
      }
    }
    console.log('[Update] Staženo, restartuji...');
    const args = process.argv.slice(2).join(' ');
    const exe = process.execPath;
    const bat = path.join(path.dirname(exe), '_mm_update.bat');
    const script = [
      '@echo off',
      'timeout /t 2 /nobreak >nul',
      'copy /y "' + dest + '" "' + exe + '"',
      'del "' + dest + '"',
      fs.existsSync(remoteDest)
        ? 'copy /y "' + remoteDest + '" "' + path.join(BASE_DIR, 'multimix-remote.exe') + '"\r\ndel "' + remoteDest + '"'
        : 'rem no remote helper update',
      'start "" "' + exe + '" ' + args,
      'del "%~f0"',
    ].join('\r\n');
    fs.writeFileSync(bat, script, 'utf8');
    stopRemoteHelper();
    spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore' }).unref();
    process.exit(0);
  } catch (e) {
    console.error('[Update] Chyba stažení: ' + e.message);
  }
});
socket.on('disconnect', reason => {
  if (reason === 'io server disconnect') {
    console.warn('[Server] Server uzavřel spojení, zkouším znovu…');
    try { socket.connect(); } catch {}
    return;
  }
  console.log('[Server] Odpojen:', reason);
});

socket.on('obs:cmd', async function(data) {
  const reqId = data.reqId, method = data.method, params = data.params;
  try {
    const result = await obsCall(method, params || {});
    socket.emit('obs:result', { reqId, ok: true, result });
  } catch (e) {
    socket.emit('obs:result', { reqId, ok: false, error: e.message });
  }
});

socket.on('obs:status-req', reportStatus);
socket.on('agent:mute-mic',   () => setMicMute(true));
socket.on('agent:unmute-mic', () => setMicMute(false));

// ----- Generic agent command dispatcher -----
socket.on('agent:cmd', async ({ reqId, method, params }) => {
  try {
    let result = {};
    if (method === 'setup-dock')      result = await setupDock(params.url, params.title);
    else if (method === 'read-obs-config') result = readObsConfig();
    else if (method === 'list-obs-config')  result = listObsConfig();
    else throw new Error(`Neznámá metoda: ${method}`);
    socket.emit('agent:result', { reqId, ok: true, result });
  } catch (e) {
    socket.emit('agent:result', { reqId, ok: false, error: e.message });
  }
});

// ----- OBS dock setup: write global.ini + restart OBS -----
function findObsConfigPath() {
  for (const exePath of OBS_PATHS) {
    if (!fs.existsSync(exePath)) continue;
    // Portable OBS: go up 3 dirs from obs64.exe → obs root, then config/obs-studio/global.ini
    const obsRoot  = path.dirname(path.dirname(path.dirname(exePath)));
    const portable = path.join(obsRoot, 'config', 'obs-studio', 'global.ini');
    if (fs.existsSync(portable)) return { configPath: portable, obsExe: exePath };
    // Portable config doesn't exist yet — return path anyway so we can create it
    if (fs.existsSync(path.dirname(path.dirname(portable)))) {
      return { configPath: portable, obsExe: exePath };
    }
  }
  // Fall back to %APPDATA%
  const appData = process.env.APPDATA ||
    path.join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Roaming');
  const sysPath = path.join(appData, 'obs-studio', 'global.ini');
  const obsExe  = OBS_PATHS.find(p => fs.existsSync(p)) || OBS_PATHS[1];
  return { configPath: sysPath, obsExe };
}

function patchIniDock(content, url, title) {
  // OBS 28+ stores all custom browser docks as a JSON array in one key.
  const eol  = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const uuid     = crypto.randomUUID().replace(/-/g, '');
  const dockJson = JSON.stringify([{ title, url, uuid }]);
  const newLine  = `ExtraBrowserDocks=${dockJson}`;

  let secStart = -1, secEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '[BasicWindow]') { secStart = i; }
    else if (secStart >= 0 && i > secStart && /^\[/.test(lines[i].trim())) { secEnd = i; break; }
  }

  if (secStart === -1) {
    return [...lines, '', '[BasicWindow]', newLine].join(eol);
  }

  // Replace any existing ExtraBrowserDocks line (old or new format), keep everything else
  const before  = lines.slice(0, secStart + 1);
  // Remove ALL old-format and new-format ExtraBrowserDock* keys
  const section = lines.slice(secStart + 1, secEnd).filter(l => !/^ExtraBrowserDock/i.test(l.trim()));
  const after   = lines.slice(secEnd);
  return [...before, ...section, newLine, ...after].join(eol);
}

function listObsConfig() {
  const { configPath } = findObsConfigPath();
  const obsStudioDir = path.dirname(configPath); // .../obs-studio/
  const result = {};
  function walk(dir, depth) {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel  = path.relative(obsStudioDir, full);
      if (e.isDirectory()) { walk(full, depth + 1); }
      else if (/\.(ini|json)$/i.test(e.name)) {
        try {
          const txt = fs.readFileSync(full, 'utf8');
          if (/dock/i.test(txt + rel)) result[rel] = txt.slice(0, 2000);
        } catch {}
      }
    }
  }
  walk(obsStudioDir, 0);
  return { obsStudioDir, files: result };
}

function readObsConfig() {
  const { configPath } = findObsConfigPath();
  const exists = fs.existsSync(configPath);
  const content = exists ? fs.readFileSync(configPath, 'utf8') : null;
  // Return full path + the [BasicWindow] section so we can inspect the format
  const section = content
    ? (content.match(/\[BasicWindow\][\s\S]*?(?=\n\[|$)/) || ['(sekcia nenájdená)'])[0]
    : '(súbor neexistuje)';
  return { configPath, section };
}

async function setupDock(url, title) {
  const { configPath, obsExe } = findObsConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '[BasicWindow]\r\n';
  fs.writeFileSync(configPath, patchIniDock(existing, url, title), 'utf8');
  console.log('[Dock] Zapísané do', configPath);

  // OBS 32 reads ExtraBrowserDocks from user.ini (same dir as global.ini)
  const userIniPath = path.join(path.dirname(configPath), 'user.ini');
  const userExisting = fs.existsSync(userIniPath) ? fs.readFileSync(userIniPath, 'utf8') : '[BasicWindow]\r\n';
  fs.writeFileSync(userIniPath, patchIniDock(userExisting, url, title), 'utf8');
  console.log('[Dock] Zapísané do', userIniPath);

  if (obsConnected && obsExe) {
    // Force-kill OBS (before it can overwrite our config on clean exit)
    spawn('taskkill', ['/f', '/im', 'obs64.exe'], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 2500));
    const binDir = path.dirname(obsExe);
    spawn(obsExe,
      ['--portable', '--multi', '--websocket_port', String(OBS_PORT), '--websocket_password', OBS_PASS],
      { cwd: binDir, detached: true, stdio: 'ignore' }
    ).unref();
    console.log('[Dock] OBS reštartovaný');
    return { configPath, restarted: true };
  }
  return { configPath, restarted: false };
}

console.log('[Agent] OBS nespouštím — spusť ho ručně. Agent jen sdílí obrazovku.');
if (LAUNCH) {
  console.warn('[Agent] Parametr --launch ignoruji (OBS se nespouští).');
}

// ----- RTMP tunnel: leftover localhost ingest; unused when OBS streams directly -----
let rtmpConn = null;

const rtmpServer = net.createServer(conn => {
  if (rtmpConn && !rtmpConn.destroyed) rtmpConn.destroy();
  rtmpConn = conn;
  console.log('[RTMP] OBS pripojené na lokálny tunel');

  conn.on('data', chunk => socket.emit('rtmp:data', chunk));
  conn.on('end',  () => { socket.emit('rtmp:end'); rtmpConn = null; });
  conn.on('error', err => { console.log('[RTMP] Chyba:', err.message); socket.emit('rtmp:end'); rtmpConn = null; });
});

socket.on('rtmp:reply', chunk => {
  if (rtmpConn && !rtmpConn.destroyed)
    rtmpConn.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
});
socket.on('rtmp:end', () => {
  if (rtmpConn && !rtmpConn.destroyed) { rtmpConn.destroy(); rtmpConn = null; }
});

rtmpServer.listen(1935, '127.0.0.1', () => console.log('[RTMP] Tunel počúva na 127.0.0.1:1935'));
rtmpServer.on('error', err => console.error('[RTMP] Nemôžem spustiť tunel:', err.message));

// ----- Remote desktop helper (multimix-remote.exe) -----
// Lifecycle matches the agent: spawn at start (idle), capture on/off on demand.
const REMOTE_EXE = path.join(BASE_DIR, 'multimix-remote.exe');
const MSG_JSON = 1;
const MSG_JPEG = 2;

let remoteProc = null;
let remoteCapturing = false;
let remoteRespawnTimer = null;
let remoteStopping = false;
let remoteStdoutBuf = Buffer.alloc(0);
let lastCaptureParams = null;
const REMOTE_STDOUT_BACKLOG = 2 * 1024 * 1024;

function remoteSend(obj) {
  if (!remoteProc || !remoteProc.stdin || remoteProc.stdin.destroyed) return false;
  try {
    remoteProc.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  } catch (e) {
    console.error('[Remote] stdin chyba:', e.message);
    return false;
  }
}

function parseRemoteStdout(chunk) {
  remoteStdoutBuf = Buffer.concat([remoteStdoutBuf, chunk]);
  while (remoteStdoutBuf.length >= 5) {
    const type = remoteStdoutBuf[0];
    const len = remoteStdoutBuf.readUInt32BE(1);
    if (len > 8 * 1024 * 1024) {
      console.error('[Remote] Neplatná délka rámce:', len);
      remoteStdoutBuf = Buffer.alloc(0);
      break;
    }
    if (remoteStdoutBuf.length < 5 + len) break;
    const payload = remoteStdoutBuf.subarray(5, 5 + len);
    remoteStdoutBuf = remoteStdoutBuf.subarray(5 + len);
    if (type === MSG_JSON) {
      try {
        const msg = JSON.parse(payload.toString('utf8'));
        if (msg.event === 'status') remoteCapturing = !!msg.capturing;
        if (msg.event === 'clipboard') {
          socket.emit('remote:clipboard', { hall: HALL, text: msg.text || '' });
        } else {
          socket.emit('remote:status', { hall: HALL, ...msg });
        }
      } catch (e) {
        console.error('[Remote] JSON parse:', e.message);
      }
    } else if (type === MSG_JPEG) {
      if (remoteCapturing && remoteStdoutBuf.length < REMOTE_STDOUT_BACKLOG)
        socket.emit('remote:frame', Buffer.from(payload));
    }
  }
}

function restoreCaptureIfNeeded() {
  if (!lastCaptureParams || !remoteProc) return;
  remoteCapturing = true;
  remoteSend({
    cmd: 'capture-on',
    width: lastCaptureParams.width ?? 640,
    fps: lastCaptureParams.fps ?? 4,
    fpsIdle: lastCaptureParams.fpsIdle ?? lastCaptureParams.fps ?? 4,
    quality: lastCaptureParams.quality ?? 35,
  });
}

function killRemoteHelperForUpdate() {
  clearTimeout(remoteRespawnTimer);
  remoteRespawnTimer = null;
  const proc = remoteProc;
  remoteProc = null;
  if (proc) {
    try { proc.removeAllListeners('exit'); } catch {}
    try { proc.kill(); } catch {}
  }
}

function spawnRemoteHelper() {
  if (remoteStopping) return;
  if (!fs.existsSync(REMOTE_EXE)) {
    console.warn('[Remote] multimix-remote.exe nenalezen vedle agenta — vzdálené ovládání nedostupné');
    socket.emit('remote:status', { hall: HALL, event: 'error', message: 'Helper chybí', ready: false });
    return;
  }
  if (remoteProc) return;

  console.log('[Remote] Spouštím helper (idle)...');
  remoteStdoutBuf = Buffer.alloc(0);
  remoteProc = spawn(REMOTE_EXE, [], {
    cwd: BASE_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  remoteProc.stdout.on('data', parseRemoteStdout);
  remoteProc.stderr.on('data', d => {
    const t = d.toString('utf8').trim();
    if (t) console.warn('[Remote]', t);
  });
  remoteProc.on('exit', (code, signal) => {
    console.log('[Remote] Helper ukončen (code=' + code + ' signal=' + signal + ')');
    remoteProc = null;
    remoteCapturing = false;
    socket.emit('remote:status', { hall: HALL, event: 'status', capturing: false, ready: false });
    if (!remoteStopping) {
      clearTimeout(remoteRespawnTimer);
      remoteRespawnTimer = setTimeout(spawnRemoteHelper, 2000);
    }
  });
  remoteProc.on('error', err => {
    console.error('[Remote] Spawn chyba:', err.message);
    remoteProc = null;
  });
  restoreCaptureIfNeeded();
}

function stopRemoteHelper() {
  remoteStopping = true;
  clearTimeout(remoteRespawnTimer);
  if (remoteCapturing) remoteSend({ cmd: 'capture-off' });
  if (remoteProc) {
    try { remoteProc.kill(); } catch {}
    remoteProc = null;
  }
  remoteCapturing = false;
}

socket.on('remote:start', (params = {}) => {
  lastCaptureParams = params;
  if (!remoteProc) spawnRemoteHelper();
  // Allow frames even if status JSON is slightly delayed
  remoteCapturing = true;
  const ok = remoteSend({
    cmd: 'capture-on',
    width: params.width ?? 640,
    fps: params.fps ?? 4,
    fpsIdle: params.fpsIdle ?? params.fps ?? 4,
    quality: params.quality ?? 35,
  });
  if (!ok) {
    remoteCapturing = false;
    socket.emit('remote:status', { hall: HALL, event: 'error', message: 'Helper není připraven' });
  }
});

socket.on('remote:stop', () => {
  lastCaptureParams = null;
  remoteSend({ cmd: 'capture-off' });
  remoteCapturing = false;
});

socket.on('remote:input', data => {
  if (!data || typeof data !== 'object') return;
  remoteSend({ cmd: 'input', ...data });
});

ensureRemoteHelper().finally(() => spawnRemoteHelper());

obsConnect();
process.on('SIGINT', () => { stopRemoteHelper(); socket.disconnect(); process.exit(0); });
process.on('SIGTERM', () => { stopRemoteHelper(); socket.disconnect(); process.exit(0); });
process.on('exit', () => { try { stopRemoteHelper(); } catch {} });
