// Per-hall RTMP relay: ffmpeg reads from local MediaMTX and pushes to the active
// broadcast destination (YouTube or any other RTMP ingest). No re-encoding —
// OBS already encodes on the notebook; server just copies the stream.
import { spawn } from 'node:child_process';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const RETRY_MS = 4000;
const MAX_RETRIES = 10;

export class YTRelay {
  constructor(log = console.log) {
    this._log = log;
    this._halls = new Map(); // hallId -> { proc, streamKey, ytTarget, retries, stopped, timer }
  }

  start(hallId, streamKey, rtmpUrl, broadcastKey) {
    this.stop(hallId);
    if (!broadcastKey) return { ok: false, error: 'Hala nemá vysílací klíč' };
    const base = (rtmpUrl || '').replace(/\/$/, '');
    if (!base) return { ok: false, error: 'Chybí RTMP adresa vysílací cesty' };
    const ytTarget = `${base}/${broadcastKey}`;
    const s = { proc: null, streamKey, ytTarget, retries: 0, stopped: false, timer: null };
    this._halls.set(hallId, s);
    this._spawn(hallId, s);
    return { ok: true, ytTarget };
  }

  stop(hallId) {
    const s = this._halls.get(hallId);
    if (!s) return;
    s.stopped = true;
    clearTimeout(s.timer);
    if (s.proc) { try { s.proc.kill('SIGKILL'); } catch {} }
    this._halls.delete(hallId);
    this._log(`[Relay] Hala ${hallId} zastavena`);
  }

  isRunning(hallId) { return this._halls.has(hallId); }

  stopAll() { for (const id of [...this._halls.keys()]) this.stop(id); }

  _spawn(hallId, s) {
    if (s.stopped) return;
    const src = `rtmp://${process.env.MEDIAMTX_HOST || '127.0.0.1'}:1935/${s.streamKey}`;
    this._log(`[Relay] Hala ${hallId}: ${src} → ${s.ytTarget}`);

    let proc;
    try {
      proc = spawn(FFMPEG, [
        '-hide_banner', '-loglevel', 'warning',
        '-i', src,
        '-c', 'copy', '-f', 'flv', s.ytTarget
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      this._log(`[Relay] Hala ${hallId} spawn chyba: ${e.message}`);
      this._retry(hallId, s);
      return;
    }

    s.proc = proc;
    proc.stderr.on('data', d => {
      const line = d.toString().trim();
      if (line) this._log(`[Relay:${hallId}] ${line}`);
    });
    proc.on('exit', code => {
      s.proc = null;
      if (!s.stopped) {
        this._log(`[Relay] Hala ${hallId} skončila (${code}), restart…`);
        this._retry(hallId, s);
      }
    });
  }

  _retry(hallId, s) {
    if (s.stopped || s.retries >= MAX_RETRIES) {
      if (s.retries >= MAX_RETRIES) this._log(`[Relay] Hala ${hallId}: max retries, končím`);
      this._halls.delete(hallId);
      return;
    }
    s.retries++;
    s.timer = setTimeout(() => this._spawn(hallId, s), RETRY_MS);
  }
}
