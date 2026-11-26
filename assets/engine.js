// Turkey Bowl draft rules. Shared by the website (to show what you can afford)
// and the GitHub Action (which is the only thing that records picks).
// Pure functions over plain JSON so both sides agree exactly.

export const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF'];
export const FLEX_POSITIONS = ['RB', 'WR', 'TE'];
export const TEAM_COLORS = ['cranberry', 'gold', 'slate'];
export const POS_LABEL = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', FLEX: 'Flex', K: 'K', DEF: 'D/ST' };

const sameUser = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function snakeIndex(turn, n) {
  const round = Math.floor(turn / n);
  const i = turn % n;
  return round % 2 === 0 ? i : n - 1 - i;
}

export function slotsFor(league) {
  return league.slots ?? SLOTS;
}

export function newLeague({ commissioner, repo, cap = 100, maxTeams = 3, name = 'Turkey Bowl' }) {
  return {
    name,
    repo,
    commissioner,
    cap,
    maxTeams,
    slots: SLOTS,
    status: 'signup',
    teams: [],
    order: [],
    turn: 0,
    picks: [],
    passes: [],
    startedAt: null,
    completedAt: null,
    updatedAt: null,
  };
}

/** Derived view of the league: rosters, money left, who owns whom. */
export function buildState(league, players) {
  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  const ownerOf = {};
  const teams = {};
  for (const t of league.teams) {
    teams[t.id] = { ...t, picks: [], spent: 0 };
  }
  for (const pick of league.picks) {
    ownerOf[pick.player] = pick.team;
    const t = teams[pick.team];
    if (!t) continue;
    t.picks.push(pick);
    t.spent += pick.salary;
  }
  for (const t of Object.values(teams)) {
    t.left = league.cap - t.spent;
    t.open = openSlots(league, t.picks);
    t.full = t.open.length === 0;
    t.roster = rosterBySlot(league, t.picks, byId);
  }
  return { byId, ownerOf, teams };
}

export function openSlots(league, picks) {
  const open = [...slotsFor(league)];
  for (const p of picks) {
    const i = open.indexOf(p.slot);
    if (i >= 0) open.splice(i, 1);
  }
  return open;
}

function rosterBySlot(league, picks, byId) {
  const remaining = [...picks];
  return slotsFor(league).map((slot) => {
    const i = remaining.findIndex((p) => p.slot === slot);
    if (i < 0) return { slot, pick: null, player: null };
    const [pick] = remaining.splice(i, 1);
    return { slot, pick, player: byId[pick.player] ?? null };
  });
}

/** Which open spot a player would fill: their own position first, then Flex. */
export function slotFor(open, pos) {
  if (open.includes(pos)) return pos;
  if (FLEX_POSITIONS.includes(pos) && open.includes('FLEX')) return 'FLEX';
  return null;
}

export function isLocked(player, nowMs) {
  return Date.parse(player.kickoff) <= nowMs;
}

/** Cheapest way to fill the given open spots from the given players (Infinity if impossible). */
export function cheapestFill(open, pool) {
  const order = ['QB', 'K', 'DEF', 'TE', 'RB', 'WR', 'FLEX'];
  const slots = [...open].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const used = new Set();
  const sorted = [...pool].sort((a, b) => a.salary - b.salary);
  let total = 0;
  for (const slot of slots) {
    const p = sorted.find(
      (x) => !used.has(x.id) && (x.pos === slot || (slot === 'FLEX' && FLEX_POSITIONS.includes(x.pos))),
    );
    if (!p) return Infinity;
    used.add(p.id);
    total += p.salary;
  }
  return total;
}

export function onClock(league) {
  if (league.status !== 'drafting' || !league.order.length) return null;
  const id = league.order[snakeIndex(league.turn, league.order.length)];
  return league.teams.find((t) => t.id === id) ?? null;
}

