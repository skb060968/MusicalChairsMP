/**
 * Musical Chairs — pure game engine (no Firebase, no DOM).
 *
 * PEER-RUN. There is no host authority once the game starts: every phase change is
 * a deterministic function of the shared `game` node and the server clock, so ANY
 * connected player may write it once the deadline has passed. The Firebase rules
 * re-check every transition below field by field, which is why each reducer here
 * changes exactly the fields the rules allow and nothing else.
 *
 *  music ──(musicMs)──▶ claiming ──(CLAIM_MS or everyone settled)──▶ reveal
 *    ▲                                                                  │
 *    └──────────────────(REVEAL_MS, if 2+ players remain)───────────────┘
 *                                                     └─▶ finished (one left)
 *
 * Game node shape (all of it validated by the rules):
 *   status    'playing' | 'finished'
 *   roundId   start timestamp — identifies one game between resets
 *   revision  +1 on every write
 *   round     1, 2, 3 …
 *   phase     'music' | 'claiming' | 'reveal'
 *   phaseAt   server timestamp the current phase began (the shared clock)
 *   musicMs   10000 | 20000 | 30000 for the current round
 *   order     ['player_0', …] seats dealt in at Start (connected players only)
 *   active    { player_N: true }   still in the game
 *   claims    { player_N: chairIndex }  this round's chairs (absent while music plays)
 *   out       { player_N: round }  who was eliminated, and when
 *   winnerKey 'player_N' once finished
 *   operation { type, ownerUid, actorKey, roundId, revision, timestamp }
 *
 * Chairs are never stored: there are always activeCount − 1 of them, indexed
 * 0 … activeCount − 2. An offline player simply never claims one.
 */

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const PLAYER_KEY_RE = /^player_[0-7]$/;

/** The music runs for exactly one of these. The rules accept ONLY these values. */
export const MUSIC_CHOICES_MS = Object.freeze([10000, 20000, 30000]);
/** How long players have to grab a chair once the music stops. */
export const CLAIM_MS = 10000;
/** How long the elimination result is shown before the next round starts. */
export const REVEAL_MS = 3500;
/** The rules accept a transition this much BEFORE the deadline, to absorb clock and
 *  network skew between the device that fires and the server. Client timers wait
 *  for the full deadline; this slack is only for the server-side check. */
export const DEADLINE_SLACK_MS = 1500;

export const PHASES = Object.freeze({ MUSIC: 'music', CLAIMING: 'claiming', REVEAL: 'reveal' });

/* ----------------------------- helpers ----------------------------- */

export function pickMusicMs(random = Math.random) {
  const roll = typeof random === 'function' ? random() : Math.random();
  const safe = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 0.9999999999) : 0;
  return MUSIC_CHOICES_MS[Math.floor(safe * MUSIC_CHOICES_MS.length)];
}

export function isValidMusicMs(value) {
  return MUSIC_CHOICES_MS.includes(value);
}

/** Seats in the game, in seating order (Firebase may hand `order` back as an object). */
export function orderKeys(game) {
  const o = game?.order;
  if (Array.isArray(o)) return o.filter(Boolean);
  return Object.keys(o || {}).sort((a, b) => Number(a) - Number(b)).map((k) => o[k]);
}

/** Players still in the game, in seating order. */
export function activeKeys(game) {
  const active = game?.active || {};
  return orderKeys(game).filter((k) => active[k] === true);
}

/** Number of chairs this round: one fewer than the players still in. */
export function chairCount(game) {
  return Math.max(0, activeKeys(game).length - 1);
}

export function claimedChairs(game) {
  return Object.values(game?.claims || {}).filter((c) => Number.isInteger(c));
}

export function chairOwner(game, chair) {
  const claims = game?.claims || {};
  return Object.keys(claims).find((k) => claims[k] === chair) || null;
}

/** Length of the current phase, in ms. */
export function phaseLength(game) {
  if (!game) return 0;
  if (game.phase === PHASES.MUSIC) return isValidMusicMs(game.musicMs) ? game.musicMs : MUSIC_CHOICES_MS[0];
  if (game.phase === PHASES.CLAIMING) return CLAIM_MS;
  if (game.phase === PHASES.REVEAL) return REVEAL_MS;
  return 0;
}

/** Server-time deadline of the current phase (NaN when the start time is unknown). */
export function phaseDeadline(game) {
  return Number.isFinite(game?.phaseAt) ? game.phaseAt + phaseLength(game) : NaN;
}

/** True once the current phase's deadline has passed on the server clock. */
export function isPhaseDue(game, serverNow) {
  const deadline = phaseDeadline(game);
  return Number.isFinite(deadline) && serverNow >= deadline;
}

/** True when every chair is taken — no point waiting out the claim window. */
export function allChairsClaimed(game) {
  return chairCount(game) > 0 && claimedChairs(game).length >= chairCount(game);
}

/** True when every player still in has either grabbed a chair or is offline, so the
 *  claim window can close early (nobody is left who could still act). */
export function everyoneSettled(game, players) {
  const claims = game?.claims || {};
  const keys = activeKeys(game);
  if (!keys.length) return false;
  return keys.every((k) => Number.isInteger(claims[k]) || players?.[k]?.connected === false);
}

