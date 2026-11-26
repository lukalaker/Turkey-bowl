import { POS_LABEL, buildState, onClock, checkPick, maxBid, snakeIndex, slotsFor } from './engine.js';
import { scoreSummary, pointsFor, fetchSummary, ESPN_API, RULES } from './scoring.js';

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode: fine */
    }
  },
};

const S = {
  players: [],
  games: [],
  byId: {},
  league: null,
  leagueText: '',
  scored: {}, // gameId -> scoreSummary()
  board: {}, // gameId -> { state, detail, scores: {ABBR: n} }
  tab: null,
  me: store.get('tb.me') || '',
  pos: 'ALL',
  q: '',
  hideTaken: store.get('tb.hideTaken') !== '0',
  pending: null,
  flash: null,
};

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DEF'];
const FILTER_LABEL = { ALL: 'All', FLEX: 'Flex', DEF: 'D/ST' };

/* ---------- helpers ---------- */
const now = () => Date.now();
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const pts = (n) => (Math.round((n ?? 0) * 10) / 10).toFixed(1);
const gameOf = (p) => S.games.find((g) => g.id === p.game);

function repo() {
  if (S.league?.repo) return S.league.repo;
  const owner = location.hostname.split('.')[0];
  const name = location.pathname.split('/').filter(Boolean)[0] ?? 'Turkey-bowl';
  return `${owner}/${name}`;
}
function issueUrl(title, body) {
  return `https://github.com/${repo()}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}
function teamById(id) {
  return S.league?.teams.find((t) => t.id === id) ?? null;
}
function gameState(g) {
  const b = S.board[g.id];
  if (b) return b.state;
  return now() >= Date.parse(g.kickoff) ? 'in' : 'pre';
}
function phase() {
  const L = S.league;
  if (!L) return 'loading';
  const anyStarted = S.games.some((g) => gameState(g) !== 'pre');
  const allFinal = S.games.length && S.games.every((g) => gameState(g) === 'post');
  if (L.picks.length && allFinal) return 'final';
  if (L.picks.length && anyStarted) return 'live';
  return L.status; // signup | drafting | complete
}
function avatar(p) {
  if (p.pos === 'DEF' || !/^\d+$/.test(p.id)) {
    return `<img class="avatar logo" alt="" loading="lazy" src="https://a.espncdn.com/i/teamlogos/nfl/500/${p.team.toLowerCase()}.png">`;
  }
  return `<img class="avatar" alt="" loading="lazy" data-team="${esc(p.team)}" src="https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/${p.id}.png&w=96&h=96&scale=crop">`;
}
function matchup(p) {
  const g = gameOf(p);
  const where = p.home ? 'vs' : '@';
  return `${esc(p.team)} ${where} ${esc(p.opp)}, ${g ? fmtTime(g.kickoff) : ''}`;
}
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 4500);
}

function teamScore(team) {
  let total = 0;
  let toPlay = 0;
  let proj = 0;
  for (const r of team.roster) {
    if (!r.player) continue;
    proj += r.player.proj;
    const pt = pointsFor(r.player, S.scored);
    total += pt?.pts ?? 0;
    if (gameState(gameOf(r.player)) === 'pre') toPlay += 1;
  }
  return { total, toPlay, proj };
}

/* ---------- data ---------- */
async function loadJSON(path) {
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function setLeague(next) {
  const text = JSON.stringify(next);
  if (text === S.leagueText) return false;
  const prev = S.league;
  S.league = next;
  S.leagueText = text;
  if (prev) {
    const fresh = next.picks.slice(prev.picks.length);
    const last = fresh[fresh.length - 1];
    if (last) {
      const p = S.byId[last.player];
      toast(`${teamById(last.team)?.name ?? 'A team'} drafted ${p?.name ?? 'a player'} for $${last.salary}`);
      S.flash = last.player;
    } else if (next.teams.length > prev.teams.length) {
      toast(`${next.teams[next.teams.length - 1].name} joined the league`);
    }
    if (S.pending) {
      const done =
        (S.pending.kind === 'pick' && next.picks.some((x) => x.player === S.pending.player)) ||
        (S.pending.kind === 'join' && next.teams.length > prev.teams.length);
      if (done) {
        S.pending = null;
        $('#sheet').open && $('#sheet').close();
      }
    }
  }
  if (S.me && !teamById(S.me)) S.me = '';
  return true;
}

async function refreshLeague() {
  try {
    if (setLeague(await loadJSON('data/league.json'))) render();
  } catch (e) {
    console.warn(e);
  }
}

function useBackupScores(sc) {
  for (const [id, g] of Object.entries(sc?.games ?? {})) {
    if (S.board[id]?.fromEspn) continue;
    S.scored[id] = g;
    S.board[id] = {
      state: g.state,
      detail: g.detail,
      scores: Object.fromEntries(Object.entries(g.scores ?? {}).map(([k, v]) => [k, v.score])),
    };
  }
}

function scoreboardDate() {
  const first = S.games[0]?.kickoff;
  if (!first) return '';
  return new Date(first).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replaceAll('-', '');
}

async function refreshScores() {
  const t = now();
  const active = S.games.some((g) => t >= Date.parse(g.kickoff) - 15 * 60e3 && S.board[g.id]?.state !== 'post');
  if (!active) return;
  try {
    const res = await fetch(`${ESPN_API}/scoreboard?dates=${scoreboardDate()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`ESPN ${res.status}`);
    const sb = await res.json();
    for (const e of sb.events ?? []) {
      if (!S.games.some((g) => g.id === e.id)) continue;
      const comp = e.competitions[0];
      const wasFinal = S.board[e.id]?.state === 'post' && S.scored[e.id]?.state === 'post';
      S.board[e.id] = {
        fromEspn: true,
        state: e.status.type.state,
        detail: e.status.type.shortDetail,
        scores: Object.fromEntries(comp.competitors.map((c) => [c.team.abbreviation, Number(c.score) || 0])),
      };
      if (e.status.type.state !== 'pre' && !wasFinal) {
        S.scored[e.id] = scoreSummary(await fetchSummary(e.id));
      }
    }
  } catch (e) {
    console.warn('Live scores unavailable, using saved scores', e);
    try {
      useBackupScores(await loadJSON('data/scores.json'));
    } catch {
      /* nothing saved yet */
    }
  }
  render();
}

