/**
 * Game State Manager — Musical Chairs
 *
 * Holds the local game state and the pure game-logic helpers that drive phase
 * transitions, chair claiming, elimination, and round progression.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MECHANIC (classic musical chairs — no tap race)
 * ─────────────────────────────────────────────────────────────────────────────
 * N active players compete for N-1 chairs. Music plays and avatars orbit. When
 * the music stops, each player drags their own avatar; a claim is attempted as
 * soon as its centre enters a free chair's capture zone, never on release. A
 * chair node is CREATE-ONLY for players under the deployed rules, so the second
 * device racing for the same chair is rejected with PERMISSION_DENIED — that
 * rejection IS the arbitration, there is no server code. Whoever holds no chair
 * when the round resolves is eliminated. Nothing compares timestamps to decide
 * who is out.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MODULE CONTRACT (important for the property tests in tasks 4.1 - 4.5)
 * ─────────────────────────────────────────────────────────────────────────────
 * This module has NO top-level Firebase import and must stay that way. The
 * property tests import it directly in a bare jsdom environment where no
 * Firebase app, auth session, or network is available, so a top-level
 * `import ... from './firebase-config.js'` would break every test on load.
 *
 * Firebase I/O uses lazy dynamic imports inside async wrappers or writers
 * supplied as injected dependency parameters. Pure decision functions remain
 * Firebase-free, with I/O kept in thin wrappers around them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECTION MAP
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. Constants                                        (task 3.1)
 *   2. Local game state                                 (task 3.1)
 *   3. Room code helpers (pure)                         (task 3.1)
 *   4. Player index helpers (pure)                      (task 3.1)
 *   5. Music phase logic                                (task 3.2)
 *   6. Chair claiming logic                             (task 3.3)
 *   7. Elimination logic                                (task 3.4)
 *   8. Round progression, victory, reset, rankings      (task 3.5)
 *   9. Claim phase timeout (10s)                        (task 3.6)
 */

// `firebase-recovery.js` is import-safe: it defines functions only and reaches
// for `firebase-config.js` lazily, so pulling it in here keeps the bare-jsdom
// contract above intact while giving every write retries + error logging.
import { withRetry, logError } from './firebase-recovery.js';

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — CONSTANTS
// ═════════════════════════════════════════════════════════════════════════════

/** Minimum connected players required to start a game (Req 1.7, 2.5). */
export const MIN_PLAYERS = 2;

/** Maximum players per room — indices 0-7 (Req 1.5, 1.7). */
export const MAX_PLAYERS = 8;

/** Firebase player keys are `player_0` .. `player_7`. */
export const PLAYER_KEY_PREFIX = 'player_';

/** Firebase chair keys are `chair_0` .. `chair_6`. */
export const CHAIR_KEY_PREFIX = 'chair_';

/**
 * Highest chair count the deployed rules accept: `$chairId` must match
 * `/^chair_[0-6]$/`, i.e. N-1 chairs for the maximum of 8 players.
 */
export const MAX_CHAIRS = MAX_PLAYERS - 1;

/** Matches a chair ID the deployed rules will accept. */
export const CHAIR_ID_PATTERN = /^chair_[0-6]$/;

/** Room codes are 4 chars, A-Z minus the ambiguous I and O (Req 1.1). */
export const ROOM_CODE_LENGTH = 4;

/** Matches a valid room code: 4 uppercase letters excluding I, O, 1, 0. */
export const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z]{4}$/;

/**
 * Returned by {@link assignPlayerIndex} when the room has no free slot.
 * Chosen over throwing so callers can branch on capacity without try/catch;
 * the join flow (task 6.2) surfaces the "Room is full" toast (Req 1.5).
 */
export const NO_INDEX_AVAILABLE = -1;

