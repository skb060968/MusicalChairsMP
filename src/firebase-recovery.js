/**
 * Firebase Recovery — Musical Chairs
 *
 * A thin, additive layer over `firebase-sync.js`. Nothing in this module
 * rewrites or wraps the sync module's exports; callers opt in per operation:
 *
 *   const res = await withRetry(() => writeGameState(roomCode, next),
 *                               { context: 'writeGameState', metadata: { roomCode } });
 *   if (!res.ok) showToast(res.message, true);
 *
 * Responsibilities (Requirement 16):
 *   - 16.1  Firebase writes retry with 100ms / 200ms / 400ms exponential backoff.
 *   - 16.2  Firebase reads retry once, surfacing "Connection issue, retrying...".
 *   - 16.3  Connection state is monitored through `.info/connected`; the SDK
 *           reconnects on its own and `forceReconnect()` can kick it manually.
 *   - 16.4  On restoration, reconnect listeners fire immediately and are held
 *           to a 2 second resync deadline.
 *
 * Two hard rules:
 *   1. A retry failure NEVER throws into game logic. `withRetry` / `withReadRetry`
 *      always resolve to a result object and also publish the failure through
 *      `onRecoveryError` + a `window` CustomEvent.
 *   2. A bare `import` of this module must not touch Firebase. `firebase-config.js`
 *      builds a live `Database` at import time, so it is only pulled in lazily
 *      (dynamic import inside `startConnectionMonitor`) and may be replaced with
 *      injected stubs. Importing this file in jsdom does nothing but define
 *      functions.
 *
 * The subscribe API mirrors `audio-manager.js`: `getXStatus()` +
 * `onXChange(listener) => unsubscribe` + a CustomEvent on `window`.
 */

/* ================================ constants ============================== */

/** DOM event carrying the connection status object. */
export const CONNECTION_STATUS_EVENT = 'musical-chairs:connection-status';
/** DOM event carrying a retry/terminal failure report. */
export const RECOVERY_ERROR_EVENT = 'musical-chairs:recovery-error';

/** Toast copy required by Req 16.2. */
export const READ_RETRY_MESSAGE = 'Connection issue, retrying...';
/** Toast copy for a write that is being retried. */
export const WRITE_RETRY_MESSAGE = 'Action failed, retrying...';
/** Toast copy for a write that exhausted its retries. */
export const WRITE_FAILED_MESSAGE = 'Action failed. Please refresh.';
/** Toast copy for a read that failed twice. */
export const READ_FAILED_MESSAGE = 'Failed to load data. Please refresh.';
/** Toast copy while the connection is down (Req 16.3). */
export const CONNECTION_LOST_MESSAGE = 'Connection lost, attempting to reconnect...';
/** Toast copy once the connection comes back. */
export const CONNECTION_RESTORED_MESSAGE = 'Reconnected, syncing game state...';

/** Backoff schedule applied before retry 1, 2 and 3 (Req 16.1). */
export const RETRY_DELAYS_MS = Object.freeze([100, 200, 400]);
/** Retries allowed after the initial write attempt (Req 16.1). */
export const MAX_WRITE_RETRIES = 3;
/** Retries allowed after the initial read attempt (Req 16.2). */
export const MAX_READ_RETRIES = 1;
/** Budget for a post-reconnect resynchronization (Req 16.4). */
export const RESYNC_DEADLINE_MS = 2000;

/**
 * Error codes/messages that will never succeed on retry. Retrying these burns
 * 700ms of a live round for nothing, so they short-circuit to a terminal result.
 */
const TERMINAL_PATTERNS = [
  'permission_denied',
  'permission-denied',
  'unauthorized',
  'unauthenticated',
  'invalid_token',
  'expired_token',
  'invalid-argument',
  'invalid_argument',
  'validation failed',
  'operation-not-allowed',
  'quota_exceeded',
  'quota-exceeded',
  'not-found',
  'room not found',
  'write_canceled',
  'overriddenbyset',
  'max_retries',
  'app-deleted',
  'database-not-initialized',
];

/** Programming mistakes: a retry just repeats the same crash. */
const TERMINAL_ERROR_NAMES = ['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'];

/* ================================= state ================================= */