/** Can this team legally take this player right now? Returns {ok, slot} or {ok:false, error}. */
export function checkPick(league, players, teamId, playerId, nowMs, state = buildState(league, players)) {
  const team = state.teams[teamId];
  const player = state.byId[playerId];
  if (!team) return { ok: false, error: 'That team is not in the league.' };
  if (!player) return { ok: false, error: 'That player is not in the Thanksgiving player pool.' };
  if (state.ownerOf[playerId]) {
    const owner = state.teams[state.ownerOf[playerId]];
    return { ok: false, error: `${player.name} is already on ${owner?.name ?? 'another team'}.`, reason: 'taken' };
  }
  if (isLocked(player, nowMs)) {
    return { ok: false, error: `${player.name}'s game has already kicked off, so he's locked.`, reason: 'locked' };
  }
  const slot = slotFor(team.open, player.pos);
  if (!slot) {
    return { ok: false, error: `${team.name} has no open spot for a ${POS_LABEL[player.pos]}.`, reason: 'nospot' };
  }
  if (player.salary > team.left) {
    return { ok: false, error: `${player.name} costs $${player.salary} and ${team.name} only has $${team.left} left.`, reason: 'budget' };
  }
  const openAfter = [...team.open];
  openAfter.splice(openAfter.indexOf(slot), 1);
  const pool = players.filter((p) => p.id !== playerId && !state.ownerOf[p.id] && !isLocked(p, nowMs));
  const need = cheapestFill(openAfter, pool);
  const leftAfter = team.left - player.salary;
  if (need > leftAfter) {
    const spots = openAfter.map((s) => POS_LABEL[s]).join(', ');
    const needText = Number.isFinite(need) ? `the cheapest way to fill them costs $${need}` : 'there are not enough players left to fill them';
    return {
      ok: false,
      error: `After ${player.name} you'd have $${leftAfter} left for ${spots}, but ${needText}.`,
      reason: 'reserve',
    };
  }
  return { ok: true, slot, player, team, leftAfter };
}

/** Most a team can spend on its next pick and still fill every other spot. */
export function maxBid(league, players, teamId, nowMs, state = buildState(league, players)) {
  let best = -1;
  for (const p of players) {
    const r = checkPick(league, players, teamId, p.id, nowMs, state);
    if (r.ok && p.salary > best) best = p.salary;
  }
  return best;
}

function canPickAnything(league, players, teamId, nowMs, state) {
  if (state.teams[teamId].full) return false;
  return players.some((p) => checkPick(league, players, teamId, p.id, nowMs, state).ok);
}

/** Move the clock past teams that are full or have nothing they can afford. */
export function advance(league, players, nowMs) {
  if (league.status !== 'drafting') return league;
  const n = league.order.length;
  const limit = slotsFor(league).length * n * 3;
  while (league.turn < limit) {
    const state = buildState(league, players);
    const live = league.teams.filter((t) => canPickAnything(league, players, t.id, nowMs, state));
    if (!live.length) break;
    const team = onClock(league);
    if (live.some((t) => t.id === team.id)) return league;
    if (!state.teams[team.id].full) {
      league.passes.push({ turn: league.turn, team: team.id, at: new Date(nowMs).toISOString() });
    }
    league.turn += 1;
  }
  league.status = 'complete';
  league.completedAt = new Date(nowMs).toISOString();
  return league;
}

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startDraft(league, players, nowMs, rng) {
  league.order = shuffle(league.teams.map((t) => t.id), rng);
  league.status = 'drafting';
  league.turn = 0;
  league.picks = [];
  league.passes = [];
  league.startedAt = new Date(nowMs).toISOString();
  league.completedAt = null;
  advance(league, players, nowMs);
}

/** Turn an issue title into a command, e.g. "PICK: Josh Allen #3918298". */
export function parseCommand(title) {
  const m = /^\s*(join|add|kick|pick|undo|reset)\b\s*:?\s*(.*)$/i.exec(title ?? '');
  if (!m) return null;
  return { kind: m[1].toLowerCase(), arg: m[2].trim() };
}

