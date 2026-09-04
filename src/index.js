// MultiMix central server: REST API + Socket.IO realtime + static UIs
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { Server as SocketIO } from 'socket.io';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureCert, localIPv4 } from './cert.js';

import { db, getSetting, setSetting, matchElapsedMs, mediaDir,
  periodLengthMs, prevPeriodsMs, totalGameMs, ensureAgentToken,
  listBroadcastServices } from './db.js';
import { hashPassword, verifyPassword, createSession, getSessionUser, deleteSession, getUserHalls, checkLoginRateLimit } from './auth.js';
import { checkApiAccess, checkStreamPreviewAccess, sessionCookie, verifyHallToken } from './auth-guard.js';
import { groupStandings, propagateWinner } from './standings.js';
import { AgentRouter } from './agent-router.js';
import { startTournamentSync, restartTournamentSync, getTournamentState } from './tournament-sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 3000);
const BIND = process.env.MULTIMIX_BIND || '0.0.0.0';

const app = Fastify({ logger: false });
await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 * 1024 } });
await app.register(fastifyStatic, { root: path.join(__dirname, '..', 'public'), prefix: '/' });
await app.register(fastifyStatic, { root: mediaDir, prefix: '/media-files/', decorateReply: false });

// ---------- auth ----------
function parseCookies(header) {
  const c = {};
  if (!header) return c;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) c[k.trim()] = v.join('=');
  }
  return c;
}

// Attach user to every request (null if not logged in)
app.addHook('onRequest', async (req, reply) => {
  const token = parseCookies(req.headers.cookie).session;
  req.user = getSessionUser(token) || null;

  const url = (req.raw.url || '').split('?')[0];

  // Stream preview (WHEP/HLS) — réžie only
  if (url.startsWith('/whep/') || url.startsWith('/whep-resource/') || url.startsWith('/hls/')) {
    const gate = checkStreamPreviewAccess(req);
    if (!gate.allow) return reply.code(gate.status).send({ error: gate.error });
    return;
  }

  // Setup page — réžie only
  if (url === '/setup' || url.startsWith('/setup/')) {
    if (!req.user || !['admin', 'reziser'].includes(req.user.role))
      return reply.redirect('/login/?next=' + encodeURIComponent(req.raw.url || '/setup/'));
    return;
  }

  // Protect admin panel: only admin or reziser
  if (url === '/admin' || url.startsWith('/admin/')) {
    if (!req.user || !['admin', 'reziser'].includes(req.user.role)) {
      return reply.redirect('/login/');
    }
    return;
  }

  // Protect hall panel: any logged-in user (hall assignment checked API-side)
  if (url === '/hall' || url.startsWith('/hall/')) {
    if (!req.user) return reply.redirect('/login/');
    return;
  }

  // API access control
  if (url.startsWith('/api/')) {
    const gate = checkApiAccess(req);
    if (!gate.allow) return reply.code(gate.status).send({ error: gate.error });
  }
});

// ---------- auth API ----------
app.post('/api/auth/login', async (req, reply) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  if (!checkLoginRateLimit(ip))
    return reply.code(429).send({ error: 'Příliš mnoho pokusů, zkus to za chvíli' });
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash))
    return reply.code(401).send({ error: 'Nesprávné jméno nebo heslo' });
  const token = createSession(user.id);
  reply.header('Set-Cookie', sessionCookie(token, req));
  const halls = user.role === 'hall' ? getUserHalls(user.id) : null;
  return { ok: true, user: { id: user.id, username: user.username, role: user.role, halls } };
});

app.post('/api/auth/logout', async (req, reply) => {
  const token = parseCookies(req.headers.cookie).session;
  if (token) deleteSession(token);
  reply.header('Set-Cookie', 'session=; Path=/; HttpOnly; Max-Age=0');
  return { ok: true };
});

app.get('/api/auth/me', async (req) => {
  if (!req.user) return { user: null };
  const halls = req.user.role === 'hall' ? getUserHalls(req.user.id) : null;
  return { user: { ...req.user, halls } };
});

// ---------- users (admin only) ----------
async function requireAdmin(req, reply) {
  if (!req.user || req.user.role !== 'admin')
    return reply.code(403).send({ error: 'Vyžadována role admin' });
}

app.get('/api/users', { preHandler: requireAdmin }, () =>
  db.prepare('SELECT id, username, role FROM users ORDER BY id').all()
);
app.post('/api/users', { preHandler: requireAdmin }, req => {
  const { username, password, role } = req.body;
  if (!username || !password || !['admin', 'reziser', 'hall'].includes(role))
    return { error: 'Neplatná data' };
  const r = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)')
    .run(username, hashPassword(password), role);
  return db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(r.lastInsertRowid);
});
app.put('/api/users/:id', { preHandler: requireAdmin }, req => {
  const { username, password, role } = req.body;
  const cur = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!cur) return { error: 'Uživatel neexistuje' };
  const hash = password ? hashPassword(password) : cur.password_hash;
  db.prepare('UPDATE users SET username=?, password_hash=?, role=? WHERE id=?')
    .run(username ?? cur.username, hash, role ?? cur.role, req.params.id);
  return db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(req.params.id);
});
app.delete('/api/users/:id', { preHandler: requireAdmin }, req => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  return { ok: true };
});

// User-hall assignments
app.get('/api/users/:id/halls', { preHandler: requireAdmin }, req =>
  db.prepare('SELECT hall_id FROM user_halls WHERE user_id = ?').all(req.params.id).map(r => r.hall_id)
);
app.put('/api/users/:id/halls', { preHandler: requireAdmin }, req => {
  const userId = +req.params.id;
  const hallIds = Array.isArray(req.body.halls) ? req.body.halls.map(Number) : [];
  db.prepare('DELETE FROM user_halls WHERE user_id = ?').run(userId);
  for (const hallId of hallIds)
    db.prepare('INSERT OR IGNORE INTO user_halls (user_id, hall_id) VALUES (?,?)').run(userId, hallId);
  return { ok: true };
});

// Never cache the UIs/scripts: overlays update often and OBS browser sources
// caching stale overlay.js was making graphics tweaks appear not to take effect.
// Uploaded media (/media-files) keeps normal caching.
app.addHook('onSend', async (req, reply, payload) => {
  const url = (req.raw.url || '').split('?')[0];
  if (!url.startsWith('/media-files') && (url === '/' || /\.(html|js|css)$/.test(url) || url.endsWith('/'))) {
    reply.header('Cache-Control', 'no-store');
  }
  return payload;
});

const agentRouter = new AgentRouter();

// Overlay URL in OBS is refreshed when the hall agent reports OBS connected.
// OBS streaming itself is configured manually on the notebook (direct RTMP).
const overlaySynced = new Set();

function publicOrigin(req) {
  const fallback = (process.env.PUBLIC_URL || 'https://multimix.pohodovy.cloud').replace(/\/$/, '');
  if (!req) return fallback;
  const proto = req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  if (!host || /^(127\.0\.0\.1|localhost)(:|$)/i.test(host)) return fallback;
  const hostname = host.split(':')[0];
  const isLanIp = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  const scheme = (!isLanIp && proto === 'http') ? 'https' : proto;
  return `${scheme}://${host}`.replace(/\/$/, '');
}

function overlayUrlForHall(hallId, token) {
  return `${publicOrigin()}/overlay/?hall=${+hallId}&driver=1&token=${encodeURIComponent(token || '')}`;
}

function dockUrlForHall(hallId, token, req) {
  return `${publicOrigin(req)}/dock/?hall=${+hallId}&token=${encodeURIComponent(token || '')}`;
}

async function syncHallOverlayUrl(hallId) {
  const id = +hallId;
  const hall = db.prepare('SELECT id, agent_token FROM halls WHERE id = ?').get(id);
  if (!hall) return;
  const token = hall.agent_token || ensureAgentToken(id);
  const overlayUrl = overlayUrlForHall(id, token);
  const hallNeedle = `hall=${id}`;
  try {
    const names = new Set(['Overlay']);
    const list = await agentRouter.obsCmd(id, 'GetInputList', { inputKind: 'browser_source' }).catch(() => ({ inputs: [] }));
    for (const inp of list.inputs || []) names.add(inp.inputName);

    let updated = 0;
    for (const inputName of names) {
      const info = await agentRouter.obsCmd(id, 'GetInputSettings', { inputName }).catch(() => null);
      const current = info?.inputSettings?.url || '';
      const isOverlay = inputName === 'Overlay' || current.includes('/overlay/');
      if (!isOverlay) continue;
      if (current && !current.includes(hallNeedle) && inputName !== 'Overlay') continue;
      if (current === overlayUrl) continue;
      await agentRouter.obsCmd(id, 'SetInputSettings', {
        inputName,
        inputSettings: { ...(info?.inputSettings || {}), url: overlayUrl },
      });
      updated++;
    }
    if (updated)
      console.log(`[overlay] Hala ${id}: URL overlaye obnovena (${updated}, token ${String(token).slice(0, 8)}…)`);
  } catch (e) {
    console.error(`[overlay] Hala ${id}: ${e.message}`);
  }
}

function enrichAgentStatus(status) {
  return (status || []).map(s => ({
    ...s,
    outputActive: !!s.streamActive,
  }));
}

function syncHallOverlayWhenObs(status) {
  const live = new Set((status || []).filter(s => s.obsConnected && !s.tokenRejected).map(s => s.hall));
  for (const id of [...overlaySynced]) {
    if (!live.has(id)) overlaySynced.delete(id);
  }
  for (const id of live) {
    if (overlaySynced.has(id)) continue;
    overlaySynced.add(id);
    syncHallOverlayUrl(id).catch(() => overlaySynced.delete(id));
  }
}

// WHEP (WebRTC playback) proxy — réžia admin preview can't reach MediaMTX:8889 through CF.
app.addContentTypeParser('application/sdp', { parseAs: 'string' }, (req, body, done) => done(null, body));
const whepSessions = new Map();
app.post('/whep/:key', async (req, reply) => {
  const mediamtxHost = process.env.MEDIAMTX_HOST || '127.0.0.1';
  const base = `http://${mediamtxHost}:8889`;
  const r = await fetch(`${base}/${req.params.key}/whep`, {
    method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: req.body
  });
  const sdp = await r.text();
  const loc = r.headers.get('Location');
  if (loc) {
    const token = crypto.randomUUID();
    whepSessions.set(token, new URL(loc, base).href);
    reply.header('Location', `/whep-resource/${token}`);
  }
  return reply.code(r.status).header('Content-Type', 'application/sdp').send(sdp);
});
app.delete('/whep-resource/:token', async (req, reply) => {
  const url = whepSessions.get(req.params.token);
  if (url) { await fetch(url, { method: 'DELETE' }).catch(() => {}); whepSessions.delete(req.params.token); }
  return reply.code(200).send();
});

// HLS proxy — serve MediaMTX HLS segments through the app server (port 443/80).
// Must forward query string — MediaMTX uses ?session=... to track clients.
app.get('/hls/:key/*', async (req, reply) => {
  const mediamtxHost = process.env.MEDIAMTX_HOST || '127.0.0.1';
  const seg = req.params['*'];
  const qs  = new URLSearchParams(req.query).toString();
  const url = `http://${mediamtxHost}:8888/${req.params.key}/${seg}${qs ? '?' + qs : ''}`;
  const r = await fetch(url);
  if (!r.ok) return reply.code(r.status).send();
  const ct = r.headers.get('content-type') || 'application/octet-stream';
  const buf = Buffer.from(await r.arrayBuffer());
  return reply.code(200)
    .header('Content-Type', ct)
    .header('Cache-Control', 'no-store')
    .send(buf);
});

