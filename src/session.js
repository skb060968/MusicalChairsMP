/**
 * Session Persistence — Musical Chairs
 *
 * Saves the minimum room/player identity needed to auto-rejoin after a page
 * refresh or an accidental disconnect (Req 11.8, 20.3). Mirrors the proven
 * BollywoodBeats `multiplayer-game.js` session pattern (SESSION_KEY +
 * save/load/clear, every localStorage call wrapped in try/catch), lifted into
 * a standalone module with validation and a UI-facing status getter.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MODULE CONTRACT
 * ─────────────────────────────────────────────────────────────────────────────
 *  - NO Firebase import, no DOM dependency. Pure and importable in bare jsdom.
 *  - NOTHING here ever throws. Private browsing, disabled storage, and quota
 *    errors make *every* localStorage touch throw — including reads and the
 *    feature-detect itself (`typeof localStorage` can throw in some hardened
 *    browsers) — so each access sits in its own try/catch and degrades to a
 *    "storage unavailable" state instead of propagating.
 *  - This module only stores and validates. The wiring lives elsewhere:
 *      task 6.2  → `saveSession()` after a successful create or join
 *      task 6.6  → `clearSession()` on Return to Menu / intentional leave
 *      task 7.2  → `loadSession()` on page load for the auto-rejoin flow
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STALE SESSIONS (design judgement call)
 * ─────────────────────────────────────────────────────────────────────────────
 * A `savedAt` timestamp is written alongside the session and sessions older
 * than {@link SESSION_MAX_AGE_MS} (24h) are treated as absent and cleared.
 * Rationale: the Firebase rules mark rooms idle beyond 24 hours as
 * unusable/cleanable (Req 17.2), so a session older than that can never be
 * rejoined — attempting it would only produce a "Previous room no longer
 * exists" toast on every future boot. Expiring locally keeps the boot path
 * fast and avoids a pointless network round trip.
 *
 * A `v` (schema version) field is also written. Anything without the current
 * version — or with a missing/implausible `savedAt`, which is what an older
 * schema or a foreign writer looks like — is discarded and cleared.
 */

/** localStorage key holding the serialized session. */
export const SESSION_KEY = 'musical_chairs_session';

/** Current stored-payload schema version. Bump when fields change. */
export const SESSION_SCHEMA_VERSION = 1;

/**
 * Message the UI surfaces when localStorage cannot be used, so the player
 * knows a refresh will require a manual rejoin (design §Error Handling →
 * "LocalStorage Unavailable").
 */
export const STORAGE_UNAVAILABLE_MESSAGE = 'Auto-rejoin unavailable in private mode';

/** Message the UI surfaces when a restore target has gone away (task 7.2). */
export const SESSION_EXPIRED_MESSAGE = 'Previous room no longer exists';

/** Sessions older than this cannot be rejoined (rooms idle >24h are cleaned). */
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Tolerance for a `savedAt` in the future. Devices with a skewed clock (or a
 * clock corrected between save and load) shouldn't lose their session, but a
 * wildly future timestamp means the payload is not ours.
 */
export const SESSION_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Room code shape: 4 uppercase letters, no ambiguous I/O (Req 1.1).
 * Duplicated from `game-manager.ROOM_CODE_PATTERN` on purpose — this module
 * stays dependency-free so the boot path can read the session before anything
 * else loads.
 */
const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z]{4}$/;

/** Player indices are 0-7 (`MAX_PLAYERS` in game-manager). */
const MAX_PLAYER_INDEX = 7;

/** Defensive cap so a hostile/corrupt name can't bloat storage. */
const MAX_NAME_LENGTH = 40;

/**
 * Tri-state storage availability: null = not probed yet, true/false = known.
 * Set by every access path so the status reflects reality, not just a probe.
 * @type {boolean|null}
 */
let storageAvailable = null;

/** True once we've logged the unavailable warning (keeps the console quiet). */
let warnedUnavailable = false;

/* ============================== storage access ============================ */

/**
 * Resolve the localStorage object. Returns null instead of throwing when the
 * global is missing or merely *touching* it throws (hardened/private modes).
 * @returns {Storage|null}
 */
function getStorage() {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) return null;
    return localStorage;
  } catch (_) {
    return null;
  }
}

/** Record that storage works. */
function markAvailable() {
  storageAvailable = true;
}

/**
 * Record that storage is unusable (private browsing, quota, disabled).
 * @param {string} op - Operation that failed, for the one-time warning
 */