/** Valid values for `gameState.phase`. */
export const PHASES = Object.freeze({
  LOBBY: 'lobby',
  MUSIC: 'music',
  CLAIMING: 'claiming',
  ELIMINATION: 'elimination',
  VICTORY: 'victory',
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — LOCAL GAME STATE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Builds a fresh local game state matching the design's `LocalGameState`.
 * Pure factory — safe to call from tests to get an isolated state object.
 *
 * @returns {{
 *   roomCode: string | null,
 *   playerIndex: number | null,
 *   isHost: boolean,
 *   round: number,
 *   activePlayerIds: string[],
 *   musicDuration: number,
 *   musicStartTime: number,
 *   phase: 'lobby' | 'music' | 'claiming' | 'elimination' | 'victory',
 *   eliminatedThisRound: string[],
 *   players: Object<string, { name: string, uid?: string, connected: boolean, eliminated: boolean }>,
 *   chairs: Object<string, { playerId: string, claimedAt: number, round: number }>,
 *   hasLocalPlayerClaimed: boolean,
 *   claimedChairId: string | null,
 *   localTimerRemaining: number,
 *   isAnimatingElimination: boolean
 * }}
 */
export function createInitialGameState() {
  return {
    // Session
    roomCode: null,
    playerIndex: null,
    isHost: false,

    // Synced from Firebase metadata. Missing metadata is legacy v1; fresh local
    // state defaults to v2 so isolated tests and all newly-created rooms use
    // round-tagged claims.
    schemaVersion: 2,
    round: 1,
    activePlayerIds: [],
    musicDuration: 0,
    musicStartTime: 0,
    phase: PHASES.LOBBY,
    eliminatedThisRound: [],
    players: {},
    // `chairs` mirrors normalized Firebase chair records:
    // chairId → { playerId, claimedAt, round }.
    chairs: {},

    // Local UI state
    hasLocalPlayerClaimed: false,
    claimedChairId: null,
    localTimerRemaining: 0,
    isAnimatingElimination: false,
  };
}

/**
 * The single local game state instance used by the UI controller.
 * Mutated in place so the exported binding always reflects current state.
 */
export const gameState = createInitialGameState();

/**
 * Resets the shared `gameState` back to its initial values in place.
 * Used when leaving a room or returning to the menu.
 */
export function resetLocalGameState() {
  Object.assign(gameState, createInitialGameState());
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — ROOM CODE HELPERS (pure)
// ═════════════════════════════════════════════════════════════════════════════
// Note: room code *generation* lives in `firebase-sync.js` (generateRoomCode).
// Only Firebase-free validation belongs here.

/**
 * Validates a room code's format (Req 1.1).
 * @param {unknown} code - Candidate room code
 * @returns {boolean} True for exactly 4 uppercase letters with no I, O, 1 or 0
 */
export function isValidRoomCode(code) {
  return typeof code === 'string' && ROOM_CODE_PATTERN.test(code);
}

/**
 * Normalizes user input into room code form (trim + uppercase).
 * Does not validate — pair with {@link isValidRoomCode}.
 * @param {unknown} input - Raw input from the join screen
 * @returns {string} Normalized candidate code
 */
export function normalizeRoomCode(input) {
  return typeof input === 'string' ? input.trim().toUpperCase() : '';
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — PLAYER INDEX HELPERS (pure)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Builds the Firebase player key for an index.
 * @param {number} index - Player index (0-7)
 * @returns {string} e.g. `player_3`
 */
export function playerKey(index) {
  return `${PLAYER_KEY_PREFIX}${index}`;
}

/**
 * Parses the numeric index out of a player key.
 * @param {string} key - e.g. `player_3`
 * @returns {number} The index, or NaN when the key is malformed
 */
export function playerIndexFromKey(key) {
  if (typeof key !== 'string' || !key.startsWith(PLAYER_KEY_PREFIX)) return NaN;
  const raw = key.slice(PLAYER_KEY_PREFIX.length);
  return /^\d+$/.test(raw) ? Number(raw) : NaN;
}

/**
 * Collects the occupied player indices from a players object, ignoring keys
 * that are malformed or outside the 0-7 range.
 * @param {Object|null|undefined} players - Firebase `players` node
 * @returns {number[]} Sorted ascending list of occupied indices
 */
export function occupiedPlayerIndices(players) {
  if (!players || typeof players !== 'object') return [];
  return Object.keys(players)
    .map(playerIndexFromKey)
    .filter((i) => Number.isInteger(i) && i >= 0 && i < MAX_PLAYERS)
    .sort((a, b) => a - b);
}

/**
 * Counts the players currently occupying a slot (0-7).
 * @param {Object|null|undefined} players - Firebase `players` node
 * @returns {number} Occupied slot count
 */
export function countPlayers(players) {
  return occupiedPlayerIndices(players).length;
}

/**
 * Assigns the lowest unused player index in the range 0-7 (Req 1.3).
 * Reuses gaps left by players who left, so indices stay unique and compact.
 *
 * Pure: does not read or write Firebase and does not mutate `players`.
 *
 * @param {Object|null|undefined} players - Firebase `players` node, e.g.
 *   `{ player_0: {...}, player_2: {...} }`. Null/undefined/empty means an
 *   empty room, which yields index 0.
 * @returns {number} Lowest free index in [0, 7], or
 *   {@link NO_INDEX_AVAILABLE} (-1) when all 8 slots are taken (Req 1.5).
 *   Never throws — callers check for -1 and show "Room is full".
 */
export function assignPlayerIndex(players) {
  const occupied = new Set(occupiedPlayerIndices(players));
  for (let i = 0; i < MAX_PLAYERS; i++) {
    if (!occupied.has(i)) return i;
  }
  return NO_INDEX_AVAILABLE;
}

/**
 * Reports whether the room is at capacity (Req 1.5, 1.7).
 * @param {Object|null|undefined} players - Firebase `players` node
 * @returns {boolean} True once MAX_PLAYERS (8) slots are occupied
 */
export function isRoomFull(players) {
  return countPlayers(players) >= MAX_PLAYERS;
}

/**
 * Player IDs whose `connected` flag is true, in index order.
 * Used to build `activePlayerIds` at game start (Req 3.3) and on reset.
 * @param {Object|null|undefined} players - Firebase `players` node
 * @returns {string[]} e.g. `['player_0', 'player_2']`
 */
export function connectedPlayerIds(players) {
  return occupiedPlayerIndices(players)
    .map(playerKey)
    .filter((key) => players[key]?.connected === true);
}

/**
 * Whether enough connected players are present to start (Req 2.5, 1.7).
 * @param {Object|null|undefined} players - Firebase `players` node
 * @returns {boolean} True at MIN_PLAYERS (2) or more connected players
 */
export function hasEnoughPlayers(players) {
  return connectedPlayerIds(players).length >= MIN_PLAYERS;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — MUSIC PHASE LOGIC  (task 3.2)
// ═════════════════════════════════════════════════════════════════════════════
// Pure: generateMusicDuration, buildMusicPhaseState, toFirebaseGameState, roomPath
// Firebase I/O (host only): startMusicPhase, startClaimPhase
// Timers: startMusicCountdown / clearMusicCountdown

/** Shortest music phase, in ms (Req 4.1). Firebase rules reject anything less. */
export const MUSIC_DURATION_MIN_MS = 30000;

/** Longest music phase, in ms (Req 4.1). Firebase rules reject anything more. */
export const MUSIC_DURATION_MAX_MS = 60000;

/** Optional remaining-time tick cadence; an independent timeout controls expiry. */
export const MUSIC_TICK_INTERVAL_MS = 100;

/** Root node holding every room (Req 1.2, 18.1). */
export const ROOM_PATH_PREFIX = 'musical-chairs-rooms';

/**
 * Absolute Firebase path inside a room.
 * @param {string} roomCode - 4-character room code
 * @param {string} [suffix] - Child path, e.g. `game/phase`
 * @returns {string} e.g. `musical-chairs-rooms/ABCD/game/phase`
 */
export function roomPath(roomCode, suffix = '') {
  const base = `${ROOM_PATH_PREFIX}/${roomCode}`;
  return suffix ? `${base}/${suffix}` : base;
}

/* ------------------------------ Firebase glue ----------------------------- */
// Everything below keeps Firebase out of module scope: the property tests load
// this file in bare jsdom. Each writer either uses an injected `writer`
// (tests) or lazily imports `firebase-config.js` + `firebase/database`.

/**
 * Resolves the Firebase Realtime Database handle and the `update` helper.
 * Lazy on purpose — see the module contract at the top of the file.
 * @returns {Promise<{ db: any, ref: Function, update: Function }>}
 */
async function loadDatabase() {
  const [config, rtdb] = await Promise.all([
    import('./firebase-config.js'),
    import('firebase/database'),
  ]);
  return { db: config.db, ref: rtdb.ref, update: rtdb.update };
}

/**
 * Resolves a `serverTimestamp()` sentinel (Req 12.3 — never a client clock).
 * @param {{ serverTimestamp?: Function }} [options] - Injectable for tests
 * @returns {Promise<any>} The sentinel to write
 */
async function resolveServerTimestamp(options = {}) {
  if (typeof options.serverTimestamp === 'function') return options.serverTimestamp();
  const rtdb = await import('firebase/database');
  return rtdb.serverTimestamp();
}

/**
 * Applies a multi-location update at the database root, or hands it to the
 * injected writer. Multi-location updates are validated path-by-path, so a
 * host-only path and `meta/lastActivity` can safely travel together.
 * @param {Object<string, any>} updates - Absolute path → value map
 * @param {{ writer?: (updates: Object) => Promise<any> }} [options]
 * @returns {Promise<any>}
 */
async function applyUpdates(updates, options = {}) {
  if (typeof options.writer === 'function') return options.writer(updates);
  const { db, ref, update } = await loadDatabase();
  return update(ref(db), updates);
}

/**
 * Whether the caller is allowed to write host-only nodes (`game`, the whole
 * `chairs` node, `rankings`, `players/*`). Defaults to the shared local state.
 * @param {{ isHost?: boolean }} [options]
 * @returns {boolean}
 */
function isHostWriter(options = {}) {
  return (options.isHost !== undefined ? options.isHost : gameState.isHost) === true;
}

/**
 * Recognises a rules rejection. For {@link claimChair} this is the EXPECTED
 * outcome of losing a race for a chair, not an error.
 * @param {any} error - Caught Firebase error
 * @returns {boolean}
 */
function isPermissionDenied(error) {
  if (!error) return false;
  const text = `${error.code || ''} ${error.message || ''}`.toLowerCase();
  return text.includes('permission_denied') || text.includes('permission-denied');
}

/* ------------------------------- pure logic ------------------------------ */

/**
 * Random music duration for a round (Req 4.1, Property 6).
 * Integer milliseconds in the inclusive range [30000, 60000] — the same range
 * the deployed Firebase rules validate `game/musicDuration` against. Change one
 * and you MUST change the other, or every music-phase write is rejected.
 *
 * @param {() => number} [random=Math.random] - Injectable RNG for tests
 * @returns {number} Integer in [MUSIC_DURATION_MIN_MS, MUSIC_DURATION_MAX_MS]
 */
export function generateMusicDuration(random = Math.random) {
  const span = MUSIC_DURATION_MAX_MS - MUSIC_DURATION_MIN_MS + 1;
  const roll = typeof random === 'function' ? random() : Math.random();
  const safe = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 0.9999999999) : 0;
  return MUSIC_DURATION_MIN_MS + Math.floor(safe * span);
}

/**
 * Builds the `game` object for a fresh music phase (Req 4.1, 4.2, Property 7).
 * Pure — no Firebase, no mutation of the inputs. `musicStartTime` is left at 0
 * because only the host's write may set it, and it must come from
 * `serverTimestamp()` (Req 4.3, 12.3).
 *
 * @param {number} round - Round number (1-based)
 * @param {string[]} activePlayerIds - Players still in play
 * @param {Object} [options]
 * @param {number} [options.musicDuration] - Override the random duration (tests)
 * @param {() => number} [options.random] - Injectable RNG
 * @returns {{
 *   round: number,
 *   activePlayerIds: string[],
 *   musicDuration: number,
 *   musicStartTime: number,
 *   phase: 'music',
 *   eliminatedThisRound: string[],
 *   winnerId: null
 * }}
 */
export function buildMusicPhaseState(round, activePlayerIds, options = {}) {
  const safeRound = Number.isFinite(round) && round >= 1 ? Math.floor(round) : 1;
  const ids = Array.isArray(activePlayerIds) ? [...activePlayerIds] : [];
  const duration = Number.isFinite(options.musicDuration)
    ? Math.round(options.musicDuration)
    : generateMusicDuration(options.random);

  return {
    round: safeRound,
    activePlayerIds: ids,
    musicDuration: duration,
    musicStartTime: 0,
    phase: PHASES.MUSIC,
    eliminatedThisRound: [],
    winnerId: null,
  };
}

/**
 * Projects any state object down to exactly the keys the deployed rules accept
 * under `game`. Local-only fields (`chairs`, `players`, UI flags) are dropped and
 * `winnerId` is only kept when it matches `player_[0-7]`.
 *
 * @param {Object} state - Local or partial game state
 * @returns {Object} Firebase-ready `game` node
 */
export function toFirebaseGameState(state) {
  const src = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  const activePlayerIds = uniqueIds(src.activePlayerIds).filter(isValidWinnerId);
  const eliminatedThisRound = uniqueIds(src.eliminatedThisRound)
    .filter((id) => isValidWinnerId(id) && !activePlayerIds.includes(id));
  const duration = Number.isInteger(src.musicDuration)
    && (src.musicDuration === 0
      || (src.musicDuration >= MUSIC_DURATION_MIN_MS && src.musicDuration <= MUSIC_DURATION_MAX_MS))
    ? src.musicDuration
    : 0;

  const node = {
    round: Number.isInteger(src.round) && src.round >= 1 ? src.round : 1,
    activePlayerIds,
    musicDuration: duration,
    musicStartTime: Number.isFinite(src.musicStartTime) && src.musicStartTime >= 0
      ? src.musicStartTime
      : 0,
    phase: Object.values(PHASES).includes(src.phase) ? src.phase : PHASES.LOBBY,
    eliminatedThisRound,
  };
  if (isValidWinnerId(src.winnerId) && activePlayerIds.includes(src.winnerId)) {
    node.winnerId = src.winnerId;
  }
  return node;
}

/* ------------------------------ Firebase I/O ----------------------------- */

/**
 * HOST ONLY. Starts a music phase in Firebase (Req 3.4, 4.1, 4.2, 4.3, 12.3).
 *
 * The deployed rules make the whole `game` node host-writable only, so a
 * non-host call resolves with `{ ok: false, skipped: 'not-host' }` instead of
 * generating a write the rules would reject. The whole `chairs` node is cleared
 * in the same atomic update so round R+1 never sees round R's chairs
 * (Property 15) — the host is the only writer allowed to clear it.
 *
 * @param {string} roomCode - Room code
 * @param {Object} [options]
 * @param {boolean} [options.isHost] - Defaults to `gameState.isHost`
 * @param {number} [options.round] - Defaults to `gameState.round`
 * @param {string[]} [options.activePlayerIds] - Defaults to `gameState.activePlayerIds`
 * @param {number} [options.musicDuration] - Override the random duration
 * @param {Function} [options.serverTimestamp] - Injectable sentinel factory
 * @param {(updates: Object) => Promise<any>} [options.writer] - Injectable writer
 * @returns {Promise<{ ok: boolean, skipped?: string, round: number,
 *   musicDuration: number, attempts?: number, error?: any, message?: string|null }>}
 */
export async function startMusicPhase(roomCode, options = {}) {
  const round = options.round !== undefined ? options.round : gameState.round;
  const activePlayerIds = options.activePlayerIds !== undefined
    ? options.activePlayerIds
    : gameState.activePlayerIds;
  const phaseState = buildMusicPhaseState(round, activePlayerIds, options);

  if (!isHostWriter(options)) {
    return { ok: false, skipped: 'not-host', round: phaseState.round, musicDuration: phaseState.musicDuration };
  }

  const startedAt = await resolveServerTimestamp(options);
  const updates = {
    [roomPath(roomCode, 'game/round')]: phaseState.round,
    [roomPath(roomCode, 'game/activePlayerIds')]: phaseState.activePlayerIds,
    [roomPath(roomCode, 'game/musicDuration')]: phaseState.musicDuration,
    [roomPath(roomCode, 'game/musicStartTime')]: startedAt,
    [roomPath(roomCode, 'game/phase')]: PHASES.MUSIC,
    [roomPath(roomCode, 'game/eliminatedThisRound')]: null,
    [roomPath(roomCode, 'chairs')]: null,
    [roomPath(roomCode, 'meta/lastActivity')]: startedAt,
  };

  const result = await withRetry(() => applyUpdates(updates, options), {
    context: 'startMusicPhase',
    metadata: { roomCode, round: phaseState.round, musicDuration: phaseState.musicDuration },
  });

  return {
    ok: result.ok,
    round: phaseState.round,
    musicDuration: phaseState.musicDuration,
    attempts: result.attempts,
    error: result.error,
    message: result.message ?? null,
  };
}

/**
 * HOST ONLY. Flips the room into the claiming phase (Req 4.4, 6.1, Property 7).
 * Called from the music countdown's expiry hook on the host device; every other
 * device reacts to the Firebase update instead. Chairs are already empty at this
 * point because {@link startMusicPhase} cleared them.
 *
 * @param {string} roomCode - Room code
 * @param {Object} [options] - Same shape as {@link startMusicPhase}
 * @returns {Promise<{ ok: boolean, skipped?: string, attempts?: number,
 *   error?: any, message?: string|null }>}
 */
export async function startClaimPhase(roomCode, options = {}) {
  if (!isHostWriter(options)) return { ok: false, skipped: 'not-host' };

  const activityAt = await resolveServerTimestamp(options);
  const updates = {
    [roomPath(roomCode, 'game/phase')]: PHASES.CLAIMING,
    [roomPath(roomCode, 'meta/lastActivity')]: activityAt,
  };

  const result = await withRetry(() => applyUpdates(updates, options), {
    context: 'startClaimPhase',
    metadata: { roomCode },
  });

  return {
    ok: result.ok,
    attempts: result.attempts,
    error: result.error,
    message: result.message ?? null,
  };
}

/* -------------------------------- timers -------------------------------- */

let musicTickTimer = null;
let musicExpiryTimer = null;
let musicDeadlineAt = 0;

/**
 * Runs the hidden local music countdown and transitions to the claiming phase
 * when the duration expires (Req 4.4). Every device runs its own timer: the
 * interval maintains optional remaining-time state and callbacks, while the
 * timeout controls expiry independently of tick cadence.
 *
 * Cancellable and single-instance — starting a new countdown clears the old one,
 * so timers cannot leak across rounds.
 *
 * @param {number} durationMs - Music duration from Firebase
 * @param {Object} [options]
 * @param {(remainingMs: number, totalMs: number) => void} [options.onTick]
 * @param {() => void} [options.onExpire] - Host wires this to {@link startClaimPhase}
 * @param {number} [options.intervalMs=100] - Tick cadence
 * @param {Object|null} [options.state] - State whose `localTimerRemaining` to update
 * @returns {() => void} The cancel function ({@link clearMusicCountdown})
 */
export function startMusicCountdown(durationMs, options = {}) {
  const { onTick, onExpire, intervalMs = MUSIC_TICK_INTERVAL_MS } = options;
  const state = options.state !== undefined ? options.state : gameState;

  clearMusicCountdown();

  const total = Number.isFinite(durationMs) && durationMs > 0
    ? Math.round(durationMs)
    : MUSIC_DURATION_MIN_MS;
  musicDeadlineAt = Date.now() + total;
  if (state) state.localTimerRemaining = total;

  const emit = (remaining) => {
    if (state) state.localTimerRemaining = remaining;
    if (typeof onTick !== 'function') return;
    try {
      onTick(remaining, total);
    } catch (error) {
      logError('musicCountdownTick', error, { remaining, total });
    }
  };

  musicTickTimer = setInterval(() => {
    emit(Math.max(0, musicDeadlineAt - Date.now()));
  }, Math.max(16, intervalMs));

  musicExpiryTimer = setTimeout(() => {
    clearMusicCountdown();
    emit(0);
    if (typeof onExpire !== 'function') return;
    try {
      onExpire();
    } catch (error) {
      logError('musicCountdownExpire', error, { total });
    }
  }, total);

  return clearMusicCountdown;
}

/** Cancels the music countdown. Safe to call when nothing is running. */
export function clearMusicCountdown() {
  if (musicTickTimer !== null) {
    clearInterval(musicTickTimer);
    musicTickTimer = null;
  }
  if (musicExpiryTimer !== null) {
    clearTimeout(musicExpiryTimer);
    musicExpiryTimer = null;
  }
}

/** Whether a music countdown is currently running. */
export function isMusicCountdownActive() {
  return musicExpiryTimer !== null;
}

/**
 * Milliseconds left on the music countdown, or 0 when idle.
 * @returns {number}
 */
export function getMusicCountdownRemaining() {
  if (!isMusicCountdownActive()) return 0;
  return Math.max(0, musicDeadlineAt - Date.now());
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — CHAIR CLAIMING LOGIC  (task 3.3)
// ═════════════════════════════════════════════════════════════════════════════
// Pure: chairCountFor, chairIds, isValidChairId, chairId, canClaimChair,
//       seatedPlayerIds, chairOf, resolveDuplicateClaims
// Firebase I/O (own chair only): claimChair

/**
 * Chairs available this round: one fewer than the number of active players
 * (Req 6.1). Floored at 0 and capped at {@link MAX_CHAIRS} so the result always
 * maps onto chair IDs the deployed rules accept.
 *
 * Pure — does not mutate `activePlayerIds`.
 *
 * @param {string[]|null|undefined} activePlayerIds - Players still in play
 * @returns {number} N-1, clamped to [0, 7]
 */
export function chairCountFor(activePlayerIds) {
  const count = uniqueIds(activePlayerIds).length;
  return Math.min(Math.max(count - 1, 0), MAX_CHAIRS);
}

/**
 * Builds the Firebase chair key for an index.
 * @param {number} index - Chair index (0-6)
 * @returns {string} e.g. `chair_2`
 */
export function chairKey(index) {
  return `${CHAIR_KEY_PREFIX}${index}`;
}

/**
 * The chair IDs for a round, in seating order (Req 6.1).
 * @param {number} count - Chair count, usually {@link chairCountFor}'s output
 * @returns {string[]} e.g. `['chair_0', 'chair_1']`; empty for 0/invalid counts
 */
export function chairIds(count) {
  if (!Number.isFinite(count)) return [];
  const total = Math.min(Math.max(Math.floor(count), 0), MAX_CHAIRS);
  return Array.from({ length: total }, (_, i) => chairKey(i));
}

/**
 * Whether a chair ID is writable under the deployed rules (`/^chair_[0-6]$/`).
 * @param {unknown} id - Candidate chair ID
 * @returns {boolean}
 */
export function isValidChairId(id) {
  return typeof id === 'string' && CHAIR_ID_PATTERN.test(id);
}

/**
 * Normalizes a `chairs` node into
 * `{ chairId: { playerId, claimedAt, round } }`, dropping malformed entries.
 * Pure — always a fresh object.
 *
 * Raw legacy schema-v1 input may omit `round`; normalized records always carry
 * the authoritative current round. A claim is accepted only when its exact
 * schema matches the room version and it agrees with all authoritative round
 * context supplied by the caller (or the shared `gameState` when UI callers
 * omit options). Stale or partially-synced data must never decide an
 * elimination.
 *
 * @param {Object|null|undefined} chairs - Firebase `chairs` node
 * @param {Object} [options] - Authoritative game context; defaults field-by-field
 *   to the shared `gameState`
 * @param {number} [options.round] - Current `game.round`
 * @param {string} [options.phase] - Current `game.phase`
 * @param {string[]} [options.activePlayerIds] - Current active IDs
 * @param {Object} [options.players] - Current `players` node
 * @returns {Object<string, { playerId: string, claimedAt: number, round: number }>}
 */
export function normalizeChairs(chairs, options = {}) {
  if (!chairs || typeof chairs !== 'object' || Array.isArray(chairs)) return {};

  const round = options.round !== undefined ? options.round : gameState.round;
  const schemaVersion = options.schemaVersion !== undefined
    ? options.schemaVersion
    : (gameState.schemaVersion ?? 2);
  const isLegacy = schemaVersion === 1;
  const phase = options.phase !== undefined ? options.phase : gameState.phase;
  const sourceActiveIds = options.activePlayerIds !== undefined
    ? options.activePlayerIds
    : gameState.activePlayerIds;
  const players = options.players !== undefined ? options.players : gameState.players;
  if (!Number.isInteger(round) || round < 1 || phase !== PHASES.CLAIMING) return {};
  if (!players || typeof players !== 'object' || Array.isArray(players)) return {};

  const activePlayerIds = uniqueIds(sourceActiveIds).filter(isValidWinnerId);
  const active = new Set(activePlayerIds);
  const availableChairs = new Set(chairIds(chairCountFor(activePlayerIds)));
  const out = {};

  for (const [id, record] of Object.entries(chairs)) {
    if (!availableChairs.has(id) || !record || typeof record !== 'object' || Array.isArray(record)) continue;
    const keys = Object.keys(record).sort();
    const exactV2 = keys.length === 3
      && keys[0] === 'claimedAt'
      && keys[1] === 'playerId'
      && keys[2] === 'round';
    const exactLegacy = keys.length === 2
      && keys[0] === 'claimedAt'
      && keys[1] === 'playerId';
    if (isLegacy ? !exactLegacy : !exactV2) continue;
    if (!isValidWinnerId(record.playerId) || !active.has(record.playerId)) continue;
    if (!Number.isFinite(record.claimedAt)) continue;
    if (!isLegacy && (!Number.isInteger(record.round) || record.round !== round)) continue;

    const player = players[record.playerId];
    if (!player || player.connected !== true || player.eliminated !== false) continue;

    out[id] = {
      playerId: record.playerId,
      claimedAt: record.claimedAt,
      round: isLegacy ? round : record.round,
    };
  }
  return out;
}

/** Chair IDs in seating order (chair_0, chair_1, …). */
function sortedChairIds(chairs) {
  return Object.keys(chairs).sort((a, b) => {
    const ai = Number(a.slice(CHAIR_KEY_PREFIX.length));
    const bi = Number(b.slice(CHAIR_KEY_PREFIX.length));
    return ai - bi;
  });
}

/**
 * Player IDs currently holding a chair (Req 7.1).
 * Pure — order follows the chairs (chair_0 first). Historical, malformed, or
 * partially synchronized same-player duplicates are collapsed defensively;
 * schema-v2 rules prevent new duplicates.
 *
 * @param {Object|null|undefined} chairs - Firebase `chairs` node
 * @returns {string[]} Seated player IDs
 */
export function seatedPlayerIds(chairs, options = {}) {
  const normalized = normalizeChairs(chairs, options);
  const seen = new Set();
  const out = [];
  for (const id of sortedChairIds(normalized)) {
    const playerId = normalized[id].playerId;
    if (seen.has(playerId)) continue;
    seen.add(playerId);
    out.push(playerId);
  }
  return out;
}

/**
 * The chair a player is sitting on, if any (Req 6.4).
 * For defensive historical, malformed, or partially synchronized duplicate
 * data, the lowest-numbered chair is reported; {@link resolveDuplicateClaims}
 * performs the full deterministic reconciliation.
 *
 * @param {Object|null|undefined} chairs - Firebase `chairs` node
 * @param {string} playerId - e.g. `player_2`
 * @returns {string|null} chairId, or null when the player has no chair
 */
export function chairOf(chairs, playerId, options = {}) {
  if (typeof playerId !== 'string') return null;
  const normalized = normalizeChairs(chairs, options);
  for (const id of sortedChairIds(normalized)) {
    if (normalized[id].playerId === playerId) return id;
  }
  return null;
}

/**
 * Guard for a drag-to-claim gesture (Req 6.6, 6.7, Property 8).
 * Pure — reads the state object, never writes it.
 *
 * True only when all four hold:
 *   1. `phase === 'claiming'`
 *   2. the local player is in `activePlayerIds`
 *   3. the local player has not already claimed
 *      (`hasLocalPlayerClaimed` / `claimedChairId` latch, or a chair already
 *      held in the local `chairs` mirror)
 *   4. that chair is unclaimed in the local `chairs` mirror
 *
 * Losing a race that the local mirror had not caught up on is still possible;
 * the rules reject that write and {@link claimChair} reports `'chair-taken'`.
 *
 * @param {Object|null|undefined} state - Local game state (or a test stand-in).
 *   Uses `phase`, `activePlayerIds`, `chairs`, `hasLocalPlayerClaimed`,
 *   `claimedChairId`, and the local identity from `playerId` or `playerIndex`.
 * @param {string} chairId - Chair the player is dragging onto
 * @returns {boolean}
 */
export function canClaimChair(state, chairId) {
  if (!state || typeof state !== 'object') return false;
  if (state.phase !== PHASES.CLAIMING) return false;
  if (!Number.isInteger(state.round) || state.round < 1) return false;
  if (!isValidChairId(chairId)) return false;
  if (state.hasLocalPlayerClaimed === true) return false;
  if (typeof state.claimedChairId === 'string' && state.claimedChairId.length > 0) return false;

  const id = typeof state.playerId === 'string'
    ? state.playerId
    : (Number.isInteger(state.playerIndex) ? playerKey(state.playerIndex) : null);
  if (!isValidWinnerId(id)) return false;

  const active = uniqueIds(state.activePlayerIds);
  if (!active.includes(id)) return false;
  if (!chairIds(chairCountFor(active)).includes(chairId)) return false;

  const player = state.players && typeof state.players === 'object' ? state.players[id] : null;
  if (!player || player.connected !== true || player.eliminated !== false) return false;

  const context = {
    schemaVersion: state.schemaVersion ?? 2,
    round: state.round,
    phase: state.phase,
    activePlayerIds: active,
    players: state.players,
  };
  const chairs = normalizeChairs(state.chairs, context);
  if (chairs[chairId]) return false;                 // chair already taken locally
  if (chairOf(chairs, id, context) !== null) return false; // this player already sat down

  return true;
}

/**
 * Reconciles defensive input in which one player holds two or more chairs
 * (Req 7.1).
 *
 * Current deployed rules scan sibling chair IDs and reject a second chair for
 * the same player. This helper is defense-in-depth for historical legacy,
 * malformed, or partially synchronized data. It deterministically keeps the
 * earliest `claimedAt`; ties keep the lower-numbered chair so every device
 * reaches the same answer.
 *
 * Pure — returns a fresh chairs map; `chairs` is never mutated.
 *
 * @param {Object|null|undefined} chairs - Raw Firebase `chairs` node; legacy
 *   input may omit `round`
 * @returns {{ chairs: Object<string, { playerId: string, claimedAt: number, round: number }>,
 *   releasedChairIds: string[] }} Cleaned map plus the chairs that were released
 *   (in seating order)
 */
export function resolveDuplicateClaims(chairs, options = {}) {
  const normalized = normalizeChairs(chairs, options);
  const order = sortedChairIds(normalized);

  /** playerId → chairId currently winning. */
  const keptByPlayer = new Map();
  const released = [];

  for (const id of order) {
    const { playerId, claimedAt } = normalized[id];
    const incumbent = keptByPlayer.get(playerId);
    if (incumbent === undefined) {
      keptByPlayer.set(playerId, id);
      continue;
    }
    // Earliest claimedAt wins; equal timestamps keep the lower chair index,
    // which `order` guarantees is the incumbent.
    if (claimedAt < normalized[incumbent].claimedAt) {
      released.push(incumbent);
      keptByPlayer.set(playerId, id);
    } else {
      released.push(id);
    }
  }

  const kept = {};
  const keptIds = new Set(keptByPlayer.values());
  for (const id of order) {
    if (keptIds.has(id)) kept[id] = { ...normalized[id] };
  }

  return { chairs: kept, releasedChairIds: released.sort((a, b) => order.indexOf(a) - order.indexOf(b)) };
}

/** Internal sentinel: the rules rejected the claim because the chair was taken. */
const CHAIR_TAKEN = Symbol('chair-taken');

/**
 * Claims a chair for the local player (Req 6.3, 6.4, 6.6, 12.3).
 *
 * `hasLocalPlayerClaimed` / `claimedChairId` are latched BEFORE the write so a
 * second drag during the round-trip cannot produce a second write (Property 8).
 *
 * ARBITRATION: `chairs/{chairId}` is CREATE-ONLY for players and the written
 * `playerId` must own the caller's uid, so when two devices race for one chair
 * the loser's write comes back PERMISSION_DENIED. That is the whole arbitration
 * mechanism — there is no server code and no timestamp comparison. A lost race
 * is EXPECTED: it resolves as `{ ok: false, reason: 'chair-taken' }`, is not
 * logged as an error, and must not raise a scary toast. The UI bounces the
 * avatar back and the player drags to another chair, so both latches are
 * released before returning.
 *
 * Any other write failure also releases the latches so the player can retry.
 * The latches prevent duplicate local attempts, while deployed sibling checks
 * reject a second chair for the same player.
 *
 * @param {string} roomCode - Room code
 * @param {string} chairId - Target chair, `chair_0` .. `chair_6`
 * @param {number} [playerIndex] - Defaults to `gameState.playerIndex`
 * @param {Object} [options]
 * @param {Object} [options.state] - State to latch, defaults to shared `gameState`
 * @param {boolean} [options.force] - Skip {@link canClaimChair} (recovery paths)
 * @param {Function} [options.serverTimestamp] - Injectable sentinel factory
 * @param {(updates: Object) => Promise<any>} [options.writer] - Injectable writer
 * @returns {Promise<{ ok: boolean, claimed: boolean, reason: 'claimed'|'chair-taken'|
 *   'write-failed'|'invalid-player-index'|'invalid-chair-id'|'claim-not-allowed',
 *   chairId: string|null, playerId?: string, attempts?: number, error?: any,
 *   message?: string|null }>}
 */
export async function claimChair(roomCode, chairId, playerIndex, options = {}) {
  const state = options.state || gameState;
  const index = Number.isInteger(playerIndex) ? playerIndex : state.playerIndex;

  if (!Number.isInteger(index) || index < 0 || index >= MAX_PLAYERS) {
    return { ok: false, claimed: false, reason: 'invalid-player-index', chairId: null };
  }
  if (!isValidChairId(chairId)) {
    return { ok: false, claimed: false, reason: 'invalid-chair-id', chairId: null };
  }

  const playerId = playerKey(index);
  const round = state.round;
  const claimState = { ...state, playerIndex: index, playerId };
  if (options.force === true) {
    claimState.hasLocalPlayerClaimed = false;
    claimState.claimedChairId = null;
  }
  if (!canClaimChair(claimState, chairId)) {
    return { ok: false, claimed: false, reason: 'claim-not-allowed', chairId };
  }

  // Idempotency latch — set before the await (Property 8, Req 6.6).
  state.hasLocalPlayerClaimed = true;
  state.claimedChairId = chairId;

  const claimedAt = await resolveServerTimestamp(options);
  const claimRecord = { playerId, claimedAt };
  if ((state.schemaVersion ?? 2) !== 1) claimRecord.round = round;
  const updates = {
    [roomPath(roomCode, `chairs/${chairId}`)]: claimRecord,
    [roomPath(roomCode, 'meta/lastActivity')]: claimedAt,
  };

  // A rules rejection is converted into a resolved sentinel so it never reaches
  // `withRetry`'s error channel: no retry, no logError, no error toast.
  const result = await withRetry(async () => {
    try {
      return await applyUpdates(updates, options);
    } catch (error) {
      if (isPermissionDenied(error)) return CHAIR_TAKEN;
      throw error;
    }
  }, {
    context: 'claimChair',
    metadata: { roomCode, playerIndex: index, chairId },
  });

  if (result.ok && result.value !== CHAIR_TAKEN) {
    return { ok: true, claimed: true, reason: 'claimed', chairId, playerId, attempts: result.attempts };
  }

  // Either the chair was taken or the write failed — let the player drag again.
  state.hasLocalPlayerClaimed = false;
  state.claimedChairId = null;

  if (result.ok) {
    // Expected outcome of a lost race. Informational only, never an error.
    console.info(`[game-manager] ${chairId} was already claimed — ${playerId} must pick another chair`);
    return { ok: false, claimed: false, reason: 'chair-taken', chairId, playerId, attempts: result.attempts };
  }

  return {
    ok: false,
    claimed: false,
    reason: 'write-failed',
    chairId,
    playerId,
    attempts: result.attempts,
    error: result.error,
    message: result.message ?? null,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — ELIMINATION LOGIC  (task 3.4)
// ═════════════════════════════════════════════════════════════════════════════
// All pure: determineElimination

/**
 * Decides who leaves the game this round (Req 7.1, 7.2, 7.3, 11.5).
 *
 * One rule: with N-1 chairs for N players, whoever holds no chair when the round
 * resolves is eliminated. No timestamps are compared to pick a loser;
 * `claimedAt` is used only by the defensive legacy/malformed-data duplicate
 * reconciliation in {@link resolveDuplicateClaims}, which runs first.
 *
 * A player whose `connected` flag is false counts as UNSEATED even if a stale
 * claim exists, because a player disconnected at the end of the claiming phase
 * is treated as not having claimed (Req 11.5).
 *
 * Pure and Firebase-free — neither `chairs` nor `activePlayerIds` is mutated.
 *
 * @param {Object<string, {playerId: string, claimedAt: number, round?: number}>|null|undefined} chairs -
 *   Raw `chairs` node; legacy input may omit `round`
 * @param {string[]} activePlayerIds - Players still in play
 * @param {Object} [options]
 * @param {Object} [options.players] - `players` node; disconnected actives count
 *   as unseated (Req 11.5)
 * @returns {{
 *   eliminatedPlayerIds: string[],
 *   reason: 'unseated' | 'all-seated' | 'no-active-players',
 *   seated: string[],
 *   unseated: string[]
 * }} `seated` / `unseated` both follow `activePlayerIds` order
 */
export function determineElimination(chairs, activePlayerIds, options = {}) {
  const ids = uniqueIds(activePlayerIds).filter(isValidWinnerId);
  if (ids.length === 0) {
    return {
      eliminatedPlayerIds: [], reason: 'no-active-players', seated: [], unseated: [], chairs: {},
    };
  }

  const players = options.players && typeof options.players === 'object' ? options.players : {};
  const context = {
    round: options.round,
    phase: options.phase,
    activePlayerIds: ids,
    players,
  };
  const { chairs: cleaned } = resolveDuplicateClaims(chairs, context);
  const seatedSet = new Set(seatedPlayerIds(cleaned, context));

  const seated = [];
  const unseated = [];
  for (const id of ids) {
    if (seatedSet.has(id)) seated.push(id);
    else unseated.push(id);
  }

  return {
    eliminatedPlayerIds: unseated,
    reason: unseated.length > 0 ? 'unseated' : 'all-seated',
    seated,
    unseated,
    chairs: cleaned,
  };
}

/**
 * Normalizes an ID list: strings only, duplicates removed, order preserved.
 * @param {unknown} ids - Candidate list
 * @returns {string[]}
 */
function uniqueIds(ids) {
  if (!Array.isArray(ids)) return [];
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — ROUND PROGRESSION, VICTORY, RESET, RANKINGS  (task 3.5)
// ═════════════════════════════════════════════════════════════════════════════
// Pure: applyElimination, advanceToNextRound, checkVictory, isValidWinnerId,
//       resolveRoundOutcome, resetGame, computeFinalRankings
// Firebase I/O (host only): persistVictory

/** `game/winnerId` must match `player_[0-7]` or the deployed rules reject it. */
export const WINNER_ID_PATTERN = /^player_[0-7]$/;

/**
 * Whether a winner ID is writable to `game/winnerId` under the deployed rules.
 * @param {unknown} id - Candidate winner ID
 * @returns {boolean}
 */
export function isValidWinnerId(id) {
  return typeof id === 'string' && WINNER_ID_PATTERN.test(id);
}

/**
 * Applies an elimination to a game state (Req 7.4, 7.5, 7.6, Properties 11, 12).
 *
 * Pure: returns a new state object with cloned `players` entries; the input is
 * never mutated.
 *
 * @param {Object} state - Current game state
 * @param {string[]} eliminatedPlayerIds - IDs from {@link determineElimination}
 * @returns {Object} New state with `eliminated: true` on each affected player,
 *   those IDs removed from `activePlayerIds`, `eliminatedThisRound` populated,
 *   and `phase: 'elimination'`
 */
export function applyElimination(state, eliminatedPlayerIds) {
  const base = state && typeof state === 'object' ? state : createInitialGameState();
  const eliminated = uniqueIds(eliminatedPlayerIds);
  const active = uniqueIds(base.activePlayerIds);

  const players = {};
  for (const [id, player] of Object.entries(base.players || {})) {
    players[id] = { ...player };
  }
  for (const id of eliminated) {
    players[id] = { ...(players[id] || {}), eliminated: true };
  }

  return {
    ...base,
    activePlayerIds: active.filter((id) => !eliminated.includes(id)),
    eliminatedThisRound: eliminated,
    players,
    phase: PHASES.ELIMINATION,
  };
}

/**
 * Opens the next round (Req 9.1, 9.4, Properties 13, 15).
 *
 * Increments `round` by exactly 1, clears every chair from the finished round,
 * clears `eliminatedThisRound`, and stages a fresh music phase. Pure — returns a
 * new object; the input state and its `chairs` are untouched.
 *
 * @param {Object} state - State after the elimination animation
 * @param {Object} [options]
 * @param {number} [options.musicDuration] - Override the random duration (tests)
 * @param {() => number} [options.random] - Injectable RNG
 * @returns {Object} New state for round R+1
 */
export function advanceToNextRound(state, options = {}) {
  const base = state && typeof state === 'object' ? state : createInitialGameState();
  const round = Number.isFinite(base.round) && base.round >= 1 ? Math.floor(base.round) : 1;

  return {
    ...base,
    round: round + 1,
    chairs: {},
    eliminatedThisRound: [],
    phase: PHASES.MUSIC,
    musicDuration: Number.isFinite(options.musicDuration)
      ? Math.round(options.musicDuration)
      : generateMusicDuration(options.random),
    musicStartTime: 0,
    hasLocalPlayerClaimed: false,
    claimedChairId: null,
    localTimerRemaining: 0,
    isAnimatingElimination: false,
  };
}

/**
 * Victory check (Req 9.3, 10.1, 10.2, Property 16).
 * @param {string[]} activePlayerIds - Players still in play
 * @returns {string|null} The winner's ID when exactly 1 player remains, else null
 */
export function checkVictory(activePlayerIds) {
  const ids = uniqueIds(activePlayerIds);
  return ids.length === 1 ? ids[0] : null;
}

/**
 * Decides what happens after an elimination (Req 9.2, 9.3, Property 14).
 * Pure — delegates to {@link checkVictory} and {@link advanceToNextRound}.
 *
 * @param {Object} state - State returned by {@link applyElimination}
 * @param {Object} [options] - Forwarded to {@link advanceToNextRound}
 * @returns {{
 *   outcome: 'victory' | 'next-round' | 'no-players',
 *   winnerId: string|null,
 *   nextState: Object
 * }} `nextState` is the victory state or the round R+1 state
 */
export function resolveRoundOutcome(state, options = {}) {
  const base = state && typeof state === 'object' ? state : createInitialGameState();
  const active = uniqueIds(base.activePlayerIds);
  const winnerId = checkVictory(active);

  if (winnerId) {
    return {
      outcome: 'victory',
      winnerId,
      nextState: { ...base, activePlayerIds: active, phase: PHASES.VICTORY, winnerId },
    };
  }
  if (active.length === 0) {
    return { outcome: 'no-players', winnerId: null, nextState: { ...base, activePlayerIds: [] } };
  }
  return { outcome: 'next-round', winnerId: null, nextState: advanceToNextRound(base, options) };
}

/**
 * Builds the post-"Play Again" state (Req 15.2, 15.3, 15.4, 15.5, Property 17).
 *
 * Pure: clones every player with `eliminated: false`, resets the round to 1,
 * empties `chairs`, and rebuilds `activePlayerIds` from the CONNECTED players
 * only. The room returns to lobby status, keeping everyone in place (Req 15.6).
 *
 * @param {Object|null|undefined} players - Firebase `players` node
 * @returns {{
 *   round: number,
 *   activePlayerIds: string[],
 *   musicDuration: number,
 *   musicStartTime: number,
 *   phase: 'lobby',
 *   eliminatedThisRound: string[],
 *   winnerId: null,
 *   chairs: Object,
 *   players: Object
 * }} Flat game fields plus the reset `players` node.
 *   Pass the result through {@link toFirebaseGameState} to get the `game` node.
 */
export function resetGame(players) {
  const resetPlayers = {};
  for (const [id, player] of Object.entries(players && typeof players === 'object' ? players : {})) {
    resetPlayers[id] = { ...player, eliminated: false };
  }

  return {
    round: 1,
    activePlayerIds: connectedPlayerIds(resetPlayers),
    musicDuration: 0,
    musicStartTime: 0,
    phase: PHASES.LOBBY,
    eliminatedThisRound: [],
    winnerId: null,
    chairs: {},
    players: resetPlayers,
  };
}

/**
 * Final rankings from the elimination order (Req 10.5).
 *
 * The winner ranks 1; after that the LAST eliminated player ranks highest, so
 * the elimination order is walked backwards. Players eliminated in the same
 * round share a rank and the next rank skips over them (competition ranking).
 *
 * Pure — no Firebase, no mutation.
 *
 * @param {Array<string|string[]>} eliminationOrder - One entry per round, in
 *   round order. A string is a single elimination; an array is a simultaneous
 *   multi-player elimination.
 * @param {Object} [options]
 * @param {string|null} [options.winnerId] - Winner from {@link checkVictory}
 * @param {Object} [options.players] - `players` node, used for display names
 * @returns {Array<{ playerId: string, name: string|null, rank: number,
 *   eliminatedInRound: number|null }>} Sorted by rank ascending
 */
export function computeFinalRankings(eliminationOrder, options = {}) {
  const players = options.players && typeof options.players === 'object' ? options.players : {};
  const winnerId = typeof options.winnerId === 'string' ? options.winnerId : null;
  const nameOf = (id) => (players[id] && typeof players[id].name === 'string' ? players[id].name : null);

  const groups = (Array.isArray(eliminationOrder) ? eliminationOrder : [])
    .map((entry, index) => ({ round: index + 1, ids: uniqueIds(Array.isArray(entry) ? entry : [entry]) }))
    .filter((group) => group.ids.length > 0);

  const rankings = [];
  const seen = new Set();
  let nextRank = 1;

  if (winnerId) {
    rankings.push({ playerId: winnerId, name: nameOf(winnerId), rank: nextRank, eliminatedInRound: null });
    seen.add(winnerId);
    nextRank += 1;
  }

  // Last eliminated ranks highest below the winner.
  for (let i = groups.length - 1; i >= 0; i--) {
    const { round, ids } = groups[i];
    const fresh = ids.filter((id) => !seen.has(id));
    if (fresh.length === 0) continue;
    for (const id of fresh) {
      rankings.push({ playerId: id, name: nameOf(id), rank: nextRank, eliminatedInRound: round });
      seen.add(id);
    }
    nextRank += fresh.length;
  }

  return rankings;
}

/**
 * Projects rankings to the exact root-level schema accepted by schema v2.
 * Extra fields and malformed rows are dropped. The winner intentionally omits
 * `eliminatedInRound`; RTDB also removes that child when older callers send it
 * as null.
 *
 * @param {unknown} rankings - Candidate root `rankings` array
 * @param {{ winnerId?: string }} [options]
 * @returns {Array<{playerId: string, name: string, rank: number, eliminatedInRound?: number}>}
 */
export function toFirebaseRankings(rankings, options = {}) {
  if (!Array.isArray(rankings)) return [];
  const winnerId = isValidWinnerId(options.winnerId) ? options.winnerId : null;
  const seen = new Set();
  const projected = [];

  for (const entry of rankings) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (!isValidWinnerId(entry.playerId) || seen.has(entry.playerId)) continue;
    if (typeof entry.name !== 'string' || entry.name.length === 0) continue;
    if (!Number.isInteger(entry.rank) || entry.rank < 1) continue;

    const row = { playerId: entry.playerId, name: entry.name, rank: entry.rank };
    if (entry.playerId !== winnerId) {
      if (!Number.isInteger(entry.eliminatedInRound) || entry.eliminatedInRound < 1) continue;
      row.eliminatedInRound = entry.eliminatedInRound;
    }
    projected.push(row);
    seen.add(entry.playerId);
  }

  return projected;
}

/**
 * HOST ONLY. Persists the victory state and the final rankings (Req 10.1, 10.2,
 * 10.5). `game` and `rankings` are both host-writable only under the deployed
 * rules, and `winnerId` must match `player_[0-7]` — an invalid ID is dropped
 * rather than written and rejected.
 *
 * @param {string} roomCode - Room code
 * @param {Object} [options]
 * @param {boolean} [options.isHost] - Defaults to `gameState.isHost`
 * @param {string} [options.winnerId] - Winner from {@link checkVictory}
 * @param {Array} [options.rankings] - Output of {@link computeFinalRankings}
 * @param {(updates: Object) => Promise<any>} [options.writer] - Injectable writer
 * @returns {Promise<{ ok: boolean, skipped?: string, attempts?: number,
 *   error?: any, message?: string|null }>}
 */
export async function persistVictory(roomCode, options = {}) {
  if (!isHostWriter(options)) return { ok: false, skipped: 'not-host' };

  const activityAt = await resolveServerTimestamp(options);
  const updates = {
    [roomPath(roomCode, 'game/phase')]: PHASES.VICTORY,
    [roomPath(roomCode, 'meta/lastActivity')]: activityAt,
  };
  if (isValidWinnerId(options.winnerId)) {
    updates[roomPath(roomCode, 'game/winnerId')] = options.winnerId;
  }
  if (Array.isArray(options.rankings)) {
    updates[roomPath(roomCode, 'rankings')] = toFirebaseRankings(options.rankings, {
      winnerId: options.winnerId,
    });
  }

  const result = await withRetry(() => applyUpdates(updates, options), {
    context: 'persistVictory',
    metadata: { roomCode, winnerId: options.winnerId ?? null },
  });

  return {
    ok: result.ok,
    attempts: result.attempts,
    error: result.error,
    message: result.message ?? null,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — CLAIM PHASE TIMEOUT (10s)  (task 3.6)
// ═════════════════════════════════════════════════════════════════════════════
// Pure: resolveClaimPhase
// Timers: startClaimPhaseTimeout / clearClaimPhaseTimeout / clearAllGameTimers
// Firebase I/O (host only): writeEliminationResult, finalizeClaimPhase

/**
 * Players get 10 seconds to drag onto a chair before the round resolves with
 * whatever chairs exist (Req 7.2). Anyone still unseated is eliminated.
 */
export const CLAIM_PHASE_TIMEOUT_MS = 10000;

/**
 * @deprecated Back-compat alias for {@link CLAIM_PHASE_TIMEOUT_MS}; the tap race
 * is gone. Kept only so an out-of-date import keeps resolving — new code should
 * use `CLAIM_PHASE_TIMEOUT_MS`.
 */
export const TAP_PHASE_TIMEOUT_MS = CLAIM_PHASE_TIMEOUT_MS;

let claimTimeoutTimer = null;
let claimTimeoutDeadlineAt = 0;

/**
 * Starts the 10-second claiming deadline (Req 7.2, 7.3).
 *
 * Runs on every device so eliminated players and spectators stay in sync, but
 * only the host's expiry handler writes — see {@link finalizeClaimPhase}. Cancel
 * it as soon as every chair is taken so the round resolves early.
 *
 * Single-instance and cancellable: a new call clears the previous timer.
 *
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=10000] - Deadline length
 * @param {() => void} [options.onExpire] - Host wires this to {@link finalizeClaimPhase}
 * @returns {() => void} The cancel function ({@link clearClaimPhaseTimeout})
 */
export function startClaimPhaseTimeout(options = {}) {
  const { timeoutMs = CLAIM_PHASE_TIMEOUT_MS, onExpire } = options;
  clearClaimPhaseTimeout();

  const total = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs) : CLAIM_PHASE_TIMEOUT_MS;
  claimTimeoutDeadlineAt = Date.now() + total;

  claimTimeoutTimer = setTimeout(() => {
    clearClaimPhaseTimeout();
    if (typeof onExpire !== 'function') return;
    try {
      onExpire();
    } catch (error) {
      logError('claimPhaseTimeoutExpire', error, { timeoutMs: total });
    }
  }, total);

  return clearClaimPhaseTimeout;
}

/** Cancels the claiming deadline. Safe to call when nothing is running. */
export function clearClaimPhaseTimeout() {
  if (claimTimeoutTimer !== null) {
    clearTimeout(claimTimeoutTimer);
    claimTimeoutTimer = null;
  }
}

/** Whether the claiming deadline is currently armed. */
export function isClaimPhaseTimeoutActive() {
  return claimTimeoutTimer !== null;
}

/**
 * Milliseconds left on the claiming deadline, or 0 when idle.
 * @returns {number}
 */
export function getClaimPhaseTimeoutRemaining() {
  if (!isClaimPhaseTimeoutActive()) return 0;
  return Math.max(0, claimTimeoutDeadlineAt - Date.now());
}

/** Cancels every game timer this module owns. Call on leave / reset / unload. */
export function clearAllGameTimers() {
  clearMusicCountdown();
  clearClaimPhaseTimeout();
}

/**
 * Resolves a claiming phase with whatever chairs exist (Req 7.2, 7.3, 7.4, 7.6,
 * 11.5). Returns the claiming-phase resolution shape consumed by round
 * progression and victory handling.
 *
 * Pure — chains {@link determineElimination} → {@link applyElimination} →
 * {@link checkVictory} without touching Firebase or mutating `state`. This is
 * what the 10-second timeout runs: whoever never claimed is simply unseated.
 *
 * @param {Object} state - Local game state at the end of the claiming phase
 * @param {Object} [options]
 * @param {Object} [options.chairs] - Override `state.chairs`
 * @param {Object} [options.players] - Override `state.players` (Req 11.5)
 * @returns {{
 *   eliminatedPlayerIds: string[],
 *   reason: string,
 *   nextState: Object,
 *   winnerId: string|null,
 *   outcome: 'victory' | 'next-round' | 'no-players'
 * }}
 */
export function resolveClaimPhase(state, options = {}) {
  const base = state && typeof state === 'object' ? state : createInitialGameState();
  const chairs = options.chairs !== undefined ? options.chairs : base.chairs;
  const players = options.players !== undefined ? options.players : base.players;

  const decision = determineElimination(chairs, base.activePlayerIds, {
    round: base.round,
    phase: base.phase,
    players,
  });
  const nextState = applyElimination({ ...base, chairs: decision.chairs }, decision.eliminatedPlayerIds);
  const remaining = nextState.activePlayerIds;
  const winnerId = checkVictory(remaining);

  return {
    eliminatedPlayerIds: decision.eliminatedPlayerIds,
    reason: decision.reason,
    nextState,
    winnerId,
    outcome: winnerId ? 'victory' : (remaining.length === 0 ? 'no-players' : 'next-round'),
  };
}

/**
 * HOST ONLY. Writes an elimination result (Req 7.4, 7.5, 7.6).
 *
 * `game` and `players/*` are host-writable only under the deployed rules, which
 * is exactly the property that keeps a single writer in charge and prevents
 * duplicate elimination writes from 8 devices. The `players/{id}/eliminated`
 * leaves are updated individually so the required `name`/`uid`/`connected`
 * children survive validation.
 *
 * @param {string} roomCode - Room code
 * @param {{ eliminatedPlayerIds: string[], nextState: Object }} resolution -
 *   Output of {@link resolveClaimPhase}
 * @param {Object} [options]
 * @param {boolean} [options.isHost] - Defaults to `gameState.isHost`
 * @param {(updates: Object) => Promise<any>} [options.writer] - Injectable writer
 * @returns {Promise<{ ok: boolean, skipped?: string, attempts?: number,
 *   error?: any, message?: string|null }>}
 */
export async function writeEliminationResult(roomCode, resolution, options = {}) {
  if (!isHostWriter(options)) return { ok: false, skipped: 'not-host' };

  const eliminated = uniqueIds(resolution?.eliminatedPlayerIds);
  const nextState = resolution?.nextState || {};
  const activityAt = await resolveServerTimestamp(options);

  const updates = {
    [roomPath(roomCode, 'game/phase')]: PHASES.ELIMINATION,
    [roomPath(roomCode, 'game/round')]: Number.isInteger(nextState.round) && nextState.round >= 1
      ? nextState.round
      : 1,
    [roomPath(roomCode, 'game/activePlayerIds')]: uniqueIds(nextState.activePlayerIds),
    [roomPath(roomCode, 'game/eliminatedThisRound')]: eliminated.length ? eliminated : null,
    [roomPath(roomCode, 'meta/lastActivity')]: activityAt,
  };
  for (const id of eliminated) {
    updates[roomPath(roomCode, `players/${id}/eliminated`)] = true;
  }

  const result = await withRetry(() => applyUpdates(updates, options), {
    context: 'writeEliminationResult',
    metadata: { roomCode, eliminated },
  });

  return {
    ok: result.ok,
    attempts: result.attempts,
    error: result.error,
    message: result.message ?? null,
  };
}

/**
 * Resolves the claiming phase and, on the host only, persists the result
 * (Req 7.2, 7.3, 7.4). Wire this to {@link startClaimPhaseTimeout}'s `onExpire`
 * and to the "every chair is taken" path; non-hosts still get the resolution
 * back for optimistic rendering, they just do not write.
 *
 * @param {string} roomCode - Room code
 * @param {Object} [options]
 * @param {Object} [options.state] - Defaults to the shared `gameState`
 * @param {boolean} [options.isHost] - Defaults to `gameState.isHost`
 * @param {Object} [options.chairs] - Override the chairs used for the decision
 * @param {Object} [options.players] - Override the players used for the decision
 * @param {(updates: Object) => Promise<any>} [options.writer] - Injectable writer
 * @returns {Promise<{ resolution: ReturnType<typeof resolveClaimPhase>,
 *   write: { ok: boolean, skipped?: string } }>}
 */
export async function finalizeClaimPhase(roomCode, options = {}) {
  const state = options.state || gameState;
  clearClaimPhaseTimeout();

  const resolution = resolveClaimPhase(state, options);
  const write = await writeEliminationResult(roomCode, resolution, options);
  return { resolution, write };
}
