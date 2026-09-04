// Manages outbound connections from hall notebooks (obs-agent.js).
// Each agent connects via Socket.IO and identifies itself with auth.type='agent'.
// réžia sends OBS commands through the server — notebooks need no open inbound port.
import net from 'node:net';
import fs  from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyHallToken } from './auth-guard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function currentAgentVersion() {
  const f = path.join(__dirname, '..', 'public', 'downloads', 'multimix-agent-version.txt');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '0';
}

export class AgentRouter {
  constructor() {
    this._agents       = new Map(); // hallId -> { socket, obsConnected, cameras }
    this._pending      = new Map(); // reqId  -> { resolve, reject, timer }  (OBS commands)
    this._agentPending = new Map(); // reqId  -> { resolve, reject, timer }  (agent commands)
    this._logs         = new Map(); // hallId -> [{ msg, ts }]  (ring buffer, max 200)
    this._remoteViewers = new Map(); // hallId -> Map<socket.id, 'preview'|'control'>
    this._reqId        = 0;
    this._onChange     = null;
    this._onLog        = null;      // (hallId, entry) => void
    this._io           = null;
    this._lastReject   = new Map(); // hallId -> { prefix, len, ts }
  }

  // Call after io is created. onChange(statusArray) fires on connect/disconnect/status.
  attach(io, onChange, onLog) {
    this._io       = io;
    this._onChange = onChange;
    this._onLog    = onLog;
    // Reject invalid agent tokens in middleware so the client never gets a fake
    // `connect` + `io server disconnect` (that looks like "Připojený" then drop).
    io.use((socket, next) => {
      if (socket.handshake.auth?.type !== 'agent') return next();
      const hall = +socket.handshake.auth.hall;
      const token = socket.handshake.auth.token || '';
      if (hall && verifyHallToken(hall, token)) return next();
      const prefix = token ? String(token).slice(0, 8) : '';
      const got = prefix ? prefix + '…' : '(prázdný)';
      console.log(`[agent] Hala ${hall || '?'} odmítnuta — neplatný token (got ${got}, len=${(token || '').length})`);
      if (hall) {
        this._lastReject.set(hall, { prefix: prefix || '(prázdný)', len: (token || '').length, ts: Date.now() });
        this._notify();
      }
      const err = new Error(
        'Neplatný token haly. Přepiš soubor %AppData%\\MultiMix\\agent-config.json ' +
        '(název MUSÍ být agent-config.json, ne config.json) souborem ze stránky /setup/' +
        (hall || '') + ' a restartuj agenta.'
      );
      return next(err);
    });
    io.on('connection', socket => {
      if (socket.handshake.auth?.type !== 'agent') return;
      const hall = +socket.handshake.auth.hall;
      this._register(hall, socket);
    });
  }

