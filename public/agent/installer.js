'use strict';
// MultiMix hall-notebook installer.
// Single self-extracting EXE built with pkg — contains OBS portable + multimix-agent.exe.
// No internet access, no PowerShell script files, no Node.js install required.
//
// Bundled via:  node tools/build-installer.mjs --hall N --server http://IP:3000
//
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const http       = require('http');
const https      = require('https');
const { execSync, spawn } = require('child_process');

// These two lines are replaced by build-installer.mjs before pkg runs:
const HALL   = Number('__HALL__');
const SERVER = '__SERVER__';
const TOKEN  = '__TOKEN__';

const INSTALL_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'MultiMix');
const OBS_DIR     = path.join(INSTALL_DIR, 'obs');
const AGENT_DEST  = path.join(INSTALL_DIR, 'multimix-agent.exe');
const REMOTE_DEST = path.join(INSTALL_DIR, 'multimix-remote.exe');

// Only multimix-agent.exe is embedded as a pkg asset (OBS + remote helper downloaded from server).
const AGENT_EXE_ASSET = path.join(__dirname, 'multimix-agent.exe');

function download(url, dest, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) { reject(new Error('Příliš mnoho přesměrování')); return; }
    const file = fs.createWriteStream(dest);
    const mod  = url.startsWith('https') ? https : http;
    mod.get(url, res => {
      const loc = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc) {
        try { file.close(); fs.unlinkSync(dest); } catch {}
        const next = /^https?:\/\//i.test(loc) ? loc : new URL(loc, url).href;
        resolve(download(next, dest, hops + 1));
        return;
      }
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode + ': ' + url)); return; }
      const total = +(res.headers['content-length'] || 0);
      let done = 0, lastPct = -1;
      res.on('data', chunk => {
        done += chunk.length;
        const pct = total ? Math.floor(done / total * 100) : -1;
        if (pct !== lastPct) {
          lastPct = pct;
          process.stdout.write('\r      ' + (done / 1e6).toFixed(0) + ' / ' + (total / 1e6).toFixed(0) + ' MB  (' + (pct >= 0 ? pct + '%' : '?') + ')   ');
        }
      });
      res.pipe(file);
      file.on('finish', () => { process.stdout.write('\n'); resolve(); });
      file.on('error', reject);
    }).on('error', e => { try { fs.unlinkSync(dest); } catch {} reject(e); });
  });
}

function log(msg) { process.stdout.write(msg + '\r\n'); }

