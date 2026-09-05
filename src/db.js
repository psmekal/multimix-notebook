// SQLite database layer (node:sqlite, built into Node 22+, synchronous)
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'media'), { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'multimix.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS halls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  stream_key TEXT NOT NULL UNIQUE,        -- SRT/RTMP path name, e.g. "hall1"
  yt_rtmp_url TEXT DEFAULT 'rtmp://a.rtmp.youtube.com/live2',
  yt_stream_key TEXT DEFAULT '',
  yt_video_id TEXT DEFAULT '',            -- for public embed
  output_mode TEXT DEFAULT 'off'          -- off | live | media
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  short_name TEXT DEFAULT '',
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  number INTEGER,
  name TEXT NOT NULL,
  position TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage TEXT NOT NULL DEFAULT 'group',    -- group | playoff
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  round TEXT DEFAULT '',                  -- playoff: QF/SF/F/3rd ...
  bracket_slot INTEGER,                   -- position within bracket round
  hall_id INTEGER REFERENCES halls(id) ON DELETE SET NULL,
  scheduled_at TEXT,                      -- ISO datetime
  home_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  away_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  home_placeholder TEXT DEFAULT '',       -- e.g. "Vitez SF1" when team unknown
  away_placeholder TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | live | finished
  home_score INTEGER NOT NULL DEFAULT 0,
  away_score INTEGER NOT NULL DEFAULT 0,
  period INTEGER NOT NULL DEFAULT 1,      -- 1 | 2 (polocas)
  timer_running INTEGER NOT NULL DEFAULT 0,
  timer_started_at INTEGER,               -- epoch ms when started
  timer_offset_ms INTEGER NOT NULL DEFAULT 0,
  winner_to_match_id INTEGER REFERENCES matches(id) ON DELETE SET NULL,
  winner_to_side TEXT                     -- home | away
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                     -- goal | penalty2 | yellow | red | timeout
  side TEXT NOT NULL,                     -- home | away
  player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  match_time_ms INTEGER NOT NULL DEFAULT 0,
  period INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  filename TEXT NOT NULL,
  type TEXT DEFAULT 'video',              -- video | image
  duration_s INTEGER DEFAULT 0,
  in_rotation INTEGER NOT NULL DEFAULT 1  -- include in automatic between-matches playlist
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  level TEXT DEFAULT 'info',              -- info | warning | important
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Match settings templates (period time, timeouts, suspension length)
db.exec(`
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  period_length_min REAL NOT NULL DEFAULT 30,
  periods INTEGER NOT NULL DEFAULT 2,         -- regular periods (overtime added on top)
  timeouts INTEGER NOT NULL DEFAULT 3,
  suspension_s INTEGER NOT NULL DEFAULT 120
);

-- persistent overlay logos (tournament / sponsors), always on, in a corner
CREATE TABLE IF NOT EXISTS branding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  filename TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'image',         -- image | video
  active INTEGER NOT NULL DEFAULT 1,
  corner TEXT NOT NULL DEFAULT 'tl',          -- tl | tr | bl | br
  size_pct INTEGER NOT NULL DEFAULT 10,       -- height as % of screen height
  sort_order INTEGER NOT NULL DEFAULT 0
);`);

// Scenarios
db.exec(`
CREATE TABLE IF NOT EXISTS scenarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scenario_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}'
);`);

// Auth tables
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'hall'   -- admin | reziser | hall
);
CREATE TABLE IF NOT EXISTS user_halls (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hall_id INTEGER NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, hall_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);`);

function _hashPwd(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

if (process.env.MULTIMIX_LOCAL === '1') {
  const pw = process.env.ADMIN_PASSWORD || 'admin';
  const hash = _hashPwd(pw);
  const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
  if (admin) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, admin.id);
  } else {
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)')
      .run('admin', hash, 'admin');
  }
  console.log('Lokální režim — přihlášení: admin / ' + pw);
} else if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(8).toString('hex');
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)')
    .run('admin', _hashPwd(pw), 'admin');
  console.log('Vytvořen výchozí admin účet: admin / ' + pw);
  if (!process.env.ADMIN_PASSWORD)
    console.log('(Heslo se znovu nezobrazí — nastav ADMIN_PASSWORD nebo změň v Nastavení → Uživatelé)');
}

// Migrations
const migrations = {
  events: ['number INTEGER', 'end_total_ms INTEGER'],
  teams: [`color_bg TEXT DEFAULT '#1d3fb8'`, `color_text TEXT DEFAULT '#ffffff'`, `logo TEXT DEFAULT ''`],
  halls: ['overlay_visible INTEGER NOT NULL DEFAULT 1', 'auto_output INTEGER NOT NULL DEFAULT 0', 'tournament_court_id TEXT DEFAULT NULL', 'agent_token TEXT DEFAULT NULL'],
  media: [
    'sort_order INTEGER NOT NULL DEFAULT 0',
    'is_ad INTEGER NOT NULL DEFAULT 0',          // 1 = advertisement (weighted ad pool)
    'weight INTEGER NOT NULL DEFAULT 5',         // share of voice 1..10
    'ad_active INTEGER NOT NULL DEFAULT 1',      // campaign running
    'swrr_current INTEGER NOT NULL DEFAULT 0'    // smooth weighted round-robin running value
  ],
  matches: [
    'period_length_ms INTEGER NOT NULL DEFAULT 1800000', // default per-period length
    `period_lengths TEXT DEFAULT ''`,                    // JSON overrides per period (index 0 = period 1)
    'timeouts_allowed INTEGER NOT NULL DEFAULT 3',
    'suspension_ms INTEGER NOT NULL DEFAULT 120000',
    'prev_periods_ms INTEGER NOT NULL DEFAULT 0',        // cumulative game time of completed periods
    'home_timeouts INTEGER NOT NULL DEFAULT 0',
    'away_timeouts INTEGER NOT NULL DEFAULT 0',
    'timeout_until INTEGER',                      // epoch ms when the 60s timeout display ends
    'timeout_side TEXT'                           // home | away, team that called the active timeout
  ]
};
for (const [table, cols] of Object.entries(migrations))
  for (const col of cols) { try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch {} }

// Backfill agent tokens for existing halls
for (const { id } of db.prepare("SELECT id FROM halls WHERE agent_token IS NULL OR agent_token = ''").all()) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('UPDATE halls SET agent_token = ? WHERE id = ?').run(token, id);
}

export function ensureAgentToken(hallId) {
  const row = db.prepare('SELECT agent_token FROM halls WHERE id = ?').get(+hallId);
  if (row?.agent_token) return row.agent_token;
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('UPDATE halls SET agent_token = ? WHERE id = ?').run(token, +hallId);
  return token;
}

// Seed default templates once
if (db.prepare('SELECT COUNT(*) c FROM templates').get().c === 0) {
  const insT = db.prepare('INSERT INTO templates (name, period_length_min, periods, timeouts, suspension_s) VALUES (?,?,?,?,?)');
  insT.run('Házená 2×30 min', 30, 2, 3, 120);
  insT.run('Házená 2×25 min', 25, 2, 3, 120);
  insT.run('Mini házená 2×20 min', 20, 2, 1, 60);
}

// Defaults
const defaults = {
  tournament_name: 'Turnaj v házené',
  period_length_min: '30',
  points_win: '2',
  points_draw: '1',
  points_loss: '0',
  mediamtx_host: '127.0.0.1',
  mediamtx_hls_port: '8888',
  mediamtx_srt_port: '8890',
  mediamtx_webrtc_port: '8889',
  // Reklamní bloky
  stinger_media_id: '',     // průhledné přechodové video (id z media)
  stinger_cut_pct: '50',    // v kterém % stingeru se skrytě přepne zdroj (plné překrytí)
  ad_block_timeout: '1',    // počet spotů: timeout
  ad_block_halftime: '3',   // počet spotů: poločas
  ad_block_between: '5',    // počet spotů: mezi zápasy
  // Automatic scenario playback (operator buttons, not clock auto-stop)
  auto_scen_period1_id: '',
  auto_scen_period1_delay: '30',
  auto_scen_period2_id: '',
  auto_scen_period2_delay: '15',
  auto_scen_overtime_id: '',
  auto_scen_overtime_delay: '15',
  auto_scen_timeout_id: '',
  auto_scen_timeout_delay: '0'
};
const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaults)) insSetting.run(k, v);

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// Broadcast destinations (YouTube + custom RTMP). One is active for all halls.
db.exec(`
CREATE TABLE IF NOT EXISTS broadcast_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  rtmp_url TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0
);
`);
if (db.prepare('SELECT COUNT(*) c FROM broadcast_services').get().c === 0) {
  const fromHall = db.prepare(
    "SELECT yt_rtmp_url FROM halls WHERE yt_rtmp_url IS NOT NULL AND TRIM(yt_rtmp_url) != '' LIMIT 1"
  ).get();
  const url = (fromHall?.yt_rtmp_url || 'rtmp://a.rtmp.youtube.com/live2').replace(/\/$/, '');
  const r = db.prepare('INSERT INTO broadcast_services (name, rtmp_url, builtin) VALUES (?,?,1)')
    .run('YouTube', url);
  setSetting('active_broadcast_service_id', String(r.lastInsertRowid));
}

export function listBroadcastServices() {
  const activeId = +(getSetting('active_broadcast_service_id') || 0);
  return db.prepare('SELECT * FROM broadcast_services ORDER BY builtin DESC, id').all()
    .map(s => ({ ...s, active: s.id === activeId ? 1 : 0 }));
}

export function getActiveBroadcastService() {
  const id = +(getSetting('active_broadcast_service_id') || 0);
  let row = id ? db.prepare('SELECT * FROM broadcast_services WHERE id = ?').get(id) : null;
  if (!row) {
    row = db.prepare('SELECT * FROM broadcast_services ORDER BY builtin DESC, id LIMIT 1').get();
    if (row) setSetting('active_broadcast_service_id', String(row.id));
  }
  return row || null;
}

// One-time: IHF default is 3 timeouts per team (seed used to be 2).
if (getSetting('_migrated_timeouts_3') !== '1') {
  db.prepare('UPDATE templates SET timeouts = 3 WHERE timeouts = 2').run();
  db.prepare(`UPDATE matches SET timeouts_allowed = 3 WHERE timeouts_allowed = 2 AND status IN ('scheduled','live')`).run();
  setSetting('_migrated_timeouts_3', '1');
}

// Current elapsed time of a match in ms (within the current period).
// Never negative — a client clock behind the server used to produce -00:01.
export function matchElapsedMs(m) {
  let ms = m.timer_offset_ms || 0;
  if (m.timer_running && m.timer_started_at) ms += Date.now() - m.timer_started_at;
  return Math.max(0, ms);
}

// Configured length of a given period (1-based). period_lengths JSON can
// override individual periods (e.g. shorter overtime); else period_length_ms.
export function periodLengthMs(m, period = m.period) {
  if (m.period_lengths) {
    try {
      const arr = JSON.parse(m.period_lengths);
      if (arr[period - 1] != null) return arr[period - 1];
    } catch {}
  }
  return m.period_length_ms ?? 1800000;
}

// Game time accumulated before the start of a given period
export function prevPeriodsMs(m, period = m.period) {
  let sum = 0;
  for (let p = 1; p < period; p++) sum += periodLengthMs(m, p);
  return sum;
}

// Total game time across all periods (for suspension carry-over)
export function totalGameMs(m) {
  return (m.prev_periods_ms ?? 0) + matchElapsedMs(m);
}

// Human period label: 1./2. poločas, then Prodloužení
export function periodLabel(m, period = m.period) {
  const reg = 2; // regular periods for handball
  if (period <= reg) return `${period}. poločas`;
  return `Prodloužení ${period - reg}`;
}

export const mediaDir = path.join(dataDir, 'media');