let monitoring = false;
let online = true; // optimistic: avoids an "offline" flash before the first read
let everConnected = false;
let lastConnectedAt = null;
let lastDisconnectedAt = null;
let downtimeMs = null;
let reconnectCount = 0;
let resyncPending = false;
let resyncOverdue = false;
let resyncTimer = null;
let resyncStartedAt = null;

/** Teardown for the `.info/connected` subscription. */
let detachInfoListener = null;
/** Lazily resolved `{ db, ref, onValue, goOffline, goOnline }`. */
let deps = null;

const statusListeners = new Set();
const reconnectListeners = new Set();
const errorListeners = new Set();

/** Supplies roomCode / playerIndex / phase to `logError` when not passed in. */
let errorContextProvider = null;

/* ============================ status plumbing ============================ */

/**
 * Current connection status. Poll this or subscribe via
 * `onConnectionChange` / the `CONNECTION_STATUS_EVENT` DOM event.
 *
 * @returns {{
 *   monitoring: boolean,          // `.info/connected` listener attached
 *   online: boolean,              // last value reported by Firebase
 *   everConnected: boolean,       // Firebase reported `true` at least once
 *   lastConnectedAt: number|null,
 *   lastDisconnectedAt: number|null,
 *   downtimeMs: number|null,      // length of the most recent outage
 *   reconnectCount: number,
 *   resyncPending: boolean,       // reconnect handlers still running
 *   resyncOverdue: boolean,       // resync blew the 2s budget (Req 16.4)
 *   message: string|null          // ready-to-display hint, or null
 * }}
 */
export function getConnectionStatus() {
  let message = null;
  if (!online) message = CONNECTION_LOST_MESSAGE;
  else if (resyncPending) message = CONNECTION_RESTORED_MESSAGE;
  return {
    monitoring,
    online,
    everConnected,
    lastConnectedAt,
    lastDisconnectedAt,
    downtimeMs,
    reconnectCount,
    resyncPending,
    resyncOverdue,
    message,
  };
}

function dispatch(eventName, detail) {
  try {
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(eventName, { detail }));
    }
  } catch (_) {}
}

function emitStatus() {
  const status = getConnectionStatus();
  statusListeners.forEach((fn) => {
    try { fn(status); } catch (_) {}
  });
  dispatch(CONNECTION_STATUS_EVENT, status);
}

/**
 * Subscribe to connection status changes (loss, restoration, resync progress).
 * The listener is invoked immediately with the current status.
 *
 * @param {(status: ReturnType<typeof getConnectionStatus>) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onConnectionChange(listener) {
  if (typeof listener !== 'function') return () => {};
  statusListeners.add(listener);
  try { listener(getConnectionStatus()); } catch (_) {}
  return () => statusListeners.delete(listener);
}

/** True while Firebase reports a live connection. */
export function isOnline() {
  return online;
}

/* ============================== error channel ============================= */

/**
 * Subscribe to retry/terminal failures. This is the channel a failed write
 * surfaces through instead of throwing into game logic.
 *
 * @param {(report: {
 *   kind: 'write'|'read',
 *   context: string,
 *   error: any,
 *   attempts: number,
 *   retrying: boolean,
 *   terminal: boolean,
 *   message: string,
 *   metadata: Object
 * }) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onRecoveryError(listener) {
  if (typeof listener !== 'function') return () => {};
  errorListeners.add(listener);
  return () => errorListeners.delete(listener);
}

function emitError(report) {
  errorListeners.forEach((fn) => {
    try { fn(report); } catch (_) {}
  });
  dispatch(RECOVERY_ERROR_EVENT, report);
}

/* ============================== error logging ============================= */

/**
 * Register a getter supplying the ambient `{ roomCode, playerIndex, phase }`
 * so `logError` can tag reports without every call site repeating them.
 * `main.js` / `game-manager.js` should point this at their local game state.
 *
 * @param {() => {roomCode?: string, playerIndex?: number, phase?: string}} provider
 */
export function setErrorContextProvider(provider) {
  errorContextProvider = typeof provider === 'function' ? provider : null;
}

function ambientContext() {
  if (!errorContextProvider) return {};
  try {
    return errorContextProvider() || {};
  } catch (_) {
    return {};
  }
}

