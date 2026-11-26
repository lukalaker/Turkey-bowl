import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  newLeague,
  applyCommand,
  buildState,
  onClock,
  checkPick,
  parseCommand,
  findPlayer,
  snakeIndex,
  cheapestFill,
  maxBid,
} from '../assets/engine.js';

const { players } = JSON.parse(readFileSync(new URL('../data/players.json', import.meta.url)));
const BEFORE = Date.parse('2026-11-26T15:00:00Z'); // morning, before any kickoff
const rngFixed = () => 0; // shuffle keeps a predictable order

function league3() {
  const L = newLeague({ commissioner: 'commish', repo: 'o/r' });
  const run = (kind, arg, author) => applyCommand(L, players, { kind, arg, author, atMs: BEFORE }, rngFixed);
  run('join', 'Gravy Train', 'commish');
  run('join', 'Stuffing Stars', 'aunt');
  const r = run('join', 'Pie Hards', 'cousin');
  return { L, run, r };
}

const byName = (name) => players.find((p) => p.name === name);

test('parses issue titles', () => {
  assert.deepEqual(parseCommand('PICK: Josh Allen #3918298'), { kind: 'pick', arg: 'Josh Allen #3918298' });
  assert.deepEqual(parseCommand('join: Gravy Train'), { kind: 'join', arg: 'Gravy Train' });
  assert.deepEqual(parseCommand('Undo'), { kind: 'undo', arg: '' });
  assert.equal(parseCommand('Question about scoring'), null);
});

test('finds players by id or by name', () => {
  const allen = byName('Josh Allen');
  assert.equal(findPlayer(players, `Josh Allen (BUF QB) #${allen.id}`).id, allen.id);
  assert.equal(findPlayer(players, 'josh allen').id, allen.id);
  assert.equal(findPlayer(players, 'Nobody Atall'), null);
});

test('snake order goes 1-2-3-3-2-1', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((t) => snakeIndex(t, 3)), [0, 1, 2, 2, 1, 0, 0]);
});

test('three joins fill the league and open the draft', () => {
  const { L, r } = league3();
  assert.equal(L.status, 'drafting');
  assert.equal(L.teams.length, 3);
  assert.match(r.message, /draft is open/);
  assert.ok(onClock(L));
});

test('a fourth join is turned away', () => {
  const { run } = league3();
  const r = run('join', 'Late Plate', 'uncle');
  assert.equal(r.ok, false);
});

test('joining again renames your team', () => {
  const L = newLeague({ commissioner: 'commish', repo: 'o/r' });
  applyCommand(L, players, { kind: 'join', arg: 'One', author: 'aunt', atMs: BEFORE });
  const r = applyCommand(L, players, { kind: 'join', arg: 'Two', author: 'aunt', atMs: BEFORE });
  assert.ok(r.ok);
  assert.equal(L.teams.length, 1);
  assert.equal(L.teams[0].name, 'Two');
});

test('players are exclusive: once taken, nobody else can draft them', () => {
  const { L, run } = league3();
  const first = onClock(L);
  const gibbs = byName('Jahmyr Gibbs');
  const r1 = run('pick', `Jahmyr Gibbs #${gibbs.id}`, first.owner);
  assert.ok(r1.ok, r1.message);
  const second = onClock(L);
  assert.notEqual(second.id, first.id);
  const r2 = run('pick', `Jahmyr Gibbs #${gibbs.id}`, second.owner);
  assert.equal(r2.ok, false);
  assert.match(r2.message, /already on/);
});

test('only the team on the clock can pick (the commissioner can pick for them)', () => {
  const { L, run } = league3();
  const clock = onClock(L);
  const other = L.teams.find((t) => t.id !== clock.id && t.owner !== 'commish');
  const r = run('pick', 'Josh Allen', other.owner);
  assert.equal(r.ok, false);
  assert.match(r.message, /not your turn/);
  const r2 = run('pick', 'Josh Allen', 'commish');
  assert.ok(r2.ok, r2.message);
  assert.equal(L.picks[0].team, clock.id);
});

test('strangers cannot pick', () => {
  const { run } = league3();
  const r = run('pick', 'Josh Allen', 'randomperson');
  assert.equal(r.ok, false);
  assert.match(r.message, /not in this league/);
});

test('a second QB goes to... nowhere (QB has no flex)', () => {
  const { L, run } = league3();
  const t = onClock(L);
  run('pick', 'Josh Allen', t.owner);
  run('pick', 'Jared Goff', onClock(L).owner);
  run('pick', 'Dak Prescott', onClock(L).owner);
  // snake: third team picks again
  const again = onClock(L);
  const r = run('pick', 'Patrick Mahomes', again.owner);
  assert.equal(r.ok, false);
  assert.match(r.message, /no open spot/);
});

test('a third RB fills the Flex spot', () => {
  const { L } = league3();
  const t = onClock(L);
  const s0 = buildState(L, players);
  // fake two RBs already on the roster
  L.picks.push({ n: 1, turn: 0, team: t.id, player: byName('Saquon Barkley').id, slot: 'RB', salary: 13 });
  L.picks.push({ n: 2, turn: 1, team: t.id, player: byName("D'Andre Swift").id, slot: 'RB', salary: 12 });
  assert.ok(s0);
  const r = checkPick(L, players, t.id, byName('James Cook III').id, BEFORE);
  assert.ok(r.ok, r.error);
  assert.equal(r.slot, 'FLEX');
});

