import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoreSummary, paPoints, pointsFor } from '../assets/scoring.js';

const final = JSON.parse(readFileSync(new URL('./fixtures/tb-at-det-final.json', import.meta.url)));
const pregame = JSON.parse(readFileSync(new URL('./fixtures/chi-at-det-pregame.json', import.meta.url)));

test('scores quarterbacks: passing, rushing, no turnovers', () => {
  const s = scoreSummary(final);
  assert.equal(s.state, 'post');
  // Mayfield: 187 pass yds (7.48) + 2 pass TD (8) + 36 rush yds (3.6)
  assert.equal(s.players['3052587'].pts, 19.08);
  // Goff: 279 pass yds (11.16) + 2 pass TD (8) + 12 rush yds (1.2)
  assert.equal(s.players['3046779'].pts, 20.36);
});

test('scores PPR receptions and touchdowns', () => {
  const s = scoreSummary(final);
  // Gibbs: 98 rush (9.8) + 2 rush TD (12) + 4 rec (4) + 20 rec yds (2)
  assert.equal(s.players['4429795'].pts, 27.8);
  // St. Brown: 5 rec + 37 yds + 1 TD
  assert.equal(s.players['4374302'].pts, 14.7);
  assert.match(s.players['4374302'].line, /5 rec, 37 yds/);
});

test('kickers score their real points', () => {
  const s = scoreSummary(final);
  assert.equal(s.players['4689936'].pts, 7); // 1 FG + 4 XP
});

test('defenses: sacks, turnovers and points allowed', () => {
  const s = scoreSummary(final);
  // DET allowed 21 (0 pts) and had 4 sacks
  assert.equal(s.dst.DET.pts, 4);
  // TB allowed 31 (-1) and had 1 sack
  assert.equal(s.dst.TB.pts, 0);
});

test('points-allowed tiers', () => {
  assert.equal(paPoints(0), 10);
  assert.equal(paPoints(3), 7);
  assert.equal(paPoints(7), 4);
  assert.equal(paPoints(17), 1);
  assert.equal(paPoints(24), 0);
  assert.equal(paPoints(31), -1);
  assert.equal(paPoints(45), -4);
});

test('pregame summaries give no points (and no free shutout points)', () => {
  const s = scoreSummary(pregame);
  assert.equal(s.state, 'pre');
  assert.deepEqual(s.players, {});
  assert.deepEqual(s.dst, {});
  const games = { '401873081': s };
  assert.equal(pointsFor({ id: 'DEF-DET', pos: 'DEF', team: 'DET', game: '401873081' }, games), null);
});

test('a rostered player with no stats in a live game scores 0', () => {
  const s = scoreSummary(final);
  const games = { x: s };
  assert.deepEqual(pointsFor({ id: 'nobody', pos: 'WR', team: 'DET', game: 'x' }, games), { pts: 0, line: 'No stats yet', breakdown: [] });
});

test('every player and defense gets a line-by-line breakdown that adds up', () => {
  const s = scoreSummary(final);
  const gibbs = s.players['4429795'];
  assert.deepEqual(gibbs.breakdown, [
    { label: 'Rushing yards', detail: '98 yds × 0.1', pts: 9.8 },
    { label: 'Rushing TDs', detail: '2 × 6', pts: 12 },
    { label: 'Receptions', detail: '4 × 1', pts: 4 },
    { label: 'Receiving yards', detail: '20 yds × 0.1', pts: 2 },
  ]);
  for (const p of [...Object.values(s.players), ...Object.values(s.dst)]) {
    const sum = Math.round(p.breakdown.reduce((a, b) => a + b.pts, 0) * 100) / 100;
    assert.ok(Math.abs(sum - p.pts) < 0.011, `${p.line}: ${sum} vs ${p.pts}`);
  }
  assert.deepEqual(s.dst.DET.breakdown[0], { label: 'Points allowed', detail: '21 (21-27 tier)', pts: 0 });
  assert.deepEqual(s.dst.DET.breakdown[1], { label: 'Sacks', detail: '4 × 1', pts: 4 });
});
