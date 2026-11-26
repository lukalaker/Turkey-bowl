import { POS_LABEL, buildState, onClock, checkPick, maxBid, snakeIndex, slotsFor } from './engine.js?v=dev';
import { scoreSummary, pointsFor, fetchSummary, ESPN_API, RULES } from './scoring.js?v=dev';
import { fold, connect, sha256, cleanPerson } from './live.js?v=dev';

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
  me: '', // the team this phone joined with (from its key)
  db: null, // live database connection
  events: {},
  results: {},
  myKey: '',
  myKeyHash: '',
  myPin: '',
  myPinHash: '',
  waiting: null, // { id, kind, done(result) } for the action this phone just sent
  status: 'connecting',
  pos: 'ALL',
  q: '',
  hideTaken: store.get('tb.hideTaken') !== '0',
  pending: null,
  flash: null,
  open: new Set(), // leaderboard teams that are expanded
};

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DEF'];
// A little turkey with a harvest-striped tail, shown beside each player's account name.
const TURKEY = `<svg class="turkey" viewBox="0 0 24 24" aria-hidden="true"><g transform="translate(12 14)"><ellipse rx="2.9" ry="7.6" transform="rotate(-62) translate(0 -5.2)" fill="#5c6a1e"/><ellipse rx="2.9" ry="7.6" transform="rotate(-31) translate(0 -5.2)" fill="#9e1f36"/><ellipse rx="2.9" ry="7.6" transform="translate(0 -5.2)" fill="#e2661e"/><ellipse rx="2.9" ry="7.6" transform="rotate(31) translate(0 -5.2)" fill="#f0a92c"/><ellipse rx="2.9" ry="7.6" transform="rotate(62) translate(0 -5.2)" fill="#9e1f36"/></g><ellipse cx="12" cy="16.4" rx="5.3" ry="5.4" fill="#6e3618"/><circle cx="12" cy="10.8" r="2.8" fill="#8f4a22"/><circle cx="12.9" cy="10.2" r="0.65" fill="#fff4e4"/><path d="M14.5 10.9l1.9.6-1.9.6z" fill="#f0a92c"/><path d="M13.5 11.8c.7.9.6 1.9-.1 2.4-.4-.8-.4-1.6.1-2.4z" fill="#c8243f"/></svg>`;
const DRUMSTICK = `<svg class="drumstick" viewBox="0 0 32 32" aria-hidden="true"><path d="M14 18 6.8 25.2" stroke="#b98d63" stroke-width="5.4" stroke-linecap="round"/><circle cx="4.6" cy="24.8" r="3.3" fill="#b98d63"/><circle cx="7.2" cy="27.4" r="3.3" fill="#b98d63"/><path d="M14 18 6.8 25.2" stroke="#fff4e4" stroke-width="3.6" stroke-linecap="round"/><circle cx="4.6" cy="24.8" r="2.5" fill="#fff4e4"/><circle cx="7.2" cy="27.4" r="2.5" fill="#fff4e4"/><ellipse cx="20.2" cy="11.8" rx="10.2" ry="8.2" transform="rotate(-45 20.2 11.8)" fill="#c8741f"/><ellipse cx="22.6" cy="8.8" rx="4.4" ry="2.3" transform="rotate(-45 22.6 8.8)" fill="#eaa456"/></svg>`;
const FILTER_LABEL = { ALL: 'All', FLEX: 'Flex', DEF: 'D/ST' };

/* ---------- helpers ---------- */
const now = () => Date.now();
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const pts = (n) => (Math.round((n ?? 0) * 10) / 10).toFixed(1);
const gameOf = (p) => S.games.find((g) => g.id === p.game);

function teamById(id) {
  return S.league?.teams.find((t) => t.id === id) ?? null;
}
function ownerLabel(t) {
  return t.owner
    ? `<span class="owner">${TURKEY}${esc(t.owner)}</span>`
    : `<span class="owner">Commissioner drafts</span>`;
}
/** Is this phone unlocked as the commissioner? */
function isCommish() {
  return !!S.league?.pinHash && S.myPinHash === S.league.pinHash;
}
/** Can this phone make the pick right now? */
function canPickNow() {
  const L = S.league;
  if (L?.status !== 'drafting') return false;
  const clock = onClock(L);
  return !!clock && (clock.id === S.me || isCommish());
}