/**
 * Log an error to the console and, in production, to `window.errorTracker`.
 * roomCode / playerIndex / phase are always present in the payload, taken from
 * `metadata` first and the registered context provider second.
 *
 * @param {string} context - Operation name, e.g. 'writeGameState'
 * @param {any} error - The caught error
 * @param {Object} [metadata] - Extra fields; may carry roomCode/playerIndex/phase
 */
export function logError(context, error, metadata = {}) {
  const meta = metadata || {};
  const ambient = ambientContext();
  const payload = {
    ...meta,
    roomCode: meta.roomCode !== undefined ? meta.roomCode : (ambient.roomCode ?? null),
    playerIndex: meta.playerIndex !== undefined ? meta.playerIndex : (ambient.playerIndex ?? null),
    phase: meta.phase !== undefined ? meta.phase : (ambient.phase ?? null),
  };

  console.error(`[${context}] Error:`, error, payload);

  try {
    const tracker = typeof window !== 'undefined' ? window.errorTracker : null;
    if (tracker && typeof tracker.captureException === 'function') {
      tracker.captureException(error, { context, ...payload });
    }
  } catch (_) {
    // Never let the tracker itself break the caller.
  }
}

/* =========================== error classification ======================== */

function errorText(error) {
  if (!error) return '';
  const parts = [];
  if (typeof error === 'string') parts.push(error);
  if (error.code) parts.push(String(error.code));
  if (error.message) parts.push(String(error.message));
  if (error.name) parts.push(String(error.name));
  return parts.join(' ').toLowerCase();
}

/**
 * Classify a Firebase failure.
 *
 * Terminal (never retried): permission denied, unauthenticated/expired token,
 * rules validation failures, invalid arguments, quota exceeded, not-found /
 * "Room not found", `write_canceled` / overridden-by-set (a newer write already
 * won, so replaying would clobber it), app-deleted, and JS programming errors
 * (TypeError, ReferenceError, SyntaxError, RangeError).
 *
 * Retryable (everything else): network-request-failed, unavailable, timeouts,
 * `disconnected`, internal/unknown SDK errors, aborted, resource-exhausted, and
 * any unrecognised error — bounded retries make optimism cheap.
 *
 * @param {any} error
 * @returns {'retryable'|'terminal'}
 */
export function classifyError(error) {
  if (error && TERMINAL_ERROR_NAMES.includes(error.name)) return 'terminal';
  const text = errorText(error);
  if (!text) return 'retryable';
  for (const pattern of TERMINAL_PATTERNS) {
    if (text.includes(pattern)) return 'terminal';
  }
  return 'retryable';
}

/** Convenience predicate over {@link classifyError}. */
export function isRetryableError(error) {
  return classifyError(error) === 'retryable';
}

/* ================================= retry ================================= */

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayFor(retryIndex, delays) {
  const table = Array.isArray(delays) && delays.length ? delays : RETRY_DELAYS_MS;
  if (retryIndex < table.length) return table[retryIndex];
  // Keep doubling past the end of the table.
  return table[table.length - 1] * Math.pow(2, retryIndex - table.length + 1);
}

/**
 * @typedef {Object} RecoveryResult
 * @property {boolean} ok - true when `fn` eventually resolved
 * @property {any} [value] - resolved value when ok
 * @property {any} [error] - final error when not ok
 * @property {number} attempts - total calls made to `fn`
 * @property {boolean} terminal - true when the failure was non-retryable
 * @property {string|null} message - display-ready message when not ok
 */

async function runWithRetry(fn, {
  kind,
  retries,
  delays,
  context,
  metadata = {},
  retryMessage,
  failMessage,
  onRetry,
  shouldRetry,
} = {}) {
  if (typeof fn !== 'function') {
    const error = new TypeError('withRetry expects a function');
    logError(context || 'withRetry', error, metadata);
    return { ok: false, error, attempts: 0, terminal: true, message: failMessage };
  }

  let attempts = 0;
  let lastError = null;

  for (let retryIndex = 0; retryIndex <= retries; retryIndex++) {
    try {
      const value = await fn(attempts);
      attempts++;
      return { ok: true, value, attempts, terminal: false, message: null };
    } catch (error) {
      attempts++;
      lastError = error;

      const terminal = shouldRetry
        ? !shouldRetry(error)
        : classifyError(error) === 'terminal';
      const exhausted = retryIndex >= retries;
      const willRetry = !terminal && !exhausted;

      logError(context, error, { ...metadata, attempt: attempts, willRetry, terminal });

      emitError({
        kind,
        context,
        error,
        attempts,
        retrying: willRetry,
        terminal,
        message: willRetry ? retryMessage : failMessage,
        metadata,
      });

      if (!willRetry) {
        return { ok: false, error, attempts, terminal, message: failMessage };
      }

      const wait = delayFor(retryIndex, delays);
      if (typeof onRetry === 'function') {
        try { onRetry({ attempts, delay: wait, error }); } catch (_) {}
      }
      await sleep(wait);
    }
  }

  // Unreachable: the loop always returns. Kept as a defensive net.
  return { ok: false, error: lastError, attempts, terminal: false, message: failMessage };
}

