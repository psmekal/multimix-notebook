// Tournament sync: Supabase Realtime (Phoenix Channels over WebSocket)
// Node 24 has native WebSocket — no npm package needed.
import { db, getSetting } from './db.js';

let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let ref = 0;
let teamsCache = new Map(); // uuid -> name
let teamsCacheTs = 0;
let io = null;
const lastState = new Map(); // hallId -> tournament data | null

function nextRef() { return String(++ref); }

async function refreshTeams(url, key) {
  if (Date.now() - teamsCacheTs < 60_000) return;
  try {
    const r = await fetch(`${url}/rest/v1/public_teams?select=id,name`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    if (r.ok) {
      const teams = await r.json();
      teamsCache = new Map(teams.map(t => [t.id, t.name]));
      teamsCacheTs = Date.now();
    }
  } catch (e) { console.error('Tournament sync: team fetch failed:', e.message); }
}

async function pollLiveNow(url, key) {
  try {
    await refreshTeams(url, key);
    const r = await fetch(`${url}/rest/v1/matches?select=*&status=eq.live`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    if (!r.ok) return;
    const matches = await r.json();
    const halls = db.prepare(
      `SELECT id, tournament_court_id FROM halls WHERE tournament_court_id IS NOT NULL AND tournament_court_id != ''`
    ).all();
    for (const hall of halls) {
      const m = matches.find(m => m.court_id === hall.tournament_court_id) ?? null;
      if (m) onMatchUpdate(m);
      else { lastState.set(hall.id, null); io.emit(`hall:${hall.id}:tournament`, null); }
    }
  } catch (e) { console.error('Tournament sync: initial poll failed:', e.message); }
}

function onMatchUpdate(record) {
  const halls = db.prepare(
    `SELECT id, tournament_court_id FROM halls WHERE tournament_court_id IS NOT NULL AND tournament_court_id != ''`
  ).all();

  const hall = halls.find(h => h.tournament_court_id === record.court_id);
  if (!hall) return;

  const live = record.status === 'live' || record.status === 'finished';
  const payload = live ? {
    home_name:             teamsCache.get(record.home_team_id) ?? '',
    away_name:             teamsCache.get(record.away_team_id) ?? '',
    home_score:            record.home_score,
    away_score:            record.away_score,
    status:                record.status,
    current_period:        record.current_period,
    clock_elapsed_seconds: record.clock_elapsed_seconds,
    clock_started_at:      record.clock_started_at,
    clock_paused_at:       record.clock_paused_at,
  } : null;
  lastState.set(hall.id, payload);
  io.emit(`hall:${hall.id}:tournament`, payload);
}

export function getTournamentState(hallId) {
  return lastState.get(hallId) ?? null;
}

function connect() {
  const url = getSetting('tournament_supabase_url');
  const key = getSetting('tournament_supabase_anon_key');
  if (!url || !key) {
    reconnectTimer = setTimeout(connect, 15_000);
    return;
  }

  refreshTeams(url, key);

  const wsUrl = url.replace('https://', 'wss://') + `/realtime/v1/websocket?apikey=${key}&vsn=1.0.0`;

  try { ws = new WebSocket(wsUrl); }
  catch (e) {
    console.error('Tournament sync: connect failed:', e.message);
    reconnectTimer = setTimeout(connect, 10_000);
    return;
  }

  ws.onopen = () => {
    console.log('Tournament sync: Realtime connected');
    const joinRef = nextRef();
    ws.send(JSON.stringify([joinRef, joinRef, 'realtime:public:matches', 'phx_join', {
      config: { postgres_changes: [{ event: 'UPDATE', schema: 'public', table: 'matches' }] }
    }]));
    heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify([null, nextRef(), 'phoenix', 'heartbeat', {}]));
    }, 30_000);
    // Emit current live matches immediately on connect (don't wait for first UPDATE)
    pollLiveNow(url, key);
  };

  ws.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const [, , , event, payload] = msg;
    if (event === 'postgres_changes' && payload?.data?.record)
      onMatchUpdate(payload.data.record);
  };

  ws.onerror = e => console.error('Tournament sync: WebSocket error:', e.message ?? e);

  ws.onclose = () => {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    console.log('Tournament sync: disconnected — reconnecting in 5s');
    reconnectTimer = setTimeout(connect, 5_000);
  };
}

function disconnect() {
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  reconnectTimer = null;
  heartbeatTimer = null;
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
}

export function startTournamentSync(ioInstance) {
  io = ioInstance;
  connect();
}

export function stopTournamentSync() {
  disconnect();
}

// Call after Supabase credentials change in settings
export function restartTournamentSync() {
  disconnect();
  teamsCacheTs = 0; // invalidate team cache so it reloads with new credentials
  setTimeout(connect, 200);
}
