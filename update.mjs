#!/usr/bin/env node
// On the portable notebook: download only files that changed in
// psmekal/multimix-notebook. Never touches data/, runtime/, or node_modules/.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const REPO = 'psmekal/multimix-notebook';
const API = `https://api.github.com/repos/${REPO}`;
const RAW = `https://raw.githubusercontent.com/${REPO}/main`;
const REV_FILE = path.join(ROOT, '.notebook-revision');
const MANIFEST_FILE = path.join(ROOT, '.notebook-manifest.json');
const SKIP = new Set(['update.mjs', '.notebook-revision', '.notebook-manifest.json']);

function gitBlobSha(buf) {
  return crypto.createHash('sha1')
    .update(`blob ${buf.length}\0`)
    .update(buf)
    .digest('hex');
}

function skipPath(p) {
  const n = p.replace(/\\/g, '/');
  if (SKIP.has(n)) return true;
  if (n.startsWith('data/') || n === 'data') return true;
  if (n.startsWith('runtime/') || n === 'runtime') return true;
  if (n.startsWith('node_modules/') || n === 'node_modules') return true;
  return false;
}

async function getJson(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'multimix-notebook-update',
      Accept: 'application/vnd.github+json',
    },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`GitHub API ${r.status}: ${url}\n${body.slice(0, 300)}`);
  }
  return r.json();
}

async function getBytes(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'multimix-notebook-update' } });
  if (!r.ok) throw new Error(`Stazeni ${url} selhalo (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

const commit = await getJson(`${API}/commits/main`);
const sha = commit.sha;
const prev = fs.existsSync(REV_FILE) ? fs.readFileSync(REV_FILE, 'utf8').trim() : '';
if (prev === sha) {
  console.log('Uz je vse aktualni.');
  process.exit(0);
}

const tree = await getJson(`${API}/git/trees/${sha}?recursive=1`);
if (tree.truncated) throw new Error('GitHub tree je prilis velky.');

const blobs = (tree.tree || []).filter((e) => e.type === 'blob' && e.path && !skipPath(e.path));
const updated = [];
const newManifest = [];

for (const entry of blobs) {
  newManifest.push(entry.path);
  const dest = path.join(ROOT, ...entry.path.split('/'));
  let localSha = '';
  try {
    localSha = gitBlobSha(fs.readFileSync(dest));
  } catch { /* missing */ }
  if (localSha && localSha === entry.sha) continue;
  const buf = await getBytes(`${RAW}/${entry.path.split('/').map(encodeURIComponent).join('/')}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  updated.push(entry.path);
}

const oldManifest = fs.existsSync(MANIFEST_FILE)
  ? JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'))
  : [];
const keep = new Set(newManifest);
for (const rel of oldManifest) {
  if (keep.has(rel) || skipPath(rel)) continue;
  const dest = path.join(ROOT, ...rel.split('/'));
  try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
}

fs.writeFileSync(MANIFEST_FILE, JSON.stringify(newManifest, null, 2) + '\n');
fs.writeFileSync(REV_FILE, sha + '\n');

if (updated.includes('package-lock.json') || updated.includes('package.json')) {
  console.log('Zavislosti se zmenily, spoustim npm ci...');
  const npmCmd = fs.existsSync(path.join(ROOT, 'runtime', 'node', 'npm.cmd'))
    ? path.join(ROOT, 'runtime', 'node', 'npm.cmd')
    : 'npm';
  execFileSync(npmCmd, ['ci', '--omit=dev'], { cwd: ROOT, stdio: 'inherit', shell: true });
}

if (!updated.length) {
  console.log('Uz je vse aktualni.');
} else {
  console.log(`Aktualizovano ${updated.length} souboru:`);
  for (const p of updated.slice(0, 30)) console.log('  ' + p);
  if (updated.length > 30) console.log('  ...');
}
console.log('Hotovo. Slozka data, Node i node_modules zustaly.');