/**
 * Wrap a Firebase write with bounded retries and exponential backoff (Req 16.1).
 * Never rejects: failures come back as `{ ok: false }` and are also published on
 * `onRecoveryError` so game logic can keep running.
 *
 * Attempt schedule with the defaults: initial call, then up to 3 retries spaced
 * 100ms / 200ms / 400ms apart (4 calls worst case).
 *
 * @param {() => Promise<any>} fn - The write, e.g. `() => writeGameState(code, s)`
 * @param {Object} [options]
 * @param {number} [options.retries=3] - Retries allowed after the first attempt
 * @param {number[]} [options.delays] - Backoff table, defaults to [100, 200, 400]
 * @param {string} [options.context='firebaseWrite'] - Label for logs/reports
 * @param {Object} [options.metadata] - Merged into the log payload
 * @param {string} [options.retryMessage]
 * @param {string} [options.failMessage]
 * @param {(info: {attempts: number, delay: number, error: any}) => void} [options.onRetry]
 * @param {(error: any) => boolean} [options.shouldRetry] - Override classification
 * @returns {Promise<RecoveryResult>}
 */
export function withRetry(fn, options = {}) {
  return runWithRetry(fn, {
    kind: 'write',
    retries: Number.isInteger(options.retries) ? options.retries : MAX_WRITE_RETRIES,
    delays: options.delays || RETRY_DELAYS_MS,
    context: options.context || 'firebaseWrite',
    metadata: options.metadata || {},
    retryMessage: options.retryMessage || WRITE_RETRY_MESSAGE,
    failMessage: options.failMessage || WRITE_FAILED_MESSAGE,
    onRetry: options.onRetry,
    shouldRetry: options.shouldRetry,
  });
}

/**
 * Wrap a Firebase read. Retries once immediately, surfacing
 * "Connection issue, retrying..." through `onRecoveryError` before the second
 * attempt (Req 16.2). Never rejects.
 *
 * @param {() => Promise<any>} fn - The read, e.g. `() => get(roomRef)`
 * @param {Object} [options] - Same shape as {@link withRetry}
 * @returns {Promise<RecoveryResult>}
 */
export function withReadRetry(fn, options = {}) {
  return runWithRetry(fn, {
    kind: 'read',
    retries: Number.isInteger(options.retries) ? options.retries : MAX_READ_RETRIES,
    delays: options.delays || [0],
    context: options.context || 'firebaseRead',
    metadata: options.metadata || {},
    retryMessage: options.retryMessage || READ_RETRY_MESSAGE,
    failMessage: options.failMessage || READ_FAILED_MESSAGE,
    onRetry: options.onRetry,
    shouldRetry: options.shouldRetry,
  });
}

/* ========================== connection monitoring ======================== */

/**
 * Subscribe to connection restoration. This is the Req 16.4 resync hook:
 * every listener fires the moment Firebase reports the connection is back, and
 * the module holds them to a 2 second budget.
 *
 * If a listener returns a promise, the resync is considered complete when all
 * returned promises settle. Otherwise the consumer calls `markResynced()`.
 * Blowing the budget flips `resyncOverdue` on the status object and logs it; it
 * never throws.
 *
 * @param {(info: {
 *   downtimeMs: number|null,
 *   reconnectCount: number,
 *   deadlineMs: number
 * }) => (void|Promise<any>)} listener
 * @returns {() => void} unsubscribe
 */