/* ---------- hero ---------- */
function scoreboardHTML(st, mode) {
  const teams = Object.values(st.teams).map((t) => ({ t, s: teamScore(t) }));
  const val = (x) => (mode === 'proj' ? x.s.proj : x.s.total);
  teams.sort((a, b) => val(b) - val(a));
  const top = teams.length ? val(teams[0]) : 0;
  return `<ol class="scoreboard">${teams
    .map((x, i) => {
      const sub =
        mode === 'proj'
          ? `${x.t.picks.length} of ${slotsFor(S.league).length} players, projected`
          : mode === 'final'
            ? 'Final'
            : x.s.toPlay
              ? `${x.s.toPlay} still to play`
              : 'Everyone has played';
      return `<li class="${val(x) === top && top > 0 ? 'leader' : ''}" data-color="${esc(x.t.color)}">
        <span class="sb-rank">${i + 1}</span>
        <span class="sb-name">${esc(x.t.name)}<small>${sub}</small></span>
        <span class="sb-pts">${pts(val(x))}</span></li>`;
    })
    .join('')}</ol>`;
}

function renderHero() {
  const el = $('#hero-body');
  const L = S.league;
  const ph = phase();
  if (ph === 'loading') return;
  const st = buildState(L, S.players);
  const first = S.games[0];
  if (ph === 'final') {
    const ranked = Object.values(st.teams)
      .map((t) => ({ t, s: teamScore(t) }))
      .sort((a, b) => b.s.total - a.s.total);
    const tied = ranked.length > 1 && Math.abs(ranked[0].s.total - ranked[1].s.total) < 0.005;
    el.innerHTML = `<p class="winner-line">${tied ? 'A tie! Split the pie.' : `🏆 ${esc(ranked[0].t.name)} wins the Turkey Bowl`}</p>${scoreboardHTML(st, 'final')}`;
    return;
  }
  if (ph === 'live') {
    el.innerHTML = scoreboardHTML(st, 'live');
    return;
  }
  if (ph === 'signup') {
    const n = L.teams.length;
    el.innerHTML = `<p class="hero-tagline">Three teams, one day of football, winner takes all. <strong>${n} of ${L.maxTeams}</strong> teams are in. First kickoff ${first ? fmtTime(first.kickoff) : ''}.</p>`;
    return;
  }
  if (ph === 'drafting') {
    const t = onClock(L);
    const team = st.teams[t.id];
    const total = slotsFor(L).length * L.teams.length;
    el.innerHTML = `<div class="clock" data-color="${esc(t.color)}">
      <span class="clock-label">On the clock</span>
      <span class="clock-team"><span class="swatch" style="background:var(--team)"></span>${esc(t.name)}</span>
      <span class="clock-meta">Pick ${L.picks.length + 1} of ${total}. $${team.left} to spend on ${team.open.length} spot${team.open.length === 1 ? '' : 's'}.</span>
    </div>`;
    return;
  }
  // draft complete, games not started
  el.innerHTML = `<p class="hero-tagline">The draft is done. First kickoff ${first ? fmtTime(first.kickoff) : ''}.</p>${scoreboardHTML(st, 'proj')}`;
}

