// Live league storage: every action (join, start, pick, undo...) is an event
// appended to a Firebase Realtime Database list. Every phone replays the same
// events through the same draft rules (engine.js), so everyone sees the same
// league, and two people tapping at once can never both get the same player:
// the event that reached the database first wins, the other is refused for all.
import { newLeague, applyCommand, onClock } from './engine.js?v=dev';

export const COMMISSIONER = 'commissioner';

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Small deterministic random generator, so a START event spins the same order on every phone. */
export function seededRng(seed) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 2 ** 32;
  };
}

export function cleanPerson(name) {
  return String(name ?? '')
    .replace(/[<>`*_~[\]@#/\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

/** Replay events (sorted by database key) into a league. Returns { league, results }. */
export function fold(eventsById, players, base) {
  const league = newLeague({ commissioner: COMMISSIONER, ...base });
  league.pinHash = null;
  const results = {};
  const ids = Object.keys(eventsById ?? {}).sort();
  for (const id of ids) {
    try {
      results[id] = applyEvent(league, players, eventsById[id]);
    } catch (err) {
      results[id] = { ok: false, message: `That didn't work: ${err.message}` };
    }
  }
  return { league, results };
}

function applyEvent(L, players, e) {
  if (!e || typeof e !== 'object') return { ok: false, message: 'Empty event.' };
  const atMs = typeof e.at === 'number' ? e.at : Date.now();
  const isCommish = !!L.pinHash && e.pin === L.pinHash;
  const run = (kind, arg, author, rng) => applyCommand(L, players, { kind, arg: arg ?? '', author, atMs }, rng);
  const commishOnly = () => ({ ok: false, message: 'Only the commissioner can do that. Unlock the commissioner tools with your PIN first.' });

  switch (e.type) {
    case 'setpin':
      if (L.pinHash) return { ok: false, message: 'The commissioner PIN is already set.' };
      if (!e.pin) return { ok: false, message: 'Missing PIN.' };
      L.pinHash = e.pin;
      L.updatedAt = new Date(atMs).toISOString();
      return { ok: true, message: "Commissioner PIN set. You're the commissioner on this phone." };

    case 'join': {
      const person = cleanPerson(e.by);
      if (!person) return { ok: false, message: 'Add your name so the family knows whose team it is.' };
      if (person.toLowerCase() === COMMISSIONER) return { ok: false, message: 'Pick a different name.' };
      if (!e.key) return { ok: false, message: 'This phone could not be identified. Reload the page and try again.' };
      const mine = L.teams.find((t) => t.keyHash === e.key);
      const sameName = L.teams.find((t) => (t.owner ?? '').toLowerCase() === person.toLowerCase());
      if (sameName && sameName !== mine) return { ok: false, message: `${person} already has a team. Add a last initial to tell you apart.` };
      if (mine) {
        // this phone already has a team: rename it (and the person, if they changed it)
        mine.owner = person;
        return run('join', e.arg, person);
      }
      const r = run('join', e.arg, person);
      if (r.ok) {
        const t = L.teams.find((x) => x.owner === person && !x.keyHash);
        if (t) t.keyHash = e.key;
      }
      return r;
    }

    case 'add':
      if (!isCommish) return commishOnly();
      return run('add', e.arg, COMMISSIONER);

    case 'kick':
    case 'start':
    case 'undo':
    case 'reset':
      if (!isCommish) return commishOnly();
      return run(e.type, e.arg, COMMISSIONER, seededRng(e.seed));

    case 'pick': {
      const t = onClock(L);
      let author;
      if (t && t.keyHash && e.key === t.keyHash) author = t.owner;
      else if (isCommish) author = COMMISSIONER;
      else author = L.teams.find((x) => x.keyHash === e.key)?.owner ?? `visitor-${String(e.key ?? '').slice(0, 6)}`;
      return run('pick', `#${e.player}`, author);
    }

    default:
      return { ok: false, message: `Unknown action "${e.type}".` };
  }
}

/** Connection to the Firebase Realtime Database (REST + live stream). */
export function connect(dbUrl, onChange, onStatus = () => {}) {
  const root = dbUrl.replace(/\/+$/, '');
  const url = `${root}/tb/events.json`;
  let events = {};
  let es = null;
  let pollTimer = null;

  const emit = () => onChange({ ...events });
  const load = async () => {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`database ${res.status}`);
    events = (await res.json()) ?? {};
    emit();
  };
  const apply = (path, data, merge) => {
    if (path === '/') {
      events = merge ? { ...events, ...(data ?? {}) } : (data ?? {});
    } else {
      const parts = path.split('/').filter(Boolean);
      if (parts.length === 1) {
        if (data === null) delete events[parts[0]];
        else events[parts[0]] = merge ? { ...(events[parts[0]] ?? {}), ...data } : data;
      } else {
        // a change inside one event: fetch everything again to stay exact
        load().catch(() => {});
        return;
      }
    }
    emit();
  };

  const startStream = () => {
    if (typeof EventSource === 'undefined') return false;
    es = new EventSource(url);
    es.addEventListener('put', (m) => {
      const { path, data } = JSON.parse(m.data);
      apply(path, data, false);
      onStatus('live');
    });
    es.addEventListener('patch', (m) => {
      const { path, data } = JSON.parse(m.data);
      apply(path, data, true);
    });
    es.addEventListener('cancel', () => onStatus('error'));
    es.onerror = () => onStatus('reconnecting');
    es.onopen = () => onStatus('live');
    return true;
  };

  if (!startStream()) load().catch(() => onStatus('error'));
  // A slow safety net in case the live stream drops quietly on a phone.
  pollTimer = setInterval(() => {
    if (!document.hidden) load().catch(() => {});
  }, 20000);

  return {
    async post(event) {
      // Plain-text body keeps this a "simple" request (no CORS preflight); Firebase reads it as JSON.
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ ...event, at: { '.sv': 'timestamp' } }),
      });
      if (!res.ok) throw new Error(`The league database said ${res.status}. Check your connection and try again.`);
      const { name } = await res.json();
      // don't wait for the stream to echo it back; fetch so the result shows fast
      load().catch(() => {});
      return name;
    },
    reload: load,
    close() {
      es?.close();
      clearInterval(pollTimer);
    },
  };
}