export function onReconnect(listener) {
  if (typeof listener !== 'function') return () => {};
  reconnectListeners.add(listener);
  return () => reconnectListeners.delete(listener);
}

/** Declare the post-reconnect resynchronization finished (Req 16.4). */
export function markResynced() {
  if (!resyncPending) return;
  clearResyncTimer();
  const elapsed = resyncStartedAt !== null ? Date.now() - resyncStartedAt : null;
  resyncPending = false;
  resyncStartedAt = null;
  if (elapsed !== null && elapsed > RESYNC_DEADLINE_MS) {
    resyncOverdue = true;
    console.warn(`[firebase-recovery] resync finished in ${elapsed}ms (budget ${RESYNC_DEADLINE_MS}ms)`);
  }
  emitStatus();
}

function clearResyncTimer() {
  if (resyncTimer !== null) {
    clearTimeout(resyncTimer);
    resyncTimer = null;
  }
}

function beginResync() {
  resyncPending = true;
  resyncOverdue = false;
  resyncStartedAt = Date.now();
  clearResyncTimer();

  const info = {
    downtimeMs,
    reconnectCount,
    deadlineMs: RESYNC_DEADLINE_MS,
  };

  resyncTimer = setTimeout(() => {
    resyncTimer = null;
    if (!resyncPending) return;
    resyncOverdue = true;
    logError('resyncTimeout', new Error(`Game state resync exceeded ${RESYNC_DEADLINE_MS}ms`), info);
    emitStatus();
  }, RESYNC_DEADLINE_MS);

  const pending = [];
  reconnectListeners.forEach((fn) => {
    try {
      const result = fn(info);
      if (result && typeof result.then === 'function') pending.push(result);
    } catch (error) {
      logError('onReconnectListener', error, info);
    }
  });

  emitStatus();

  if (pending.length) {
    Promise.allSettled(pending).then(() => markResynced());
  } else if (reconnectListeners.size === 0) {
    // Nothing to resync — do not leave the UI showing a sync banner forever.
    markResynced();
  }
}

function handleConnectedValue(connected) {
  const next = !!connected;

  if (next) {
    // Duplicate "connected" report: nothing changed.
    if (online && everConnected) return;

    // `online` only reads false once Firebase has reported a real outage, so
    // this doubles as the reconnect test.
    const wasDown = !online;
    online = true;
    everConnected = true;
    lastConnectedAt = Date.now();

    if (wasDown) {
      downtimeMs = lastDisconnectedAt ? lastConnectedAt - lastDisconnectedAt : null;
      reconnectCount++;
      console.log(`[firebase-recovery] reconnected after ${downtimeMs ?? '?'}ms`);
      beginResync();
      return;
    }
    emitStatus();
    return;
  }

  // Duplicate "disconnected" report.
  if (!online) return;
  online = false;
  lastDisconnectedAt = Date.now();
  clearResyncTimer();
  resyncPending = false;
  console.warn('[firebase-recovery] connection lost - the SDK will retry automatically');
  emitStatus();
}

/**
 * Resolve `{ db, ref, onValue, goOffline, goOnline }`, preferring injected
 * dependencies. The dynamic imports keep a bare `import` of this module free of
 * Firebase side effects (`firebase-config.js` builds a live Database eagerly).
 */
async function resolveDeps(overrides = {}) {
  if (overrides.db) {
    const rtdb = overrides.ref && overrides.onValue ? overrides : await import('firebase/database');
    return {
      db: overrides.db,
      ref: overrides.ref || rtdb.ref,
      onValue: overrides.onValue || rtdb.onValue,
      goOffline: overrides.goOffline || rtdb.goOffline,
      goOnline: overrides.goOnline || rtdb.goOnline,
    };
  }
  if (deps) return deps;

  const [config, rtdb] = await Promise.all([
    import('./firebase-config.js'),
    import('firebase/database'),
  ]);
  deps = {
    db: config.db,
    ref: rtdb.ref,
    onValue: rtdb.onValue,
    goOffline: rtdb.goOffline,
    goOnline: rtdb.goOnline,
  };
  return deps;
}