/* ---------- sending actions to the live league ---------- */
function randomKey() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function send(kind, event) {
  if (!S.db) {
    toast('The live league is not connected yet. Check your connection and reload.');
    return null;
  }
  const body = { type: kind, key: S.myKeyHash, ...event };
  if (S.myPinHash) body.pin = S.myPinHash;
  return new Promise((resolve) => {
    S.db
      .post(body)
      .then((id) => {
        const result = S.results[id];
        if (result) resolve(result);
        else S.waiting = { id, done: resolve };
      })
      .catch((err) => resolve({ ok: false, message: err.message }));
    setTimeout(() => {
      if (S.waiting?.done === resolve) {
        S.waiting = null;
        resolve({ ok: false, message: 'No answer from the league yet. Check your connection; if it went through, it will show up in a moment.' });
      }
    }, 15000);
  });
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
  S.me = next.teams.find((t) => t.keyHash && t.keyHash === S.myKeyHash)?.id ?? '';
  if (prev) {
    const fresh = next.picks.slice(prev.picks.length);
    const last = fresh[fresh.length - 1];
    const before = onClock(prev);
    const now_ = onClock(next);
    const myTurn = now_ && S.me === now_.id && before?.id !== now_.id;
    if (last) {
      const p = S.byId[last.player];
      toast(`${teamById(last.team)?.name ?? 'A team'} drafted ${p?.name ?? 'a player'} for $${last.salary}.${myTurn ? " You're on the clock!" : ''}`);
      S.flash = last.player;
    } else if (next.teams.length > prev.teams.length) {
      toast(`${next.teams[next.teams.length - 1].name} joined the league`);
    } else if (myTurn) {
      toast("You're on the clock!");
    }
    if (myTurn) navigator.vibrate?.([120, 80, 120]);
  }
  // A freshly spun draft order plays once on every device that sees it early on.
  const early = next.picks.length < next.order.length * 2;
  if (next.status === 'drafting' && next.startedAt && early && store.get('tb.spun') !== next.startedAt) {
    setTimeout(() => showSpin(), 250);
  }
  return true;
}

/* ---------- the draft-order spin ---------- */
function showSpin() {
  const L = S.league;
  if (!L?.order.length || $('.spin')) return;
  store.set('tb.spun', L.startedAt ?? '');
  const teams = L.order.map((id) => teamById(id));
  const ords = ['1st pick', '2nd pick', '3rd pick', '4th pick'];
  const el = document.createElement('div');
  el.className = 'spin';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'spin-title');
  el.innerHTML = `<div class="spin-card">
      <h2 id="spin-title">Spinning the draft order</h2>
      <ol class="reels">${teams
        .map((_, i) => `<li><span class="reel-label">${ords[i] ?? `Pick ${i + 1}`}</span><span class="reel"><span class="reel-name">&nbsp;</span></span></li>`)
        .join('')}</ol>
      <p class="spin-note" hidden>Snake draft: the order flips every round, and there's no timer. Pick when it's your turn.</p>
      <button type="button" class="btn" hidden>Let's draft</button>
    </div>`;
  document.body.append(el);
  const reels = [...el.querySelectorAll('.reel')];
  const names = teams.map((t) => t.name);
  let landed = 0;
  reels.forEach((reel, i) => {
    const label = reel.querySelector('.reel-name');
    const stopAt = performance.now() + 1500 + i * 900;
    let delay = 55;
    let k = Math.floor(Math.random() * names.length);
    const tick = () => {
      if (performance.now() >= stopAt) {
        const t = teams[i];
        label.textContent = t.name;
        reel.parentElement.dataset.color = t.color;
        reel.classList.add('landed');
        if (++landed === reels.length) {
          el.querySelector('h2').textContent = 'The draft order is set';
          el.querySelector('.spin-note').hidden = false;
          const go = el.querySelector('button');
          go.hidden = false;
          go.focus();
        }
        return;
      }
      k = (k + 1) % names.length;
      label.textContent = names[k];
      reel.classList.remove('tick');
      void reel.offsetWidth; // restart the tick animation
      reel.classList.add('tick');
      delay = Math.min(delay * 1.07, 260);
      setTimeout(tick, delay);
    };
    tick();
  });
  el.querySelector('button').addEventListener('click', () => el.remove());
}

