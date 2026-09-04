// Public site: schedule + YouTube embed per hall
import { api, fmtDateTime, teamLabel, esc, qs } from '/assets/common.js';

const app = document.getElementById('app');
let data = null;
let watching = qs.get('watch') ? +qs.get('watch') : null; // match id

const socket = io();
socket.on('schedule:update', load);
socket.on('match:update', load);
socket.on('alerts:update', load);

async function load() {
  data = await api.get('/api/public/schedule');
  render();
}

function render() {
  const { tournament_name, halls, matches, alerts } = data;
  const live = matches.filter(m => m.status === 'live');
  const upcoming = matches.filter(m => m.status === 'scheduled');
  const finished = matches.filter(m => m.status === 'finished');

  let playerHtml = '';
  if (watching) {
    const m = matches.find(x => x.id === watching);
    const hall = m && halls.find(h => h.id === m.hall_id);
    playerHtml = hall?.yt_video_id ? `
      <div class="panel grid">
        <h2 style="margin:0">${esc(teamLabel(m, 'home'))} ${m.status !== 'scheduled' ? `<b>${m.home_score} : ${m.away_score}</b>` : 'vs'} ${esc(teamLabel(m, 'away'))}</h2>
        <div class="muted">${esc(hall.name)} · ${fmtDateTime(m.scheduled_at)}</div>
        <div class="player-box">
          <iframe src="https://www.youtube.com/embed/${esc(hall.yt_video_id)}?autoplay=1"
            allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>
        </div>
        <a href="#" id="closePlayer">← zpět na program</a>
      </div>` : `<div class="panel">Přenos z této haly zatím není k dispozici.</div>`;
  }

  const row = m => `
    <div class="match-row" data-watch="${m.id}">
      <span><b>${esc(teamLabel(m, 'home'))}</b> ${m.status !== 'scheduled' ? `<b>${m.home_score} : ${m.away_score}</b>` : '–'} <b>${esc(teamLabel(m, 'away'))}</b></span>
      <span class="muted">${fmtDateTime(m.scheduled_at)} · ${esc(m.hall_name ?? '')}
        ${m.status === 'live' ? '<span class="badge live">ŽIVĚ</span>' : ''}</span>
    </div>`;

  app.innerHTML = `
    <h1 style="margin:10px 0">${esc(tournament_name)}</h1>
    ${alerts.map(a => `<div class="alert-strip">${esc(a.text)}</div>`).join('')}
    ${playerHtml}
    ${live.length ? `<div class="panel"><h2 style="margin-top:0">🔴 Právě hrajeme</h2>${live.map(row).join('')}</div>` : ''}
    <div class="panel"><h2 style="margin-top:0">📅 Program</h2>${upcoming.length ? upcoming.map(row).join('') : '<span class="muted">Žádné nadcházející zápasy.</span>'}</div>
    ${finished.length ? `<div class="panel"><h2 style="margin-top:0">✅ Výsledky</h2>${finished.map(row).join('')}</div>` : ''}`;

  app.querySelectorAll('[data-watch]').forEach(el => el.onclick = () => {
    watching = +el.dataset.watch;
    history.replaceState(null, '', `?watch=${watching}`);
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  document.getElementById('closePlayer')?.addEventListener('click', e => {
    e.preventDefault(); watching = null; history.replaceState(null, '', location.pathname); render();
  });
}

load();