// ---------- helpers ----------
const MATCH_SQL = `
  SELECT m.*,
    ht.name AS home_name, ht.short_name AS home_short,
    ht.color_bg AS home_color_bg, ht.color_text AS home_color_text, ht.logo AS home_logo,
    at.name AS away_name, at.short_name AS away_short,
    at.color_bg AS away_color_bg, at.color_text AS away_color_text, at.logo AS away_logo,
    h.name AS hall_name,
    g.name AS group_name
  FROM matches m
  LEFT JOIN teams ht ON ht.id = m.home_team_id
  LEFT JOIN teams at ON at.id = m.away_team_id
  LEFT JOIN halls h ON h.id = m.hall_id
  LEFT JOIN groups g ON g.id = m.group_id`;

function decorate(m) {
  const target = periodLengthMs(m);
  let elapsed = matchElapsedMs(m);
  if (target > 0) elapsed = Math.min(elapsed, target);
  m.elapsed_ms = elapsed;
  m.period_target_ms = target;   // length of the current period (auto-stop)
  m.total_game_ms = totalGameMs(m);
  const until = m.timeout_until || 0;
  m.timeout_remaining_ms = until > Date.now() ? until - Date.now() : 0;
  if (!m.timeout_remaining_ms) m.timeout_side = null;
  return m;
}
function getMatch(id) {
  const m = db.prepare(MATCH_SQL + ' WHERE m.id = ?').get(id);
  return m ? decorate(m) : m;
}
function listMatches(where = '', params = []) {
  return db.prepare(MATCH_SQL + (where ? ' WHERE ' + where : '') + ' ORDER BY m.scheduled_at')
    .all(...params).map(decorate);
}
function liveMatchForHall(hallId) {
  return listMatches(`m.hall_id = ? AND m.status = 'live'`, [hallId])[0] ?? null;
}

let io; // set after listen
function emitMatch(matchId) {
  const m = getMatch(matchId);
  if (!m) return;
  io.emit('match:update', m);
  if (m.hall_id) io.emit(`hall:${m.hall_id}:match`, m);
}
function emitHorn(hallId, kind) {
  if (!io || !hallId) return;
  io.emit(`hall:${hallId}:horn`, { kind });
}
function emitSchedule() { io.emit('schedule:update'); }
function hornPayload() {
  const filename = getSetting('horn_filename') || '';
  if (!filename) return { url: null, filename: null };
  const t = getSetting('horn_updated_at') || '0';
  return { url: `/media-files/${filename}?t=${encodeURIComponent(t)}`, filename };
}
function autoAlert(text) {
  db.prepare("INSERT INTO alerts (text, level, active) VALUES (?, 'info', 1)").run(text);
  io.emit('alerts:update');
}
const ROUND_LABELS = { OF: 'Osmifinále', QF: 'Čtvrtfinále', SF: 'Semifinále', F: 'Finále', '3rd': 'O 3. místo' };
function matchStageLabel(m) {
  if (m.stage === 'playoff') return ROUND_LABELS[m.round] || m.round || '';
  if (!m.group_name) return '';
  const g = String(m.group_name).trim();
  return /^skupina\b/i.test(g) ? g : `Skupina ${g}`;
}
function matchLabel(m) {
  const score = `${m.home_short ?? m.home_name ?? '?'} – ${m.away_short ?? m.away_name ?? '?'} ${m.home_score}:${m.away_score}`;
  const extra = [matchStageLabel(m), m.hall_name].filter(Boolean);
  return extra.length ? `${score} · ${extra.join(' · ')}` : score;
}

// ---------- settings ----------
app.get('/api/settings', () => Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value])));
app.put('/api/settings', req => {
  const keys = Object.keys(req.body);
  for (const [k, v] of Object.entries(req.body)) setSetting(k, v);
  if (keys.some(k => k === 'tournament_supabase_url' || k === 'tournament_supabase_anon_key'))
    restartTournamentSync();
  return { ok: true };
});