/** New events from the live database: replay them and refresh the page. */
function onEvents(events) {
  S.events = events;
  const { league, results } = fold(events, S.players, { repo: '' });
  S.results = results;
  const changed = setLeague(league);
  if (S.waiting && results[S.waiting.id]) {
    const w = S.waiting;
    S.waiting = null;
    w.done(results[w.id]);
  }
  if (changed) render();
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
      const leads = val(x) === top && top > 0;
      return `<li class="${leads ? 'leader' : ''}" data-color="${esc(x.t.color)}">
        <button type="button" class="sb-row" data-goto-team="${esc(x.t.id)}">
        <span class="sb-rank">${leads ? `${DRUMSTICK}<span class="sr-only">Leader</span>` : i + 1}</span>
        <span class="sb-name">${esc(x.t.name)}<small>${sub}</small></span>
        <span class="sb-pts">${pts(val(x))}</span></button></li>`;
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
    el.innerHTML = `<p class="winner-line">${tied ? 'A tie! Split the pie.' : `${DRUMSTICK}${esc(ranked[0].t.name)} wins the Turkey Bowl`}</p>${scoreboardHTML(st, 'final')}`;
    return;
  }
  if (ph === 'live') {
    el.innerHTML = scoreboardHTML(st, 'live');
    return;
  }
  if (ph === 'signup') {
    const n = L.teams.length;
    el.innerHTML =
      n >= L.maxTeams
        ? `<p class="hero-tagline">Three seats at the table, one day of football, winner takes all. <strong>Every seat is taken.</strong> Waiting for the commissioner to spin the draft order.</p>`
        : `<p class="hero-tagline">Three seats at the table, one day of football, winner takes all. <strong>${n} of ${L.maxTeams}</strong> seats are taken. First kickoff ${first ? fmtTime(first.kickoff) : ''}.</p>`;
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
  const myTurn = canPickNow();
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
        <div class="pbody">
          <div class="pline"><span class="pname">${esc(p.name)}</span><span class="leader" aria-hidden="true"></span><span class="price">$${p.salary}</span></div>
          <div class="pmeta"><span class="pos-tag">${POS_LABEL[p.pos]}</span>${matchup(p)}, ${pts(p.proj)} proj${inj}</div>
        </div>
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
          ? `<li data-color="${esc(t.color)}"><b>${esc(t.name)}</b>${ownerLabel(t)}</li>`
          : `<li class="empty"><b>Open seat</b><span>Waiting for a family member</span></li>`,
      );
    }
    const mine = teamById(S.me);
    if (L.teams.length >= L.maxTeams) {
      const startCtl = isCommish()
        ? `<div><button class="btn" type="button" id="start-draft">Start the draft</button></div>`
        : `<p class="hint">Only the commissioner can start it${L.pinHash ? '' : ' (set up on the How to play tab)'}.</p>`;
      return `<section class="section join panel">
        <div><h2>Everyone's at the table</h2>
        <p class="lede">All ${L.maxTeams} seats are taken. When the family is ready, the commissioner starts the draft and the order spins at random on everyone's screen.</p></div>
        ${startCtl}
        <ul class="seats">${seats.join('')}</ul>
      </section>
      <section class="section"><h2>Players and prices</h2><p class="lede">Prices are set. Plan your plate while you wait.</p></section>`;
    }
    const joinBlock = mine
      ? `<p class="lede">You're in as <b>${esc(mine.name)}</b>. Waiting for ${L.maxTeams - L.teams.length} more. Want a different team name? Type it below.</p>`
      : `<p class="lede">Type your name and a team name to claim a seat. When all ${L.maxTeams} seats are taken, the commissioner starts the draft and the order spins at random.</p>`;
    return `<section class="section join panel">
        <div><h2>Take a seat at the table</h2>${joinBlock}</div>
        <form id="join-form">
          <label class="sr-only" for="person-name">Your name</label>
          <input id="person-name" name="person" maxlength="24" required placeholder="Your name" autocomplete="given-name" value="${esc(mine?.owner ?? '')}">
          <label class="sr-only" for="team-name">Team name</label>
          <input id="team-name" name="team" maxlength="32" required placeholder="Team name, like Gravy Train" autocomplete="off">
          <button class="btn" type="submit">${mine ? 'Rename my team' : 'Take my seat'}</button>
        </form>
        <p class="hint">Use the phone you'll draft on: it remembers your team. Someone without a phone? The commissioner can add a team and draft for them.</p>
        <ul class="seats">${seats.join('')}</ul>
      </section>
      <section class="section"><h2>Players and prices</h2><p class="lede">Prices are set. Plan your plate while the seats fill up.</p></section>`;
  }
  if (L.status === 'complete') {
    return `<section class="section"><h2>Draft complete</h2><p class="lede">Every team is set. Follow the race on the Leaderboard tab once the games start.</p></section>`;
  }
  const clock = onClock(L);
  const team = st.teams[clock.id];
  const me = teamById(S.me);
  const who = `<p class="whoami">${
    me
      ? `<span class="chip" data-color="${esc(me.color)}">${esc(me.name)}</span><span class="label">is your team on this phone${isCommish() ? ", and you're the commissioner" : ''}.</span>`
      : isCommish()
        ? `<span class="label">You're the commissioner: you can pick for whoever is on the clock.</span>`
        : `<span class="label">You're watching. This phone hasn't joined a team.</span>`
  }</p>`;
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
      <p class="big">${S.me === clock.id ? "You're on the clock." : isCommish() ? `${esc(clock.name)} is on the clock. You can pick for them.` : `${esc(clock.name)} is on the clock.`}</p>
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
    <p class="lede">Snake order: the team that picks last in one round picks first in the next. No timer: as soon as one team picks, the next is up.</p>
    <p><button type="button" class="btn quiet small" data-replay>Replay the draft-order spin</button></p>
    <div class="board-wrap"><table class="board"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ---------- leaderboard ---------- */
function rosterRows(t, started) {
  return t.roster
      .map((r) => {
        if (!r.player) return `<li class="open"><span class="slot">${POS_LABEL[r.slot]}</span><div class="who"><b>Open</b></div><span></span></li>`;
        const p = r.player;
        const pt = pointsFor(p, S.scored);
        const gs = gameState(gameOf(p));
        const right = started
          ? gs === 'pre'
            ? `<span class="pts">–<small>${fmtTime(p.kickoff)}</small></span>`
            : `<button type="button" class="pts pts-btn" data-points="${esc(p.id)}" aria-label="${esc(p.name)}: ${pts(pt?.pts)} points. Show how.">${pts(pt?.pts)}<small>${gs === 'in' ? 'Playing' : 'Final'}</small></button>`
          : `<span class="pts">$${r.pick.salary}<small>${pts(p.proj)} proj</small></span>`;
        const line = started && pt?.line ? esc(pt.line) : `${esc(p.team)} ${POS_LABEL[p.pos]}, ${matchup(p).replace(/^\w+ /, '')}`;
        return `<li><span class="slot">${POS_LABEL[r.slot]}</span><div class="who"><b>${esc(p.name)}</b><span>${line}</span></div>${right}</li>`;
      })
      .join('');
}

function renderLeaderboard() {
  const L = S.league;
  if (!L.teams.length) {
    $('#view').innerHTML = `<h2>Leaderboard</h2><p class="lede">No teams yet. Take a seat at the table from the Players tab.</p>`;
    return;
  }
  const st = buildState(L, S.players);
  const ph = phase();
  const started = ph === 'live' || ph === 'final';
  const ranked = Object.values(st.teams)
    .map((t) => ({ t, s: teamScore(t) }))
    .sort((a, b) => b.s.total - a.s.total || b.s.proj - a.s.proj);
  const top = ranked[0]?.s.total ?? 0;
  const items = ranked.map(({ t, s }, i) => {
    const open = S.open.has(t.id);
    const leads = started && top > 0 && s.total === top;
    const playing = t.roster.filter((r) => r.player && gameState(gameOf(r.player)) === 'in').length;
    let sub;
    if (!started) {
      sub = L.status === 'drafting' ? `${t.picks.length} of ${slotsFor(L).length} drafted, $${t.left} left` : `${pts(s.proj)} projected`;
    } else if (ph === 'final') {
      sub = 'Final';
    } else {
      sub = [playing ? `${playing} playing` : '', s.toPlay ? `${s.toPlay} to play` : ''].filter(Boolean).join(', ') || 'Everyone has played';
    }
    return `<li class="lb-team${open ? ' open' : ''}${leads ? ' leader' : ''}" id="team-${esc(t.id)}" data-color="${esc(t.color)}">
      <button type="button" class="lb-row" data-team="${esc(t.id)}" aria-expanded="${open}">
        <span class="lb-rank">${leads ? `${DRUMSTICK}<span class="sr-only">Leader</span>` : i + 1}</span>
        <span class="lb-name"><b>${esc(t.name)}</b>${ownerLabel(t)}</span>
        <span class="lb-total">${pts(s.total)}<small>${sub}</small></span>
        <span class="lb-chevron" aria-hidden="true"></span>
      </button>
      ${open ? `<ul class="roster">${rosterRows(t, started)}</ul>` : ''}
    </li>`;
  });
  const lede = started
    ? 'Live points, updated every 30 seconds. Tap a team to see its players, then tap a score to see how it was earned.'
    : 'Points start counting at kickoff. Tap a team to see its players.';
  $('#view').innerHTML = `<h2>Leaderboard</h2><p class="lede">${lede}</p><ol class="leaderboard">${items.join('')}</ol>`;
}

/* ---------- rules view ---------- */
function renderRules() {
  const L = S.league;
  const row = (a, b) => `<tr><td>${a}</td><td>${b}</td></tr>`;
  $('#view').innerHTML = `<div class="rules">
    <section><h2>How to play</h2>
      <ol class="steps">
        <li><b>Join.</b> On the Players tab, type your name and a team name and tap Take my seat. Use the phone you'll draft on; it remembers your team. Family without a phone can have the commissioner add a team and draft for them.</li>
        <li><b>Draft.</b> Once ${L.maxTeams} teams are in, the commissioner taps Start the draft and the order spins at random. It's a snake draft (1-2-3, then 3-2-1) with no timer: as soon as one team picks, the next is up. On your turn, tap Draft next to a player, then confirm. It shows up on everyone's phone right away.</li>
        <li><b>Watch.</b> Your players score during Thursday's three games. Highest total after the night game wins it all.</li>
      </ol></section>
    <div class="cols">
      <section><h3>Your roster and budget</h3>
        <p>Every team gets <b>$${L.cap}</b> for ${slotsFor(L).length} spots: QB, RB, RB, WR, WR, TE, Flex (RB, WR or TE), K and D/ST.</p>
        <p>Every player belongs to one team only. Once he's drafted, he's gone.</p>
        <p>You always have to keep enough money to fill your other spots with the cheapest players left. The status box shows the most you can spend on each pick.</p>
        <p>Players lock when their game kicks off.</p>
        <p>Bargain bin: if the other teams take the cheap players you were saving for and you can't afford anyone, you can take the cheapest player left at an open spot for whatever money you have. Nobody ends up a player short.</p>
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
    ${commishHTML()}
  </div>`;
}

function commishHTML() {
  const L = S.league;
  if (!L.pinHash) {
    return `<section class="commish" id="commish"><h3>Commissioner tools</h3>
      <p>Whoever runs the league sets a PIN here first. It unlocks starting the draft, undoing picks, adding teams for family without a phone, and resets.</p>
      <form class="inline-form" data-form="setpin">
        <label class="sr-only" for="pin-new">New commissioner PIN</label>
        <input id="pin-new" name="pin" inputmode="numeric" minlength="4" maxlength="12" required placeholder="Pick a PIN, 4+ digits" autocomplete="off">
        <button class="btn" type="submit">Become commissioner</button>
      </form></section>`;
  }
  if (!isCommish()) {
    return `<section class="commish" id="commish"><h3>Commissioner tools</h3>
      <p>The commissioner unlocks these with the PIN on their phone.</p>
      <form class="inline-form" data-form="unlock">
        <label class="sr-only" for="pin-enter">Commissioner PIN</label>
        <input id="pin-enter" name="pin" inputmode="numeric" maxlength="12" required placeholder="Commissioner PIN" autocomplete="off">
        <button class="btn quiet" type="submit">Unlock</button>
      </form></section>`;
  }
  const signup = L.status === 'signup';
  const full = L.teams.length >= L.maxTeams;
  const kickOptions = L.teams.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('');
  return `<section class="commish" id="commish"><h3>Commissioner tools</h3>
    <p>You're the commissioner on this phone. You can also pick for whichever team is on the clock.</p>
    <div class="commish-grid">
      ${signup && full ? `<div><button class="btn" type="button" id="start-draft">Start the draft</button></div>` : ''}
      ${signup && !full ? `<form class="inline-form" data-form="add">
        <label class="sr-only" for="add-team">Team name for someone without a phone</label>
        <input id="add-team" name="team" maxlength="32" required placeholder="Add a team you'll draft for" autocomplete="off">
        <button class="btn quiet" type="submit">Add team</button></form>` : ''}
      ${signup && L.teams.length ? `<form class="inline-form" data-form="kick">
        <label class="sr-only" for="kick-team">Team to remove</label>
        <select id="kick-team" name="team">${kickOptions}</select>
        <button class="btn quiet" type="submit">Remove team</button></form>` : ''}
      ${L.picks.length ? `<div><button class="btn quiet" type="button" data-commish="undo">Undo the last pick</button></div>` : ''}
      ${L.status !== 'signup' ? `<div><button class="btn quiet" type="button" data-commish="reset">Restart the draft (keep teams)</button></div>` : ''}
      <div><button class="btn quiet" type="button" data-commish="reset-all">Clear everything (all teams and picks)</button></div>
      <div><button class="btn quiet" type="button" data-commish="lock">Lock commissioner tools on this phone</button></div>
    </div></section>`;
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
  const forWho = clock.id === S.me ? '' : ` for ${esc(clock.name)}`;
  $('#sheet-body').innerHTML = `<h2 id="sheet-title">Draft ${esc(p.name)}${forWho}?</h2>
    <p>${esc(p.team)} ${POS_LABEL[p.pos]} at ${POS_LABEL[r.slot]} for $${r.price}${r.bargain ? ` from the bargain bin (he lists at $${p.salary})` : ''}. ${esc(clock.name)} would have $${r.leftAfter} left for ${open} spot${open === 1 ? '' : 's'}.</p>
    <p class="sheet-msg" role="status" hidden></p>
    <div class="actions"><button class="btn quiet" value="cancel">Cancel</button>
    <button class="btn" type="button" id="go">Draft ${esc(p.name.split(' ').slice(-1)[0])}</button></div>`;
  $('#go').addEventListener('click', async () => {
    const go = $('#go');
    if (go.dataset.failed) return $('#sheet').close();
    go.disabled = true;
    go.textContent = 'Drafting…';
    const result = await send('pick', { player: playerId });
    if (result?.ok) {
      $('#sheet').close();
      toast(`${p.name} is yours${forWho ? ` (${clock.name})` : ''}!`);
    } else if (result) {
      const msg = $('.sheet-msg');
      msg.hidden = false;
      msg.textContent = result.message;
      go.textContent = 'Pick someone else';
      go.dataset.failed = '1';
      go.disabled = false;
    }
  });
  $('#sheet').showModal();
}

function openPointsSheet(playerId) {
  const p = S.byId[playerId];
  if (!p) return;
  const pt = pointsFor(p, S.scored) ?? { pts: 0, breakdown: [] };
  const ownerId = S.league.picks.find((x) => x.player === playerId)?.team;
  const owner = ownerId ? teamById(ownerId) : null;
  const g = gameOf(p);
  const b = g ? S.board[g.id] : null;
  const status = b?.state === 'post' ? 'Final' : b?.detail || 'In progress';
  const rows = (pt.breakdown ?? [])
    .map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(r.detail)}</td><td>${r.pts > 0 ? '+' : ''}${pts(r.pts)}</td></tr>`)
    .join('');
  $('#sheet-body').innerHTML = `<h2 id="sheet-title">${esc(p.name)}</h2>
    <p class="hint">${esc(p.team)} ${POS_LABEL[p.pos]}${owner ? ` on ${esc(owner.name)}` : ''}. ${esc(g?.short ?? '')}, ${esc(status)}.</p>
    ${
      rows
        ? `<table class="breakdown"><tbody>${rows}</tbody><tfoot><tr><td colspan="2">Total</td><td>${pts(pt.pts)}</td></tr></tfoot></table>`
        : `<p>No points yet. Nothing in the box score for ${esc(p.name)} so far.</p>`
    }
    <div class="actions"><button class="btn quiet" value="close">Close</button></div>`;
  $('#sheet').showModal();
}