test('budget: cannot spend so much that the other spots cannot be filled', () => {
  const { L } = league3();
  const t = onClock(L);
  // Pretend this team already spent $79 on four stars, leaving $21 for QB, TE, Flex, K, D/ST
  const fake = ['Jahmyr Gibbs', 'Emmett Johnson', 'Amon-Ra St. Brown', 'CeeDee Lamb'];
  const slots = ['RB', 'RB', 'WR', 'WR'];
  fake.forEach((n, i) => L.picks.push({ n: i + 1, turn: i, team: t.id, player: byName(n).id, slot: slots[i], salary: byName(n).salary }));
  const st = buildState(L, players);
  assert.equal(st.teams[t.id].left, 100 - fake.reduce((s, n) => s + byName(n).salary, 0));
  // Caleb Williams ($19) is affordable but would leave $2 for TE + Flex + K + D/ST
  const r = checkPick(L, players, t.id, byName('Caleb Williams').id, BEFORE);
  assert.equal(r.ok, false);
  assert.match(r.error, /cheapest way to fill/);
  const mb = maxBid(L, players, t.id, BEFORE);
  assert.ok(mb > 0 && mb < 19, `max bid ${mb}`);
});

test('players lock once their game kicks off', () => {
  const { L } = league3();
  const t = onClock(L);
  const afterEarly = Date.parse('2026-11-26T18:05:00Z');
  const r = checkPick(L, players, t.id, byName('Jared Goff').id, afterEarly);
  assert.equal(r.ok, false);
  assert.match(r.error, /kicked off/);
  const r2 = checkPick(L, players, t.id, byName('Josh Allen').id, afterEarly);
  assert.ok(r2.ok, r2.error);
});

test('undo puts the player back and the same team back on the clock', () => {
  const { L, run } = league3();
  const t = onClock(L);
  run('pick', 'Josh Allen', t.owner);
  const r = run('undo', '', 'commish');
  assert.ok(r.ok);
  assert.equal(L.picks.length, 0);
  assert.equal(onClock(L).id, t.id);
  assert.equal(run('undo', '', t.owner === 'commish' ? 'aunt' : t.owner).ok, false);
});

test('a full draft of best-available picks completes with 9 players each, under budget', () => {
  const { L, run } = league3();
  let guard = 0;
  while (L.status === 'drafting' && guard++ < 100) {
    const t = onClock(L);
    const st = buildState(L, players);
    const choice = [...players]
      .sort((a, b) => b.proj - a.proj)
      .find((p) => checkPick(L, players, t.id, p.id, BEFORE, st).ok);
    const r = run('pick', `${choice.name} #${choice.id}`, t.owner);
    assert.ok(r.ok, r.message);
  }
  assert.equal(L.status, 'complete');
  const st = buildState(L, players);
  for (const t of Object.values(st.teams)) {
    assert.equal(t.picks.length, 9, `${t.name} has ${t.picks.length}`);
    assert.ok(t.spent <= 100, `${t.name} spent ${t.spent}`);
  }
  const ids = L.picks.map((p) => p.player);
  assert.equal(new Set(ids).size, ids.length, 'no player drafted twice');
});

test('cheapestFill handles flex and impossible cases', () => {
  const pool = [
    { id: 'a', pos: 'RB', salary: 2 },
    { id: 'b', pos: 'WR', salary: 3 },
    { id: 'c', pos: 'K', salary: 2 },
  ];
  assert.equal(cheapestFill(['RB', 'FLEX'], pool), 5);
  assert.equal(cheapestFill(['QB'], pool), Infinity);
});

test('reset reshuffles and clears picks', () => {
  const { L, run } = league3();
  run('pick', 'Josh Allen', onClock(L).owner);
  const r = run('reset', '', 'commish');
  assert.ok(r.ok);
  assert.equal(L.picks.length, 0);
  assert.equal(L.status, 'drafting');
});

test('commissioner can add a team for someone without GitHub and picks for them', () => {
  const L = newLeague({ commissioner: 'commish', repo: 'o/r' });
  const run = (kind, arg, author) => applyCommand(L, players, { kind, arg, author, atMs: BEFORE }, rngFixed);
  assert.equal(run('add', 'Grandma', 'aunt').ok, false);
  assert.ok(run('add', 'Grandma', 'commish').ok);
  assert.ok(run('add', 'Uncle Bob @bobgh', 'commish').ok);
  assert.equal(L.teams[1].owner, 'bobgh');
  assert.equal(L.teams[0].owner, null);
  run('join', 'Gravy Train', 'commish');
  assert.equal(L.status, 'drafting');
  const grandma = L.teams[0];
  const cheapFirst = [...players].sort((a, b) => a.salary - b.salary).filter((p) => p.name !== 'Jahmyr Gibbs');
  while (onClock(L).id !== grandma.id) {
    const p = cheapFirst.find((x) => checkPick(L, players, onClock(L).id, x.id, BEFORE).ok);
    assert.ok(run('pick', `${p.name} #${p.id}`, 'commish').ok);
  }
  const r = run('pick', 'Jahmyr Gibbs', 'commish');
  assert.ok(r.ok, r.message);
  assert.match(r.message, /Grandma drafts Jahmyr Gibbs/);
});

test('RESET ALL wipes test teams and picks back to an empty league', () => {
  const { L, run } = league3();
  run('pick', 'Josh Allen', onClock(L).owner);
  assert.equal(run('reset', 'all', 'aunt').ok, false);
  const r = run('reset', 'ALL', 'commish');
  assert.ok(r.ok, r.message);
  assert.equal(L.status, 'signup');
  assert.equal(L.teams.length, 0);
  assert.equal(L.picks.length, 0);
  assert.ok(run('join', 'Gravy Train', 'commish').ok);
});
