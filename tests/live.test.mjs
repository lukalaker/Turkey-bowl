import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fold, sha256, seededRng } from '../assets/live.js';
import { onClock, buildState, checkPick } from '../assets/engine.js?v=dev';

const { players } = JSON.parse(readFileSync(new URL('../data/players.json', import.meta.url)));
const BASE = { repo: 'o/r' };
let clock = Date.parse('2026-11-26T15:00:00Z');
let n = 0;
const ev = (e) => [`-E${String(++n).padStart(6, '0')}`, { at: (clock += 1000), ...e }];
const toMap = (list) => Object.fromEntries(list);

async function setup() {
  const pin = await sha256('tb-pin:4321');
  const keys = { drew: await sha256('k1'), aunt: await sha256('k2'), cousin: await sha256('k3') };
  const list = [
    ev({ type: 'setpin', pin }),
    ev({ type: 'join', by: 'Drew', arg: 'Gravy Train', key: keys.drew }),
    ev({ type: 'join', by: 'Aunt Kay', arg: 'Stuffing Stars', key: keys.aunt }),
    ev({ type: 'join', by: 'Cousin Lee', arg: 'Pie Hards', key: keys.cousin }),
  ];
  return { pin, keys, list };
}

test('first PIN wins; nobody can overwrite it', async () => {
  const { pin, list } = await setup();
  list.push(ev({ type: 'setpin', pin: await sha256('tb-pin:0000') }));
  const { league, results } = fold(toMap(list), players, BASE);
  assert.equal(league.pinHash, pin);
  assert.equal(results[list.at(-1)[0]].ok, false);
});

test('joining from a phone ties the team to that phone; names cannot be reused', async () => {
  const { keys, list } = await setup();
  list.push(ev({ type: 'join', by: 'drew', arg: 'Impostors', key: await sha256('k9') }));
  list.push(ev({ type: 'join', by: 'Drew', arg: 'Gravy Boat', key: keys.drew })); // same phone renames
  const { league, results } = fold(toMap(list), players, BASE);
  assert.equal(league.teams.length, 3);
  assert.equal(results[list.at(-2)[0]].ok, false);
  assert.equal(league.teams.find((t) => t.keyHash === keys.drew).name, 'Gravy Boat');
});

test('only the commissioner can start, and the spun order is the same on every phone', async () => {
  const { pin, list } = await setup();
  list.push(ev({ type: 'start', seed: 12345, pin: 'wrong' }));
  list.push(ev({ type: 'start', seed: 12345, pin }));
  const a = fold(toMap(list), players, BASE);
  const b = fold(toMap(list), players, BASE);
  assert.equal(a.results[list.at(-2)[0]].ok, false);
  assert.equal(a.results[list.at(-1)[0]].ok, true);
  assert.equal(a.league.status, 'drafting');
  assert.deepEqual(a.league.order, b.league.order);
  // different seeds give different orders often enough
  const orders = new Set();
  for (let s = 1; s <= 30; s++) {
    const l2 = [...list.slice(0, -2), ev({ type: 'start', seed: s * 7919, pin })];
    orders.add(fold(toMap(l2), players, BASE).league.order.join());
  }
  assert.ok(orders.size >= 4, `${orders.size} distinct orders`);
});

