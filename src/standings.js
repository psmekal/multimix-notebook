// Group standings calculation (handball: win 2, draw 1, loss 0 by default)
import { db, getSetting } from './db.js';

export function groupStandings(groupId) {
  const pw = +getSetting('points_win'), pd = +getSetting('points_draw'), pl = +getSetting('points_loss');
  const teams = db.prepare('SELECT * FROM teams WHERE group_id = ?').all(groupId);
  const table = new Map(teams.map(t => [t.id, {
    team_id: t.id, name: t.name, short_name: t.short_name,
    played: 0, wins: 0, draws: 0, losses: 0, goals_for: 0, goals_against: 0, points: 0
  }]));

  const matches = db.prepare(
    `SELECT * FROM matches WHERE stage = 'group' AND group_id = ? AND status = 'finished'`
  ).all(groupId);

  for (const m of matches) {
    const h = table.get(m.home_team_id), a = table.get(m.away_team_id);
    if (!h || !a) continue;
    h.played++; a.played++;
    h.goals_for += m.home_score; h.goals_against += m.away_score;
    a.goals_for += m.away_score; a.goals_against += m.home_score;
    if (m.home_score > m.away_score) { h.wins++; a.losses++; h.points += pw; a.points += pl; }
    else if (m.home_score < m.away_score) { a.wins++; h.losses++; a.points += pw; h.points += pl; }
    else { h.draws++; a.draws++; h.points += pd; a.points += pd; }
  }

  return [...table.values()].sort((x, y) =>
    y.points - x.points ||
    (y.goals_for - y.goals_against) - (x.goals_for - x.goals_against) ||
    y.goals_for - x.goals_for ||
    x.name.localeCompare(y.name, 'cs')
  );
}

// After a playoff match finishes, push the winner into the linked match slot
export function propagateWinner(match) {
  if (!match.winner_to_match_id || !match.winner_to_side) return;
  if (match.home_score === match.away_score) return; // playoff draw must be resolved manually
  const winnerId = match.home_score > match.away_score ? match.home_team_id : match.away_team_id;
  if (!winnerId) return;
  const col = match.winner_to_side === 'home' ? 'home_team_id' : 'away_team_id';
  db.prepare(`UPDATE matches SET ${col} = ? WHERE id = ?`).run(winnerId, match.winner_to_match_id);
}