function markUnavailable(op) {
  storageAvailable = false;
  if (!warnedUnavailable) {
    warnedUnavailable = true;
    console.warn(`[session] localStorage unavailable during ${op} - ${STORAGE_UNAVAILABLE_MESSAGE}`);
  }
}

/**
 * Read the raw stored string. Never throws.
 * @returns {string|null} Raw value, or null when absent/unavailable
 */
function readRaw() {
  const store = getStorage();
  if (!store) {
    markUnavailable('read');
    return null;
  }
  try {
    const raw = store.getItem(SESSION_KEY);
    markAvailable();
    return typeof raw === 'string' ? raw : null;
  } catch (_) {
    markUnavailable('read');
    return null;
  }
}

/**
 * Write the raw stored string. Never throws.
 * @param {string} raw - Serialized payload
 * @returns {boolean} True when the write landed
 */
function writeRaw(raw) {
  const store = getStorage();
  if (!store) {
    markUnavailable('write');
    return false;
  }
  try {
    store.setItem(SESSION_KEY, raw);
    markAvailable();
    return true;
  } catch (_) {
    // Quota exceeded or a storage-denying browser mode.
    markUnavailable('write');
    return false;
  }
}

/**
 * Remove the stored session. Never throws.
 * @returns {boolean} True when the removal landed (or nothing was stored)
 */
function removeRaw() {
  const store = getStorage();
  if (!store) {
    markUnavailable('clear');
    return false;
  }
  try {
    store.removeItem(SESSION_KEY);
    markAvailable();
    return true;
  } catch (_) {
    markUnavailable('clear');
    return false;
  }
}

/* ================================ validation ============================= */

/**
 * Normalize and validate a session payload.
 * Applied on both save and load, so a payload that survives a round trip is
 * always well formed. Anything malformed yields null — callers treat that as
 * "no session" (and `loadSession` additionally clears it).
 *
 * Rules:
 *  - `roomCode`    string, 4 uppercase letters excluding I/O (case-normalized)
 *  - `playerIndex` integer in [0, 7]
 *  - `isHost`      strict boolean
 *  - `playerName`  non-empty string after trim, truncated to 40 chars
 *
 * @param {unknown} data - Candidate session object
 * @returns {{roomCode: string, playerIndex: number, isHost: boolean, playerName: string}|null}
 */
function normalizeSession(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  const { roomCode, playerIndex, isHost, playerName } = /** @type {any} */ (data);

  if (typeof roomCode !== 'string') return null;
  const code = roomCode.trim().toUpperCase();
  if (!ROOM_CODE_PATTERN.test(code)) return null;

  // Reject numeric strings and floats — an index must be a real integer.
  if (typeof playerIndex !== 'number' || !Number.isInteger(playerIndex)) return null;
  if (playerIndex < 0 || playerIndex > MAX_PLAYER_INDEX) return null;

  if (typeof isHost !== 'boolean') return null;

  if (typeof playerName !== 'string') return null;
  const name = playerName.trim().slice(0, MAX_NAME_LENGTH);
  if (name.length === 0) return null;

  return { roomCode: code, playerIndex, isHost, playerName: name };
}

/**
 * Whether a stored payload's age is still rejoinable.
 * @param {unknown} savedAt - Stored `savedAt` value
 * @param {number} now - Current epoch ms
 * @returns {boolean} True when `savedAt` is plausible and within 24h
 */
function isFreshTimestamp(savedAt, now) {
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt) || savedAt <= 0) return false;
  if (savedAt > now + SESSION_FUTURE_SKEW_MS) return false; // not ours / bad clock
  return now - savedAt <= SESSION_MAX_AGE_MS;
}

/* ================================ public API ============================= */

/**
 * Persist the session so the player can auto-rejoin after a refresh
 * (Req 11.8). Call right after a successful `createRoom` / `joinRoom`
 * (tasks 6.2). Invalid payloads are rejected rather than stored.
 *
 * @param {{roomCode: string, playerIndex: number, isHost: boolean, playerName: string}} data
 * @returns {boolean} True when the session was written. False means either the
 *   payload failed validation or storage is unavailable — check
 *   {@link getStorageStatus} to tell the two apart and show
 *   {@link STORAGE_UNAVAILABLE_MESSAGE} when appropriate. Never throws.
 */