async function main() {
  log('');
  log('================================================');
  log('  MultiMix Setup  -  Hala ' + HALL);
  log('  Server: ' + SERVER);
  log('================================================');
  log('');

  fs.mkdirSync(INSTALL_DIR, { recursive: true });

  // ------------------------------------------------------------------
  // 1. OBS Studio
  // ------------------------------------------------------------------
  const obsExeBin   = path.join(OBS_DIR, 'bin', '64bit', 'obs64.exe');
  const obsThemeDir = path.join(OBS_DIR, 'data', 'obs-studio', 'themes');
  const obsOk = fs.existsSync(obsExeBin) && fs.existsSync(obsThemeDir);
  log('[1/5] OBS: exe=' + (fs.existsSync(obsExeBin) ? 'OK' : 'CHYBA') +
              '  themes=' + (fs.existsSync(obsThemeDir) ? 'OK' : 'CHYBA'));

  if (!obsOk) {
    // Always remove previous (possibly partial) extraction before re-extracting.
    if (fs.existsSync(OBS_DIR)) {
      log('      Mazem predoslu instalaciu OBS...');
      fs.rmSync(OBS_DIR, { recursive: true, force: true });
    }

    // Download OBS zip from MultiMix server (local network — no internet needed).
    const tmpZip = path.join(os.tmpdir(), 'obs-mm.zip');
    log('      Stahujem OBS zo servera (~160 MB, lokalna siet)...');
    await download(SERVER + '/downloads/obs-portable.zip', tmpZip);

    // Extract with PowerShell Expand-Archive via -EncodedCommand (no execution policy).
    fs.mkdirSync(OBS_DIR, { recursive: true });
    log('      Rozbalujem do: ' + OBS_DIR);
    const psScript = `$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath '${tmpZip}' -DestinationPath '${OBS_DIR}' -Force`;
    const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
    execSync('powershell.exe -NoProfile -EncodedCommand ' + b64,
      { stdio: 'inherit', timeout: 300000 });
    try { fs.unlinkSync(tmpZip); } catch {}

    // If ZIP had a single root subdir (e.g. OBS-Studio-30.2.2/) flatten it.
    const rootItems = fs.readdirSync(OBS_DIR);
    log('      Obsah obs/: [' + rootItems.join(', ') + ']');
    if (!rootItems.includes('bin') && rootItems.length === 1) {
      const sub = path.join(OBS_DIR, rootItems[0]);
      log('      Presuvam obsah z podpriecinku ' + rootItems[0] + '/...');
      for (const f of fs.readdirSync(sub)) {
        fs.renameSync(path.join(sub, f), path.join(OBS_DIR, f));
      }
      try { fs.rmdirSync(sub); } catch {}
    }

    if (!fs.existsSync(obsExeBin) || !fs.existsSync(obsThemeDir)) {
      throw new Error('OBS sa nerozbalil spravne. obs64=' + fs.existsSync(obsExeBin) + ' themes=' + fs.existsSync(obsThemeDir));
    }
    log('      OBS OK');
  } else {
    log('      OBS uz nainstalvany, preskakujem.');
  }

  // ------------------------------------------------------------------
  // 2. Pre-configure OBS websocket (port 4461, password "multimix")
  // ------------------------------------------------------------------
  log('[2/5] Konfigurujem OBS websocket...');
  const wsCfgDir = path.join(OBS_DIR, 'config', 'obs-studio', 'plugin_config', 'obs-websocket');
  fs.mkdirSync(wsCfgDir, { recursive: true });
  fs.writeFileSync(path.join(wsCfgDir, 'config.json'), JSON.stringify({
    alerts_enabled: false,
    auth_required: true,
    first_load: false,
    server_enabled: true,
    server_password: 'multimix',
    server_port: 4461
  }));

  // ------------------------------------------------------------------
  // 3. Copy multimix-agent.exe + write agent-config.json (source of truth)
  // ------------------------------------------------------------------
  log('[3/5] Kopirujem MultiMix agenta...');
  fs.writeFileSync(AGENT_DEST, fs.readFileSync(AGENT_EXE_ASSET));

  const cfgPath = path.join(INSTALL_DIR, 'agent-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    hall: HALL,
    server: SERVER,
    token: TOKEN,
    installedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  log('      agent-config.json OK (token ' + String(TOKEN).slice(0, 8) + '…)');

  // ------------------------------------------------------------------
  // 4. Download remote-desktop helper (screen capture + input)
  // ------------------------------------------------------------------
  log('[4/5] Stahuji vzdaleny helper (multimix-remote.exe)...');
  try {
    await download(SERVER + '/downloads/multimix-remote.exe', REMOTE_DEST);
    log('      Remote helper OK');
  } catch (e) {
    log('      VAROVANI: remote helper se nepodarilo stahnout: ' + e.message);
    log('      Vzdalene ovladani v rezii nebude dostupne, dokud helper nebude na serveru.');
  }

  // ------------------------------------------------------------------
  // 5. Desktop shortcut via VBScript (wscript.exe — no execution policy)
  // Token lives in agent-config.json so a stale .lnk cannot break auth.
  // ------------------------------------------------------------------
  log('[5/5] Vytvarim zkratku na ploche (bez --launch, token je v agent-config.json)...');
  const vbs = [
    'Dim ws, sc',
    'Set ws = CreateObject("WScript.Shell")',
    'Set sc = ws.CreateShortcut(ws.SpecialFolders("Desktop") & "\\MultiMix Hala ' + HALL + '.lnk")',
    'sc.TargetPath = "' + AGENT_DEST.replace(/\\/g, '\\\\') + '"',
    'sc.Arguments = ""',
    'sc.WorkingDirectory = "' + INSTALL_DIR.replace(/\\/g, '\\\\') + '"',
    'sc.WindowStyle = 7',
    'sc.Save',
  ].join('\r\n');

  const vbsPath = path.join(os.tmpdir(), 'mm_shortcut_' + HALL + '.vbs');
  fs.writeFileSync(vbsPath, vbs, 'utf8');
  try { execSync('wscript.exe "' + vbsPath + '"', { stdio: 'ignore' }); } catch {}
  try { fs.unlinkSync(vbsPath); } catch {}
  log('      Zástupce přepsán: Cíl = multimix-agent.exe (bez --launch, bez --token)');

  log('');
  log('Spoustim agenta (OBS nespoustim — ten spust rucne)...');
  spawn(AGENT_DEST, [], {
    detached: true, stdio: 'ignore', cwd: INSTALL_DIR
  }).unref();

  log('');
  log('================================================');
  log('  Hotovo!');
  log('  Skratka "MultiMix Hala ' + HALL + '" je na ploche.');
  log('  Agent sdili obrazovku. OBS spust rucne.');
  log('  Toto okno mozno zatvorit.');
  log('================================================');
  log('');

  // Auto-close after 10 s so the user can read the output
  await new Promise(r => setTimeout(r, 10000));
}

main().catch(e => {
  process.stderr.write('\r\nCHYBA: ' + e.message + '\r\n\r\n');
  process.stderr.write('Stlac Enter pre zatvorenie...\r\n');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(1));
});