/** May `playerKey` claim `chair` right now? (The rules check the same things.) */
export function canClaim(game, playerKey, chair) {
  if (!game || game.status !== 'playing' || game.phase !== PHASES.CLAIMING) return false;
  if (!game.active?.[playerKey]) return false;
  if (!Number.isInteger(chair) || chair < 0 || chair >= chairCount(game)) return false;
  const claims = game.claims || {};
  if (Number.isInteger(claims[playerKey])) return false;          // already seated
  return chairOwner(game, chair) === null;                         // chair still free
}

/* ----------------------------- reducers ----------------------------- */

function operation(type, ownerUid, actorKey, roundId, revision, timestamp) {
  return { type, ownerUid, actorKey, roundId, revision, timestamp };
}

/**
 * Fresh game for the seats that were connected at Start. `phaseAt` is left as 0
 * here — the sync layer overlays a server timestamp sentinel so every device
 * measures the music from the same clock.
 */
export function createGame(playerKeys, ownerUid, timestamp = Date.now(), random = Math.random) {
  const order = [...playerKeys].filter((k) => PLAYER_KEY_RE.test(k)).sort();
  if (order.length < MIN_PLAYERS) throw new Error(`Need at least ${MIN_PLAYERS} players`);
  if (order.length > MAX_PLAYERS) throw new Error(`At most ${MAX_PLAYERS} players`);
  return {
    status: 'playing',
    roundId: timestamp,
    revision: 0,
    round: 1,
    phase: PHASES.MUSIC,
    phaseAt: 0,
    musicMs: pickMusicMs(random),
    order,
    active: Object.fromEntries(order.map((k) => [k, true])),
    operation: operation('start', ownerUid, order[0], timestamp, 0, timestamp),
  };
}

/** music → claiming. Any connected player, once the music deadline has passed. */
export function stopMusic(game, actorKey, ownerUid, timestamp = Date.now()) {
  if (!game || game.status !== 'playing' || game.phase !== PHASES.MUSIC) return null;
  const revision = (game.revision || 0) + 1;
  const next = {
    ...game,
    phase: PHASES.CLAIMING,
    phaseAt: 0,
    revision,
    operation: operation('stop', ownerUid, actorKey, game.roundId, revision, timestamp),
  };
  delete next.claims;
  return next;
}

/**
 * claiming → reveal (or finished). Everyone still in who has no chair is out —
 * unless nobody claimed at all (a whole table asleep), in which case the round is
 * simply replayed so a glitch cannot wipe the game.
 */
export function reveal(game, actorKey, ownerUid, timestamp = Date.now()) {
  if (!game || game.status !== 'playing' || game.phase !== PHASES.CLAIMING) return null;
  const revision = (game.revision || 0) + 1;
  const claims = game.claims || {};
  const anyClaims = claimedChairs(game).length > 0;
  const active = { ...(game.active || {}) };
  const out = { ...(game.out || {}) };
  if (anyClaims) {
    for (const k of activeKeys(game)) {
      if (!Number.isInteger(claims[k])) { delete active[k]; out[k] = game.round; }
    }
  }
  const remaining = Object.keys(active);
  const next = {
    ...game,
    phase: PHASES.REVEAL,
    phaseAt: 0,
    revision,
    active,
    operation: operation('reveal', ownerUid, actorKey, game.roundId, revision, timestamp),
  };
  if (Object.keys(out).length) next.out = out; else delete next.out;
  if (remaining.length === 1) {
    next.status = 'finished';
    next.winnerKey = remaining[0];
  }
  return next;
}

/** reveal → music for round + 1. Any connected player, once the reveal has been shown. */
export function nextRound(game, actorKey, ownerUid, timestamp = Date.now(), random = Math.random) {
  if (!game || game.status !== 'playing' || game.phase !== PHASES.REVEAL) return null;
  if (activeKeys(game).length < 2) return null;
  const revision = (game.revision || 0) + 1;
  const next = {
    ...game,
    round: game.round + 1,
    phase: PHASES.MUSIC,
    phaseAt: 0,
    musicMs: pickMusicMs(random),
    revision,
    operation: operation('next', ownerUid, actorKey, game.roundId, revision, timestamp),
  };
  delete next.claims;
  return next;
}

/** The single transition that is due right now, or null. Used by every device's watchdog. */
export function dueTransition(game, players, serverNow) {
  if (!game || game.status !== 'playing') return null;
  if (game.phase === PHASES.MUSIC) return isPhaseDue(game, serverNow) ? 'stop' : null;
  if (game.phase === PHASES.CLAIMING) {
    return isPhaseDue(game, serverNow) || allChairsClaimed(game) || everyoneSettled(game, players) ? 'reveal' : null;
  }
  if (game.phase === PHASES.REVEAL) return isPhaseDue(game, serverNow) ? 'next' : null;
  return null;
}

/* ----------------------------- results ----------------------------- */

/** Rounds a player lasted: the round they went out in, or every round if they never did. */
export function roundsSurvived(game, key) {
  const outRound = game?.out?.[key];
  return Number.isInteger(outRound) ? outRound : (game?.round || 0);
}

/** Final standings: winner first, then by how long they lasted, then seating order. */
export function standings(game) {
  const keys = orderKeys(game);
  return keys
    .map((key, seat) => ({ key, seat, survived: roundsSurvived(game, key), winner: key === game?.winnerKey }))
    .sort((a, b) => (b.winner - a.winner) || (b.survived - a.survived) || (a.seat - b.seat));
}