export function saveSession(data) {
  const session = normalizeSession(data);
  if (!session) {
    console.warn('[session] refusing to save malformed session payload');
    return false;
  }

  let raw;
  try {
    raw = JSON.stringify({
      ...session,
      v: SESSION_SCHEMA_VERSION,
      savedAt: Date.now(),
    });
  } catch (_) {
    return false; // Unreachable for plain data, but never let it escape.
  }

  return writeRaw(raw);
}

/**
 * Read the stored session for the auto-rejoin flow (task 7.2).
 *
 * Returns null — and clears the stored value — when the payload is corrupt
 * JSON, fails validation, comes from an older schema, or is older than
 * {@link SESSION_MAX_AGE_MS}. Corrupt storage therefore cannot crash boot.
 *
 * @returns {{roomCode: string, playerIndex: number, isHost: boolean, playerName: string, savedAt: number}|null}
 *   The validated session, or null when there is nothing usable. Never throws.
 */
export function loadSession() {
  const raw = readRaw();
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    console.warn('[session] stored session is not valid JSON - discarding');
    removeRaw();
    return null;
  }

  const session = normalizeSession(parsed);
  if (!session) {
    console.warn('[session] stored session failed validation - discarding');
    removeRaw();
    return null;
  }

  const savedAt = parsed && typeof parsed === 'object' ? parsed.savedAt : undefined;
  const version = parsed && typeof parsed === 'object' ? parsed.v : undefined;

  // A missing/wrong version or an implausible timestamp means an older schema
  // or a foreign writer. Treat both exactly like a stale session.
  if (version !== SESSION_SCHEMA_VERSION || !isFreshTimestamp(savedAt, Date.now())) {
    console.warn('[session] stored session is stale or from an older schema - discarding');
    removeRaw();
    return null;
  }

  return { ...session, savedAt };
}

/**
 * Remove the stored session. Call on intentional leave / Return to Menu
 * (tasks 6.6, 8.3) and whenever a restore attempt finds the room gone.
 * @returns {boolean} True when the removal landed. Never throws.
 */
export function clearSession() {
  return removeRaw();
}

/**
 * Cheap existence check that applies the same validation as
 * {@link loadSession} (and the same discard-on-invalid behaviour).
 * @returns {boolean} True when a usable session is stored
 */
export function hasStoredSession() {
  return loadSession() !== null;
}

/**
 * Whether localStorage can be used at all. Probes with a throwaway key when
 * nothing has touched storage yet, so the UI can warn before the first save.
 * @returns {boolean} False in private browsing / disabled-storage / quota cases
 */
export function isStorageAvailable() {
  if (storageAvailable !== null) return storageAvailable;

  const store = getStorage();
  if (!store) {
    markUnavailable('probe');
    return false;
  }
  const probeKey = `${SESSION_KEY}__probe`;
  try {
    store.setItem(probeKey, '1');
    store.removeItem(probeKey);
    markAvailable();
    return true;
  } catch (_) {
    markUnavailable('probe');
    return false;
  }
}

/**
 * Session/storage status for the UI, mirroring `audio-manager.getAudioStatus`.
 * Show `message` (when non-null) as a toast so the player knows auto-rejoin
 * won't survive a refresh.
 *
 * @returns {{
 *   available: boolean,        // localStorage usable
 *   probed: boolean,           // availability has been determined
 *   hasSession: boolean,       // a valid, fresh session is stored
 *   message: string|null       // ready-to-display hint, or null
 * }}
 */
export function getStorageStatus() {
  const available = isStorageAvailable();
  return {
    available,
    probed: storageAvailable !== null,
    hasSession: available ? hasStoredSession() : false,
    message: available ? null : STORAGE_UNAVAILABLE_MESSAGE,
  };
}

/* ============================ test/reset helper ========================== */

/**
 * Reset in-memory module state (availability cache and the one-time warning
 * flag). Does not touch localStorage — call {@link clearSession} for that.
 * Intended for tests only.
 */
export function __resetSessionForTests() {
  storageAvailable = null;
  warnedUnavailable = false;
}

export default {
  saveSession,
  loadSession,
  clearSession,
  hasStoredSession,
  isStorageAvailable,
  getStorageStatus,
  SESSION_KEY,
  SESSION_SCHEMA_VERSION,
  SESSION_MAX_AGE_MS,
  STORAGE_UNAVAILABLE_MESSAGE,
  SESSION_EXPIRED_MESSAGE,
};