function renderGames() {
  $('#games').innerHTML = S.games
    .map((g) => {
      const state = gameState(g);
      const b = S.board[g.id];
      const sc = (abbr) => (b && state !== 'pre' ? ` <b>${b.scores?.[abbr] ?? 0}</b>` : '');
      const status = state === 'pre' ? `${fmtTime(g.kickoff)}, ${esc(g.network)}` : esc(b?.detail ?? 'In progress');
      return `<li class="${state === 'in' ? 'live' : ''}">
        <div class="game-teams"><span>${esc(g.away.abbr)}${sc(g.away.abbr)}</span><span>@</span><span>${esc(g.home.abbr)}${sc(g.home.abbr)}</span></div>
        <div class="game-status">${status}</div></li>`;
    })
    .join('');
}

/* ---------- players view ---------- */
function filtered() {
  const q = S.q.trim().toLowerCase();
  return S.players.filter((p) => {
    if (S.pos === 'FLEX' && !['RB', 'WR', 'TE'].includes(p.pos)) return false;
    if (S.pos !== 'ALL' && S.pos !== 'FLEX' && p.pos !== S.pos) return false;
    if (q && !`${p.name} ${p.team} ${p.opp}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

const WHY = { locked: 'Game started', nospot: 'No spot', budget: 'Over budget', reserve: 'Over budget' };

function playerRows() {
  const L = S.league;
  const st = buildState(L, S.players);
  const clock = onClock(L);
  const drafting = L.status === 'drafting';
  const myTurn = drafting && (!S.me || S.me === clock?.id);
  const t = now();
  const list = filtered().filter((p) => !(S.hideTaken && st.ownerOf[p.id]));
  if (!list.length) return `<li class="empty-note">No players match. Try another position or clear the search.</li>`;
  return list
    .map((p) => {
      const ownerId = st.ownerOf[p.id];
      const owner = ownerId ? teamById(ownerId) : null;
      let action = '';
      if (owner) action = `<span class="chip" data-color="${esc(owner.color)}">${esc(owner.name)}</span>`;
      else if (drafting && Date.parse(p.kickoff) <= t) action = `<span class="why">Game started</span>`;
      else if (myTurn) {
        const r = checkPick(L, S.players, clock.id, p.id, t, st);
        action = r.ok
          ? `<button type="button" class="btn small" data-draft="${esc(p.id)}">Draft</button>`
          : `<span class="why">${WHY[r.reason] ?? ''}</span>`;
      }
      const inj = p.injury ? ` <span class="inj">${esc(p.injury)}</span>` : '';
      return `<li class="player${owner ? ' taken' : ''}${S.flash === p.id ? ' flash' : ''}">
        ${avatar(p)}
        <div><div class="pname">${esc(p.name)}</div><div class="pmeta"><span class="pos-tag">${POS_LABEL[p.pos]}</span>${matchup(p)}${inj}</div></div>
        <div class="price">$${p.salary}<small>${pts(p.proj)} proj</small></div>
        <div class="row-action">${action}</div></li>`;
    })
    .join('');
}

function picksUntil(L, teamId) {
  const n = L.order.length;
  for (let k = 0; k < n * 2 + 1; k++) {
    if (L.order[snakeIndex(L.turn + k, n)] === teamId) return k;
  }
  return null;
}

function topHTML() {
  const L = S.league;
  const st = buildState(L, S.players);
  if (L.status === 'signup') {
    const seats = [];
    for (let i = 0; i < L.maxTeams; i++) {
      const t = L.teams[i];
      seats.push(
        t
          ? `<li data-color="${esc(t.color)}" style="border-left-color:var(--team)"><b>${esc(t.name)}</b>${t.owner ? `@${esc(t.owner)}` : 'Commissioner drafts'}</li>`
          : `<li class="empty"><b>Open seat</b>Waiting for a family member</li>`,
      );
    }
    return `<section class="section join panel">
        <div><h2>Join the league</h2>
        <p class="lede">Name your team and claim a seat. When all ${L.maxTeams} seats are taken, the draft order is drawn at random and the draft opens.</p></div>
        <form id="join-form">
          <label class="sr-only" for="team-name">Team name</label>
          <input id="team-name" name="team" maxlength="32" required placeholder="Team name, like Gravy Train" autocomplete="off">
          <button class="btn" type="submit">Join on GitHub</button>
        </form>
        <p class="hint">You need a free GitHub account. GitHub opens with your team filled in; tap Submit and you're in within a minute. No GitHub? Ask the commissioner, @${esc(L.commissioner)}, to add your team.</p>
        <ul class="seats">${seats.join('')}</ul>
      </section>
      <section class="section"><h2>The player pool</h2><p class="lede">Prices are set. Plan your team while the seats fill up.</p></section>`;
  }
  if (L.status === 'complete') {
    return `<section class="section"><h2>Draft complete</h2><p class="lede">Every team is set. Watch the scores on the Teams tab once the games start.</p></section>`;
  }
  const clock = onClock(L);
  const team = st.teams[clock.id];
  const who = `<div class="whoami"><span class="label">I'm drafting as</span><div class="seg">${L.teams
    .map((t) => `<button type="button" data-me="${esc(t.id)}" data-color="${esc(t.color)}" aria-pressed="${S.me === t.id}">${esc(t.name)}</button>`)
    .join('')}</div></div>`;
  let status;
  if (S.me && S.me !== clock.id) {
    const k = picksUntil(L, S.me);
    const mine = st.teams[S.me];
    status = `<div class="status" data-color="${esc(teamById(S.me).color)}">
      <p class="big">${esc(clock.name)} is picking.${k ? ` You're up in ${k} pick${k === 1 ? '' : 's'}.` : ''}</p>
      <p>You have $${mine.left} for ${mine.open.length} spot${mine.open.length === 1 ? '' : 's'}.</p>
      <div class="needs">${mine.open.map((s) => `<span>${POS_LABEL[s]}</span>`).join('')}</div></div>`;
  } else {
    const mb = maxBid(L, S.players, clock.id, now(), st);
    status = `<div class="status" data-color="${esc(clock.color)}">
      <p class="big">${S.me ? "You're on the clock." : `${esc(clock.name)} is on the clock.`}</p>
      <p>$${team.left} left for ${team.open.length} spot${team.open.length === 1 ? '' : 's'}${mb > 0 ? `, so you can spend up to $${mb} on this pick` : ''}.</p>
      <div class="needs">${team.open.map((s) => `<span>${POS_LABEL[s]}</span>`).join('')}</div></div>`;
  }
  return `<section class="section">${who}${status}</section>`;
}

function renderPlayers(full) {
  const view = $('#view');
  if (full || !$('#pv-list')) {
    view.innerHTML = `<div id="pv-top">${topHTML()}</div>
      <div class="filters">
        <div class="pos-filter" role="group" aria-label="Position">${POSITIONS.map(
          (p) => `<button type="button" data-pos="${p}" aria-pressed="${S.pos === p}">${FILTER_LABEL[p] ?? p}</button>`,
        ).join('')}</div>
        <label class="sr-only" for="search">Search players</label>
        <input type="search" id="search" placeholder="Search name or team" value="${esc(S.q)}" autocomplete="off">
        <label class="toggle"><input type="checkbox" id="hide-taken" ${S.hideTaken ? 'checked' : ''}> Hide drafted players</label>
      </div>
      <ul class="players" id="pv-list"></ul>`;
  } else {
    $('#pv-top').innerHTML = topHTML();
  }
  $('#pv-list').innerHTML = playerRows();
}

/* ---------- board view ---------- */
function renderBoard() {
  const L = S.league;
  if (!L.order.length) {
    $('#view').innerHTML = `<h2>Draft board</h2><p class="lede">The board appears once all ${L.maxTeams} teams have joined and the draft order is drawn.</p>`;
    return;
  }
  const n = L.order.length;
  const rounds = Math.max(slotsFor(L).length, Math.ceil((L.turn + 1) / n));
  const byTurn = Object.fromEntries(L.picks.map((p) => [p.turn, p]));
  const passed = new Set(L.passes.map((p) => p.turn));
  const head = L.order.map((id) => teamById(id)).map((t) => `<th scope="col" data-color="${esc(t.color)}">${esc(t.name)}</th>`).join('');
  let body = '';
  for (let r = 0; r < rounds; r++) {
    const cells = L.order.map((teamId) => {
      const i = L.order.indexOf(teamId);
      const turn = r * n + (r % 2 === 0 ? i : n - 1 - i);
      const pick = byTurn[turn];
      if (pick) {
        const p = S.byId[pick.player];
        return `<td><b>${esc(p?.name ?? pick.player)}</b><span>${esc(p?.team ?? '')} ${POS_LABEL[p?.pos] ?? ''}, $${pick.salary}</span></td>`;
      }
      if (passed.has(turn)) return `<td class="passed">Passed</td>`;
      if (L.status === 'drafting' && turn === L.turn) return `<td class="now"><b>On the clock</b></td>`;
      return '<td></td>';
    });
    body += `<tr><th scope="row">Rd ${r + 1}</th>${cells.join('')}</tr>`;
  }
  $('#view').innerHTML = `<h2>Draft board</h2>
    <p class="lede">Snake order: the team that picks last in one round picks first in the next.</p>
    <div class="board-wrap"><table class="board"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ---------- teams view ---------- */
function renderTeams() {
  const L = S.league;
  if (!L.teams.length) {
    $('#view').innerHTML = `<h2>Teams</h2><p class="lede">No teams yet. Join from the Players tab.</p>`;
    return;
  }
  const st = buildState(L, S.players);
  const started = phase() === 'live' || phase() === 'final';
  const cards = L.teams.map((t0) => {
    const t = st.teams[t0.id];
    const s = teamScore(t);
    const rows = t.roster
      .map((r) => {
        if (!r.player) return `<li class="open"><span class="slot">${POS_LABEL[r.slot]}</span><div class="who"><b>Open</b></div><span></span></li>`;
        const p = r.player;
        const pt = pointsFor(p, S.scored);
        const gs = gameState(gameOf(p));
        const right = started
          ? `<span class="pts">${gs === 'pre' ? '–' : pts(pt?.pts)}<small>${gs === 'pre' ? fmtTime(p.kickoff) : gs === 'in' ? 'Playing' : 'Final'}</small></span>`
          : `<span class="pts">$${r.pick.salary}<small>${pts(p.proj)} proj</small></span>`;
        const line = started && pt?.line ? esc(pt.line) : `${esc(p.team)} ${POS_LABEL[p.pos]}, ${matchup(p).replace(/^\w+ /, '')}`;
        return `<li><span class="slot">${POS_LABEL[r.slot]}</span><div class="who"><b>${esc(p.name)}</b><span>${line}</span></div>${right}</li>`;
      })
      .join('');
    const total = started
      ? `<div class="team-total">${pts(s.total)}<small><br>points</small></div>`
      : `<div class="team-total">$${t.left}<small><br>left</small></div>`;
    return `<article class="team" data-color="${esc(t.color)}" style="border-top-color:var(--team)">
      <div class="team-head"><div><h3>${esc(t.name)}</h3><small>${t.owner ? `@${esc(t.owner)}` : 'Commissioner drafts'}</small></div>${total}</div>
      <ul class="roster">${rows}</ul></article>`;
  });
  $('#view').innerHTML = `<h2>Teams</h2><p class="lede">${started ? 'Points update every 30 seconds while games are on.' : 'Rosters fill in as the draft goes.'}</p><div class="team-grid">${cards.join('')}</div>`;
}

/* ---------- rules view ---------- */
function renderRules() {
  const L = S.league;
  const row = (a, b) => `<tr><td>${a}</td><td>${b}</td></tr>`;
  $('#view').innerHTML = `<div class="rules">
    <section><h2>How to play</h2>
      <ol class="steps">
        <li><b>Join.</b> Name your team on the Players tab and submit it on GitHub. You need a free GitHub account. Family without one can ask the commissioner, @${esc(L.commissioner)}, to add them.</li>
        <li><b>Draft.</b> Once ${L.maxTeams} teams are in, the order is drawn at random and the snake draft starts (1-2-3, then 3-2-1). On your turn, tap Draft, then Submit on GitHub. The league bot checks the pick and replies within a minute.</li>
        <li><b>Watch.</b> Your players score during Thursday's three games. Highest total after the night game wins it all.</li>
      </ol></section>
    <div class="cols">
      <section><h3>Your roster and budget</h3>
        <p>Every team gets <b>$${L.cap}</b> for ${slotsFor(L).length} spots: QB, RB, RB, WR, WR, TE, Flex (RB, WR or TE), K and D/ST.</p>
        <p>Every player belongs to one team only. Once he's drafted, he's gone.</p>
        <p>You always have to keep enough money to fill your other spots with the cheapest players left. The status box shows the most you can spend on each pick.</p>
        <p>Players lock when their game kicks off. If a team can't afford anyone for its open spots, its turn is skipped.</p>
        <p>A tie at the end is a tie. Split the pie.</p></section>
      <section><h3>Scoring (full PPR)</h3>
        <table class="score-table"><tbody>
          ${row('Passing yards', '1 per 25')}
          ${row('Passing TD', RULES.passTd)}
          ${row('Interception thrown', RULES.passInt)}
          ${row('Rushing or receiving yards', '1 per 10')}
          ${row('Rushing or receiving TD', RULES.rushTd)}
          ${row('Reception', RULES.rec)}
          ${row('Fumble lost', RULES.fumLost)}
          ${row('Kick or punt return TD', RULES.returnTd)}
          ${row('Field goal / extra point', `${RULES.fg} / ${RULES.xp}`)}
          ${row('D/ST sack', RULES.dstSack)}
          ${row('D/ST interception or fumble recovery', RULES.dstInt)}
          ${row('D/ST touchdown', RULES.dstTd)}
          ${row('D/ST shutout', 10)}
          ${row('D/ST allows 1-6 / 7-13', '7 / 4')}
          ${row('D/ST allows 14-20 / 21-27', '1 / 0')}
          ${row('D/ST allows 28-34 / 35+', '-1 / -4')}
        </tbody></table></section>
    </div>
    <section><h3>Commissioner tools</h3>
      <p>The commissioner (@${esc(L.commissioner)}) runs the league by opening issues with these titles:</p>
      <p><code>ADD: Grandma's Gravy Boat</code> adds a team the commissioner drafts for. <code>ADD: Team name @username</code> saves a seat for someone on GitHub.</p>
      <p><code>KICK: Team name</code> removes a team before the draft. <code>UNDO</code> takes back the last pick. <code>RESET</code> clears the draft and redraws the order. <code>RESET ALL</code> removes every team and pick so you can start over.</p>
      <p>The commissioner can also submit a pick for whichever team is on the clock.</p></section>
  </div>`;
}

/* ---------- sheet ---------- */
function openPickSheet(playerId) {
  const L = S.league;
  const clock = onClock(L);
  const p = S.byId[playerId];
  const r = checkPick(L, S.players, clock.id, playerId, now());
  if (!r.ok) {
    toast(r.error);
    return;
  }
  const open = buildState(L, S.players).teams[clock.id].open.length - 1;
  const url = issueUrl(
    `PICK: ${p.name} (${p.team} ${POS_LABEL[p.pos]}) #${p.id}`,
    `Tap **Submit new issue** (or **Create**) to lock in this pick for ${clock.name}.\n\nThe league bot replies here within a minute.`,
  );
  $('#sheet-body').innerHTML = `<h2 id="sheet-title">Draft ${esc(p.name)}?</h2>
    <p>${esc(p.team)} ${POS_LABEL[p.pos]} at ${POS_LABEL[r.slot]} for $${p.salary}. ${esc(clock.name)} would have $${r.leftAfter} left for ${open} spot${open === 1 ? '' : 's'}.</p>
    <p class="hint">GitHub opens with the pick filled in. Tap Submit there and the league bot locks it in.</p>
    <div class="actions"><button class="btn quiet" value="cancel">Cancel</button>
    <a class="btn" id="go" href="${esc(url)}" target="_blank" rel="noopener">Open GitHub to submit</a></div>`;
  $('#go').addEventListener('click', () => {
    S.pending = { kind: 'pick', player: playerId };
    waitingSheet(`${p.name} goes to ${clock.name} as soon as the league bot sees your GitHub issue. This page updates by itself.`);
  });
  $('#sheet').showModal();
}

function waitingSheet(text) {
  $('#sheet-body').innerHTML = `<h2 id="sheet-title">Waiting for the league bot</h2><p>${esc(text)}</p>
    <p class="hint">If GitHub says something went wrong, the bot's reply on your issue explains why.</p>
    <div class="actions"><button class="btn quiet" value="close">Close</button></div>`;
  if (!$('#sheet').open) $('#sheet').showModal();
}

/* ---------- render + events ---------- */
function defaultTab() {
  const ph = phase();
  return ph === 'live' || ph === 'final' ? 'teams' : 'players';
}

function render(full = false) {
  if (!S.league) return;
  renderHero();
  renderGames();
  const tab = S.tab ?? defaultTab();
  for (const b of document.querySelectorAll('.tabs button')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  if (tab === 'players') renderPlayers(full);
  else if (tab === 'board') renderBoard();
  else if (tab === 'teams') renderTeams();
  else renderRules();
  S.flash = null;
}

function bind() {
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    S.tab = b.dataset.tab;
    render(true);
  });
  const view = $('#view');
  view.addEventListener('click', (e) => {
    const draft = e.target.closest('[data-draft]');
    if (draft) return openPickSheet(draft.dataset.draft);
    const me = e.target.closest('[data-me]');
    if (me) {
      S.me = S.me === me.dataset.me ? '' : me.dataset.me;
      store.set('tb.me', S.me);
      return render();
    }
    const pos = e.target.closest('[data-pos]');
    if (pos) {
      S.pos = pos.dataset.pos;
      for (const b of view.querySelectorAll('[data-pos]')) b.setAttribute('aria-pressed', b.dataset.pos === S.pos);
      $('#pv-list').innerHTML = playerRows();
    }
  });
  view.addEventListener('input', (e) => {
    if (e.target.id === 'search') {
      S.q = e.target.value;
      $('#pv-list').innerHTML = playerRows();
    }
  });
  view.addEventListener('change', (e) => {
    if (e.target.id === 'hide-taken') {
      S.hideTaken = e.target.checked;
      store.set('tb.hideTaken', S.hideTaken ? '1' : '0');
      $('#pv-list').innerHTML = playerRows();
    }
  });
  view.addEventListener('submit', (e) => {
    if (e.target.id !== 'join-form') return;
    e.preventDefault();
    const name = new FormData(e.target).get('team').toString().trim();
    if (!name) return;
    window.open(
      issueUrl(`JOIN: ${name}`, `Tap **Submit new issue** (or **Create**) to join the Turkey Bowl as **${name}**.\n\nThe league bot replies here within a minute.`),
      '_blank',
      'noopener',
    );
    S.pending = { kind: 'join' };
    waitingSheet(`${name} joins as soon as the league bot sees your GitHub issue. This page updates by itself.`);
  });
  // fall back to the team logo when a headshot is missing
  document.addEventListener(
    'error',
    (e) => {
      const img = e.target;
      if (img.tagName === 'IMG' && img.dataset.team && !img.dataset.fallback) {
        img.dataset.fallback = '1';
        img.classList.add('logo');
        img.src = `https://a.espncdn.com/i/teamlogos/nfl/500/${img.dataset.team.toLowerCase()}.png`;
      }
    },
    true,
  );
  $('#sheet').addEventListener('close', () => {
    if ($('#sheet').returnValue === 'cancel') S.pending = null;
  });
}

function loop(fn, ms) {
  const tick = async () => {
    if (!document.hidden) await fn();
    setTimeout(tick, typeof ms === 'function' ? ms() : ms);
  };
  setTimeout(tick, typeof ms === 'function' ? ms() : ms);
}

async function init() {
  try {
    const [pool, league] = await Promise.all([loadJSON('data/players.json'), loadJSON('data/league.json')]);
    S.players = pool.players;
    S.games = pool.games;
    S.byId = Object.fromEntries(pool.players.map((p) => [p.id, p]));
    setLeague(league);
  } catch (e) {
    $('#hero-body').innerHTML = `<p class="hero-tagline">The league data didn't load. Check your connection and refresh the page.</p>`;
    console.error(e);
    return;
  }
  try {
    useBackupScores(await loadJSON('data/scores.json'));
  } catch {
    /* no saved scores yet */
  }
  bind();
  render(true);
  refreshScores();
  loop(refreshLeague, () => (S.pending ? 5000 : 15000));
  loop(refreshScores, 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshLeague();
      refreshScores();
    }
  });
}

init();