/**
 * Start watching Firebase's `.info/connected` reference (Req 16.3).
 *
 * Lazy and failure-tolerant: the Firebase modules are imported on demand and
 * any failure (no live database, jsdom, offline build) is logged and swallowed,
 * leaving `monitoring: false`. Safe to call more than once.
 *
 * @param {Object} [options]
 * @param {any} [options.db] - Injected Database (tests)
 * @param {Function} [options.ref] - Injected `ref` (tests)
 * @param {Function} [options.onValue] - Injected `onValue` (tests)
 * @param {Function} [options.goOffline]
 * @param {Function} [options.goOnline]
 * @returns {Promise<boolean>} true when the listener attached
 */
export async function startConnectionMonitor(options = {}) {
  if (monitoring) return true;

  try {
    // An explicitly falsy `db` means "there is no database here" (unit tests,
    // pre-auth boot). Do not fall back to importing the live config.
    if (Object.prototype.hasOwnProperty.call(options, 'db') && !options.db) {
      throw new Error('Firebase database unavailable');
    }

    const resolved = await resolveDeps(options);
    if (!resolved || !resolved.db || !resolved.ref || !resolved.onValue) {
      throw new Error('Firebase database unavailable');
    }
    if (!options.db) deps = resolved;

    const infoRef = resolved.ref(resolved.db, '.info/connected');
    const unsubscribe = resolved.onValue(infoRef, (snapshot) => {
      try {
        handleConnectedValue(snapshot && typeof snapshot.val === 'function' ? snapshot.val() : snapshot);
      } catch (error) {
        logError('connectionMonitor', error, {});
      }
    }, (error) => {
      logError('connectionMonitor', error, {});
    });

    detachInfoListener = typeof unsubscribe === 'function' ? unsubscribe : null;
    monitoring = true;
    emitStatus();
    return true;
  } catch (error) {
    // No live database (unit tests, misconfigured env): stay dormant.
    monitoring = false;
    logError('startConnectionMonitor', error, {});
    emitStatus();
    return false;
  }
}

/** Detach the `.info/connected` listener and cancel any resync watchdog. */
export function stopConnectionMonitor() {
  if (detachInfoListener) {
    try { detachInfoListener(); } catch (_) {}
  }
  detachInfoListener = null;
  monitoring = false;
  clearResyncTimer();
  resyncPending = false;
  emitStatus();
}

/**
 * Manually kick the socket (goOffline → goOnline). The SDK already reconnects
 * on its own; this is the escape hatch for a wedged connection, e.g. after a
 * long background suspend on mobile.
 *
 * @returns {Promise<boolean>} true when the kick was issued
 */
export async function forceReconnect() {
  try {
    const resolved = deps || await resolveDeps();
    if (!resolved || !resolved.db || !resolved.goOffline || !resolved.goOnline) return false;
    resolved.goOffline(resolved.db);
    resolved.goOnline(resolved.db);
    console.log('[firebase-recovery] forced a reconnect');
    return true;
  } catch (error) {
    logError('forceReconnect', error, {});
    return false;
  }
}

/* ============================ test/reset helper ========================== */

/** Reset module state. Intended for tests only. */
export function __resetRecoveryForTests() {
  stopConnectionMonitor();
  deps = null;
  online = true;
  everConnected = false;
  lastConnectedAt = null;
  lastDisconnectedAt = null;
  downtimeMs = null;
  reconnectCount = 0;
  resyncPending = false;
  resyncOverdue = false;
  resyncStartedAt = null;
  errorContextProvider = null;
  statusListeners.clear();
  reconnectListeners.clear();
  errorListeners.clear();
}

export default {
  withRetry,
  withReadRetry,
  classifyError,
  isRetryableError,
  logError,
  setErrorContextProvider,
  startConnectionMonitor,
  stopConnectionMonitor,
  forceReconnect,
  getConnectionStatus,
  onConnectionChange,
  onReconnect,
  markResynced,
  isOnline,
  onRecoveryError,
  CONNECTION_STATUS_EVENT,
  RECOVERY_ERROR_EVENT,
  READ_RETRY_MESSAGE,
  WRITE_RETRY_MESSAGE,
  WRITE_FAILED_MESSAGE,
  READ_FAILED_MESSAGE,
  CONNECTION_LOST_MESSAGE,
  CONNECTION_RESTORED_MESSAGE,
  RETRY_DELAYS_MS,
  MAX_WRITE_RETRIES,
  MAX_READ_RETRIES,
  RESYNC_DEADLINE_MS,
};