test("picks only count from the phone that's on the clock, or the commissioner", async () => {
  const { pin, keys, list } = await setup();
  list.push(ev({ type: 'start', seed: 99, pin }));
  let { league } = fold(toMap(list), players, BASE);
  const up = onClock(league);
  const upKey = Object.values(keys).find((k) => k === up.keyHash);
  const otherKey = Object.values(keys).find((k) => k !== up.keyHash);
  const gibbs = players.find((p) => p.name === 'Jahmyr Gibbs');
  list.push(ev({ type: 'pick', player: gibbs.id, key: otherKey })); // wrong phone
  list.push(ev({ type: 'pick', player: gibbs.id, key: upKey })); // right phone
  ({ league } = fold(toMap(list), players, BASE));
  const r = fold(toMap(list), players, BASE).results;
  assert.equal(r[list.at(-2)[0]].ok, false);
  assert.match(r[list.at(-2)[0]].message, /not your turn/);
  assert.equal(r[list.at(-1)[0]].ok, true);
  assert.equal(league.picks[0].team, up.id);
  // the commissioner can pick for whoever is up next
  const next = onClock(league);
  const allen = players.find((p) => p.name === 'Josh Allen');
  list.push(ev({ type: 'pick', player: allen.id, pin }));
  ({ league } = fold(toMap(list), players, BASE));
  assert.equal(league.picks[1].team, next.id);
});

test('two phones tapping the same player at once: the first to reach the database gets him', async () => {
  const { pin, keys, list } = await setup();
  list.push(ev({ type: 'start', seed: 5, pin }));
  let { league } = fold(toMap(list), players, BASE);
  const up = onClock(league);
  const allen = players.find((p) => p.name === 'Josh Allen');
  // commissioner and the on-clock phone both submit Josh Allen
  list.push(ev({ type: 'pick', player: allen.id, key: up.keyHash }));
  list.push(ev({ type: 'pick', player: allen.id, pin }));
  const { league: L2, results } = fold(toMap(list), players, BASE);
  assert.equal(results[list.at(-2)[0]].ok, true);
  assert.equal(results[list.at(-1)[0]].ok, false);
  assert.equal(L2.picks.filter((p) => p.player === allen.id).length, 1);
});

test('undo and reset need the PIN', async () => {
  const { pin, list } = await setup();
  list.push(ev({ type: 'start', seed: 5, pin }));
  const up = onClock(fold(toMap(list), players, BASE).league);
  list.push(ev({ type: 'pick', player: players[0].id, key: up.keyHash }));
  list.push(ev({ type: 'undo', key: up.keyHash }));
  let r = fold(toMap(list), players, BASE);
  assert.equal(r.league.picks.length, 1);
  list.push(ev({ type: 'undo', pin }));
  r = fold(toMap(list), players, BASE);
  assert.equal(r.league.picks.length, 0);
  list.push(ev({ type: 'reset', arg: 'all', pin }));
  r = fold(toMap(list), players, BASE);
  assert.equal(r.league.teams.length, 0);
  assert.equal(r.league.pinHash, pin, 'reset keeps the commissioner');
});

test('a whole draft played as events ends with full, legal rosters', async () => {
  const { pin, list } = await setup();
  list.push(ev({ type: 'start', seed: 2026, pin }));
  const at = Date.parse('2026-11-26T15:00:00Z');
  for (let i = 0; i < 40; i++) {
    const { league } = fold(toMap(list), players, BASE);
    if (league.status !== 'drafting') break;
    const t = onClock(league);
    const st = buildState(league, players);
    const choice = [...players].sort((a, b) => b.proj - a.proj).find((p) => checkPick(league, players, t.id, p.id, at, st).ok);
    list.push(ev({ type: 'pick', player: choice.id, key: t.keyHash }));
  }
  const { league } = fold(toMap(list), players, BASE);
  assert.equal(league.status, 'complete');
  const st = buildState(league, players);
  for (const t of Object.values(st.teams)) {
    assert.equal(t.picks.length, 9);
    assert.ok(t.spent <= 100);
  }
});

