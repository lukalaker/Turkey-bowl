// Turkey Bowl scoring (full PPR). Turns an ESPN game summary into fantasy points.
// Shared by the website (live scoring) and the GitHub Action (backup scores.json).

export const ESPN_API = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';

export const RULES = {
  passYd: 0.04, // 1 point per 25 yards
  passTd: 4,
  passInt: -2,
  rushYd: 0.1,
  rushTd: 6,
  rec: 1,
  recYd: 0.1,
  recTd: 6,
  fumLost: -2,
  returnTd: 6,
  fg: 3,
  xp: 1,
  dstSack: 1,
  dstInt: 2,
  dstFumRec: 2,
  dstTd: 6,
};

// Points allowed by a defense -> fantasy points.
export const POINTS_ALLOWED = [
  [0, 10],
  [6, 7],
  [13, 4],
  [20, 1],
  [27, 0],
  [34, -1],
  [Infinity, -4],
];

export function paPoints(allowed) {
  for (const [max, pts] of POINTS_ALLOWED) if (allowed <= max) return pts;
  return 0;
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round(n * 100) / 100;

/** Flatten one box-score category into {athleteId: {key: number}}. */
function readCategory(cat) {
  const out = {};
  const keys = cat.keys ?? [];
  for (const a of cat.athletes ?? []) {
    const row = {};
    keys.forEach((key, i) => {
      const raw = a.stats?.[i];
      if (key.includes('/')) {
        const [k1, k2] = key.split('/');
        const [v1, v2] = String(raw ?? '').split('/');
        row[k1] = num(v1);
        row[k2] = num(v2);
      } else if (key.includes('-')) {
        const [k1, k2] = key.split('-');
        const [v1, v2] = String(raw ?? '').split('-');
        row[k1] = num(v1);
        row[k2] = num(v2);
      } else {
        row[key] = num(raw);
      }
    });
    out[a.athlete.id] = row;
  }
  return out;
}

function sumKey(rows, key) {
  return Object.values(rows).reduce((s, r) => s + (r[key] ?? 0), 0);
}

function teamStat(teamBox, name) {
  const s = (teamBox?.statistics ?? []).find((x) => x.name === name);
  return s ? s.displayValue : undefined;
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Header info: state ('pre' | 'in' | 'post'), scores by team abbreviation. */
export function gameInfo(summary) {
  const comp = summary?.header?.competitions?.[0];
  const status = comp?.status?.type ?? {};
  const teams = {};
  for (const c of comp?.competitors ?? []) {
    teams[c.team.abbreviation] = { score: num(c.score), homeAway: c.homeAway, id: c.team.id };
  }
  return { state: status.state ?? 'pre', detail: status.shortDetail ?? status.detail ?? '', completed: !!status.completed, teams };
}

/**
 * Score one ESPN summary.
 * Returns { state, players: {espnId: {pts, line}}, dst: {ABBR: {pts, line}} }
 */
export function scoreSummary(summary) {
  const info = gameInfo(summary);
  const result = { state: info.state, detail: info.detail, scores: info.teams, players: {}, dst: {} };
  const box = summary?.boxscore;
  if (!box?.players?.length || info.state === 'pre') return result;

  const perTeam = {};
  for (const tp of box.players) {
    const abbr = tp.team.abbreviation;
    const cats = {};
    for (const cat of tp.statistics ?? []) cats[cat.name] = readCategory(cat);
    perTeam[abbr] = cats;

    const ids = new Set();
    for (const c of Object.values(cats)) for (const id of Object.keys(c)) ids.add(id);
    for (const id of ids) {
      const pass = cats.passing?.[id] ?? {};
      const rush = cats.rushing?.[id] ?? {};
      const recv = cats.receiving?.[id] ?? {};
      const fum = cats.fumbles?.[id] ?? {};
      const kr = cats.kickReturns?.[id] ?? {};
      const pr = cats.puntReturns?.[id] ?? {};
      const kick = cats.kicking?.[id] ?? {};
      const retTd = (kr.kickReturnTouchdowns ?? 0) + (pr.puntReturnTouchdowns ?? 0);
      const pts =
        (pass.passingYards ?? 0) * RULES.passYd +
        (pass.passingTouchdowns ?? 0) * RULES.passTd +
        (pass.interceptions ?? 0) * RULES.passInt +
        (rush.rushingYards ?? 0) * RULES.rushYd +
        (rush.rushingTouchdowns ?? 0) * RULES.rushTd +
        (recv.receptions ?? 0) * RULES.rec +
        (recv.receivingYards ?? 0) * RULES.recYd +
        (recv.receivingTouchdowns ?? 0) * RULES.recTd +
        (fum.fumblesLost ?? 0) * RULES.fumLost +
        retTd * RULES.returnTd +
        (kick.fieldGoalsMade ?? 0) * RULES.fg +
        (kick.extraPointsMade ?? 0) * RULES.xp;

      const parts = [];
      if (pass.passingAttempts) {
        parts.push(`${pass.completions}/${pass.passingAttempts}, ${fmt(pass.passingYards ?? 0)} pass yds`);
        if (pass.passingTouchdowns) parts.push(`${pass.passingTouchdowns} pass TD`);
        if (pass.interceptions) parts.push(`${pass.interceptions} INT`);
      }
      if (rush.rushingAttempts) {
        parts.push(`${rush.rushingAttempts} car, ${fmt(rush.rushingYards ?? 0)} rush yds`);
        if (rush.rushingTouchdowns) parts.push(`${rush.rushingTouchdowns} rush TD`);
      }
      if (recv.receptions || recv.receivingTargets) {
        parts.push(`${recv.receptions ?? 0} rec, ${fmt(recv.receivingYards ?? 0)} yds`);
        if (recv.receivingTouchdowns) parts.push(`${recv.receivingTouchdowns} rec TD`);
      }
      if (retTd) parts.push(`${retTd} return TD`);
      if (fum.fumblesLost) parts.push(`${fum.fumblesLost} fumble lost`);
      if (kick.fieldGoalAttempts || kick.extraPointAttempts) {
        parts.push(`${kick.fieldGoalsMade ?? 0}/${kick.fieldGoalAttempts ?? 0} FG, ${kick.extraPointsMade ?? 0}/${kick.extraPointAttempts ?? 0} XP`);
      }
      result.players[id] = { pts: round2(pts), line: parts.join(', ') };
    }
  }

  const abbrs = Object.keys(perTeam);
  for (const abbr of abbrs) {
    const opp = abbrs.find((a) => a !== abbr);
    if (!opp) continue;
    const own = perTeam[abbr];
    const them = perTeam[opp];
    const oppTeamBox = box.teams?.find((t) => t.team.abbreviation === opp);
    const ownTeamBox = box.teams?.find((t) => t.team.abbreviation === abbr);

    const sacksStat = teamStat(oppTeamBox, 'sacksYardsLost');
    const sacks = sacksStat !== undefined ? num(String(sacksStat).split('-')[0]) : sumKey(them.passing ?? {}, 'sacks');
    const ints = sumKey(them.passing ?? {}, 'interceptions');
    const fumRecStat = teamStat(oppTeamBox, 'fumblesLost');
    const fumRec = fumRecStat !== undefined ? num(fumRecStat) : sumKey(them.fumbles ?? {}, 'fumblesLost');
    const defTdStat = teamStat(ownTeamBox, 'defensiveTouchdowns');
    const defTd =
      defTdStat !== undefined
        ? num(defTdStat)
        : sumKey(own.defensive ?? {}, 'defensiveTouchdowns') + sumKey(own.interceptions ?? {}, 'interceptionTouchdowns');
    const retTd = sumKey(own.kickReturns ?? {}, 'kickReturnTouchdowns') + sumKey(own.puntReturns ?? {}, 'puntReturnTouchdowns');
    const allowed = info.teams[opp]?.score ?? 0;
    const pa = paPoints(allowed);
    const pts =
      sacks * RULES.dstSack + ints * RULES.dstInt + fumRec * RULES.dstFumRec + (defTd + retTd) * RULES.dstTd + pa;

    const parts = [`${allowed} pts allowed`];
    if (sacks) parts.push(`${sacks} sack${sacks === 1 ? '' : 's'}`);
    if (ints) parts.push(`${ints} INT`);
    if (fumRec) parts.push(`${fumRec} fum rec`);
    if (defTd + retTd) parts.push(`${defTd + retTd} TD`);
    result.dst[abbr] = { pts: round2(pts), line: parts.join(', ') };
  }
  return result;
}

/** Points for one pool player out of a set of scored games (keyed by game id). */
export function pointsFor(player, scoredGames) {
  const g = scoredGames?.[player.game];
  if (!g) return null;
  if (player.pos === 'DEF') return g.dst?.[player.team] ?? (g.state === 'pre' ? null : { pts: 0, line: '' });
  return g.players?.[player.id] ?? (g.state === 'pre' ? null : { pts: 0, line: 'No stats yet' });
}

export async function fetchSummary(gameId, fetchImpl = fetch) {
  const res = await fetchImpl(`${ESPN_API}/summary?event=${gameId}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  return res.json();
}
