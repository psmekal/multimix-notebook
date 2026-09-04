// API / stream preview access control.
import { db } from './db.js';
import { getUserHalls } from './auth.js';

export function verifyHallToken(hallId, token) {
  if (!hallId || !token) return false;
  const row = db.prepare('SELECT agent_token FROM halls WHERE id = ?').get(+hallId);
  return !!(row?.agent_token && row.agent_token === token);
}

function pathOnly(url) {
  return (url || '').split('?')[0];
}

function matchHallId(matchId) {
  return db.prepare('SELECT hall_id FROM matches WHERE id = ?').get(+matchId)?.hall_id ?? null;
}

function eventHallId(eventId) {
  return db.prepare(
    'SELECT m.hall_id FROM events e JOIN matches m ON m.id = e.match_id WHERE e.id = ?'
  ).get(+eventId)?.hall_id ?? null;
}

function userCanAccessHall(user, hallId) {
  if (!hallId) return false;
  if (['admin', 'reziser'].includes(user.role)) return true;
  if (user.role === 'hall') return getUserHalls(user.id).includes(+hallId);
  return false;
}

function isPublicApi(method, path, query) {
  if (method === 'POST' && path === '/api/auth/login') return true;
  if (method === 'GET' && path === '/api/public/schedule') return true;
  if (method === 'GET' && path === '/api/branding') return true;
  if (method === 'GET' && path === '/api/horn') return true;
  if (method === 'GET' && path === '/api/agent/version') return true;
  if (method === 'GET' && /^\/api\/halls\/\d+\/live$/.test(path)) return true;
  if (method === 'GET' && /^\/api\/halls\/\d+\/overlay-state$/.test(path)) return true;
  if (method === 'GET' && /^\/api\/matches\/\d+\/suspensions$/.test(path)) return true;
  if (method === 'GET' && path === '/api/alerts' && !query?.all) return true;
  if (method === 'POST' && /^\/api\/halls\/\d+\/alerts\/\d+\/dismiss$/.test(path)) return true;
  return false;
}

function checkHallRole(method, path, user) {
  const halls = getUserHalls(user.id);

  if (method === 'GET' && path === '/api/auth/me') return true;
  if (method === 'GET' && path === '/api/halls') return true;

  const hallLive = path.match(/^\/api\/halls\/(\d+)\/live$/);
  if (method === 'GET' && hallLive) return halls.includes(+hallLive[1]);

  const hallTournament = path.match(/^\/api\/halls\/(\d+)\/tournament$/);
  if (method === 'GET' && hallTournament) return halls.includes(+hallTournament[1]);

  const hallOverlay = path.match(/^\/api\/halls\/(\d+)\/overlay$/);
  if (method === 'POST' && hallOverlay) return halls.includes(+hallOverlay[1]);

  const matchPath = path.match(/^\/api\/matches\/(\d+)(?:\/([\w-]+))?$/);
  if (matchPath) {
    const matchId = +matchPath[1];
    const action = matchPath[2];
    const hallId = matchHallId(matchId);
    if (!halls.includes(hallId)) return false;

    if (method === 'GET' && ['suspensions-admin', 'events'].includes(action)) return true;
    if (method === 'POST' && ['start', 'timer', 'period', 'score', 'event', 'finish', 'timeout-undo', 'config'].includes(action)) return true;
    if (method === 'GET' && !action) return true;
    return false;
  }

  const evDel = path.match(/^\/api\/events\/(\d+)$/);
  if (method === 'DELETE' && evDel) {
    const hallId = eventHallId(+evDel[1]);
    return halls.includes(hallId);
  }

  const teamPlayers = path.match(/^\/api\/teams\/(\d+)\/players$/);
  if (method === 'GET' && teamPlayers) return true;

  return false;
}

function hallTokenFromReq(req) {
  return req.headers['x-hall-token'] || req.query?.token || '';
}

function allowByHallToken(req) {
  const token = hallTokenFromReq(req);
  if (!token) return false;
  const method = req.method;
  const path = pathOnly(req.url);

  const matchPath = path.match(/^\/api\/matches\/(\d+)(?:\/([\w-]+))?$/);
  if (matchPath) {
    const hallId = matchHallId(+matchPath[1]);
    if (!verifyHallToken(hallId, token)) return false;
    const action = matchPath[2];
    if (method === 'GET' && ['suspensions-admin', 'events', 'suspensions'].includes(action)) return true;
    if (method === 'GET' && !action) return true;
    if (method === 'POST' && ['start', 'timer', 'period', 'score', 'event', 'finish', 'timeout-undo', 'config'].includes(action))
      return true;
    return false;
  }

  const evDel = path.match(/^\/api\/events\/(\d+)$/);
  if (method === 'DELETE' && evDel) return verifyHallToken(eventHallId(+evDel[1]), token);

  const hallOverlay = path.match(/^\/api\/halls\/(\d+)\/overlay$/);
  if (method === 'POST' && hallOverlay) return verifyHallToken(+hallOverlay[1], token);

  return false;
}

export function checkApiAccess(req) {
  const method = req.method;
  const path = pathOnly(req.url);

  if (!path.startsWith('/api/')) return { allow: true };

  if (isPublicApi(method, path, req.query)) return { allow: true };

  // OBS dock / overlay: no login cookie, hall agent_token in header or query.
  if (allowByHallToken(req)) return { allow: true };

  if (!req.user) return { allow: false, status: 401, error: 'Nepřihlášen' };

  if (req.user.role === 'admin') return { allow: true };

  if (req.user.role === 'reziser') {
    if (path.startsWith('/api/users')) return { allow: false, status: 403, error: 'Vyžadována role admin' };
    return { allow: true };
  }

  if (req.user.role === 'hall') {
    if (method === 'GET' && path === '/api/matches') {
      const hallId = +req.query?.hall_id;
      if (!hallId || !getUserHalls(req.user.id).includes(hallId))
        return { allow: false, status: 403, error: 'Nedostatečná oprávnění' };
      return { allow: true };
    }
    if (checkHallRole(method, path, req.user)) return { allow: true };
    return { allow: false, status: 403, error: 'Nedostatečná oprávnění' };
  }

  return { allow: false, status: 403, error: 'Nedostatečná oprávnění' };
}

export function checkStreamPreviewAccess(req) {
  if (!req.user || !['admin', 'reziser'].includes(req.user.role))
    return { allow: false, status: 401, error: 'Nepřihlášen' };
  return { allow: true };
}

export function sessionCookie(token, req) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || !!req.socket?.encrypted;
  return `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${secure ? '; Secure' : ''}`;
}