test('seeded random numbers repeat exactly', () => {
  const a = seededRng(42);
  const b = seededRng(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

import { newLeague, applyCommand } from '../assets/engine.js?v=dev';

function githubLeague() {
  // the league as the old GitHub version left it: 3 teams, draft started, 1 pick
  const L = newLeague({ commissioner: 'lukalaker', repo: 'o/r' });
  const at = Date.parse('2026-11-26T02:45:00Z');
  const run = (k, a, u) => applyCommand(L, players, { kind: k, arg: a, author: u, atMs: at }, () => 0.3);
  run('join', 'Winner', 'lukalaker');
  run('join', 'Austin', 'austinpaxton');
  run('join', 'Big Daddy', 'razorback1000');
  run('start', '', 'lukalaker');
  const lamb = players.find((p) => p.name === 'CeeDee Lamb');
  run('pick', `x #${lamb.id}`, 'lukalaker');
  return L;
}

test('carrying the GitHub league over keeps teams, names, order and picks', async () => {
  const old = githubLeague();
  // Firebase drops empty lists, so simulate that
  const stored = JSON.parse(JSON.stringify(old));
  delete stored.passes;
  const list = [ev({ type: 'import', league: stored })];
  const { league, results } = fold(toMap(list), players, BASE);
  assert.equal(results[list[0][0]].ok, true);
  assert.deepEqual(league.teams.map((t) => `${t.name}/${t.owner}`), ['Winner/lukalaker', 'Austin/austinpaxton', 'Big Daddy/razorback1000']);
  assert.deepEqual(league.order, old.order);
  assert.equal(league.picks.length, 1);
  assert.equal(league.status, 'drafting');
  assert.equal(onClock(league).id, onClock(old).id, 'same team on the clock');
  assert.deepEqual(league.passes, []);
});

test('import only works as the very first event', async () => {
  const { list } = await setup();
  list.push(ev({ type: 'import', league: githubLeague() }));
  const { league, results } = fold(toMap(list), players, BASE);
  assert.equal(results[list.at(-1)[0]].ok, false);
  assert.deepEqual(league.teams.map((t) => t.name), ['Gravy Train', 'Stuffing Stars', 'Pie Hards']);
});

test('family members claim their carried-over teams and keep drafting from their phones', async () => {
  const pin = await sha256('tb-pin:2468');
  const k = { drew: await sha256('a'), austin: await sha256('b'), big: await sha256('c'), stranger: await sha256('d') };
  const list = [ev({ type: 'import', league: githubLeague() }), ev({ type: 'setpin', pin })];
  list.push(ev({ type: 'claim', team: 't1', key: k.drew }));
  list.push(ev({ type: 'claim', team: 't2', key: k.austin }));
  list.push(ev({ type: 'claim', team: 't3', key: k.big }));
  list.push(ev({ type: 'claim', team: 't3', key: k.stranger })); // already claimed
  list.push(ev({ type: 'claim', team: 't2', key: k.drew })); // drew's phone already has a team
  let r = fold(toMap(list), players, BASE);
  assert.equal(r.results[list.at(-2)[0]].ok, false);
  assert.equal(r.results[list.at(-1)[0]].ok, false);
  assert.equal(r.league.teams.find((t) => t.id === 't3').keyHash, k.big);
  // whoever is on the clock picks from their own phone
  const up = onClock(r.league);
  const key = { t1: k.drew, t2: k.austin, t3: k.big }[up.id];
  const allen = players.find((p) => p.name === 'Josh Allen');
  list.push(ev({ type: 'pick', player: allen.id, key }));
  r = fold(toMap(list), players, BASE);
  assert.equal(r.results[list.at(-1)[0]].ok, true, r.results[list.at(-1)[0]].message);
  assert.equal(r.league.picks.length, 2);
  // the commissioner can release a team so another phone can claim it
  list.push(ev({ type: 'unclaim', team: 't3', key: k.austin })); // not the commissioner
  list.push(ev({ type: 'unclaim', team: 't3', pin }));
  list.push(ev({ type: 'claim', team: 't3', key: k.stranger }));
  r = fold(toMap(list), players, BASE);
  assert.equal(r.results[list.at(-3)[0]].ok, false);
  assert.equal(r.league.teams.find((t) => t.id === 't3').keyHash, k.stranger);
});