function confirmSheet(title, text, label, onYes) {
  $('#sheet-body').innerHTML = `<h2 id="sheet-title">${esc(title)}</h2><p>${esc(text)}</p>
    <div class="actions"><button class="btn quiet" value="cancel">Cancel</button>
    <button class="btn" type="button" id="yes">${esc(label)}</button></div>`;
  $('#yes').addEventListener('click', async () => {
    $('#yes').disabled = true;
    $('#sheet').close();
    await onYes();
  });
  $('#sheet').showModal();
}

/** Send a commissioner/join action and report how it went. */
async function act(kind, event, okText) {
  const result = await send(kind, event);
  if (result) toast(result.ok ? okText ?? result.message.split('\n')[0] : result.message);
  return result;
}

/* ---------- render + events ---------- */
function defaultTab() {
  const ph = phase();
  return ph === 'live' || ph === 'final' || ph === 'complete' ? 'leaderboard' : 'players';
}

function showTeam(teamId) {
  S.tab = 'leaderboard';
  S.open.add(teamId);
  render(true);
  document.getElementById(`team-${teamId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  else if (tab === 'leaderboard') renderLeaderboard();
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
  $('#hero-body').addEventListener('click', (e) => {
    const row = e.target.closest('[data-goto-team]');
    if (row) showTeam(row.dataset.gotoTeam);
  });
  const view = $('#view');
  view.addEventListener('click', (e) => {
    if (e.target.closest('[data-replay]')) return showSpin();
    if (e.target.closest('#start-draft')) {
      const seed = crypto.getRandomValues(new Uint32Array(1))[0];
      return act('start', { seed }, 'The draft order is spun!');
    }
    const cmd = e.target.closest('[data-commish]')?.dataset.commish;
    if (cmd === 'undo') {
      const last = S.league.picks.at(-1);
      const p = last ? S.byId[last.player] : null;
      return confirmSheet('Undo the last pick?', `${p?.name ?? 'The last player'} goes back into the pool and ${teamById(last?.team)?.name ?? 'that team'} is back on the clock.`, 'Undo pick', () => act('undo', {}, 'Pick undone.'));
    }
    if (cmd === 'reset') {
      return confirmSheet('Restart the draft?', 'Every pick is cleared. The teams stay seated, and you spin a new order with Start the draft.', 'Restart draft', () => act('reset', {}, 'Draft restarted. Teams are still seated.'));
    }
    if (cmd === 'reset-all') {
      return confirmSheet('Clear everything?', 'Every team and every pick is removed and all seats open up again. Your commissioner PIN stays.', 'Clear everything', () => act('reset', { arg: 'all' }, 'League cleared. Every seat is open.'));
    }
    if (cmd === 'lock') {
      S.myPin = '';
      S.myPinHash = '';
      store.set('tb.pin', '');
      toast('Commissioner tools locked on this phone.');
      return render(true);
    }
    const team = e.target.closest('[data-team]');
    if (team) {
      const id = team.dataset.team;
      if (S.open.has(id)) S.open.delete(id);
      else S.open.add(id);
      return renderLeaderboard();
    }
    const draft = e.target.closest('[data-draft]');
    if (draft) return openPickSheet(draft.dataset.draft);
    const points = e.target.closest('[data-points]');
    if (points) return openPointsSheet(points.dataset.points);
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
  view.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = new FormData(form);
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    try {
      if (form.id === 'join-form') {
        const person = cleanPerson(data.get('person'));
        const team = String(data.get('team') ?? '').trim();
        if (!person || !team) return;
        const r = await act('join', { by: person, arg: team }, `You're in as ${team}!`);
        if (r?.ok) form.reset();
      } else if (form.dataset.form === 'setpin' || form.dataset.form === 'unlock') {
        const pin = String(data.get('pin') ?? '').trim();
        if (pin.length < 4) return toast('Use at least 4 digits.');
        const hash = await sha256(`tb-pin:${pin}`);
        if (form.dataset.form === 'setpin') {
          S.myPin = pin;
          S.myPinHash = hash;
          const r = await act('setpin', { pin: hash }, "PIN set. You're the commissioner on this phone.");
          if (!r?.ok) {
            S.myPin = '';
            S.myPinHash = '';
          } else store.set('tb.pin', pin);
        } else if (hash === S.league.pinHash) {
          S.myPin = pin;
          S.myPinHash = hash;
          store.set('tb.pin', pin);
          toast('Commissioner tools unlocked on this phone.');
        } else {
          toast("That PIN doesn't match.");
        }
        render(true);
      } else if (form.dataset.form === 'add') {
        const team = String(data.get('team') ?? '').trim();
        if (team) await act('add', { arg: team }, `${team} added. You'll draft for them.`);
      } else if (form.dataset.form === 'kick') {
        const team = String(data.get('team') ?? '');
        if (team) await act('kick', { arg: team }, `${team} removed.`);
      }
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
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
}

