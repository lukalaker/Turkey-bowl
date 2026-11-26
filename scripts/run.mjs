// The Turkey Bowl bot. Runs inside GitHub Actions.
// Picks now happen live on the website (Firebase), so issue commands are only
// processed when LEAGUE_FROM_ISSUES=1 (the old GitHub-issue mode).
// During game windows it pulls ESPN box scores into data/scores.json, a backup
// the website uses if it can't reach ESPN itself.
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { applyCommand, parseCommand, buildState, clockMessage } from '../assets/engine.js';
import { scoreSummary, fetchSummary } from '../assets/scoring.js';

const root = new URL('../', import.meta.url);
const path = (p) => new URL(p, root);
const readJSON = async (p) => JSON.parse(await readFile(path(p), 'utf8'));
const writeJSON = (p, v) => writeFile(path(p), JSON.stringify(v, null, 2) + '\n');

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const api = async (method, url, body) => {
  const res = await fetch(`https://api.github.com/repos/${repo}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${url}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};

const rng = () => randomInt(0, 2 ** 32) / 2 ** 32;
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] }).toString();

async function processIssues(league, players) {
  if (!token || !repo) {
    console.log('No GITHUB_TOKEN/GITHUB_REPOSITORY; skipping issues.');
    return [];
  }
  const issues = await api('GET', '/issues?state=open&sort=created&direction=asc&per_page=100');
  const replies = [];
  for (const issue of issues) {
    if (issue.pull_request || issue.user?.type === 'Bot') continue;
    const cmd = parseCommand(issue.title);
    if (!cmd) continue;
    const atMs = Date.parse(issue.created_at);
    let result;
    try {
      result = applyCommand(league, players, { ...cmd, author: issue.user.login, atMs }, rng);
    } catch (e) {
      console.error(e);
      result = { ok: false, message: `Something went wrong reading this command: ${e.message}` };
    }
    console.log(`#${issue.number} ${issue.title} -> ${result.ok ? 'OK' : 'REJECTED'}: ${result.message}`);
    replies.push({ issue, ...result });
  }
  return replies;
}

async function updateScores(players, nowMs) {
  let scores;
  try {
    scores = await readJSON('data/scores.json');
  } catch {
    scores = { updatedAt: null, games: {} };
  }
  const { games } = await readJSON('data/players.json');
  let changed = false;
  for (const g of games) {
    const kick = Date.parse(g.kickoff);
    const prev = scores.games[g.id];
    if (nowMs < kick - 5 * 60e3) continue; // not started
    if (prev?.state === 'post') continue; // already final
    try {
      const s = scoreSummary(await fetchSummary(g.id));
      if (JSON.stringify(s) !== JSON.stringify(prev)) {
        scores.games[g.id] = s;
        changed = true;
      }
    } catch (e) {
      console.error(`Scores for ${g.short} failed: ${e.message}`);
    }
  }
  if (changed) {
    scores.updatedAt = new Date(nowMs).toISOString();
    await writeJSON('data/scores.json', scores);
  }
  return changed;
}

function commitAndPush(message) {
  git('add', 'data/league.json', 'data/scores.json');
  const staged = git('diff', '--cached', '--name-only').trim();
  if (!staged) return false;
  git('-c', 'user.name=turkey-bowl-bot', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-m', message);
  const branch = process.env.GITHUB_REF_NAME || git('rev-parse', '--abbrev-ref', 'HEAD').trim();
  try {
    git('push', 'origin', `HEAD:refs/heads/${branch}`);
  } catch {
    git('pull', '--rebase', 'origin', branch);
    git('push', 'origin', `HEAD:refs/heads/${branch}`);
  }
  return true;
}

async function main() {
  const nowMs = Date.now();
  const league = await readJSON('data/league.json');
  const { players } = await readJSON('data/players.json');
  if (!league.repo && repo) league.repo = repo;
  const before = JSON.stringify(league);

  const replies = process.env.LEAGUE_FROM_ISSUES === '1' ? await processIssues(league, players) : [];
  const leagueChanged = JSON.stringify(league) !== before;
  if (leagueChanged) await writeJSON('data/league.json', league);
  const scoresChanged = await updateScores(players, nowMs);

  const summary = replies.map((r) => `${r.ok ? 'ok' : 'rejected'} #${r.issue.number}`).join(', ');
  const pushed = leagueChanged || scoresChanged ? commitAndPush(summary ? `League bot: ${summary}` : 'League bot: update scores') : false;

  const site = `https://${repo.split('/')[0].toLowerCase()}.github.io/${repo.split('/')[1]}/`;
  for (const r of replies) {
    const body = `${r.ok ? '✅' : '❌'} ${r.message}\n\n[Open the Turkey Bowl board](${site})`;
    try {
      await api('POST', `/issues/${r.issue.number}/comments`, { body });
      await api('PATCH', `/issues/${r.issue.number}`, { state: 'closed', state_reason: r.ok ? 'completed' : 'not_planned' });
    } catch (e) {
      console.error(`Could not reply to #${r.issue.number}: ${e.message}`);
    }
  }

  const st = buildState(league, players);
  console.log(`Status: ${league.status}. ${clockMessage(league)} Teams: ${Object.values(st.teams).map((t) => `${t.name} ($${t.left} left, ${t.picks.length} picks)`).join('; ')}`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${pushed}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
