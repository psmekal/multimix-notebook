import crypto from 'node:crypto';
import { db } from './db.js';

const TTL_MS = 8 * 60 * 60 * 1000; // 8 hodín

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const attempt = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(attempt, 'hex'));
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now); // opportunistic cleanup
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, userId, now, now + TTL_MS);
  return token;
}

// Simple in-memory login rate limit: per-IP sliding window. Resets on restart,
// which is fine — the goal is slowing down brute-force, not perfect accounting.
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map(); // ip -> [timestamps]

export function checkLoginRateLimit(ip) {
  const now = Date.now();
  const arr = (loginAttempts.get(ip) || []).filter(t => now - t < LOGIN_WINDOW_MS);
  if (arr.length >= LOGIN_MAX_ATTEMPTS) {
    loginAttempts.set(ip, arr);
    return false;
  }
  arr.push(now);
  loginAttempts.set(ip, arr);
  return true;
}

export function getSessionUser(token) {
  if (!token) return null;
  return db.prepare(
    `SELECT u.id, u.username, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`
  ).get(token, Date.now()) || null;
}

export function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function getUserHalls(userId) {
  return db.prepare('SELECT hall_id FROM user_halls WHERE user_id = ?').all(userId).map(r => r.hall_id);
}