  _register(hall, socket) {
    const prev = this._agents.get(hall);
    this._agents.set(hall, { socket, obsConnected: false, cameras: [] });
    this._lastReject.delete(hall);
    if (prev?.socket && prev.socket.id !== socket.id) {
      try { prev.socket.disconnect(true); } catch {}
    }
    console.log(`[agent] Hala ${hall} připojena`);
    this._notify();

    // RTMP tunnel: OBS on notebook → agent → Socket.IO → here → MediaMTX
    let mediamtxConn = null;
    socket.on('rtmp:data', chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!mediamtxConn || mediamtxConn.destroyed) {
        // MediaMTX rejects mid-stream leftovers as "invalid rtmp version".
        // Only open a new TCP session on a real RTMP handshake (C0 = 0x03).
        if (buf[0] !== 0x03) {
          socket.emit('rtmp:end');
          return;
        }
        mediamtxConn = net.connect(1935, process.env.MEDIAMTX_HOST || '127.0.0.1');
        mediamtxConn.on('data', data => socket.emit('rtmp:reply', data));
        mediamtxConn.on('end', () => { socket.emit('rtmp:end'); mediamtxConn = null; });
        mediamtxConn.on('error', err => {
          console.error(`[RTMP tunel] Hala ${hall}: ${err.message}`);
          socket.emit('rtmp:end');
          mediamtxConn = null;
        });
        mediamtxConn.on('connect', () => console.log(`[RTMP tunel] Hala ${hall}: spojení s MediaMTX otevřeno`));
      }
      try { mediamtxConn.write(buf); } catch { mediamtxConn = null; }
    });
    socket.on('rtmp:end', () => {
      if (mediamtxConn) { mediamtxConn.destroy(); mediamtxConn = null; }
      console.log(`[RTMP tunel] Hala ${hall}: stream ukončen`);
    });

    socket.on('agent:version', ({ version }) => {
      const current = currentAgentVersion();
      console.log(`[agent] Hala ${hall} verze: ${version}, server: ${current}`);
      // Do not push auto-update here. The old Windows updater exits the agent to
      // copy the exe, which surfaces as "xhr poll error" and often fails to replace
      // a locked multimix-agent.exe — hall notebooks then bounce forever.
      if (current !== '0' && String(version) !== current) {
        console.log(`[agent] Hala ${hall}: starší agent, update ručně z /setup/${hall} (multimix-agent.exe)`);
      }
    });

    socket.on('remote:frame', chunk => {
      if (!this._io) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this._io.to('remote:' + hall).emit('remote:frame', { hall, jpeg: buf });
    });

    socket.on('remote:status', status => {
      if (!this._io) return;
      this._io.to('remote:' + hall).emit('remote:status', { hall, ...status });
    });

    socket.on('remote:clipboard', payload => {
      if (!this._io) return;
      const text = typeof payload?.text === 'string' ? payload.text : '';
      this._io.to('remote:' + hall).emit('remote:clipboard', { hall, text });
    });

    socket.on('agent:log', ({ msg, ts }) => {
      if (!this._logs.has(hall)) this._logs.set(hall, []);
      const buf = this._logs.get(hall);
      const entry = { msg, ts: ts || Date.now() };
      buf.push(entry);
      if (buf.length > 200) buf.shift();
      if (this._onLog) this._onLog(hall, entry);
    });

    socket.on('agent:status', ({ obsConnected }) => {
      const a = this._agents.get(hall);
      if (a) { a.obsConnected = !!obsConnected; this._notify(); }
    });

    socket.on('agent:cameras', ({ cameras }) => {
      const a = this._agents.get(hall);
      if (a) { a.cameras = cameras || []; this._notify(); }
    });

    socket.on('agent:stream-state', ({ active }) => {
      const a = this._agents.get(hall);
      if (a) { a.streamActive = !!active; this._notify(); }
    });

    socket.on('obs:result', ({ reqId, ok, result, error }) => {
      const p = this._pending.get(reqId);
      if (!p) return;
      clearTimeout(p.timer);
      this._pending.delete(reqId);
      ok ? p.resolve(result) : p.reject(new Error(error));
    });

    socket.on('agent:result', ({ reqId, ok, result, error }) => {
      const p = this._agentPending.get(reqId);
      if (!p) return;
      clearTimeout(p.timer);
      this._agentPending.delete(reqId);
      ok ? p.resolve(result) : p.reject(new Error(error));
    });

    socket.on('disconnect', () => {
      if (mediamtxConn) { mediamtxConn.destroy(); mediamtxConn = null; }
      const cur = this._agents.get(hall);
      // Only drop the map entry if THIS socket is still the registered one.
      // A replacement connect can otherwise be wiped by the old socket's disconnect.
      if (cur && cur.socket && cur.socket.id === socket.id) {
        this._agents.delete(hall);
        this._remoteViewers.delete(hall);
        console.log(`[agent] Hala ${hall} odpojena`);
        this._notify();
      }
    });
  }

  remoteRoom(hallId) {
    return 'remote:' + (+hallId);
  }

  _viewerCount(hallId) {
    return this._remoteViewers.get(+hallId)?.size || 0;
  }

  _viewerHasControl(hallId) {
    const modes = this._remoteViewers.get(+hallId);
    if (!modes) return false;
    for (const mode of modes.values()) {
      if (mode === 'control') return true;
    }
    return false;
  }

  /** Preview tiles vs full remote-control session. Control always wins. */
  static PREVIEW_CAPTURE = { width: 960, fps: 8, fpsIdle: 8, quality: 40 };
  static CONTROL_CAPTURE = { width: 1920, fps: 15, fpsIdle: 15, quality: 50 };

  applyRemoteCapture(hallId) {
    const id = +hallId;
    if (this._viewerCount(id) === 0) {
      this.send(id, 'remote:stop', {});
      console.log(`[remote] Hala ${id}: capture stop (no viewers)`);
      return { ok: true };
    }
    const control = this._viewerHasControl(id);
    const opts = control ? AgentRouter.CONTROL_CAPTURE : AgentRouter.PREVIEW_CAPTURE;
    return this.startRemoteCapture(id, opts);
  }

  /** Tell agent to start capturing desktop frames. */
  startRemoteCapture(hallId, opts = {}) {
    const id = +hallId;
    if (!this._agents.has(id)) {
      return { ok: false, error: 'Agent haly není připojen' };
    }
    const payload = {
      width: opts.width ?? 960,
      fps: opts.fps || 8,
      fpsIdle: opts.fpsIdle || opts.fps || 8,
      quality: opts.quality || 40,
    };
    this.send(id, 'remote:start', payload);
    console.log(`[remote] Hala ${id}: capture ${payload.width}px @ ${payload.fps} fps q${payload.quality}`);
    return { ok: true };
  }

  /** Subscribe a browser socket to receive frames for this hall. */
  subscribeRemote(hallId, viewerSocket, mode = 'preview') {
    const id = +hallId;
    if (!this._agents.has(id)) {
      return { ok: false, error: 'Agent haly není připojen' };
    }
    const kind = mode === 'control' ? 'control' : 'preview';
    viewerSocket.join(this.remoteRoom(id));
    if (!this._remoteViewers.has(id)) this._remoteViewers.set(id, new Map());
    this._remoteViewers.get(id).set(viewerSocket.id, kind);
    if (!viewerSocket.data.remoteHalls) viewerSocket.data.remoteHalls = new Set();
    viewerSocket.data.remoteHalls.add(id);
    viewerSocket.data.remoteHall = id;
    this.applyRemoteCapture(id);
    return { ok: true, mode: kind };
  }

  /** Unsubscribe viewer; stop capture when last viewer leaves. */
  unsubscribeRemote(hallId, viewerSocket) {
    const id = +hallId;
    if (viewerSocket) {
      viewerSocket.leave(this.remoteRoom(id));
      const set = this._remoteViewers.get(id);
      if (set) {
        set.delete(viewerSocket.id);
        if (set.size === 0) this._remoteViewers.delete(id);
      }
      viewerSocket.data.remoteHalls?.delete(id);
      if (viewerSocket.data?.remoteHall === id) viewerSocket.data.remoteHall = null;
    }
    this.applyRemoteCapture(id);
    return { ok: true };
  }

  unsubscribeAllRemote(viewerSocket) {
    const halls = [...(viewerSocket?.data?.remoteHalls || [])];
    if (viewerSocket?.data?.remoteHall && !halls.includes(viewerSocket.data.remoteHall)) {
      halls.push(viewerSocket.data.remoteHall);
    }
    for (const id of halls) this.unsubscribeRemote(id, viewerSocket);
    return { ok: true };
  }

  /** Force-stop capture and drop all viewers for a hall (REST stop). */
  stopRemoteCapture(hallId) {
    const id = +hallId;
    const set = this._remoteViewers.get(id);
    if (set && this._io) {
      for (const sid of set) {
        const s = this._io.sockets.sockets.get(sid);
        if (s) {
          s.leave(this.remoteRoom(id));
          s.data.remoteHalls?.delete(id);
          if (s.data?.remoteHall === id) s.data.remoteHall = null;
        }
      }
    }
    this._remoteViewers.delete(id);
    this.send(id, 'remote:stop', {});
    console.log(`[remote] Hala ${id}: capture stop`);
    return { ok: true };
  }

  forwardRemoteInput(hallId, data) {
    const id = +hallId;
    if (!this._agents.has(id)) return false;
    this.send(id, 'remote:input', data);
    return true;
  }

  _notify() {
    if (this._onChange) this._onChange(this.status());
  }

  // Send an arbitrary OBS command to a hall's agent and return the response.
  obsCmd(hallId, method, params = {}) {
    const agent = this._agents.get(+hallId);
    if (!agent) return Promise.reject(new Error(`Agent pro halu ${hallId} není připojen`));
    return new Promise((resolve, reject) => {
      const reqId = 'a' + (++this._reqId);
      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        reject(new Error('Agent timeout'));
      }, 10000);
      this._pending.set(reqId, { resolve, reject, timer });
      agent.socket.emit('obs:cmd', { reqId, method, params });
    });
  }

  // Send a generic command to the agent and wait for agent:result response.
  agentCmd(hallId, method, params = {}, timeout = 20000) {
    const agent = this._agents.get(+hallId);
    if (!agent) return Promise.reject(new Error(`Agent pro halu ${hallId} není připojen`));
    return new Promise((resolve, reject) => {
      const reqId = 'c' + (++this._reqId);
      const timer = setTimeout(() => {
        this._agentPending.delete(reqId);
        reject(new Error('Agent timeout'));
      }, timeout);
      this._agentPending.set(reqId, { resolve, reject, timer });
      agent.socket.emit('agent:cmd', { reqId, method, params });
    });
  }

  // Send any event directly to a hall's agent socket.
  send(hallId, event, data) {
    const agent = this._agents.get(+hallId);
    if (agent) agent.socket.emit(event, data);
  }

  logs(hallId) { return this._logs.get(+hallId) || []; }

  isConnected(hallId) { return this._agents.has(+hallId); }

  status() {
    const live = Array.from(this._agents.entries()).map(([hall, a]) => ({
      hall, obsConnected: a.obsConnected, cameras: a.cameras, streamActive: a.streamActive ?? false
    }));
    const liveIds = new Set(live.map(x => x.hall));
    const rejected = [];
    for (const [hall, r] of this._lastReject) {
      if (liveIds.has(hall)) continue;
      rejected.push({
        hall, obsConnected: false, cameras: [], streamActive: false,
        tokenRejected: true, tokenPrefix: r.prefix, tokenLen: r.len,
      });
    }
    return [...live, ...rejected];
  }

  hallStatus(hallId) {
    const id = +hallId;
    const a = this._agents.get(id);
    const lastReject = this._lastReject.get(id) || null;
    return a
      ? { connected: true,  obsConnected: a.obsConnected, cameras: a.cameras, streamActive: a.streamActive ?? false, lastReject: null }
      : { connected: false, obsConnected: false,           cameras: [], streamActive: false, lastReject };
  }
}