export function findPlayer(players, arg) {
  const idMatch = /#\s*([A-Za-z0-9-]+)\s*$/.exec(arg) ?? /\[([A-Za-z0-9-]+)\]/.exec(arg);
  if (idMatch) {
    const p = players.find((x) => x.id === idMatch[1]);
    if (p) return p;
  }
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9/ ]/g, '').replace(/\s+/g, ' ').trim();
  const q = norm(arg.replace(/#.*$/, '').replace(/\(.*?\)/g, ''));
  if (!q) return null;
  const exact = players.filter((p) => norm(p.name) === q);
  if (exact.length === 1) return exact[0];
  const partial = players.filter((p) => norm(p.name).includes(q));
  return partial.length === 1 ? partial[0] : null;
}

function teamByName(league, name) {
  const q = name.trim().toLowerCase();
  return league.teams.find((t) => t.name.toLowerCase() === q) ?? null;
}

function cleanName(s) {
  return s.replace(/[<>`*_~\[\]@#]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32);
}

function mention(league, team) {
  return team.owner ? `@${team.owner}` : `@${league.commissioner} (picking for ${team.name})`;
}

export function clockMessage(league) {
  if (league.status === 'complete') return 'The draft is complete. Enjoy the games!';
  const t = onClock(league);
  if (!t) return '';
  const pickNo = league.picks.length + 1;
  return `Pick ${pickNo}: ${t.name} is on the clock, ${mention(league, t)}.`;
}

/**
 * Apply one command from a GitHub issue. Mutates and returns the league.
 * cmd = { kind, arg, author, atMs }
 * Returns { ok, message }.
 */
export function applyCommand(league, players, cmd, rng = Math.random) {
  const { kind, arg, author, atMs } = cmd;
  const isCommish = sameUser(author, league.commissioner);
  const own = league.teams.find((t) => sameUser(t.owner, author));
  const fail = (message) => ({ ok: false, message });
  const done = (message) => {
    league.updatedAt = new Date(atMs).toISOString();
    return { ok: true, message };
  };

  if (kind === 'join' || kind === 'add') {
    let name = arg;
    let owner = author;
    if (kind === 'add') {
      if (!isCommish) return fail(`Only the commissioner (@${league.commissioner}) can add teams.`);
      const at = /\s@([A-Za-z0-9-]+)\s*$/.exec(` ${arg}`);
      owner = at ? at[1] : null;
      name = at ? arg.slice(0, arg.lastIndexOf('@')).trim() : arg;
    }
    name = cleanName(name);
    const existing = owner ? league.teams.find((t) => sameUser(t.owner, owner)) : null;
    if (existing) {
      if (!name) return fail('Add a team name after JOIN:, for example "JOIN: Gravy Train".');
      if (teamByName(league, name) && teamByName(league, name) !== existing) return fail(`There's already a team called ${name}.`);
      const old = existing.name;
      existing.name = name;
      return done(`Renamed ${old} to ${name}.`);
    }
    if (league.status !== 'signup') return fail('The draft has already started, so the league is closed.');
    if (league.teams.length >= league.maxTeams) return fail(`The league is full (${league.maxTeams} teams).`);
    if (!name) name = owner ? `${owner}'s team` : `Team ${league.teams.length + 1}`;
    if (teamByName(league, name)) return fail(`There's already a team called ${name}. Pick another name.`);
    const team = { id: `t${league.teams.length + 1}`, name, owner, color: TEAM_COLORS[league.teams.length % TEAM_COLORS.length] };
    league.teams.push(team);
    let message = `${name} joined the Turkey Bowl${owner ? ` (@${owner})` : ' (the commissioner drafts for this team)'}.`;
    const seats = league.maxTeams - league.teams.length;
    if (seats > 0) {
      message += ` ${seats} seat${seats === 1 ? '' : 's'} left.`;
    } else {
      startDraft(league, players, atMs, rng);
      const order = league.order.map((id, i) => `${i + 1}. ${league.teams.find((t) => t.id === id).name}`).join('\n');
      message += `\n\nThe league is full, so the draft is open. Snake order:\n${order}\n\n${clockMessage(league)}`;
    }
    return done(message);
  }

  if (kind === 'kick') {
    if (!isCommish) return fail('Only the commissioner can remove teams.');
    if (league.status !== 'signup') return fail('Teams can only be removed before the draft starts. Use RESET first.');
    const t = teamByName(league, arg);
    if (!t) return fail(`No team called ${arg}.`);
    league.teams = league.teams.filter((x) => x !== t).map((x, i) => ({ ...x, id: `t${i + 1}`, color: TEAM_COLORS[i % TEAM_COLORS.length] }));
    return done(`Removed ${t.name}.`);
  }

  if (kind === 'reset') {
    if (!isCommish) return fail('Only the commissioner can reset the draft.');
    if (/^(all|league|everything)$/i.test(arg)) {
      Object.assign(league, { status: 'signup', teams: [], order: [], turn: 0, picks: [], passes: [], startedAt: null, completedAt: null });
      return done('League wiped. All teams and picks are gone and every seat is open again.');
    }
    if (league.teams.length >= league.maxTeams) {
      startDraft(league, players, atMs, rng);
      const order = league.order.map((id, i) => `${i + 1}. ${league.teams.find((t) => t.id === id).name}`).join('\n');
      return done(`Draft reset with a fresh random order:\n${order}\n\n${clockMessage(league)}`);
    }
    Object.assign(league, { status: 'signup', order: [], turn: 0, picks: [], passes: [], startedAt: null, completedAt: null });
    return done('Draft reset. Waiting for the league to fill up.');
  }

  if (kind === 'undo') {
    if (!isCommish) return fail('Only the commissioner can undo a pick.');
    const last = league.picks.pop();
    if (!last) return fail('There are no picks to undo.');
    league.turn = last.turn;
    league.passes = league.passes.filter((p) => p.turn < last.turn);
    league.status = 'drafting';
    league.completedAt = null;
    const p = players.find((x) => x.id === last.player);
    return done(`Undid pick ${league.picks.length + 1}: ${p?.name ?? last.player} is back in the pool.\n\n${clockMessage(league)}`);
  }

  if (kind === 'pick') {
    if (league.status === 'signup') return fail('The draft starts once all 3 teams have joined.');
    if (league.status === 'complete') return fail('The draft is already complete.');
    advance(league, players, atMs);
    if (league.status === 'complete') return fail('The draft is already complete.');
    const team = onClock(league);
    if (!sameUser(team.owner, author) && !isCommish) {
      if (!own) return fail(`You're not in this league. It's ${team.name}'s turn.`);
      return fail(`It's not your turn. ${team.name} is on the clock.`);
    }
    const player = findPlayer(players, arg);
    if (!player) return fail(`I couldn't find "${arg}" in the Thanksgiving player pool. Use the Draft button on the website so the name matches exactly.`);
    const r = checkPick(league, players, team.id, player.id, atMs);
    if (!r.ok) return fail(r.error);
    league.picks.push({
      n: league.picks.length + 1,
      turn: league.turn,
      team: team.id,
      player: player.id,
      slot: r.slot,
      salary: player.salary,
      by: author,
      at: new Date(atMs).toISOString(),
    });
    league.turn += 1;
    advance(league, players, atMs);
    const forText = sameUser(team.owner, author) ? '' : ` (entered by the commissioner)`;
    const msg = `${team.name} drafts ${player.name} (${player.team} ${POS_LABEL[player.pos]}) for $${player.salary} at ${POS_LABEL[r.slot]}${forText}. $${r.leftAfter} left.`;
    return done(`${msg}\n\n${clockMessage(league)}`);
  }

  return fail('Unknown command.');
}
