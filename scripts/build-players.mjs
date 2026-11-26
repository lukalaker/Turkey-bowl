// Builds data/players.json: the Thanksgiving player pool with salaries.
// Run once before the draft:  node scripts/build-players.mjs
// Sources: ESPN (schedule, rosters, player ids) and Sleeper (week projections).
import { writeFile } from 'node:fs/promises';

const SEASON = 2026;
const DATE = '20261126'; // Thanksgiving Day
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';

async function getJSON(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

export function normName(s) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’-]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Salary in whole dollars out of a $100 budget for 9 spots.
// Stars cost a premium (squared term) so nobody can afford all of them.
export function salaryFor(pos, proj) {
  if (pos === 'K' || pos === 'DEF') return Math.max(2, Math.round(proj * 0.5));
  return Math.max(2, Math.round(0.55 * proj + 0.018 * proj * proj));
}

const MIN_PROJ = 2.0; // skip deep backups who are projected for almost nothing

async function main() {
  const sb = await getJSON(`${ESPN}/scoreboard?dates=${DATE}`);
  const games = sb.events.map((e) => {
    const c = e.competitions[0];
    const home = c.competitors.find((t) => t.homeAway === 'home');
    const away = c.competitors.find((t) => t.homeAway === 'away');
    return {
      id: e.id,
      name: e.name,
      short: e.shortName,
      kickoff: new Date(e.date).toISOString(),
      network: c.broadcasts?.[0]?.names?.[0] ?? c.broadcast ?? '',
      home: { abbr: home.team.abbreviation, id: home.team.id, name: home.team.displayName, short: home.team.shortDisplayName ?? home.team.name, color: home.team.color },
      away: { abbr: away.team.abbreviation, id: away.team.id, name: away.team.displayName, short: away.team.shortDisplayName ?? away.team.name, color: away.team.color },
    };
  });
  const teamGame = {};
  for (const g of games) {
    teamGame[g.home.abbr] = { game: g, opp: g.away.abbr, home: true, team: g.home };
    teamGame[g.away.abbr] = { game: g, opp: g.home.abbr, home: false, team: g.away };
  }

  // ESPN rosters -> name lookup for ESPN athlete ids (used to match box scores).
  const espnByName = {};
  for (const g of games) {
    for (const t of [g.home, g.away]) {
      const r = await getJSON(`${ESPN}/teams/${t.id}/roster`);
      for (const group of r.athletes) {
        for (const a of group.items) {
          espnByName[`${t.abbr}|${normName(a.fullName ?? a.displayName)}`] = a;
          espnByName[`${t.abbr}|${normName(a.displayName)}`] = a;
        }
      }
    }
  }

  const week = sb.week?.number ?? 12;
  const pos = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map((p) => `position%5B%5D=${p}`).join('&');
  const proj = await getJSON(
    `https://api.sleeper.app/projections/nfl/${SEASON}/${week}?season_type=regular&${pos}&order_by=pts_ppr`,
  );

  const players = [];
  const unmatched = [];
  for (const r of proj) {
    const tg = teamGame[r.team];
    if (!tg) continue;
    const p = r.player ?? {};
    const position = p.position;
    const pts = r.stats?.pts_ppr ?? 0;
    if (!['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(position)) continue;
    if (position === 'K' || position === 'DEF') {
      if (pts <= 0.5) continue;
    } else if (pts < MIN_PROJ) continue;
    if (['Out', 'IR', 'PUP', 'Sus'].includes(p.injury_status)) continue;

    // Price from the same rounded projection the site shows, so the two always agree.
    const shown = Math.round(pts * 10) / 10;
    const base = {
      pos: position,
      team: r.team,
      opp: tg.opp,
      home: tg.home,
      game: tg.game.id,
      kickoff: tg.game.kickoff,
      proj: shown,
      salary: salaryFor(position, shown),
      injury: p.injury_status ?? null,
    };
    if (position === 'DEF') {
      players.push({ id: `DEF-${r.team}`, name: `${tg.team.short} D/ST`, ...base });
      continue;
    }
    const fullName = `${p.first_name} ${p.last_name}`;
    const a = espnByName[`${r.team}|${normName(fullName)}`];
    if (!a) {
      unmatched.push(`${fullName} (${r.team} ${position})`);
      continue;
    }
    players.push({ id: String(a.id), name: a.displayName ?? fullName, jersey: a.jersey ?? null, ...base });
  }

  players.sort((a, b) => b.salary - a.salary || b.proj - a.proj || a.name.localeCompare(b.name));
  const out = { season: SEASON, week, generatedAt: new Date().toISOString(), games, players };
  await writeFile(new URL('../data/players.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote ${players.length} players across ${games.length} games.`);
  if (unmatched.length) console.log(`No ESPN match (left out): ${unmatched.join(', ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