function normalizeRtmpUrl(url) {
  const u = String(url || '').trim().replace(/\/$/, '');
  if (!/^rtmps?:\/\//i.test(u)) return null;
  return u;
}

function broadcastServiceRow(id) {
  const activeId = +(getSetting('active_broadcast_service_id') || 0);
  const s = db.prepare('SELECT * FROM broadcast_services WHERE id = ?').get(id);
  return s ? { ...s, active: s.id === activeId ? 1 : 0 } : null;
}

app.get('/api/broadcast-services', () => listBroadcastServices());
app.post('/api/broadcast-services', req => {
  const name = String(req.body?.name || '').trim();
  const rtmp_url = normalizeRtmpUrl(req.body?.rtmp_url);
  if (!name || !rtmp_url) return { error: 'Vyplň název a platnou RTMP adresu (rtmp:// nebo rtmps://)' };
  const r = db.prepare('INSERT INTO broadcast_services (name, rtmp_url) VALUES (?,?)').run(name, rtmp_url);
  return broadcastServiceRow(r.lastInsertRowid);
});
app.put('/api/broadcast-services/:id', req => {
  const cur = db.prepare('SELECT * FROM broadcast_services WHERE id = ?').get(req.params.id);
  if (!cur) return { error: 'Služba neexistuje' };
  const name = req.body?.name != null ? String(req.body.name).trim() : cur.name;
  const rtmp_url = req.body?.rtmp_url != null ? normalizeRtmpUrl(req.body.rtmp_url) : cur.rtmp_url;
  if (!name || !rtmp_url) return { error: 'Vyplň název a platnou RTMP adresu (rtmp:// nebo rtmps://)' };
  db.prepare('UPDATE broadcast_services SET name=?, rtmp_url=? WHERE id=?').run(name, rtmp_url, cur.id);
  if (req.body?.active) setSetting('active_broadcast_service_id', String(cur.id));
  return broadcastServiceRow(cur.id);
});
app.post('/api/broadcast-services/:id/activate', req => {
  const cur = db.prepare('SELECT * FROM broadcast_services WHERE id = ?').get(req.params.id);
  if (!cur) return { error: 'Služba neexistuje' };
  setSetting('active_broadcast_service_id', String(cur.id));
  return { ok: true, ...broadcastServiceRow(cur.id) };
});
app.delete('/api/broadcast-services/:id', req => {
  const cur = db.prepare('SELECT * FROM broadcast_services WHERE id = ?').get(req.params.id);
  if (!cur) return { error: 'Služba neexistuje' };
  if (cur.builtin) return { error: 'Vestavěnou službu nelze smazat' };
  const activeId = +(getSetting('active_broadcast_service_id') || 0);
  if (cur.id === activeId) return { error: 'Nelze smazat aktivní cestu — nejdřív vyber jinou' };
  db.prepare('DELETE FROM broadcast_services WHERE id = ?').run(cur.id);
  return { ok: true };
});

app.get('/api/horn', () => hornPayload());
app.post('/api/horn/upload', async (req, reply) => {
  const part = await req.file();
  if (!part) return reply.code(400).send({ error: 'Chybí soubor' });
  const name = part.filename || '';
  const ok = /\.mp3$/i.test(name) || /audio\/mpeg/i.test(part.mimetype || '');
  if (!ok) {
    part.file.resume();
    return reply.code(400).send({ error: 'Nahraj soubor MP3' });
  }
  const filename = 'horn_custom.mp3';
  await pipeline(part.file, fs.createWriteStream(path.join(mediaDir, filename)));
  setSetting('horn_filename', filename);
  setSetting('horn_updated_at', String(Date.now()));
  const payload = hornPayload();
  io.emit('horn:update', payload);
  return payload;
});
app.delete('/api/horn', () => {
  const filename = getSetting('horn_filename');
  if (filename) try { fs.unlinkSync(path.join(mediaDir, filename)); } catch {}
  setSetting('horn_filename', '');
  setSetting('horn_updated_at', String(Date.now()));
  const payload = { url: null, filename: null };
  io.emit('horn:update', payload);
  return payload;
});

// ---------- halls ----------
app.get('/api/halls', req => {
  if (req.user?.role === 'hall') {
    const ids = getUserHalls(req.user.id);
    if (!ids.length) return [];
    return db.prepare(
      `SELECT id, name, stream_key, overlay_visible, tournament_court_id FROM halls WHERE id IN (${ids.map(() => '?').join(',')})`
    ).all(...ids);
  }
  return db.prepare('SELECT * FROM halls').all();
});
app.post('/api/halls', req => {
  const { name, stream_key } = req.body;
  const r = db.prepare('INSERT INTO halls (name, stream_key) VALUES (?, ?)').run(name, stream_key);
  ensureAgentToken(r.lastInsertRowid);
  return db.prepare('SELECT * FROM halls WHERE id = ?').get(r.lastInsertRowid);
});
app.put('/api/halls/:id', req => {
  const { name, stream_key, yt_stream_key, yt_video_id, tournament_court_id } = req.body;
  const cur = db.prepare('SELECT * FROM halls WHERE id = ?').get(req.params.id);
  if (!cur) return { error: 'Hala nenalezena' };
  db.prepare(`UPDATE halls SET name=?, stream_key=?, yt_stream_key=?, yt_video_id=?, tournament_court_id=? WHERE id=?`)
    .run(name, stream_key, yt_stream_key ?? cur.yt_stream_key, yt_video_id ?? cur.yt_video_id, tournament_court_id || null, req.params.id);
  return db.prepare('SELECT * FROM halls WHERE id = ?').get(req.params.id);
});

app.get('/api/halls/:id/tournament', req => getTournamentState(+req.params.id));

// Tournament integration: list courts from Supabase for admin UI
app.get('/api/tournament/courts', async () => {
  const url = getSetting('tournament_supabase_url');
  const key = getSetting('tournament_supabase_anon_key');
  if (!url || !key) return [];
  try {
    const r = await fetch(`${url}/rest/v1/courts?select=id,name&order=sort_order.asc`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    return r.ok ? r.json() : [];
  } catch { return []; }
});
app.delete('/api/halls/:id', req => { db.prepare('DELETE FROM halls WHERE id = ?').run(req.params.id); return { ok: true }; });

app.get('/api/halls/:id/overlay-state', req => {
  const h = db.prepare('SELECT id, overlay_visible FROM halls WHERE id = ?').get(+req.params.id);
  if (!h) return { error: 'Hala nenalezena' };
  return h;
});

app.post('/api/halls/:id/regenerate-agent-token', { preHandler: requireAdmin }, req => {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('UPDATE halls SET agent_token = ? WHERE id = ?').run(token, +req.params.id);
  return { ok: true, agent_token: token };
});

// Live agent config for hall notebooks (fixes stale tokens without full reinstall)
app.get('/api/halls/:id/agent-config', async (req, reply) => {
  if (!req.user || !['admin', 'reziser'].includes(req.user.role))
    return reply.code(403).send({ error: 'Nedostatečná oprávnění' });
  const hall = db.prepare('SELECT * FROM halls WHERE id = ?').get(+req.params.id);
  if (!hall) return reply.code(404).send({ error: 'Hala nenalezena' });
  const server = publicOrigin(req);
  const cfg = {
    hall: hall.id,
    server,
    token: hall.agent_token || ensureAgentToken(hall.id),
    downloadedAt: new Date().toISOString(),
  };
  reply.header('Content-Type', 'application/json; charset=utf-8');
  reply.header('Content-Disposition', 'attachment; filename="agent-config.json"');
  return cfg;
});

app.post('/api/halls/:id/alerts/:alertId/dismiss', async (req, reply) => {
  const hallId = +req.params.id;
  if (!verifyHallToken(hallId, req.headers['x-hall-token']))
    return reply.code(403).send({ error: 'Neplatný token haly' });
  db.prepare('UPDATE alerts SET active = 0 WHERE id = ?').run(+req.params.alertId);
  io.emit('alerts:update');
  return { ok: true };
});
// Show/hide the scoreboard overlay for a hall (animated on the overlay side)
app.post('/api/halls/:id/overlay', req => {
  const visible = req.body.visible ? 1 : 0;
  db.prepare('UPDATE halls SET overlay_visible = ? WHERE id = ?').run(visible, req.params.id);
  io.emit(`hall:${req.params.id}:overlay`, { visible: !!visible });
  return { ok: true, visible: !!visible };
});

// ---------- match settings templates ----------
app.get('/api/templates', () => db.prepare('SELECT * FROM templates ORDER BY id').all());
app.post('/api/templates', req => {
  const { name, period_length_min = 30, periods = 2, timeouts = 3, suspension_s = 120 } = req.body;
  const r = db.prepare('INSERT INTO templates (name, period_length_min, periods, timeouts, suspension_s) VALUES (?,?,?,?,?)')
    .run(name, period_length_min, periods, timeouts, suspension_s);
  return db.prepare('SELECT * FROM templates WHERE id = ?').get(r.lastInsertRowid);
});
app.put('/api/templates/:id', req => {
  const c = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  const b = { ...c, ...req.body };
  db.prepare('UPDATE templates SET name=?, period_length_min=?, periods=?, timeouts=?, suspension_s=? WHERE id=?')
    .run(b.name, b.period_length_min, b.periods, b.timeouts, b.suspension_s, req.params.id);
  return db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
});
app.delete('/api/templates/:id', req => { db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id); return { ok: true }; });

// ---------- agent status ----------
app.get('/api/agent/version', () => {
  const f = path.join(__dirname, '..', 'public', 'downloads', 'multimix-agent-version.txt');
  const version = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '0';
  return { version };
});

app.get('/api/agent/status', () => enrichAgentStatus(agentRouter.status()));
app.get('/api/agent/:hallId/status', req => agentRouter.hallStatus(+req.params.hallId));

// ---------- agent OBS scene setup ----------
app.post('/api/agent/:hallId/setup-scene', async req => {
  const hallId = +req.params.hallId;
  const hall   = db.prepare('SELECT * FROM halls WHERE id = ?').get(hallId);
  if (!hall) return { ok: false, error: 'Hala nenalezena' };

  const cameraId = req.body?.cameraId || '';

  // Overlay uses the public HTTPS domain (browser source in OBS must load via HTTPS).
  // RTMP destination is set manually in OBS (direct to YouTube / broadcast path).
  const overlayUrl = overlayUrlForHall(hallId, hall.agent_token || ensureAgentToken(hallId));
  const SCENE      = 'MultiMix';
  const steps      = [];

  const cmd = (method, params = {}) => agentRouter.obsCmd(hallId, method, params);

  // Returns sceneItemId for a named source in the scene (null if not found).
  async function getItemId(sourceName) {
    const r = await cmd('GetSceneItemList', { sceneName: SCENE });
    const item = (r.sceneItems || []).find(i => i.sourceName === sourceName);
    return item ? item.sceneItemId : null;
  }

  // Stretch a scene item to fill the full 1920×1080 canvas.
  async function fillCanvas(sceneItemId) {
    await cmd('SetSceneItemTransform', {
      sceneName: SCENE,
      sceneItemId,
      sceneItemTransform: {
        positionX: 0, positionY: 0,
        boundsType: 'OBS_BOUNDS_STRETCH',
        boundsWidth: 1920, boundsHeight: 1080,
        alignment: 5
      }
    });
  }

  try {
    // 1. Canvas resolution & FPS
    await cmd('SetVideoSettings', {
      baseWidth: 1920, baseHeight: 1080,
      outputWidth: 1920, outputHeight: 1080,
      fpsNumerator: 30, fpsDenominator: 1
    });
    steps.push('Rozlišení 1920×1080 @ 30 fps');

    // 2. Scene
    await cmd('CreateScene', { sceneName: SCENE }).catch(() => {});
    await cmd('SetCurrentProgramScene', { sceneName: SCENE });
    steps.push('Scéna "' + SCENE + '" aktivní');

    // 3. Camera — create or update, then stretch to fill canvas
    if (cameraId) {
      let camItemId;
      const createRes = await cmd('CreateInput', {
        sceneName: SCENE, inputName: 'Kamera', inputKind: 'dshow_input',
        inputSettings: { video_device_id: cameraId }, sceneItemEnabled: true
      }).catch(async () => {
        await cmd('SetInputSettings', {
          inputName: 'Kamera', inputSettings: { video_device_id: cameraId }
        }).catch(() => {});
        return null; // already existed
      });
      camItemId = createRes?.sceneItemId ?? await getItemId('Kamera');
      if (camItemId != null) await fillCanvas(camItemId).catch(() => {});
      steps.push('Kamera: ' + cameraId.slice(0, 60));
    } else {
      steps.push('Kamera přeskočena (nebyla vybrána)');
    }

    // 4. Browser source overlay — create or update URL
    const browserSettings = {
      url: overlayUrl, width: 1920, height: 1080,
      fps: 30, reroute_audio: true, css: ''
    };
    const overlayRes = await cmd('CreateInput', {
      sceneName: SCENE, inputName: 'Overlay', inputKind: 'browser_source',
      inputSettings: browserSettings, sceneItemEnabled: true
    }).catch(async () => {
      await cmd('SetInputSettings', {
        inputName: 'Overlay', inputSettings: browserSettings
      }).catch(() => {});
      return null;
    });

    // Position overlay at 0,0 and ensure it's on top
    const overlayItemId = overlayRes?.sceneItemId ?? await getItemId('Overlay');
    if (overlayItemId != null) {
      await cmd('SetSceneItemTransform', {
        sceneName: SCENE, sceneItemId: overlayItemId,
        sceneItemTransform: { positionX: 0, positionY: 0, alignment: 5 }
      }).catch(() => {});
      const allItems = await cmd('GetSceneItemList', { sceneName: SCENE });
      const maxIdx = Math.max(0, ...(allItems.sceneItems || []).map(i => i.sceneItemIndex));
      await cmd('SetSceneItemIndex', {
        sceneName: SCENE, sceneItemId: overlayItemId, newIndex: maxIdx
      }).catch(() => {});
    }
    steps.push('Overlay: ' + overlayUrl.replace(/([?&]token=)[^&]*/i, '$1…'));
    steps.push('RTMP: nastav ručně v OBS (přímo na vysílací cestu)');

    // 6. Keyframe interval 2s (YouTube requirement ≤4s)
    const outputs = await cmd('GetOutputList').catch(() => ({ outputs: [] }));
    const streamOut = (outputs.outputs || []).find(o => o.outputKind === 'rtmp_output');
    if (streamOut) {
      await cmd('SetOutputSettings', {
        outputName: streamOut.outputName,
        outputSettings: { keyint_sec: 2 }
      }).catch(() => {});
      steps.push('Keyframe interval: 2s');
    } else {
      steps.push('Keyframe: nastav ručně na 2s v OBS → Výstup → Kódování');
    }

    return { ok: true, steps };
  } catch (e) {
    return { ok: false, error: e.message, steps };
  }
});

// ---------- agent OBS start/stop (destination is configured manually in OBS) ----------
app.post('/api/agent/:hallId/start-stream', async req => {
  const hallId = +req.params.hallId;
  try {
    await agentRouter.obsCmd(hallId, 'StartStream');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

app.post('/api/agent/:hallId/stop-stream', async req => {
  const hallId = +req.params.hallId;
  try {
    await agentRouter.obsCmd(hallId, 'StopStream');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

app.post('/api/agent/:hallId/remote/start', async (req, reply) => {
  if (!req.user || !['admin', 'reziser'].includes(req.user.role))
    return reply.code(403).send({ error: 'Nedostatečná oprávnění' });
  const hallId = +req.params.hallId;
  if (!agentRouter.isConnected(hallId))
    return reply.code(503).send({ error: 'Agent haly není připojen' });
  const body = req.body || {};
  return agentRouter.startRemoteCapture(hallId, body);
});

app.post('/api/agent/:hallId/remote/stop', async (req, reply) => {
  if (!req.user || !['admin', 'reziser'].includes(req.user.role))
    return reply.code(403).send({ error: 'Nedostatečná oprávnění' });
  const hallId = +req.params.hallId;
  return agentRouter.stopRemoteCapture(hallId);
});

app.post('/api/agent/:hallId/setup-dock', async req => {
  const hallId = +req.params.hallId;
  const hall   = db.prepare('SELECT * FROM halls WHERE id = ?').get(hallId);
  if (!hall) return { ok: false, error: 'Hala nenalezena' };
  const url    = dockUrlForHall(hallId, hall.agent_token || ensureAgentToken(hallId), req);
  const title  = `MultiMix Hala ${hallId}`;
  try {
    const result = await agentRouter.agentCmd(hallId, 'setup-dock', { url, title });
    return { ok: true, url: url.replace(/([?&]token=)[^&]*/i, '$1…'), ...result };
  } catch (e) { return { ok: false, error: e.message }; }
});

app.get('/api/agent/:hallId/logs', req => agentRouter.logs(+req.params.hallId));

app.get('/api/agent/:hallId/obs-config-list', async req => {
  try {
    const result = await agentRouter.agentCmd(+req.params.hallId, 'list-obs-config', {});
    return { ok: true, ...result };
  } catch (e) { return { ok: false, error: e.message }; }
});

app.get('/api/agent/:hallId/obs-config', async req => {
  try {
    const result = await agentRouter.agentCmd(+req.params.hallId, 'read-obs-config', {});
    return { ok: true, ...result };
  } catch (e) { return { ok: false, error: e.message }; }
});

function resolveStinger() {
  const stingerId = getSetting('stinger_media_id');
  if (!stingerId) return null;
  const s = db.prepare('SELECT filename FROM media WHERE id=?').get(+stingerId);
  if (!s?.filename) return null;
  if (!fs.existsSync(path.join(mediaDir, s.filename))) return null;
  return s.filename;
}

// ---------- overlay spot (new architecture: video in browser source, mic via agent) ----------
app.post('/api/overlay/:hallId/spot', async req => {
  const hallId = +req.params.hallId;
  const m = db.prepare('SELECT * FROM media WHERE id = ?').get(req.body.media_id);
  if (!m) return { error: 'médium nenalezeno' };
  if (!fs.existsSync(path.join(mediaDir, m.filename)))
    return { error: 'soubor média na serveru chybí' };
  const stinger = resolveStinger();
  const cutPct = +getSetting('stinger_cut_pct') || 50;
  agentRouter.send(hallId, 'agent:mute-mic', {});
  io.emit('spot:play', { hallId, filename: m.filename, name: m.name || m.filename, stinger, cutPct });
  return { ok: true };
});
app.post('/api/overlay/:hallId/spot/stop', async req => {
  const hallId = +req.params.hallId;
  stopScenario(hallId);
  io.emit('scenario:done', { hallId });
  if (adBreaks.has(hallId)) { adBreaks.delete(hallId); io.emit('adbreak:stop', { hallId }); }
  io.emit('spot:stop', { hallId });
  agentRouter.send(hallId, 'agent:unmute-mic', {});
  return { ok: true };
});

// ---------- reklamné bloky (weighted ad break) ----------
// Active ad-break halls (mic stays muted until overlay reports adbreak:ended).
const adBreaks = new Set();

// Running scenarios: hallId -> { steps, stepIdx, phase, timer, stinger, cutPct }
const runningScenarios = new Map();

function stopScenario(hallId) {
  const state = runningScenarios.get(hallId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  runningScenarios.delete(hallId);
  io.emit('scenario:abort', { hallId }); // tell overlay to restore score/branding immediately
}

async function execScenarioStep(hallId, state) {
  if (!runningScenarios.has(hallId)) return;
  const step = state.steps[state.stepIdx];
  const params = JSON.parse(step.params || '{}');
  const total = state.steps.length;
  io.emit('scenario:step', { hallId, stepIdx: state.stepIdx, total, type: step.type });

  if (step.type === 'spot') {
    const m = db.prepare('SELECT * FROM media WHERE id = ?').get(params.media_id);
    if (!m || !fs.existsSync(path.join(mediaDir, m.filename))) { advanceScenario(hallId); return; }
    agentRouter.send(hallId, 'agent:mute-mic', {});
    io.emit('spot:play', { hallId, filename: m.filename, name: m.name || m.filename, stinger: state.stinger, cutPct: state.cutPct });
    // advance triggered by spot:ended socket event (fires after closing stinger)

  } else if (step.type === 'adbreak') {
    const block = params.block;
    const count = block ? (BLOCK_COUNTS[block]?.() ?? 1) : (+params.count || 1);
    const ads = pickWeightedAds(count);
    if (!ads.length) { advanceScenario(hallId); return; }
    adBreaks.add(hallId);
    agentRouter.send(hallId, 'agent:mute-mic', {});
    io.emit('adbreak:play', { hallId, stinger: state.stinger, cutPct: state.cutPct, ads });
    // advance triggered by adbreak:ended socket event (fires after closing stinger)

  } else if (step.type === 'lineups') {
    const duration = (params.duration_s || 30) * 1000;
    const m = currentMatchForHall(hallId);
    if (!m) { advanceScenario(hallId); return; }
    io.emit('lineups:show', { hallId, home: teamLineup(m, 'home'), away: teamLineup(m, 'away') });
    state.timer = setTimeout(() => {
      io.emit('lineups:hide', { hallId });
      advanceScenario(hallId);
    }, duration);

  } else if (step.type === 'upcoming') {
    const duration = (params.duration_s || 30) * 1000;
    const matches = upcomingForHall(hallId);
    io.emit('upcoming:show', { hallId, matches });
    state.timer = setTimeout(() => {
      io.emit('upcoming:hide', { hallId });
      advanceScenario(hallId);
    }, duration);

  } else if (step.type === 'wait') {
    const duration = (params.seconds || 5) * 1000;
    state.timer = setTimeout(() => advanceScenario(hallId), duration);

  } else {
    advanceScenario(hallId);
  }
}

function advanceScenario(hallId) {
  const state = runningScenarios.get(hallId);
  if (!state) return;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  state.stepIdx++;
  if (state.stepIdx >= state.steps.length) {
    state.phase = 'end';
    // No global closing stinger — the last ad/spot step already closed with its own stinger
    io.emit('scenario:end', { hallId, stinger: null, cutPct: 0 });
    // safety: if overlay never responds with scenario:closed (e.g. stinger video fails),
    // force-finish after 10s so the stop button disappears and score is restored
    state.timer = setTimeout(() => {
      if (runningScenarios.get(hallId) === state) {
        runningScenarios.delete(hallId);
        agentRouter.send(hallId, 'agent:unmute-mic', {});
        io.emit('scenario:done', { hallId });
      }
    }, 10000);
    return;
  }
  // Stingers on each ad/spot step provide the visual transitions; no extra gap needed
  execScenarioStep(hallId, state);
}

// Smooth Weighted Round-Robin: pick `count` ads from the active ad pool,
// proportional to weight, evenly distributed. State (swrr_current) persists
// in DB so the distribution converges to the configured weights over time.
function pickWeightedAds(count) {
  const ads = db.prepare(
    `SELECT id, name, filename, weight, swrr_current FROM media
     WHERE type='video' AND is_ad=1 AND ad_active=1`).all();
  if (!ads.length) return [];
  const totalWeight = ads.reduce((s, a) => s + Math.max(1, a.weight), 0);
  const picked = [];
  for (let i = 0; i < count; i++) {
    let best = null;
    for (const a of ads) {
      a.swrr_current += Math.max(1, a.weight);
      if (!best || a.swrr_current > best.swrr_current) best = a;
    }
    best.swrr_current -= totalWeight;
    picked.push({ filename: best.filename, name: best.name });
  }
  // Persist running SWRR state
  const upd = db.prepare('UPDATE media SET swrr_current=? WHERE id=?');
  for (const a of ads) upd.run(a.swrr_current, a.id);
  return picked;
}

const BLOCK_COUNTS = {
  timeout:  () => +getSetting('ad_block_timeout')  || 1,
  halftime: () => +getSetting('ad_block_halftime') || 3,
  between:  () => +getSetting('ad_block_between')   || 5
};

app.post('/api/overlay/:hallId/ad-break', async req => {
  const hallId = +req.params.hallId;
  const block = req.body.block;            // timeout | halftime | between
  const count = block ? BLOCK_COUNTS[block]?.() : (+req.body.count || 1);
  if (!count) return { error: 'neznámý typ bloku' };
  const ads = pickWeightedAds(count);
  if (!ads.length) return { error: 'žádné aktivní reklamy' };
  const stinger = resolveStinger();
  const cutPct = +getSetting('stinger_cut_pct') || 50;
  adBreaks.add(hallId);
  agentRouter.send(hallId, 'agent:mute-mic', {});
  io.emit('adbreak:play', { hallId, stinger, ads, cutPct });
  return { ok: true, spots: count };
});

// ---------- team lineups (pre-match rosters shown full-screen in the overlay) ----------
// Pick the match to show rosters for: a live match takes priority, otherwise the
// soonest upcoming scheduled match assigned to the hall.
function currentMatchForHall(hallId) {
  return liveMatchForHall(hallId)
    ?? listMatches(`m.hall_id = ? AND m.status = 'scheduled'`, [hallId])[0]
    ?? null;
}
function teamLineup(m, side) {
  const teamId = m[`${side}_team_id`];
  const players = teamId
    ? db.prepare('SELECT number, name, position FROM players WHERE team_id = ? ORDER BY (number IS NULL), number')
        .all(teamId)
    : [];
  return {
    name: m[`${side}_name`] || m[`${side}_placeholder`] || '',
    color_bg: m[`${side}_color_bg`] || '#1d3fb8',
    color_text: m[`${side}_color_text`] || '#ffffff',
    logo: m[`${side}_logo`] || '',
    players,
  };
}
app.post('/api/overlay/:hallId/lineups', async req => {
  const hallId = +req.params.hallId;
  const m = currentMatchForHall(hallId);
  if (!m) return { error: 'žádný zápas pro tuto halu' };
  io.emit('lineups:show', { hallId, home: teamLineup(m, 'home'), away: teamLineup(m, 'away') });
  return { ok: true };
});
app.post('/api/overlay/:hallId/lineups/stop', async req => {
  io.emit('lineups:hide', { hallId: +req.params.hallId });
  return { ok: true };
});

// ---------- scenarios ----------
app.get('/api/scenarios', () => db.prepare('SELECT * FROM scenarios ORDER BY id').all());

app.post('/api/scenarios', req => {
  const { name } = req.body;
  if (!name) return { error: 'name chýba' };
  const r = db.prepare('INSERT INTO scenarios (name) VALUES (?)').run(name);
  return db.prepare('SELECT * FROM scenarios WHERE id = ?').get(r.lastInsertRowid);
});

app.put('/api/scenarios/:id', req => {
  const { name } = req.body;
  db.prepare('UPDATE scenarios SET name = ? WHERE id = ?').run(name, req.params.id);
  return db.prepare('SELECT * FROM scenarios WHERE id = ?').get(req.params.id);
});

app.delete('/api/scenarios/:id', req => {
  db.prepare('DELETE FROM scenarios WHERE id = ?').run(req.params.id);
  return { ok: true };
});

app.get('/api/scenarios/:id/steps', req =>
  db.prepare('SELECT * FROM scenario_steps WHERE scenario_id = ? ORDER BY step_order, id').all(req.params.id)
);

app.post('/api/scenarios/:id/steps', req => {
  const { type, params = {} } = req.body;
  const maxRow = db.prepare('SELECT MAX(step_order) m FROM scenario_steps WHERE scenario_id = ?').get(req.params.id);
  const nextOrder = (maxRow.m ?? -1) + 1;
  const r = db.prepare('INSERT INTO scenario_steps (scenario_id, step_order, type, params) VALUES (?,?,?,?)')
    .run(req.params.id, nextOrder, type, JSON.stringify(params));
  return db.prepare('SELECT * FROM scenario_steps WHERE id = ?').get(r.lastInsertRowid);
});

app.put('/api/scenario-steps/:id', req => {
  const cur = db.prepare('SELECT * FROM scenario_steps WHERE id = ?').get(req.params.id);
  if (!cur) return { error: 'krok nenájdený' };
  const { type, params, step_order } = req.body;
  db.prepare('UPDATE scenario_steps SET type=?, params=?, step_order=? WHERE id=?')
    .run(type ?? cur.type, params != null ? JSON.stringify(params) : cur.params, step_order ?? cur.step_order, req.params.id);
  return db.prepare('SELECT * FROM scenario_steps WHERE id = ?').get(req.params.id);
});

app.delete('/api/scenario-steps/:id', req => {
  db.prepare('DELETE FROM scenario_steps WHERE id = ?').run(req.params.id);
  return { ok: true };
});

app.post('/api/scenarios/:id/run', async req => {
  const hallId = +req.query.hallId;
  if (!hallId) return { error: 'hallId chýba' };
  const scenario = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(req.params.id);
  if (!scenario) return { error: 'Scénář nenalezen' };
  const steps = db.prepare('SELECT * FROM scenario_steps WHERE scenario_id = ? ORDER BY step_order, id').all(req.params.id);
  if (!steps.length) return { error: 'Scénář nemá žádné kroky' };
  stopScenario(hallId);
  const stinger = resolveStinger();
  const cutPct = +getSetting('stinger_cut_pct') || 50;
  const state = { steps, stepIdx: 0, phase: 'begin', timer: null, stinger, cutPct };
  runningScenarios.set(hallId, state);
  io.emit('scenario:start', { hallId, scenarioId: scenario.id, name: scenario.name, total: steps.length });
  // No global opening stinger — each ad/spot step plays its own stinger on both ends
  io.emit('scenario:begin', { hallId, stinger: null, cutPct });
  // execution continues via scenario:ready socket event from the overlay
  return { ok: true };
});

app.post('/api/scenarios/:id/stop', async req => {
  const hallId = +req.query.hallId;
  stopScenario(hallId);
  io.emit('scenario:done', { hallId });
  return { ok: true };
});

// ---------- upcoming matches (next 3 scheduled for a hall) ----------
const UPCOMING_SQL = `
  SELECT m.id, m.stage, m.round, m.scheduled_at,
    m.home_placeholder, m.away_placeholder,
    ht.name AS home_name, ht.color_bg AS home_color_bg, ht.color_text AS home_color_text, ht.logo AS home_logo,
    at.name AS away_name, at.color_bg AS away_color_bg, at.color_text AS away_color_text, at.logo AS away_logo,
    h.name AS hall_name,
    g.name AS group_name
  FROM matches m
  LEFT JOIN teams ht ON ht.id = m.home_team_id
  LEFT JOIN teams at ON at.id = m.away_team_id
  LEFT JOIN halls h ON h.id = m.hall_id
  LEFT JOIN groups g ON g.id = m.group_id
  WHERE m.hall_id = ? AND m.status = 'scheduled'
  ORDER BY m.scheduled_at ASC
  LIMIT 3`;

function upcomingForHall(hallId) {
  return db.prepare(UPCOMING_SQL).all(hallId);
}

app.get('/api/halls/:id/upcoming', req => upcomingForHall(+req.params.id));

app.post('/api/overlay/:hallId/upcoming', async req => {
  const hallId = +req.params.hallId;
  const matches = upcomingForHall(hallId);
  io.emit('upcoming:show', { hallId, matches });
  return { ok: true, count: matches.length };
});

app.post('/api/overlay/:hallId/upcoming/stop', async req => {
  io.emit('upcoming:hide', { hallId: +req.params.hallId });
  return { ok: true };
});

// ---------- setup page (download for hall notebooks) ----------
function setupPageHtml(hall, serverUrl) {
  const hallToken = hall.agent_token || '';
  const dockUrl = `${serverUrl}/dock/?hall=${hall.id}&token=${encodeURIComponent(hallToken)}`;
  const exeName = `multimix-setup-hala-${hall.id}.exe`;
  const exePath = path.join(__dirname, '..', 'public', 'downloads', exeName);
  const exeExists = fs.existsSync(exePath);
  const exeSizeMB = exeExists ? (fs.statSync(exePath).size / 1e6).toFixed(0) : 0;

  const exeVer = exeExists ? fs.statSync(exePath).mtimeMs.toFixed(0) : '0';
  const agentOnlyPath = path.join(__dirname, '..', 'public', 'downloads', 'multimix-agent.exe');
  const agentOnlyExists = fs.existsSync(agentOnlyPath);
  const agentOnlyVer = agentOnlyExists ? fs.statSync(agentOnlyPath).mtimeMs.toFixed(0) : '0';
  const downloadBlock = exeExists
    ? `<a class="btn" href="/downloads/${exeName}?v=${exeVer}" download="${exeName}">&#11123; Stáhnout ${exeName} (${exeSizeMB}&nbsp;MB)</a>
       <p class="note">Dvakrát klikni na <b>nově stažený</b> soubor (ne starý z Downloads) – nainstaluje OBS, zapíše token a vytvoří zástupce.</p>`
    : `<div class="warn">Instalační soubor ještě nebyl vygenerován.<br>
       Na vývojovém PC spusť:<br>
       <code>node tools/build-installer.mjs --hall ${hall.id} --server https://multimix.pohodovy.cloud</code><br>
       Pak nasaď přes <code>git push vm main</code>.</div>`;

  const tokenPfx = (hall.agent_token || '').slice(0, 8) || '????????';
  const agentOnlyBtn = agentOnlyExists
    ? `<a class="btn" style="background:#1f6feb;margin-top:10px" href="/downloads/multimix-agent.exe?v=${agentOnlyVer}" download="multimix-agent.exe">&#11123; Stáhnout jen multimix-agent.exe</a>`
    : '';
  const repairBlock = `
    <p style="margin-top:14px"><b>Oprava tokenu</b> (bez reinstalace OBS)</p>
    <p class="note">Starý zástupce má v <b>Cíli</b> parametr <code style="display:inline;padding:0 4px">--token</code>.
    Starý agent tento token použije a <b>soubor agent-config.json ignoruje</b>.</p>
    <ol style="color:#8b949e;font-size:14px;padding-left:20px;margin:8px 0 12px">
      <li>Zavři okno MultiMix agenta.</li>
      <li>Na ploše pravý klik na <b>MultiMix Hala ${hall.id}</b> → <b>Vlastnosti</b>.</li>
      <li>Pole <b>Cíl</b> uprav na jen:
        <code>"%AppData%\\MultiMix\\multimix-agent.exe"</code>
        Smaž <code style="display:inline;padding:0 4px">--hall</code>, <code style="display:inline;padding:0 4px">--server</code> i <code style="display:inline;padding:0 4px">--token …</code>.</li>
      <li>Pokud ještě nemáš nového agenta: místo mazání zkopíruj hodnotu <code style="display:inline;padding:0 4px">token</code>
        z <code style="display:inline;padding:0 4px">agent-config.json</code> do <code style="display:inline;padding:0 4px">--token</code> v Cíli
        (musí začínat na <b>${tokenPfx}</b>).</li>
      <li>OK, znovu spusť zástupce.</li>
    </ol>
    <p class="note">Soubor pravdy: <code>%AppData%\\MultiMix\\agent-config.json</code> vedle exe.
    Stáhni ho přihlášený (jinak dostaneš HTML). Název MUSÍ být agent-config.json, ne config.json.</p>
    <a class="btn" style="background:#1f6feb;margin-top:10px" href="/api/halls/${hall.id}/agent-config" download="agent-config.json">&#11123; Stáhnout agent-config.json</a>
    ${agentOnlyBtn}
    <p class="note">Nový agent čte JSON a starý --token ve zástupci ignoruje. Přepiš jím <code style="display:inline;padding:0 4px">multimix-agent.exe</code> ve stejné složce.</p>`;

  return `<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="UTF-8">
  <title>MultiMix Setup – Hala ${hall.id}: ${hall.name}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 60px auto; padding: 0 20px; background: #0d1117; color: #e6edf3; }
    h1 { color: #58a6ff; margin-bottom: 4px; }
    .sub { color: #8b949e; margin-bottom: 32px; }
    .step { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px 24px; margin-bottom: 16px; }
    .step h3 { margin: 0 0 8px; color: #f0f6fc; }
    .step p  { margin: 0 0 12px; color: #8b949e; font-size: 14px; }
    .btn { display: inline-block; background: #238636; color: #fff; padding: 12px 24px;
      border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 15px; }
    .btn:hover { background: #2ea043; }
    .note { font-size: 13px; color: #8b949e; margin-top: 8px; }
    code { display: inline-block; background: #21262d; padding: 2px 8px; border-radius: 4px; font-size: 13px; margin-top: 6px; }
    .warn { background: #2d1a00; border: 1px solid #6e3a00; color: #e3a84e; padding: 14px 18px; border-radius: 6px; font-size: 14px; }
    .status { margin-top: 0; padding: 12px 16px; border-radius: 6px; font-size: 14px; }
    .ok   { background: #0d4429; border: 1px solid #1a7f37; color: #3fb950; }
    .wait { background: #1c2128; border: 1px solid #30363d; color: #8b949e; }
    .bad  { background: #2d1a00; border: 1px solid #6e3a00; color: #e3a84e; }
    button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px;
      padding: 8px 14px; cursor: pointer; font-size: 14px; }
    button:hover:not(:disabled) { background: #30363d; }
    button:disabled { opacity: .5; cursor: default; }
  </style>
</head>
<body>
  <h1>MultiMix Setup</h1>
  <div class="sub">Hala ${hall.id}: <b>${hall.name}</b> &nbsp;&middot;&nbsp; Server: <code>${serverUrl}</code></div>

  <div class="step">
    <h3>1. Stáhni a spusť instalační program</h3>
    <p>Obsahuje OBS Studio i MultiMix agenta. Agent po instalaci <b>nespouští OBS</b> — to si spusť ručně.</p>
    ${downloadBlock}
    ${repairBlock}
  </div>

  <div class="step">
    <h3>2. Příště stačí dvakrát kliknout</h3>
    <p>Na ploše je zástupce <b>MultiMix Hala ${hall.id}</b>. Cíl musí být jen <code>multimix-agent.exe</code> — token žije v agent-config.json. OBS spusť ručně, agent jen sdílí obrazovku.</p>
  </div>

  <div class="step">
    <h3>3. Stav připojení</h3>
    <div id="status" class="status wait">Čekám na odpověď serveru…</div>
  </div>

  <div class="step" id="obsStep" style="display:none">
    <h3>4. Nastavení OBS (jednorázové)</h3>
    <p>Vyber kameru a nakonfiguruj scénu v OBS. Pak nastav OBS dock pro ovládání tabule.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      <select id="camSel" style="flex:1;min-width:180px;padding:8px;background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px">
        <option value="">-- načítám kamery… --</option>
      </select>
      <button id="btnScene" onclick="doScene()">⚙ Připravit scénu</button>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button id="btnDock" onclick="doDock()">🖥 Nastavit OBS dock</button>
      <button onclick="readConfig()" style="font-size:12px">🔍 Číst OBS config</button>
    </div>
    <p class="note" style="margin-top:12px">Bez restartu OBS: <b>Docks → Custom Browser Docks</b> → vlož URL
      (musí obsahovat <code style="display:inline;padding:0 4px">token</code> začínající na <b>${tokenPfx}</b>):</p>
    <code id="dockUrl" style="word-break:break-all;margin-top:6px">${dockUrl.replace(/</g, '')}</code>
    <div id="obsMsg" style="margin-top:10px;font-size:13px;color:#8b949e"></div>
    <pre id="obsCfg" style="display:none;margin-top:8px;background:#0d1117;border:1px solid #30363d;padding:10px;border-radius:6px;font-size:11px;overflow-x:auto;white-space:pre-wrap;color:#8b949e"></pre>
  </div>

  <div class="step">
    <h3>Agent logy</h3>
    <p style="margin-bottom:8px">Live výpis z agenta na notebooku.</p>
    <pre id="logBox" style="background:#0d1117;border:1px solid #30363d;padding:10px;border-radius:6px;font-size:11px;height:220px;overflow-y:auto;white-space:pre-wrap;color:#8b949e;margin:0"></pre>
  </div>

  <script>
    const HALL = ${hall.id};
    const EXPECTED_PFX = ${JSON.stringify(tokenPfx)};
    const statusEl = document.getElementById('status');
    const obsStep  = document.getElementById('obsStep');
    const camSel   = document.getElementById('camSel');
    const obsMsg   = document.getElementById('obsMsg');
    const logBox   = document.getElementById('logBox');
    let lastLogTs  = 0;

    function setMsg(text, ok) {
      obsMsg.textContent = text;
      obsMsg.style.color = ok ? '#3fb950' : '#f85149';
    }

    async function pollLogs() {
      try {
        const entries = await fetch('/api/agent/' + HALL + '/logs').then(r => r.json());
        const newEntries = entries.filter(e => e.ts > lastLogTs);
        if (newEntries.length) {
          const atBottom = logBox.scrollHeight - logBox.scrollTop <= logBox.clientHeight + 20;
          for (const e of newEntries) {
            const d = new Date(e.ts);
            const t = d.toTimeString().slice(0,8);
            logBox.textContent += t + '  ' + e.msg + '\\n';
            lastLogTs = Math.max(lastLogTs, e.ts);
          }
          if (atBottom) logBox.scrollTop = logBox.scrollHeight;
        }
      } catch {}
    }
    pollLogs();
    setInterval(pollLogs, 2000);

    async function poll() {
      try {
        const d = await fetch('/api/agent/' + HALL + '/status').then(r => r.json());
        if (d.connected && d.obsConnected) {
          statusEl.className = 'status ok';
          statusEl.textContent = 'Agent připojen · OBS běží';
          obsStep.style.display = '';
          if (d.cameras && d.cameras.length) {
            const prev = camSel.value;
            camSel.innerHTML = '<option value="">-- vyber kameru --</option>' +
              d.cameras.map(c => '<option value="' + c.id + '"' + (c.id === prev ? ' selected' : '') + '>' + c.name + '</option>').join('');
          }
        } else if (d.connected) {
          statusEl.className = 'status wait';
          statusEl.textContent = 'Agent připojen · čekám na OBS…';
        } else if (d.lastReject) {
          statusEl.className = 'status bad';
          statusEl.textContent = 'Neplatný token — agent posílá ' + d.lastReject.prefix +
            '…, server čeká ' + EXPECTED_PFX +
            '…. OBS může běžet lokálně, ale MultiMix agenta nepřijme. Přepiš %AppData%\\\\MultiMix\\\\agent-config.json (ne config.json) a restartuj agenta.';
          obsStep.style.display = 'none';
        } else {
          statusEl.className = 'status wait';
          statusEl.textContent = 'Agent není připojen – spusť zástupce na ploše';
          obsStep.style.display = 'none';
        }
      } catch { statusEl.textContent = 'Chyba při kontrole stavu'; }
    }

    async function doScene() {
      const btn = document.getElementById('btnScene');
      btn.disabled = true; btn.textContent = '⏳ Nastavuji...';
      try {
        const r = await fetch('/api/agent/' + HALL + '/setup-scene', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cameraId: camSel.value })
        }).then(r => r.json());
        if (r.ok) {
          btn.textContent = '✓ Hotovo';
          setMsg('Scéna nastavena: ' + r.steps.join(', '), true);
        } else {
          btn.textContent = '✗ Chyba';
          setMsg('Chyba: ' + r.error, false);
        }
      } catch (e) { btn.textContent = '✗ Chyba'; setMsg(e.message, false); }
      setTimeout(() => { btn.disabled = false; btn.textContent = '⚙ Připravit scénu'; }, 4000);
    }

    async function doDock() {
      const btn = document.getElementById('btnDock');
      btn.disabled = true; btn.textContent = '⏳ Nastavuji...';
      try {
        const r = await fetch('/api/agent/' + HALL + '/setup-dock', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        }).then(r => r.json());
        if (r.ok) {
          btn.textContent = '✓ Hotovo';
          const detail = r.restarted ? 'OBS restartován' : 'OBS nebyl spuštěn — dock se zobrazí při startu';
          setMsg('Dock zapsán. ' + detail + '.\\nConfig: ' + r.configPath, true);
          setTimeout(readConfig, 1000);
        } else {
          btn.textContent = '✗ Chyba';
          setMsg('Chyba: ' + (r.error || JSON.stringify(r)), false);
        }
      } catch (e) { btn.textContent = '✗ Chyba'; setMsg(e.message, false); }
      setTimeout(() => { btn.disabled = false; btn.textContent = '🖥 Nastavit OBS dock'; }, 4000);
    }

    async function readConfig() {
      const pre = document.getElementById('obsCfg');
      pre.style.display = '';
      pre.textContent = 'Čtu…';
      try {
        const r = await fetch('/api/agent/' + HALL + '/obs-config').then(r => r.json());
        if (r.ok) {
          pre.textContent = 'Config: ' + r.configPath + '\\n\\n' + r.section;
        } else {
          pre.textContent = 'Chyba: ' + r.error;
        }
      } catch (e) { pre.textContent = e.message; }
    }

    poll();
    setInterval(poll, 5000);
  </script>
</body>
</html>`;
}

app.get('/setup/:hallId', (req, reply) => {
  const hall = db.prepare('SELECT * FROM halls WHERE id = ?').get(+req.params.hallId);
  if (!hall) return reply.code(404).send('Hala nenalezena');
  if (!hall.agent_token) hall.agent_token = ensureAgentToken(hall.id);
  return reply.type('text/html').send(setupPageHtml(hall, publicOrigin(req)));
});

// ---------- groups / teams / players ----------
app.get('/api/groups', () => db.prepare('SELECT * FROM groups').all());
app.post('/api/groups', req => {
  const r = db.prepare('INSERT INTO groups (name) VALUES (?)').run(req.body.name);
  return { id: r.lastInsertRowid, name: req.body.name };
});
app.delete('/api/groups/:id', req => { db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id); return { ok: true }; });
app.get('/api/groups/:id/standings', req => groupStandings(+req.params.id));

app.get('/api/teams', () => db.prepare(`
  SELECT t.*, g.name AS group_name FROM teams t LEFT JOIN groups g ON g.id = t.group_id ORDER BY t.name`).all());
app.post('/api/teams', req => {
  const { name, short_name = '', group_id = null } = req.body;
  const r = db.prepare('INSERT INTO teams (name, short_name, group_id) VALUES (?, ?, ?)').run(name, short_name, group_id);
  return db.prepare('SELECT * FROM teams WHERE id = ?').get(r.lastInsertRowid);
});
app.put('/api/teams/:id', req => {
  const cur = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  const b = { ...cur, ...req.body };
  db.prepare('UPDATE teams SET name=?, short_name=?, group_id=?, color_bg=?, color_text=? WHERE id=?')
    .run(b.name, b.short_name, b.group_id ?? null, b.color_bg, b.color_text, req.params.id);
  emitSchedule();
  return db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
});
app.post('/api/teams/:id/logo', async req => {
  const part = await req.file();
  const ext = path.extname(part.filename).toLowerCase() || '.png';
  const filename = `team${req.params.id}_logo${ext}`;
  await pipeline(part.file, fs.createWriteStream(path.join(mediaDir, filename)));
  db.prepare('UPDATE teams SET logo = ? WHERE id = ?').run(filename, req.params.id);
  emitSchedule();
  return db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
});
app.delete('/api/teams/:id', req => { db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.id); return { ok: true }; });

app.get('/api/teams/:id/players', req => db.prepare('SELECT * FROM players WHERE team_id = ? ORDER BY number').all(req.params.id));
app.post('/api/teams/:id/players', req => {
  const { number = null, name, position = '' } = req.body;
  const r = db.prepare('INSERT INTO players (team_id, number, name, position) VALUES (?, ?, ?, ?)').run(req.params.id, number, name, position);
  return db.prepare('SELECT * FROM players WHERE id = ?').get(r.lastInsertRowid);
});
app.delete('/api/players/:id', req => { db.prepare('DELETE FROM players WHERE id = ?').run(req.params.id); return { ok: true }; });

// ---------- matches / scheduler ----------
app.get('/api/matches', req => {
  const { hall_id, status, stage } = req.query;
  const cond = [], params = [];
  if (hall_id) { cond.push('m.hall_id = ?'); params.push(hall_id); }
  if (status) { cond.push('m.status = ?'); params.push(status); }
  if (stage) { cond.push('m.stage = ?'); params.push(stage); }
  return listMatches(cond.join(' AND '), params);
});
app.get('/api/matches/:id', req => getMatch(+req.params.id));
// Resolve match config from a template (if given) or explicit fields
function resolveConfig(b) {
  let period_length_ms = 1800000, timeouts_allowed = 3, suspension_ms = 120000;
  if (b.template_id) {
    const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(b.template_id);
    if (t) { period_length_ms = Math.round(t.period_length_min * 60000); timeouts_allowed = t.timeouts; suspension_ms = t.suspension_s * 1000; }
  }
  if (b.period_length_ms != null) period_length_ms = b.period_length_ms;
  if (b.timeouts_allowed != null) timeouts_allowed = b.timeouts_allowed;
  if (b.suspension_ms != null) suspension_ms = b.suspension_ms;
  return { period_length_ms, timeouts_allowed, suspension_ms, period_lengths: b.period_lengths ?? '' };
}

app.post('/api/matches', req => {
  const b = req.body;
  const c = resolveConfig(b);
  const r = db.prepare(`INSERT INTO matches
    (stage, group_id, round, bracket_slot, hall_id, scheduled_at, home_team_id, away_team_id,
     home_placeholder, away_placeholder, winner_to_match_id, winner_to_side,
     period_length_ms, period_lengths, timeouts_allowed, suspension_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.stage ?? 'group', b.group_id ?? null, b.round ?? '', b.bracket_slot ?? null, b.hall_id ?? null,
      b.scheduled_at ?? null, b.home_team_id ?? null, b.away_team_id ?? null,
      b.home_placeholder ?? '', b.away_placeholder ?? '', b.winner_to_match_id ?? null, b.winner_to_side ?? null,
      c.period_length_ms, c.period_lengths, c.timeouts_allowed, c.suspension_ms);
  emitSchedule();
  return getMatch(r.lastInsertRowid);
});

// Update match settings (works on a live match too)
app.post('/api/matches/:id/config', req => controlMatch(+req.params.id, m => {
  const b = req.body;
  const period_length_ms = b.period_length_ms ?? m.period_length_ms;
  const timeouts_allowed = b.timeouts_allowed ?? m.timeouts_allowed;
  const suspension_ms = b.suspension_ms ?? m.suspension_ms;
  const period_lengths = b.period_lengths ?? m.period_lengths;
  db.prepare('UPDATE matches SET period_length_ms=?, period_lengths=?, timeouts_allowed=?, suspension_ms=? WHERE id=?')
    .run(period_length_ms, period_lengths, timeouts_allowed, suspension_ms, m.id);
}));
app.put('/api/matches/:id', req => {
  const b = req.body, id = +req.params.id;
  db.prepare(`UPDATE matches SET stage=?, group_id=?, round=?, bracket_slot=?, hall_id=?, scheduled_at=?,
    home_team_id=?, away_team_id=?, home_placeholder=?, away_placeholder=?, winner_to_match_id=?, winner_to_side=? WHERE id=?`)
    .run(b.stage ?? 'group', b.group_id ?? null, b.round ?? '', b.bracket_slot ?? null, b.hall_id ?? null,
      b.scheduled_at ?? null, b.home_team_id ?? null, b.away_team_id ?? null,
      b.home_placeholder ?? '', b.away_placeholder ?? '', b.winner_to_match_id ?? null, b.winner_to_side ?? null, id);
  emitSchedule(); emitMatch(id);
  return getMatch(id);
});
app.delete('/api/matches/:id', req => {
  db.prepare('DELETE FROM matches WHERE id = ?').run(req.params.id);
  emitSchedule();
  return { ok: true };
});

// Generate a single-elimination bracket: pass team_ids (power of 2) or placeholders
app.post('/api/bracket/generate', req => {
  const { entries, hall_id = null } = req.body; // entries: [{team_id?|placeholder?}, ...] length 4 or 8
  const n = entries.length;
  if (![2, 4, 8, 16].includes(n)) return { error: 'entries must be 2/4/8/16' };
  const roundNames = { 16: 'OF', 8: 'QF', 4: 'SF', 2: 'F' };
  const tx = () => {
    db.exec('BEGIN');
    try {
      const result = buildBracket();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  const buildBracket = () => {
    // create rounds from final backwards so winner_to links exist
    let nextRound = []; // match ids of the following round
    let size = 1;
    const created = [];
    while (size * 2 <= n) {
      const roundSize = size; // matches in this round counted from final: 1,2,4...
      const ids = [];
      for (let i = 0; i < roundSize; i++) {
        const isFirstRound = roundSize * 2 === n;
        const e1 = isFirstRound ? entries[2 * i] : {};
        const e2 = isFirstRound ? entries[2 * i + 1] : {};
        const r = db.prepare(`INSERT INTO matches (stage, round, bracket_slot, hall_id,
            home_team_id, away_team_id, home_placeholder, away_placeholder, winner_to_match_id, winner_to_side)
          VALUES ('playoff', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(roundNames[roundSize * 2], i + 1, hall_id,
            e1.team_id ?? null, e2.team_id ?? null, e1.placeholder ?? '', e2.placeholder ?? '',
            nextRound.length ? nextRound[Math.floor(i / 2)] : null,
            nextRound.length ? (i % 2 === 0 ? 'home' : 'away') : null);
        ids.push(r.lastInsertRowid);
        created.push(r.lastInsertRowid);
      }
      nextRound = ids;
      size *= 2;
    }
    return created;
  };
  const ids = tx();
  emitSchedule();
  return { created: ids };
});

app.get('/api/bracket', () => listMatches(`m.stage = 'playoff'`));

// ---------- live match control (hall panel) ----------
const periodStopTimers = new Map(); // matchId -> Timeout
const timeoutHornTimers = new Map(); // matchId -> { warn, end }
const TIMEOUT_HORN_MS = 60000;
const TIMEOUT_WARN_BEFORE_MS = 8000;

function clearPeriodStop(matchId) {
  const t = periodStopTimers.get(matchId);
  if (t) clearTimeout(t);
  periodStopTimers.delete(matchId);
}

function clearTimeoutHorns(matchId) {
  const t = timeoutHornTimers.get(matchId);
  if (t) {
    clearTimeout(t.warn);
    clearTimeout(t.end);
  }
  timeoutHornTimers.delete(matchId);
}

function scheduleTimeoutHorns(matchId, hallId) {
  clearTimeoutHorns(matchId);
  emitHorn(hallId, 'timeout-start');
  const warn = setTimeout(() => emitHorn(hallId, 'timeout-warn'), TIMEOUT_HORN_MS - TIMEOUT_WARN_BEFORE_MS);
  const end = setTimeout(() => {
    timeoutHornTimers.delete(matchId);
    db.prepare('UPDATE matches SET timeout_until=NULL, timeout_side=NULL WHERE id=?').run(matchId);
    emitHorn(hallId, 'timeout-end');
    emitMatch(matchId);
  }, TIMEOUT_HORN_MS);
  timeoutHornTimers.set(matchId, { warn, end });
}

function stopPeriodAtEnd(matchId, target, hallId) {
  db.prepare('UPDATE matches SET timer_running=0, timer_offset_ms=?, timer_started_at=NULL WHERE id=?')
    .run(target, matchId);
  emitHorn(hallId, 'period-end');
}

// Server-side auto-stop at the end of the current period. Clients only display
// the clock; they must not be the source of truth (clock skew / closed panel).
function syncPeriodStop(matchId) {
  clearPeriodStop(matchId);
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!m || m.status !== 'live' || !m.timer_running) return;
  const target = periodLengthMs(m);
  if (!target) return;
  const remaining = target - matchElapsedMs(m);
  if (remaining <= 0) {
    stopPeriodAtEnd(matchId, target, m.hall_id);
    return;
  }
  periodStopTimers.set(matchId, setTimeout(() => {
    periodStopTimers.delete(matchId);
    const cur = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
    if (!cur || !cur.timer_running) return;
    const t = periodLengthMs(cur);
    if (matchElapsedMs(cur) >= t) {
      stopPeriodAtEnd(matchId, t, cur.hall_id);
      emitMatch(matchId);
    } else {
      syncPeriodStop(matchId);
    }
  }, remaining));
}

function controlMatch(id, fn) {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
  if (!m) return null;
  fn(m);
  syncPeriodStop(id);
  emitMatch(id);
  return getMatch(id);
}

app.post('/api/matches/:id/start', req => controlMatch(+req.params.id, m => {
  clearTimeoutHorns(m.id);
  db.prepare(`UPDATE matches SET status='live', period=1, timer_offset_ms=0, timer_running=0,
    prev_periods_ms=0, home_timeouts=0, away_timeouts=0, timeout_until=NULL, timeout_side=NULL WHERE id=?`).run(m.id);
  emitSchedule();
}));
app.post('/api/matches/:id/timer', req => controlMatch(+req.params.id, m => {
  const { action } = req.body; // start | stop | reset | set | adjust | stopAt
  if (action === 'start' && !m.timer_running)
    db.prepare('UPDATE matches SET timer_running=1, timer_started_at=? WHERE id=?').run(Date.now(), m.id);
  if (action === 'stop' && m.timer_running) {
    const target = periodLengthMs(m);
    let ms = matchElapsedMs(m);
    if (target > 0) ms = Math.min(ms, target);
    db.prepare('UPDATE matches SET timer_running=0, timer_offset_ms=?, timer_started_at=NULL WHERE id=?')
      .run(ms, m.id);
  }
  if (action === 'reset')
    db.prepare('UPDATE matches SET timer_running=0, timer_offset_ms=0, timer_started_at=NULL WHERE id=?').run(m.id);
  if (action === 'set') {
    const target = periodLengthMs(m);
    let ms = Math.max(0, +req.body.ms || 0);
    if (target > 0) ms = Math.min(ms, target);
    db.prepare('UPDATE matches SET timer_offset_ms=?, timer_started_at=? WHERE id=?')
      .run(ms, m.timer_running ? Date.now() : null, m.id);
  }
  // nudge the clock by delta ms (e.g. ±1s / ±10s) without stopping it
  if (action === 'adjust') {
    const target = periodLengthMs(m);
    let next = Math.max(0, matchElapsedMs(m) + (+req.body.delta || 0));
    if (target > 0) next = Math.min(next, target);
    db.prepare('UPDATE matches SET timer_offset_ms=?, timer_started_at=? WHERE id=?')
      .run(next, m.timer_running ? Date.now() : null, m.id);
  }
  // auto-stop at end of period: stop and clamp to exact ms
  if (action === 'stopAt') {
    const target = periodLengthMs(m);
    let ms = Math.max(0, +req.body.ms || 0);
    if (target > 0) ms = Math.min(ms, target);
    db.prepare('UPDATE matches SET timer_running=0, timer_offset_ms=?, timer_started_at=NULL WHERE id=?')
      .run(ms, m.id);
  }
}));
app.post('/api/matches/:id/period', req => {
  // changing period resets the clock but keeps score and suspensions; the
  // cumulative game-time base advances so suspensions carry over correctly
  const period = Math.max(1, +req.body.period || 1);
  const result = controlMatch(+req.params.id, m => {
    db.prepare('UPDATE matches SET period=?, timer_running=0, timer_started_at=NULL, timer_offset_ms=0, prev_periods_ms=? WHERE id=?')
      .run(period, prevPeriodsMs(m, period), m.id);
  });
  if (result && period === 2) autoAlert(`Poločas: ${matchLabel(result)}`);
  return result;
});
app.post('/api/matches/:id/score', req => controlMatch(+req.params.id, m => {
  const { side, delta } = req.body;
  const col = side === 'home' ? 'home_score' : 'away_score';
  db.prepare(`UPDATE matches SET ${col} = MAX(0, ${col} + ?) WHERE id = ?`).run(delta, m.id);
  if (delta > 0) db.prepare(`INSERT INTO events (match_id, type, side, player_id, number, match_time_ms, period)
    VALUES (?, 'goal', ?, ?, ?, ?, ?)`).run(m.id, side, req.body.player_id ?? null, req.body.number ?? null, matchElapsedMs(m), m.period);
}));
app.post('/api/matches/:id/event', req => controlMatch(+req.params.id, m => {
  const { type, side, player_id = null, number = null } = req.body; // penalty2 | yellow | red | blue | timeout
  if (type === 'timeout') {
    const used = side === 'home' ? (m.home_timeouts || 0) : (m.away_timeouts || 0);
    if (used >= (m.timeouts_allowed || 0)) return;
  }
  // suspensions carry across periods via an absolute end on the cumulative clock
  const end_total_ms = type === 'penalty2' ? totalGameMs(m) + (m.suspension_ms ?? 120000) : null;
  db.prepare(`INSERT INTO events (match_id, type, side, player_id, number, match_time_ms, period, end_total_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(m.id, type, side, player_id, number, matchElapsedMs(m), m.period, end_total_ms);
  if (type === 'timeout') {
    const col = side === 'home' ? 'home_timeouts' : 'away_timeouts';
    const until = Date.now() + TIMEOUT_HORN_MS;
    // Timeout always stops the match clock (operator restarts it afterwards).
    if (m.timer_running)
      db.prepare(`UPDATE matches SET ${col} = ${col} + 1, timer_running=0, timer_offset_ms=?, timer_started_at=NULL, timeout_until=?, timeout_side=? WHERE id=?`)
        .run(matchElapsedMs(m), until, side, m.id);
    else
      db.prepare(`UPDATE matches SET ${col} = ${col} + 1, timeout_until=?, timeout_side=? WHERE id=?`)
        .run(until, side, m.id);
    scheduleTimeoutHorns(m.id, m.hall_id);
  }
  // brief on-screen announcement for timeouts and cards
  if (['timeout', 'yellow', 'red', 'blue'].includes(type) && m.hall_id)
    io.emit(`hall:${m.hall_id}:flash`, { type, side, number });
}));
// Undo the last timeout for a side (mis-click correction)
app.post('/api/matches/:id/timeout-undo', req => controlMatch(+req.params.id, m => {
  const side = req.body.side;
  const col = side === 'home' ? 'home_timeouts' : 'away_timeouts';
  if (m.timeout_side === side) {
    clearTimeoutHorns(m.id);
    db.prepare(`UPDATE matches SET ${col} = MAX(0, ${col} - 1), timeout_until=NULL, timeout_side=NULL WHERE id = ?`).run(m.id);
  } else {
    db.prepare(`UPDATE matches SET ${col} = MAX(0, ${col} - 1) WHERE id = ?`).run(m.id);
  }
  const last = db.prepare(`SELECT id FROM events WHERE match_id=? AND type='timeout' AND side=? ORDER BY id DESC LIMIT 1`).get(m.id, side);
  if (last) db.prepare('DELETE FROM events WHERE id = ?').run(last.id);
}));
app.post('/api/matches/:id/finish', req => {
  const result = controlMatch(+req.params.id, m => {
    clearTimeoutHorns(m.id);
    db.prepare(`UPDATE matches SET status='finished', timer_running=0, timer_started_at=NULL,
      timer_offset_ms=?, timeout_until=NULL, timeout_side=NULL WHERE id=?`).run(matchElapsedMs(m), m.id);
    propagateWinner(db.prepare('SELECT * FROM matches WHERE id = ?').get(m.id));
    emitSchedule();
  });
  if (result) autoAlert(`Konec: ${matchLabel(result)}`);
  return result;
});
app.get('/api/matches/:id/events', req =>
  db.prepare(`SELECT e.*, p.name AS player_name, COALESCE(e.number, p.number) AS player_number
    FROM events e LEFT JOIN players p ON p.id = e.player_id
    WHERE e.match_id = ? ORDER BY e.id DESC`).all(req.params.id));
app.delete('/api/events/:id', req => {
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (e) { db.prepare('DELETE FROM events WHERE id = ?').run(e.id); emitMatch(e.match_id); }
  return { ok: true };
});

// Live match for a hall (used by overlay and hall panel)
app.get('/api/halls/:id/live', req => liveMatchForHall(+req.params.id));

// Active suspensions for overlay. Countdown runs on the cumulative game clock,
// so a suspension started just before half-time carries into the next period.
app.get('/api/matches/:id/suspensions', req => {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!m) return [];
  const total = totalGameMs(m);
  const susp = m.suspension_ms ?? 120000;
  return db.prepare(`SELECT e.*, COALESCE(e.number, p.number) AS player_number FROM events e
    LEFT JOIN players p ON p.id = e.player_id
    WHERE e.match_id = ? AND e.type = 'penalty2'`).all(m.id)
    .map(e => {
      const end = e.end_total_ms != null ? e.end_total_ms : e.match_time_ms + susp; // legacy fallback
      return { ...e, remaining_ms: end - total };
    })
    .filter(e => e.remaining_ms > 0 && e.remaining_ms <= susp);
});
// Active suspensions incl. ids, for the hall panel correction list
app.get('/api/matches/:id/suspensions-admin', req => {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!m) return [];
  const total = totalGameMs(m), susp = m.suspension_ms ?? 120000;
  return db.prepare(`SELECT e.*, COALESCE(e.number, p.number) AS player_number, t.short_name FROM events e
    LEFT JOIN players p ON p.id = e.player_id
    LEFT JOIN matches mm ON mm.id = e.match_id
    LEFT JOIN teams t ON t.id = (CASE WHEN e.side='home' THEN mm.home_team_id ELSE mm.away_team_id END)
    WHERE e.match_id = ? AND e.type = 'penalty2' ORDER BY e.id DESC`).all(m.id)
    .map(e => ({ ...e, remaining_ms: (e.end_total_ms != null ? e.end_total_ms : e.match_time_ms + susp) - total }));
});

// ---------- media library ----------
app.get('/api/media', () => db.prepare('SELECT * FROM media ORDER BY sort_order, id').all());
// move a clip up/down in the rotation order
app.post('/api/media/:id/move', req => {
  const all = db.prepare('SELECT id, sort_order FROM media ORDER BY sort_order, id').all();
  all.forEach((m, i) => { if (m.sort_order !== i) db.prepare('UPDATE media SET sort_order=? WHERE id=?').run(i, m.id); m.sort_order = i; });
  const idx = all.findIndex(m => m.id === +req.params.id);
  const swap = req.body.dir === 'up' ? idx - 1 : idx + 1;
  if (idx >= 0 && swap >= 0 && swap < all.length) {
    db.prepare('UPDATE media SET sort_order=? WHERE id=?').run(all[swap].sort_order, all[idx].id);
    db.prepare('UPDATE media SET sort_order=? WHERE id=?').run(all[idx].sort_order, all[swap].id);
  }
  return { ok: true };
});
app.post('/api/media/upload', async req => {
  const part = await req.file();
  const safe = part.filename.replace(/[^\w.\-]+/g, '_');
  const filename = `${Date.now()}_${safe}`;
  await pipeline(part.file, fs.createWriteStream(path.join(mediaDir, filename)));
  const type = /\.(png|jpe?g|gif|webp)$/i.test(filename) ? 'image' : 'video';
  const r = db.prepare('INSERT INTO media (name, filename, type) VALUES (?, ?, ?)').run(part.filename, filename, type);
  return db.prepare('SELECT * FROM media WHERE id = ?').get(r.lastInsertRowid);
});
app.put('/api/media/:id', req => {
  const cur = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!cur) return { error: 'media not found' };
  const b = req.body;
  const name        = b.name ?? cur.name;
  const in_rotation = b.in_rotation != null ? (b.in_rotation ? 1 : 0) : cur.in_rotation;
  const is_ad       = b.is_ad != null ? (b.is_ad ? 1 : 0) : cur.is_ad;
  const ad_active   = b.ad_active != null ? (b.ad_active ? 1 : 0) : cur.ad_active;
  const weight      = b.weight != null ? Math.min(10, Math.max(1, +b.weight)) : cur.weight;
  db.prepare('UPDATE media SET name=?, in_rotation=?, is_ad=?, ad_active=?, weight=? WHERE id=?')
    .run(name, in_rotation, is_ad, ad_active, weight, req.params.id);
  return db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
});
app.delete('/api/media/:id', req => {
  const m = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (m) {
    try { fs.unlinkSync(path.join(mediaDir, m.filename)); } catch {}
    db.prepare('DELETE FROM media WHERE id = ?').run(m.id);
  }
  return { ok: true };
});

// ---------- branding (persistent logos: tournament / sponsors) ----------
app.get('/api/branding', () => db.prepare('SELECT * FROM branding ORDER BY corner, sort_order, id').all());
app.post('/api/branding/upload', async req => {
  const part = await req.file();
  const safe = part.filename.replace(/[^\w.\-]+/g, '_');
  const filename = `brand_${Date.now()}_${safe}`;
  await pipeline(part.file, fs.createWriteStream(path.join(mediaDir, filename)));
  const type = /\.(png|jpe?g|gif|webp|svg)$/i.test(filename) ? 'image' : 'video';
  const r = db.prepare('INSERT INTO branding (name, filename, type) VALUES (?, ?, ?)').run(part.filename, filename, type);
  io.emit('branding:update');
  return db.prepare('SELECT * FROM branding WHERE id = ?').get(r.lastInsertRowid);
});
app.put('/api/branding/:id', req => {
  const cur = db.prepare('SELECT * FROM branding WHERE id = ?').get(req.params.id);
  const b = { ...cur, ...req.body };
  db.prepare('UPDATE branding SET name=?, active=?, corner=?, size_pct=? WHERE id=?')
    .run(b.name, b.active ? 1 : 0, b.corner, b.size_pct, req.params.id);
  io.emit('branding:update');
  return db.prepare('SELECT * FROM branding WHERE id = ?').get(req.params.id);
});
app.delete('/api/branding/:id', req => {
  const b = db.prepare('SELECT * FROM branding WHERE id = ?').get(req.params.id);
  if (b) {
    try { fs.unlinkSync(path.join(mediaDir, b.filename)); } catch {}
    db.prepare('DELETE FROM branding WHERE id = ?').run(b.id);
    io.emit('branding:update');
  }
  return { ok: true };
});

// ---------- alerts ----------
app.get('/api/alerts', req => db.prepare(
  req.query.all ? 'SELECT * FROM alerts ORDER BY id DESC' : 'SELECT * FROM alerts WHERE active = 1 ORDER BY id DESC').all());
app.post('/api/alerts', req => {
  const { text, level = 'info' } = req.body;
  const r = db.prepare('INSERT INTO alerts (text, level) VALUES (?, ?)').run(text, level);
  io.emit('alerts:update');
  return db.prepare('SELECT * FROM alerts WHERE id = ?').get(r.lastInsertRowid);
});
app.put('/api/alerts/:id', req => {
  db.prepare('UPDATE alerts SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, req.params.id);
  io.emit('alerts:update');
  return { ok: true };
});
app.delete('/api/alerts/:id', req => {
  db.prepare('DELETE FROM alerts WHERE id = ?').run(req.params.id);
  io.emit('alerts:update');
  return { ok: true };
});

// ---------- public site data ----------
app.get('/api/public/schedule', () => ({
  tournament_name: getSetting('tournament_name'),
  halls: db.prepare('SELECT id, name, yt_video_id FROM halls').all(),
  matches: listMatches(),
  alerts: db.prepare('SELECT * FROM alerts WHERE active = 1 ORDER BY id DESC').all()
}));

// ---------- start: HTTP (localhost) + HTTPS (hall notebooks / OBS overlay) ----------
const HTTPS_PORT = +(process.env.HTTPS_PORT || 3443);
await app.ready();
const httpServer = http.createServer(app.routing);
let httpsServer = null;
try {
  httpsServer = https.createServer(await ensureCert(), app.routing);
} catch (e) {
  console.error('HTTPS se nepodařilo nastavit:', e.message);
}

io = new SocketIO({
  cors: { origin: '*' },
  maxHttpBufferSize: 10e6, // remote desktop JPEG frames (full-res control)
});
io.attach(httpServer);
if (httpsServer) io.attach(httpsServer);

agentRouter.attach(
  io,
  status => {
    const enriched = enrichAgentStatus(status);
    if (io) io.emit('agent:update', enriched);
    syncHallOverlayWhenObs(status);
  },
  (hall, entry) => { if (io) io.emit('agent:log', { hall, ...entry }); }
);

// Overlay connections identify their hall + agent_token in the handshake so these
// control events (which unmute mics / drive scenarios) can't be spoofed by an
// arbitrary client hitting the public Socket.IO endpoint.
function verifiedOverlayHall(socket, hall) {
  const hallId = +hall;
  if (!hallId) return null;
  const auth = socket.handshake.auth || {};
  if (+auth.hall !== hallId || !verifyHallToken(hallId, auth.token)) return null;
  return hallId;
}

io.on('connection', socket => {
  if (socket.handshake.auth?.type === 'agent') return; // handled by agentRouter
  socket.emit('agent:update', enrichAgentStatus(agentRouter.status()));

  // Remote desktop: browser viewers join a per-hall room for JPEG frames + input
  socket.on('remote:subscribe', ({ hallId, mode }, ack) => {
    const id = +hallId;
    if (!id) return typeof ack === 'function' && ack({ ok: false, error: 'Chybí hala' });
    const r = agentRouter.subscribeRemote(id, socket, mode);
    if (typeof ack === 'function') ack(r);
  });
  socket.on('remote:unsubscribe', ({ hallId }, ack) => {
    const id = +(hallId || socket.data?.remoteHall);
    if (id) agentRouter.unsubscribeRemote(id, socket);
    if (typeof ack === 'function') ack({ ok: true });
  });
  socket.on('remote:input', ({ hallId, ...data }) => {
    const id = +(hallId || socket.data?.remoteHall);
    if (!id) return;
    agentRouter.forwardRemoteInput(id, data);
  });
  socket.on('disconnect', () => {
    agentRouter.unsubscribeAllRemote(socket);
  });

  // Overlay reports a manual single spot ended → unmute mic (unless scenario handles it), advance scenario
  socket.on('spot:ended', ({ hall }) => {
    const hallId = verifiedOverlayHall(socket, hall);
    if (!hallId) return;
    if (!runningScenarios.has(hallId)) agentRouter.send(hallId, 'agent:unmute-mic', {});
    if (runningScenarios.has(hallId)) advanceScenario(hallId);
  });

  // Overlay reports the whole ad break finished → unmute mic (unless scenario handles it), advance scenario
  socket.on('adbreak:ended', ({ hall }) => {
    const hallId = verifiedOverlayHall(socket, hall);
    if (!hallId) return;
    adBreaks.delete(hallId);
    if (!runningScenarios.has(hallId)) agentRouter.send(hallId, 'agent:unmute-mic', {});
    if (runningScenarios.has(hallId)) advanceScenario(hallId);
  });

  // Overlay finished the opening stinger → start running steps
  socket.on('scenario:ready', ({ hall }) => {
    const hallId = verifiedOverlayHall(socket, hall);
    if (!hallId) return;
    const state = runningScenarios.get(hallId);
    if (!state || state.phase !== 'begin') return;
    state.phase = 'running';
    execScenarioStep(hallId, state);
  });

  // Overlay finished the closing stinger → scenario fully done
  socket.on('scenario:closed', ({ hall }) => {
    const hallId = verifiedOverlayHall(socket, hall);
    if (!hallId) return;
    const state = runningScenarios.get(hallId);
    if (state?.timer) clearTimeout(state.timer);
    runningScenarios.delete(hallId);
    agentRouter.send(hallId, 'agent:unmute-mic', {});
    io.emit('scenario:done', { hallId });
  });
});

httpServer.on('error', err => {
  console.error('HTTP listen error:', err.message);
  process.exit(1);
});
if (httpsServer) httpsServer.on('error', err => {
  console.error('HTTPS listen error:', err.message);
});
httpServer.listen(PORT, BIND, () => {
  const a = httpServer.address();
  console.log(`HTTP listening ${a.address}:${a.port} (${a.family})`);
});
if (httpsServer) httpsServer.listen(HTTPS_PORT, BIND, () => {
  const a = httpsServer.address();
  console.log(`HTTPS listening ${a.address}:${a.port} (${a.family})`);
});
const seenPeers = new Set();
httpServer.on('connection', sock => {
  const ip = sock.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip.endsWith('127.0.0.1')) return;
  if (seenPeers.has(ip)) return;
  seenPeers.add(ip);
  console.log('Spojeni z', ip);
});

startTournamentSync(io);

for (const { id } of db.prepare(`SELECT id FROM matches WHERE status='live' AND timer_running=1`).all())
  syncPeriodStop(id);

process.on('SIGINT', () => { process.exit(0); });
const ips = localIPv4();
console.log(`MultiMix server:`);
console.log(`  Bind: ${BIND}:${PORT}`);
console.log(`  Tento PC:  http://localhost:${PORT}/admin/`);
if (BIND === '0.0.0.0' || BIND === '::') {
  for (const ip of ips) {
    console.log(`  Sit:       http://${ip}:${PORT}/admin/`);
    console.log(`             http://${ip}:${PORT}/panel/?hall=1`);
  }
  if (!ips.length)
    console.log(`  Sit:       zadna LAN adresa — zkontroluj sitovou kartu`);
} else {
  console.log(`  Sit:       http://${BIND}:${PORT}/admin/`);
}
if (httpsServer) {
  console.log(`  HTTPS:     https://${ips[0] || BIND}:${HTTPS_PORT}  panel haly /overlay`);
}
if (process.env.MULTIMIX_LOCAL === '1') console.log('  Prihlaseni: admin / admin');
console.log(`  Pokud z jineho PC nejde pripojit, povol TCP ${PORT} ve Windows Firewall.`);