function loop(fn, ms) {
  const tick = async () => {
    if (!document.hidden) await fn();
    setTimeout(tick, typeof ms === 'function' ? ms() : ms);
  };
  setTimeout(tick, typeof ms === 'function' ? ms() : ms);
}

async function init() {
  let config;
  try {
    const [pool, cfg] = await Promise.all([loadJSON('data/players.json'), loadJSON('data/config.json')]);
    S.players = pool.players;
    S.games = pool.games;
    S.byId = Object.fromEntries(pool.players.map((p) => [p.id, p]));
    config = cfg;
  } catch (e) {
    $('#hero-body').innerHTML = `<p class="hero-tagline">The league data didn't load. Check your connection and refresh the page.</p>`;
    console.error(e);
    return;
  }
  // This phone's identity: a random key made once and kept on the phone.
  S.myKey = store.get('tb.key') || randomKey();
  store.set('tb.key', S.myKey);
  S.myKeyHash = await sha256(`tb-key:${S.myKey}`);
  S.myPin = store.get('tb.pin') || '';
  if (S.myPin) S.myPinHash = await sha256(`tb-pin:${S.myPin}`);

  onEvents({}); // an empty league until the database answers
  try {
    useBackupScores(await loadJSON('data/scores.json'));
  } catch {
    /* no saved scores yet */
  }
  bind();
  render(true);
  if (config?.firebaseUrl) {
    S.db = connect(config.firebaseUrl, onEvents, (status) => (S.status = status));
  } else {
    $('#hero-body').innerHTML = `<p class="hero-tagline">The live league database isn't connected yet.</p>`;
  }
  refreshScores();
  loop(refreshScores, 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      S.db?.reload().catch(() => {});
      refreshScores();
    }
  });
}

init();
