/**
 * UI Controller — Musical Chairs
 *
 * Entry point loaded by `index.html` as `<script type="module" src="/src/main.js">`.
 * Owns screen navigation, the shared UI helpers (toast / loading / screen-reader
 * announcements), and the application bootstrap.
 *
 * Task 6.1 | Requirements: 16.5, 20.8
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DOM CONTRACT (fixed by index.html + style.css — do not invent new IDs)
 * ─────────────────────────────────────────────────────────────────────────────
 *   - Screens are `<section class="screen">` toggled with the `active` CLASS.
 *     `.screen { display: none }` / `.screen.active { display: flex }`.
 *     NEVER use the `hidden` attribute to switch screens.
 *   - `#toastNotification` starts with `[hidden]` and opacity 0. The transition
 *     only runs if `[hidden]` is removed and `.show` is added on a LATER FRAME.
 *     Optional modifier classes: `.error`, `.success`.
 *   - `#loadingOverlay` is driven by the `hidden` attribute only (it has no
 *     `.show` state); `#loadingText` carries the message.
 *   - `#muteBtn` must keep `aria-pressed` AND `aria-label` in sync with the
 *     glyph inside `#muteIcon` (🔊 / 🔇).
 *   - `#liveAnnouncer` is an `aria-live="assertive"` region for phase changes.
 *     `#toastNotification` is already `aria-live="polite"`, so a toast must not
 *     be duplicated into the announcer.
 *   - The gameplay surface is `#stage` (a real `<button>`): `#stageChairs`
 *     and `#stageOrbit` are filled with `.chair` / active `.actor` elements by
 *     SECTION 10. JS owns their POSITION (inline left/top percentages) while
 *     style.css owns their appearance. `#stageHint` is the claim feedback
 *     region; `#stagePlayerList` is its sr-only equivalent because the ring
 *     itself is `aria-hidden`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECTION MAP
 * ─────────────────────────────────────────────────────────────────────────────
 *    1. Imports                                        (task 6.1)
 *    2. Constants                                      (task 6.1)
 *    3. Module state                                   (task 6.1)
 *    4. Screen navigation + UI helpers                 (task 6.1)
 *    5. Mute / audio status wiring                     (task 6.1)
 *    6. Connection status wiring                       (task 6.1)
 *    7. Bootstrap / DOMContentLoaded                   (task 6.1)
 *    8. Room create & join flows                       (task 6.2)
 *    9. Lobby rendering & game start                   (task 6.3)
 *   10. Game screen, stage & drag-to-claim             (task 6.4)
 *   11. Elimination animation & round advance          (task 6.5)
 *   12. Victory screen & replay                        (task 6.6)
 *   13. Session persistence, rejoin & recovery         (tasks 7.2, 7.3, 8.2, 8.3)
 *   14. PWA / service worker registration              (task 9.2)
 *
 * House rules for the sections below:
 *   - Add imports to SECTION 1, module-level mutable state to SECTION 3. Do not
 *     scatter either through the flow sections.
 *   - Use {@link el} when a missing fixed-contract node should emit a warning;
 *     direct DOM access is appropriate for optional or repeatedly queried nodes.
 *   - Use {@link showToast} for transient notices and {@link announce} for
 *     assertive nonvisual updates. Dedicated live regions are updated directly
 *     so the same message is never announced twice.
 */

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — IMPORTS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Namespace import on purpose. It gives {@link initFirebase} access to the
 * existing `authReady` promise alongside the shared auth and database exports.
 */
import * as firebaseConfig from './firebase-config.js';

import {
  initAudio,
  isMuted,
  toggleMute,
  onAudioStatusChange,
  startMusic,
  stopMusic,
  playSound,
} from './audio-manager.js';

import {
  initDeepLinkHandler,
  createShareHandler,
  showQRCode,
} from './deep-link-handler.js';

import {
  onConnectionChange,
  onReconnect,
  getConnectionStatus,
  isOnline,
  startConnectionMonitor,
  logError,
  withRetry,
  withReadRetry,
  setErrorContextProvider,
  CONNECTION_RESTORED_MESSAGE,
} from './firebase-recovery.js';

// ── Tasks 6.2 - 6.6 ─────────────────────────────────────────────────────────
// firebase-sync.js owns room lifecycle, real-time listeners, and the atomic
// initial start. game-manager.js owns host-guarded round progression and claim
// resolution.
import {
  createRoom,
  joinRoom,
  listenRoom,
  startGame,
  endGame,
  setupDisconnectHandler,
  restoreConnection,
  deleteRoomAfterHostLossGrace,
  removePlayer,
  deleteRoom,
  HOST_LOSS_GRACE_MS,
  PLAYER_AVATARS,
} from './firebase-sync.js';

import {
  // constants + shared local state
  gameState,
  PHASES,
  MIN_PLAYERS,
  MAX_PLAYERS,
  resetLocalGameState,
  roomPath,
  // pure helpers
  playerKey,
  connectedPlayerIds,
  hasEnoughPlayers,
  isValidRoomCode,
  normalizeRoomCode,
  isRoomFull,
  buildMusicPhaseState,
  toFirebaseGameState,
  checkVictory,
  computeFinalRankings,
  resetGame,
  // pure chair helpers (the drag-to-claim mechanic)
  canClaimChair,
  chairCountFor,
  chairIds,
  isValidChairId,
  normalizeChairs,
  seatedPlayerIds,
  chairOf,
  resolveDuplicateClaims,
  // Firebase I/O (host-guarded inside game-manager)
  startMusicPhase,
  startClaimPhase,
  claimChair,
  finalizeClaimPhase,
  persistVictory,
  // timers
  startMusicCountdown,
  clearMusicCountdown,
  startClaimPhaseTimeout,
  clearClaimPhaseTimeout,
  clearAllGameTimers,
  CLAIM_PHASE_TIMEOUT_MS,
  MUSIC_DURATION_MIN_MS,
  MUSIC_DURATION_MAX_MS,
} from './game-manager.js';

import {
  saveSession,
  loadSession,
  clearSession,
  getStorageStatus,
  SESSION_EXPIRED_MESSAGE,
} from './session.js';

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — CONSTANTS
// ═════════════════════════════════════════════════════════════════════════════

/** Used in share sheets, QR modals and deep-link toasts. */
export const GAME_NAME = 'Musical Chairs';

/**
 * Centralized screen IDs from index.html. Prefer `SCREENS.LOBBY` over a bare
 * string; {@link showScreen} validates the resolved target at runtime.
 */
export const SCREENS = Object.freeze({
  MENU: 'menuScreen',
  CREATE_ROOM: 'createRoomScreen',
  JOIN_ROOM: 'joinRoomScreen',
  INSTRUCTIONS: 'instructionsScreen',
  LOBBY: 'lobbyScreen',
  GAME: 'gameScreen',
  VICTORY: 'victoryScreen',
});

/** How long a toast stays fully visible before it starts fading out. */
export const TOAST_DURATION_MS = 3000;

/** Matches the `--dur-mid` transition on `.toast-notification` (240ms) + slack. */
const TOAST_FADE_MS = 280;

/** Longer dwell for a critical failure so the message is not missed (Req 16.5). */
const CRITICAL_TOAST_MS = 6000;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — MODULE STATE
// ═════════════════════════════════════════════════════════════════════════════

/** Id of the screen currently carrying `.active`. */
let currentScreenId = SCREENS.MENU;

/** Pending timers for the visible toast, so back-to-back toasts do not fight. */
let toastHideTimer = null;
let toastCleanupTimer = null;

/** Last message surfaced from each status channel — suppresses duplicate toasts. */
let lastAudioMessage = null;
let lastConnectionMessage = null;

/** Room code recovered from a `?room=ABCD` deep link; consumed by task 6.2. */
let deepLinkRoomCode = null;

/** Teardown callbacks registered during bootstrap (status subscriptions, etc.). */
const teardownCallbacks = [];

/**
 * View state for tasks 6.2 - 6.6. The authoritative game state lives in
 * `game-manager.js` (`gameState`); everything below is render bookkeeping.
 */

/** Teardown returned by {@link listenRoom}; null when not in a room (6.2). */
let unsubscribeRoom = null;

/** Latest Firebase snapshots, mirrored so any renderer can read them (6.3/6.4). */
let currentMeta = {};
let currentPlayers = {};
/** Raw `chairs` snapshot retained because listener callbacks precede game updates. */
let currentChairsSnapshot = {};
/** Current-round, schema-valid chairs only. */
let currentChairs = {};
/** Root-level rankings are authoritative; rankings never live under `game`. */
let currentRankings = [];
let currentGame = null;
let currentRoomStatus = 'lobby';

/** Cancellable onDisconnect registration, including registrations still awaiting setup. */
let disconnectRegistration = null;
let disconnectRegistrationGeneration = 0;

/** Exact host-loss generation watched by a non-host before deleting the room. */
let hostLossTimer = null;
let hostLossMarker = null;
let hostLossDeletionLatched = false;

/** True while a leave is in flight, so late Firebase events are ignored (6.3). */
let leavingRoom = false;

/** Phase/round already rendered — prevents music and timers restarting on repeated snapshots. */
let renderedPhase = null;
let renderedRound = 0;

/** Local claim latch — mirrors `gameState.hasLocalPlayerClaimed` (6.4). */
let isClaimRecorded = false;

/** Host-side guard so a claiming phase resolves exactly once (6.4). */
let claimPhaseResolving = false;

/* ------------------------- stage / drag view state ------------------------ */

/**
 * Signature of the stage currently in the DOM (round + chairs + roster).
 * The stage is only rebuilt when this changes, so a snapshot arriving mid-drag
 * cannot replace the element under the player's finger.
 */
let renderedStageSignature = null;

/**
 * The live drag, or null when no pointer is down. Owns exactly one pointer.
 * @type {{
 *   actor: HTMLElement,
 *   pointerId: number,
 *   claiming: boolean,
 *   targetChairId: string|null,
 *   onMove: (event: PointerEvent) => void,
 *   onEnd: (event: PointerEvent) => void
 * } | null}
 */
let dragState = null;

/** Chairs this device already knows are gone, so a lost race is not re-fired. */
let blockedChairIds = new Set();

/** Pending `.actor.rejected` class removals, cleared on teardown. */
const rejectTimers = new Set();

/** True once the delegated pointerdown listener is on `#stageOrbit`. */
let stageDragWired = false;

/** Elimination animation lock (6.5) — mirrors `gameState.isAnimatingElimination`. */
let isAnimatingElimination = false;
let eliminationTimer = null;

/** One entry per round, in round order, for {@link computeFinalRankings} (6.6). */
let eliminationHistory = [];

/** Victory screen bookkeeping so the sound/persist happen once (6.6). */
let victoryRendered = false;
let victoryPersisted = false;

/** Lobby prune: when each player was first seen disconnected (Req 2.2, 6.3). */
let disconnectedSince = {};
let lobbyPruneTimer = null;

/** Set once the gameplay DOM wiring has run. */
let gameplayInitialized = false;

/** Lazily imported `firebase/database` helpers (see {@link loadRtdb}). */
let rtdbModule = null;

/* ------------------ session / recovery state (SECTION 13) ----------------- */

/** Auto-rejoin runs at most once per page load (task 7.2). */
let sessionRestoreAttempted = false;

/** True while {@link attemptAutoRejoin} is mid-flight, so snapshot handlers wait. */
let sessionRestoreInFlight = false;

/** `connected: true` self-heal bookkeeping (Req 11.2, 11.3). */
let reassertInFlight = false;
let lastReassertAt = 0;

/** Reconnection grace window before a dropped player becomes unseated (Req 11.4). */
let reconnectGraceTimer = null;
/** Round whose grace window has already been spent (one window per round). */
let reconnectGraceRound = 0;
/** True while the grace window owns the `claimPhaseResolving` latch. */
let holdingResolution = false;

/** Local marker: the room has no connected players left (Req 17.1). */
let roomAbandoned = false;

/** Phase-stall watchdog (Req 16.5, design §Timing and Synchronization Errors). */
let stallWatchdogTimer = null;
let watchedPhase = null;
let watchedRound = 0;
let watchedSince = 0;

/** Ownership of `#loadingOverlay` while the syncing overlay is up. */
let syncOverlayOwned = false;
let syncOverlaySince = 0;
let syncOverlayMessage = null;
/** The Refresh button injected into `.loading-content` past the 10s stall mark. */
let refreshActionButton = null;

/** Teardown for the action handlers on the update toast (SECTION 14). */
let updateToastCleanup = null;
/** Installed worker held in `waiting` until the player explicitly updates. */
let waitingServiceWorker = null;
/** Reload on controller change only when this page requested the activation. */
let updateActivationRequested = false;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — SCREEN NAVIGATION + UI HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `document.getElementById` with a single, consistent warning path.
 * The DOM is a fixed contract, so a miss is a bug worth logging — but never
 * worth throwing over in the middle of a live round.
 *
 * @param {string} id
 * @returns {HTMLElement|null}
 */
export function el(id) {
  const node = document.getElementById(id);
  if (!node) console.warn(`[ui] element #${id} not found`);
  return node;
}

/**
 * Move keyboard focus to a screen's heading so screen-reader users land on the
 * new context instead of staying on the button they just pressed.
 * Headings are not focusable by default, so a `tabindex="-1"` is added once.
 *
 * @param {HTMLElement} screen
 */
function focusScreenHeading(screen) {
  // `aria-labelledby` on each <section> already points at its heading.
  const labelledBy = screen.getAttribute('aria-labelledby');
  const heading = (labelledBy && document.getElementById(labelledBy))
    || screen.querySelector('h1, h2, h3');
  if (!heading) return;

  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  try {
    heading.focus({ preventScroll: true });
  } catch (_) {
    try { heading.focus(); } catch (_) {}
  }
  try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch (_) {}
}

/**
 * Show one screen and hide the rest.
 *
 * Screens are switched with the `active` class (the style.css contract); the
 * `hidden` attribute is only stripped defensively because `initDeepLinkHandler`
 * sets it on the join screen.
 *
 * @param {string} screenId - One of {@link SCREENS}
 * @param {Object} [options]
 * @param {boolean} [options.focus=true] - Move focus to the new screen's heading
 * @returns {boolean} true when the screen existed and is now active
 */
export function showScreen(screenId, { focus = true } = {}) {
  const target = document.getElementById(screenId);
  if (!target) {
    console.error(`[ui] showScreen: screen #${screenId} not found`);
    return false;
  }

  document.querySelectorAll('.screen').forEach((screen) => {
    screen.classList.remove('active');
  });

  target.removeAttribute('hidden');
  target.classList.add('active');
  currentScreenId = screenId;

  if (focus) focusScreenHeading(target);
  return true;
}

/** Id of the screen currently displayed. */
export function getCurrentScreen() {
  return currentScreenId;
}

/**
 * Announce a message through `#liveAnnouncer` (assertive region) for phase
 * changes and other non-visual state updates.
 *
 * The text is cleared first so an identical repeat message is still spoken.
 * Do NOT pair this with {@link showToast} for the same text — the toast is
 * already an `aria-live="polite"` region and would double-announce.
 *
 * @param {string} message
 */
export function announce(message) {
  const announcer = document.getElementById('liveAnnouncer');
  if (!announcer || !message) return;
  announcer.textContent = '';
  requestFrame(() => { announcer.textContent = String(message); });
}

/**
 * Run a callback on the next animation frame, falling back to a timer when
 * rAF is unavailable (jsdom, background tabs).
 *
 * @param {() => void} fn
 */
function requestFrame(fn) {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
  else setTimeout(fn, 16);
}

/**
 * Show a transient toast in `#toastNotification`.
 *
 * Sequence matters: `[hidden]` is removed first, then `.show` is added on a
 * later frame so the CSS opacity/transform transition actually runs.
 *
 * @param {string} message - Text to display
 * @param {boolean|'error'|'success'} [isError=false] - `true` → `.error`;
 *        a string picks the modifier class directly
 * @param {number} [duration=TOAST_DURATION_MS] - Visible time in ms
 */
export function showToast(message, isError = false, duration = TOAST_DURATION_MS) {
  const toast = document.getElementById('toastNotification');
  if (!toast || !message) return;

  clearToastTimers();

  const variant = typeof isError === 'string'
    ? isError
    : (isError ? 'error' : '');

  toast.textContent = String(message);
  toast.className = variant
    ? `toast-notification ${variant}`
    : 'toast-notification';
  toast.removeAttribute('hidden');

  requestFrame(() => {
    // Reading a layout value flushes the style change made above, guaranteeing
    // the browser has a "from" state to transition away from.
    void toast.offsetHeight;
    toast.classList.add('show');
  });

  toastHideTimer = setTimeout(hideToast, Math.max(0, duration));
}

/** Fade the toast out and re-apply `[hidden]` once the transition finishes. */
export function hideToast() {
  const toast = document.getElementById('toastNotification');
  if (!toast) return;

  clearToastTimers();
  toast.classList.remove('show');
  toastCleanupTimer = setTimeout(() => {
    toast.setAttribute('hidden', '');
    toast.className = 'toast-notification';
    toastCleanupTimer = null;
  }, TOAST_FADE_MS);
}

function clearToastTimers() {
  if (toastHideTimer !== null) {
    clearTimeout(toastHideTimer);
    toastHideTimer = null;
  }
  if (toastCleanupTimer !== null) {
    clearTimeout(toastCleanupTimer);
    toastCleanupTimer = null;
  }
}

/**
 * Show the blocking loading overlay.
 * `#loadingOverlay` has no `.show` state — visibility is the `hidden`
 * attribute alone.
 *
 * @param {string} [message='Loading…']
 */
export function showLoading(message = 'Loading…') {
  const overlay = document.getElementById('loadingOverlay');
  if (!overlay) return;
  const text = document.getElementById('loadingText');
  if (text) text.textContent = String(message);
  overlay.removeAttribute('hidden');
}

/** Hide the loading overlay. Safe to call when it is already hidden. */
export function hideLoading() {
  const overlay = document.getElementById('loadingOverlay');
  if (!overlay) return;
  overlay.setAttribute('hidden', '');
}

/**
 * Surface a critical, gameplay-blocking failure and put the player back on the
 * menu, which is the "Return to Home" surface (Req 16.5). index.html has no
 * dedicated error screen, so the menu plus a long-lived error toast carries it.
 *
 * @param {string} message - Player-facing explanation
 * @param {any} [error] - Underlying error, logged for diagnostics
 * @param {string} [context='criticalError'] - Label for the log entry
 */
export function showCriticalError(message, error, context = 'criticalError') {
  if (error) {
    try { logError(context, error, { screen: currentScreenId }); } catch (_) {}
  }
  hideLoading();
  showScreen(SCREENS.MENU);
  showToast(message, true, CRITICAL_TOAST_MS);
}

/**
 * Wire the menu navigation buttons and every Back button.
 * Buttons are `type="button"` in index.html, so no submit guard is needed.
 */
function initScreenNavigation() {
  const routes = [
    ['createRoomBtn', SCREENS.CREATE_ROOM],
    ['joinRoomBtn', SCREENS.JOIN_ROOM],
    ['instructionsBtn', SCREENS.INSTRUCTIONS],
    ['createRoomBackBtn', SCREENS.MENU],
    ['joinRoomBackBtn', SCREENS.MENU],
    ['instructionsBackBtn', SCREENS.MENU],
  ];

  routes.forEach(([buttonId, screenId]) => {
    const button = el(buttonId);
    if (!button) return;
    button.addEventListener('click', () => showScreen(screenId));
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — MUTE / AUDIO STATUS WIRING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Push the mute state onto `#muteBtn` / `#muteIcon`.
 *
 * All three signals move together — `aria-pressed` (state), `aria-label`
 * (the action the button performs) and the glyph — because style.css also keys
 * the button's colour off `[aria-pressed="true"]`.
 *
 * @param {boolean} muted
 */
function applyMuteUi(muted) {
  const button = document.getElementById('muteBtn');
  const icon = document.getElementById('muteIcon');
  if (button) {
    button.setAttribute('aria-pressed', muted ? 'true' : 'false');
    button.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
  }
  if (icon) icon.textContent = muted ? '🔇' : '🔊';
}

/**
 * Wire `#muteBtn` to the audio manager and seed the button from the persisted
 * mute preference (localStorage, read inside `isMuted()`).
 */
function initMuteToggle() {
  const button = el('muteBtn');
  applyMuteUi(isMuted());
  if (!button) return;

  button.addEventListener('click', () => {
    const muted = toggleMute();
    applyMuteUi(muted);
    // The button is not an aria-live region, so state changes are announced.
    announce(muted ? 'Sound muted' : 'Sound on');
  });
}

/**
 * Surface audio-manager hints: "Tap anywhere to enable sound" when autoplay is
 * blocked, and "Audio unavailable - visual mode only" when the files fail to
 * load. The listener fires immediately with the current status, and again on
 * every change, so identical consecutive messages are de-duplicated.
 */
function initAudioStatusWiring() {
  const unsubscribe = onAudioStatusChange((status) => {
    if (!status) return;

    // Mute can also change from inside the audio manager (retry paths).
    applyMuteUi(status.muted);

    if (!status.message) {
      lastAudioMessage = null;
      return;
    }
    if (status.message === lastAudioMessage) return;
    lastAudioMessage = status.message;
    showToast(status.message, status.silentMode);
  });

  teardownCallbacks.push(unsubscribe);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — CONNECTION STATUS WIRING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Make connection loss and restoration visible (Req 16.3, 16.4).
 *
 * `firebase-recovery.js` already owns the retry/resync logic and pre-formats the
 * copy, so this only mirrors `status.message` into a toast: an error toast while
 * offline, a neutral one while resyncing.
 */
function initConnectionStatusWiring() {
  const unsubscribe = onConnectionChange((status) => {
    if (!status) return;

    if (!status.message) {
      lastConnectionMessage = null;
      return;
    }
    if (status.message === lastConnectionMessage) return;
    lastConnectionMessage = status.message;
    showToast(status.message, !status.online);
  });

  teardownCallbacks.push(unsubscribe);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — BOOTSTRAP / DOMContentLoaded
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Await the existing `authReady` readiness value before any Firebase access.
 *
 * @returns {Promise<boolean>} true when readiness settles without rejection;
 *   false when readiness is unavailable or rejects
 */
async function initFirebase() {
  const ready = firebaseConfig.authReady;

  if (!ready) {
    console.warn(
      '[bootstrap] firebase-config.js does not export `authReady` yet — '
      + 'continuing without waiting for anonymous auth',
    );
    return false;
  }

  try {
    await (typeof ready === 'function' ? ready() : ready);
    return true;
  } catch (error) {
    logError('initFirebase', error, {});
    showToast('Sign-in failed. Some features may not work.', true);
    return false;
  }
}

/**
 * Read a `?room=ABCD` deep link, prefill `#roomCodeInput` and open the join
 * screen. `initDeepLinkHandler` clears the `hidden` attribute on the join
 * screen, which does nothing under the `active`-class contract, so the screen is
 * switched here instead.
 */
function initDeepLink() {
  try {
    const code = initDeepLinkHandler({
      roomInputId: 'roomCodeInput',
      joinScreenId: SCREENS.JOIN_ROOM,
      gameName: GAME_NAME,
    });

    if (!code) return;
    deepLinkRoomCode = code;
    showScreen(SCREENS.JOIN_ROOM);
    refreshJoinAvatarAvailability();
  } catch (error) {
    logError('initDeepLink', error, {});
  }
}

/**
 * Room code captured from a deep link, if the player arrived through a shared
 * link. Consumed by the join flow in task 6.2.
 *
 * @returns {string|null} 4-letter uppercase code, or null
 */
export function getDeepLinkRoomCode() {
  return deepLinkRoomCode;
}

/** Release every subscription made during bootstrap. Used by tests/teardown. */
export function teardownUI() {
  while (teardownCallbacks.length) {
    const fn = teardownCallbacks.pop();
    try { if (typeof fn === 'function') fn(); } catch (_) {}
  }
}

/**
 * Application bootstrap. Ordering rationale:
 *   1. DOM wiring first, so the menu is usable even if the network is dead.
 *   2. Status subscriptions before the producers they listen to, so the very
 *      first status emission is not missed.
 *   3. `initAudio()` early — it installs the first-gesture unlock handler.
 *   4. Firebase auth, then the connection monitor (it needs a live database).
 *   5. Deep link last, because it may switch the visible screen.
 */
async function bootstrap() {
  initScreenNavigation();
  initMuteToggle();
  initAudioStatusWiring();
  initConnectionStatusWiring();

  initAudio();

  showScreen(SCREENS.MENU, { focus: false });

  await initFirebase();

  // Resolves false in a jsdom/offline context and stays dormant — never throws.
  startConnectionMonitor().catch((error) => logError('startConnectionMonitor', error, {}));

  initDeepLink();

  // Tasks 7.2 / 7.3 / 8.2 — session recovery, the reconnect hook and the
  // phase-stall watchdog (SECTION 13). Wiring first, then the rejoin attempt,
  // so a room restored below is already covered by both.
  initSessionRecovery();

  // A deep link is an explicit "join this room" instruction and outranks the
  // stored session, so the rejoin is skipped when one is present.
  if (!deepLinkRoomCode) await attemptAutoRejoin();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  // Module scripts are deferred, so this only trips on a late dynamic import.
  bootstrap();
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — ROOM CREATE & JOIN FLOWS                            (task 6.2)
// ═════════════════════════════════════════════════════════════════════════════
// Requirements: 1.3, 1.4, 1.5, 1.6, 1.7, 12.5, 20.3

/* ------------------------------ constants -------------------------------- */

/** Max name length — matches `maxlength="15"` and the Firebase rules. */
const MAX_NAME_LENGTH = 15;

/** Exact copy required by Req 1.4 / 1.5. */
const ROOM_NOT_FOUND_MESSAGE = 'Room not found';
const ROOM_FULL_MESSAGE = `Room is full (${MAX_PLAYERS} players maximum)`;

/** Shared eight-avatar palette used by persistence and both pickers. */
const AVATARS = PLAYER_AVATARS;

/** Chair glyph retained for lobby player rows (Req 14.1). */
const CHAIR_GLYPH = '🪑';

/** `.player-card.eliminating` keyframe length in style.css (Req 8.1: ≥2000ms). */
const ELIMINATION_ANIMATION_MS = 2200;

/** How long a disconnected player lingers in the lobby list (Req 2.2: <5000ms). */
const LOBBY_PRUNE_DELAY_MS = 2500;

/* ---------------------------- Firebase plumbing --------------------------- */

/**
 * Lazily resolve the `firebase/database` helpers used for the multi-path
 * "Play Again" write and one-off room reads. Dynamic so a bare import of
 * main.js in jsdom stays side-effect free, mirroring the pattern in
 * game-manager.js.
 *
 * @returns {Promise<{ref: Function, get: Function, update: Function, serverTimestamp: Function}>}
 */
async function loadRtdb() {
  if (rtdbModule) return rtdbModule;
  const rtdb = await import('firebase/database');
  rtdbModule = {
    ref: rtdb.ref,
    get: rtdb.get,
    update: rtdb.update,
    serverTimestamp: rtdb.serverTimestamp,
  };
  return rtdbModule;
}

/**
 * Multi-location update at the database root, with the standard retry policy.
 * Each path is validated independently by the rules, so host-only paths can
 * travel alongside `meta/lastActivity`.
 *
 * @param {Object<string, any>} updates - Absolute path → value
 * @param {string} context - Label for logs
 * @returns {Promise<{ok: boolean, message?: string|null}>}
 */
async function applyRootUpdates(updates, context) {
  try {
    const { ref, update } = await loadRtdb();
    return await withRetry(() => update(ref(firebaseConfig.db), updates), {
      context,
      metadata: { roomCode: gameState.roomCode },
    });
  } catch (error) {
    logError(context, error, { roomCode: gameState.roomCode });
    return { ok: false, error, message: 'Action failed. Please refresh.' };
  }
}

/**
 * Read a room once as an advisory pre-join/session check for clear errors and
 * availability. `firebase-sync.joinRoom` independently rechecks the room,
 * schema, status, capacity, avatar uniqueness, and lowest available slot in
 * its transaction, so this read is not authoritative.
 *
 * @param {string} roomCode
 * @returns {Promise<{ok: boolean, value?: any}>}
 */
async function readRoomOnce(roomCode) {
  try {
    const { ref, get } = await loadRtdb();
    return await withReadRetry(() => get(ref(firebaseConfig.db, roomPath(roomCode))), {
      context: 'readRoomOnce',
      metadata: { roomCode },
    });
  } catch (error) {
    logError('readRoomOnce', error, { roomCode });
    return { ok: false, error };
  }
}

/* ------------------------------- validation ------------------------------- */

/**
 * @param {unknown} value - Raw input value
 * @returns {boolean} True for a non-empty name of at most 15 characters
 */
export function validateNameInput(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name.length >= 1 && name.length <= MAX_NAME_LENGTH;
}

/**
 * @param {unknown} value - Raw input value
 * @returns {boolean} True for 4 uppercase letters excluding I and O
 */
export function validateRoomCodeInput(value) {
  return isValidRoomCode(normalizeRoomCode(value));
}

/**
 * Write (or clear) an inline field error and keep `aria-invalid` in sync.
 * @param {string} inputId - e.g. `hostNameInput`
 * @param {string} errorId - e.g. `hostNameError`
 * @param {string|null} message - null clears the error
 */
export function setFieldError(inputId, errorId, message) {
  const input = document.getElementById(inputId);
  const error = document.getElementById(errorId);
  if (input) {
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
  if (!error) return;
  if (message) {
    error.textContent = String(message);
    error.removeAttribute('hidden');
  } else {
    error.textContent = '';
    error.setAttribute('hidden', '');
  }
}

/** Enable #createRoomSubmitBtn once the name and avatar are valid. */
function refreshCreateFormState() {
  const button = document.getElementById('createRoomSubmitBtn');
  const name = document.getElementById('hostNameInput');
  if (!button) return;
  button.disabled = !(validateNameInput(name?.value) && getSelectedAvatar('createAvatarPicker'));
}

/** Enable #joinRoomSubmitBtn once name, room code and a free avatar are valid. */
function refreshJoinFormState() {
  const button = document.getElementById('joinRoomSubmitBtn');
  const name = document.getElementById('playerNameInput');
  const code = document.getElementById('roomCodeInput');
  if (!button) return;
  button.disabled = !(
    validateNameInput(name?.value)
    && validateRoomCodeInput(code?.value)
    && getSelectedAvatar('joinAvatarPicker')
  );
}

/**
 * Clear room-specific Join form state after a final room exit. `ABCD` remains
 * the input placeholder; a fresh deep link can still prefill on the next load.
 */
function resetJoinRoomEntry() {
  // Invalidate any room lookup still in flight before it can repaint the picker.
  avatarAvailabilityRequest++;
  deepLinkRoomCode = null;

  const code = document.getElementById('roomCodeInput');
  if (code) code.value = '';
  setFieldError('roomCodeInput', 'roomCodeError', null);
  applyAvatarAvailability({}, 'Enter a room code to see which avatars are available.');
}

/* --------------------------------- avatars -------------------------------- */

/**
 * Emoji avatar for a player index (Req 1.6).
 * @param {number} playerIndex - 0-7
 * @returns {string} Emoji
 */
export function pickAvatar(playerIndex) {
  const index = Number.isInteger(playerIndex) ? Math.abs(playerIndex) : 0;
  return AVATARS[index % AVATARS.length];
}

/**
 * Avatar to render for a player: the stored `emoji` when present, otherwise the
 * deterministic index-derived one so every device agrees.
 *
 * @param {string} playerId - e.g. `player_2`
 * @param {Object} [player] - Firebase player record
 * @returns {string} Emoji
 */
function avatarFor(playerId, player) {
  if (player && typeof player.emoji === 'string' && player.emoji) return player.emoji;
  return pickAvatar(playerIndexOf(playerId));
}

/**
 * Numeric index behind a player key.
 * @param {string} playerId - e.g. `player_2`
 * @returns {number} Index, or -1 when malformed
 */
function playerIndexOf(playerId) {
  const raw = typeof playerId === 'string' ? playerId.split('_')[1] : null;
  return raw !== undefined && raw !== null && /^\d+$/.test(raw) ? Number(raw) : -1;
}

/** Latest async join-avatar preview; older room reads are ignored. */
let avatarAvailabilityRequest = 0;

/** Selected, enabled avatar in one picker. */
export function getSelectedAvatar(pickerId) {
  const picker = document.getElementById(pickerId);
  const selected = picker?.querySelector('.avatar-choice[aria-pressed="true"]:not(:disabled)');
  const avatar = selected?.dataset?.avatar;
  return AVATARS.includes(avatar) ? avatar : null;
}

function selectAvatarButton(picker, selectedButton) {
  if (!picker || !selectedButton || selectedButton.disabled) return;
  picker.querySelectorAll('.avatar-choice').forEach((button) => {
    const selected = button === selectedButton;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
}

function wireAvatarPicker(pickerId, onChange) {
  const picker = document.getElementById(pickerId);
  if (!picker) return;
  picker.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('.avatar-choice') : null;
    if (!target || !picker.contains(target) || target.disabled) return;
    selectAvatarButton(picker, target);
    if (typeof onChange === 'function') onChange();
  });
}

/**
 * Disable room-owned avatars and move selection to the first free option.
 * The preview is advisory; joinRoom performs the same check immediately before
 * writing the authoritative player record.
 */
function applyAvatarAvailability(players, message = '') {
  const picker = document.getElementById('joinAvatarPicker');
  const hint = document.getElementById('joinAvatarHint');
  if (!picker) return;

  const taken = new Set();
  sortedPlayerIds(players).forEach((playerId) => {
    const avatar = avatarFor(playerId, players[playerId]);
    if (AVATARS.includes(avatar)) taken.add(avatar);
  });

  picker.querySelectorAll('.avatar-choice').forEach((button) => {
    const unavailable = taken.has(button.dataset.avatar);
    button.disabled = unavailable;
    button.classList.toggle('unavailable', unavailable);
    button.setAttribute('aria-disabled', unavailable ? 'true' : 'false');
    if (unavailable) {
      button.classList.remove('selected');
      button.setAttribute('aria-pressed', 'false');
    }
  });

  if (!getSelectedAvatar('joinAvatarPicker')) {
    const firstFree = picker.querySelector('.avatar-choice:not(:disabled)');
    if (firstFree) selectAvatarButton(picker, firstFree);
  }

  if (hint) {
    hint.textContent = message || (taken.size
      ? 'Taken avatars are unavailable. Choose any remaining avatar.'
      : 'All avatars are currently available.');
  }
  refreshJoinFormState();
}

/** Refresh the join picker once a complete room code is available. */
async function refreshJoinAvatarAvailability() {
  const codeInput = document.getElementById('roomCodeInput');
  const code = normalizeRoomCode(codeInput?.value || getDeepLinkRoomCode() || '');
  const request = ++avatarAvailabilityRequest;

  if (!isValidRoomCode(code)) {
    applyAvatarAvailability({}, 'Enter a room code to see which avatars are available.');
    return;
  }

  const read = await readRoomOnce(code);
  if (request !== avatarAvailabilityRequest) return;
  const snapshot = read.ok ? read.value : null;
  if (!snapshot || typeof snapshot.exists !== 'function' || !snapshot.exists()) {
    applyAvatarAvailability({}, read.ok
      ? 'Room not found. Check the code and try again.'
      : 'Avatar availability could not be loaded. It will be checked when you join.');
    return;
  }
  const room = snapshot.val() || {};
  applyAvatarAvailability(room.players || {});
}

/* ------------------------------ create / join ----------------------------- */

/**
 * Shared post-entry wiring for create and join (Req 12.5, 20.3).
 * Order matters: local identity → disconnect handler → session → listener.
 *
 * @param {{roomCode: string, playerIndex: number, isHost: boolean, playerName: string}} entry
 */
async function afterRoomEntry({ roomCode, playerIndex, isHost, playerName }) {
  clearRoomLifecycleTimers();
  leavingRoom = false;
  currentMeta = {};
  currentRankings = [];
  currentChairsSnapshot = {};
  gameState.roomCode = roomCode;
  gameState.playerIndex = playerIndex;
  gameState.isHost = isHost;
  gameState.phase = PHASES.LOBBY;
  gameState.round = 1;
  gameState.activePlayerIds = [];
  gameState.hasLocalPlayerClaimed = false;
  gameState.claimedChairId = null;
  resetRoundViewState();

  // Req 12.5 — retain the cancellable onDisconnect registration immediately after entry.
  await attachDisconnectHandler();

  // Req 11.8 / 20.3 — session persistence for auto-rejoin (task 7.x consumes it).
  if (!saveSession({ roomCode, playerIndex, isHost, playerName })) {
    const status = getStorageStatus();
    if (status.message) showToast(status.message);
  }

  startRoomListener(roomCode);
  showScreen(SCREENS.LOBBY);
  renderLobby();
}

/** Cancel the retained registration and invalidate any setup still in flight. */
async function cancelDisconnectHandlerRegistration() {
  disconnectRegistrationGeneration += 1;
  const registration = disconnectRegistration;
  disconnectRegistration = null;
  if (!registration || typeof registration.cancel !== 'function') return;
  try {
    await registration.cancel();
  } catch (error) {
    logError('cancelDisconnectHandler', error, { roomCode: gameState.roomCode });
  }
}

/** Register and retain `onDisconnect` for the local player. */
export async function attachDisconnectHandler() {
  const { roomCode, playerIndex } = gameState;
  if (!roomCode || !Number.isInteger(playerIndex) || leavingRoom) return null;

  const generation = ++disconnectRegistrationGeneration;
  const previous = disconnectRegistration;
  disconnectRegistration = null;
  if (previous && typeof previous.cancel === 'function') {
    try { await previous.cancel(); } catch (error) {
      logError('replaceDisconnectHandler', error, { roomCode, playerIndex });
    }
  }

  try {
    const registration = await setupDisconnectHandler(roomCode, playerIndex);
    const stale = generation !== disconnectRegistrationGeneration
      || leavingRoom
      || gameState.roomCode !== roomCode
      || gameState.playerIndex !== playerIndex;
    if (stale) {
      try { await registration?.cancel?.(); } catch (_) {}
      return null;
    }
    disconnectRegistration = registration;
    return registration;
  } catch (error) {
    logError('attachDisconnectHandler', error, { roomCode, playerIndex });
    return null;
  }
}

/**
 * Create a room: the creator becomes `player_0`, the host, AND an active player
 * (Req 1.3, 2.3).
 * @param {Event} [event]
 */
export async function handleCreateRoom(event) {
  if (event && typeof event.preventDefault === 'function') event.preventDefault();

  const input = document.getElementById('hostNameInput');
  const name = (input?.value || '').trim();
  const avatar = getSelectedAvatar('createAvatarPicker');
  if (!validateNameInput(name)) {
    setFieldError('hostNameInput', 'hostNameError', 'Please enter your name');
    input?.focus();
    return;
  }
  if (!avatar) {
    showToast('Please choose an avatar', true);
    return;
  }
  setFieldError('hostNameInput', 'hostNameError', null);

  showLoading('Creating room…');
  try {
    const { roomCode, playerIndex } = await createRoom(name, avatar);
    await afterRoomEntry({ roomCode, playerIndex, isHost: true, playerName: name });
    showToast(`Room ${roomCode} created`, 'success');
  } catch (error) {
    logError('handleCreateRoom', error, {});
    showToast('Could not create the room. Please try again.', true);
  } finally {
    hideLoading();
  }
}

/**
 * Join an existing room, surfacing "Room not found" (Req 1.4) and
 * "Room is full (8 players maximum)" (Req 1.5) as error toasts.
 * @param {Event} [event]
 */
export async function handleJoinRoom(event) {
  if (event && typeof event.preventDefault === 'function') event.preventDefault();

  const nameInput = document.getElementById('playerNameInput');
  const codeInput = document.getElementById('roomCodeInput');
  const name = (nameInput?.value || '').trim();
  const code = normalizeRoomCode(codeInput?.value || getDeepLinkRoomCode() || '');
  const avatar = getSelectedAvatar('joinAvatarPicker');

  let invalid = false;
  if (!validateNameInput(name)) {
    setFieldError('playerNameInput', 'playerNameError', 'Please enter your name');
    invalid = true;
  } else {
    setFieldError('playerNameInput', 'playerNameError', null);
  }
  if (!isValidRoomCode(code)) {
    setFieldError('roomCodeInput', 'roomCodeError', 'Enter the 4-letter room code (A-Z, no I or O)');
    invalid = true;
  } else {
    setFieldError('roomCodeInput', 'roomCodeError', null);
  }
  if (!avatar) {
    showToast('Please choose an available avatar', true);
    invalid = true;
  }
  if (invalid) return;

  showLoading('Joining room…');
  try {
    // Advisory preflight for clear errors and availability. The join transaction
    // remains authoritative and revalidates everything; if this read fails,
    // that transaction still performs its full validation.
    const pre = await readRoomOnce(code);
    if (pre.ok) {
      const snapshot = pre.value;
      const exists = snapshot && typeof snapshot.exists === 'function' && snapshot.exists();
      if (!exists) throw new Error(ROOM_NOT_FOUND_MESSAGE);
      const room = snapshot.val() || {};
      // Malformed or abandoned rooms fail closed. Only the host or the
      // marker-gated host-loss transaction may delete a room.
      if (isRoomAbandoned(room)) {
        throw new Error(ROOM_NOT_FOUND_MESSAGE);
      }
      if (isRoomFull(room.players)) throw new Error(ROOM_FULL_MESSAGE);
      const status = room.meta?.status || 'lobby';
      if (status !== 'lobby') throw new Error('Game already started');
      applyAvatarAvailability(room.players || {});
      const avatarTaken = sortedPlayerIds(room.players).some((playerId) =>
        avatarFor(playerId, room.players[playerId]) === avatar
      );
      if (avatarTaken) throw new Error('That avatar is already taken');
    }

    const { playerIndex } = await joinRoom(code, name, avatar);
    await afterRoomEntry({ roomCode: code, playerIndex, isHost: false, playerName: name });
  } catch (error) {
    logError('handleJoinRoom', error, { roomCode: code });
    const errorText = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
    if (errorText.includes('avatar') && errorText.includes('taken')) {
      refreshJoinAvatarAvailability();
    }
    showToast(joinErrorMessage(error), true);
  } finally {
    hideLoading();
  }
}

/**
 * Map a join failure onto player-facing copy (Req 1.4, 1.5).
 * @param {any} error
 * @returns {string}
 */
function joinErrorMessage(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  if (text.includes('not found')) return ROOM_NOT_FOUND_MESSAGE;
  if (text.includes('avatar') && text.includes('taken')) return 'That avatar was just taken. Please choose another.';
  if (text.includes('valid avatar')) return 'Please choose an available avatar';
  if (text.includes('full')) return ROOM_FULL_MESSAGE;
  if (text.includes('already started')) return 'That game has already started';
  if (text.includes('permission')) return 'The game server denied room access. Ask the host to refresh, then try again.';
  return 'Could not join the room. Please try again.';
}

/* ------------------------------ room listener ----------------------------- */

/** True while the authoritative host-loss generation is active. */
function isHostLossActive() {
  return Number.isFinite(currentMeta?.hostDisconnectedAt);
}

function clearHostLossTimer() {
  if (hostLossTimer !== null) {
    clearTimeout(hostLossTimer);
    hostLossTimer = null;
  }
}

/** Watch one exact host-loss generation; no client ever promotes a new host. */
function scheduleHostLossCleanup() {
  const marker = Number.isFinite(currentMeta?.hostDisconnectedAt)
    ? currentMeta.hostDisconnectedAt
    : null;

  if (marker !== hostLossMarker) {
    clearHostLossTimer();
    hostLossMarker = marker;
    hostLossDeletionLatched = false;
  }
  if (marker === null || gameState.isHost || leavingRoom || hostLossDeletionLatched) {
    clearHostLossTimer();
    return;
  }
  if (hostLossTimer !== null || !gameState.roomCode || !Number.isInteger(gameState.playerIndex)) return;

  const roomCode = gameState.roomCode;
  const playerIndex = gameState.playerIndex;
  const delay = Math.max(0, HOST_LOSS_GRACE_MS - (Date.now() - marker));
  hostLossTimer = setTimeout(async () => {
    hostLossTimer = null;
    if (leavingRoom
      || gameState.isHost
      || gameState.roomCode !== roomCode
      || gameState.playerIndex !== playerIndex
      || currentMeta?.hostDisconnectedAt !== marker
      || hostLossDeletionLatched) return;

    const now = Date.now();
    if (now - marker < HOST_LOSS_GRACE_MS) {
      scheduleHostLossCleanup();
      return;
    }

    hostLossDeletionLatched = true;
    try {
      await deleteRoomAfterHostLossGrace(roomCode, marker, playerIndex, now);
    } catch (error) {
      logError('deleteRoomAfterHostLossGrace', error, { roomCode, marker, playerIndex });
    }
  }, delay);
}

function handleMetaUpdate(meta) {
  if (leavingRoom) return;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    handleRoomListenerError(new Error('Invalid room metadata'));
    return;
  }
  const marker = meta.hostDisconnectedAt;
  if (marker !== undefined && marker !== null && !Number.isFinite(marker)) {
    handleRoomListenerError(new Error('Invalid host disconnect marker'));
    return;
  }

  const wasBlocked = isHostLossActive();
  currentMeta = { ...meta };
  gameState.schemaVersion = meta.schemaVersion === 2 ? 2 : 1;
  scheduleHostLossCleanup();
  updateStartButtonState(currentPlayers);
  if (getCurrentScreen() === SCREENS.VICTORY) renderVictoryContent();

  // A recovered host may have watched its old phase timer expire while blocked.
  // Re-entering the phase after the atomic marker clear safely re-arms it.
  if (wasBlocked && !isHostLossActive() && gameState.isHost && currentGame) {
    renderedPhase = null;
    updateGameFromFirebase(currentGame);
  }
}

function handleRankingsUpdate(rankings) {
  if (leavingRoom) return;
  if (!Array.isArray(rankings)) {
    handleRoomListenerError(new Error('Invalid rankings snapshot'));
    return;
  }
  currentRankings = rankings;
  if (getCurrentScreen() === SCREENS.VICTORY) renderVictoryContent();
}

function handleRoomListenerError(error) {
  if (leavingRoom) return;
  failToMenu('This room data is not supported', error, 'listenRoomSchema');
}

/**
 * Attach the single real-time listener for the room (Req 12.1, 12.2, 12.4).
 * `listenRoom` delivers metadata and root rankings independently of `game`.
 *
 * @param {string} roomCode
 */
function startRoomListener(roomCode) {
  stopRoomListener();
  clearRoomLifecycleTimers();
  unsubscribeRoom = listenRoom(roomCode, {
    onMetaChange: handleMetaUpdate,
    onStatusChange: (status) => { currentRoomStatus = status || 'lobby'; },
    onPlayersChange: handlePlayersUpdate,
    onChairsChange: handleChairsUpdate,
    onRankingsChange: handleRankingsUpdate,
    onGameUpdate: (game, status) => {
      currentRoomStatus = status || currentRoomStatus;
      updateGameFromFirebase(game);
    },
    onRoomDeleted: handleRoomDeleted,
    onError: handleRoomListenerError,
  });
}

/** Detach the room listener. Safe to call when nothing is attached. */
function stopRoomListener() {
  if (!unsubscribeRoom) return;
  try { unsubscribeRoom(); } catch (_) {}
  unsubscribeRoom = null;
}

/** The room vanished under us (host deleted it / cleanup). */
function handleRoomDeleted() {
  if (leavingRoom) return;
  showToast('The room was closed', true);
  teardownRoom();
  showScreen(SCREENS.MENU);
}

/**
 * Wire both room forms plus live validation (Req 1.3, design §UI Input Errors).
 * Submit is used rather than click so Enter works on mobile keyboards.
 */
function initRoomForms() {
  const createForm = el('createRoomForm');
  const hostName = el('hostNameInput');
  wireAvatarPicker('createAvatarPicker', refreshCreateFormState);
  if (createForm) createForm.addEventListener('submit', handleCreateRoom);
  if (hostName) {
    ['input', 'change'].forEach((ev) => hostName.addEventListener(ev, () => {
      setFieldError('hostNameInput', 'hostNameError', null);
      refreshCreateFormState();
    }));
  }
  refreshCreateFormState();

  const joinForm = el('joinRoomForm');
  const playerName = el('playerNameInput');
  const roomCode = el('roomCodeInput');
  wireAvatarPicker('joinAvatarPicker', refreshJoinFormState);
  if (joinForm) {
    joinForm.addEventListener('submit', handleJoinRoom);
    // Deep-link prefill happens after bootstrap's await, with no input event.
    joinForm.addEventListener('focusin', () => {
      refreshJoinFormState();
      refreshJoinAvatarAvailability();
    }, { once: true });
  }
  if (playerName) {
    ['input', 'change'].forEach((ev) => playerName.addEventListener(ev, () => {
      setFieldError('playerNameInput', 'playerNameError', null);
      refreshJoinFormState();
    }));
  }
  if (roomCode) {
    ['input', 'change'].forEach((ev) => roomCode.addEventListener(ev, () => {
      const cleaned = String(roomCode.value || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      if (cleaned !== roomCode.value) roomCode.value = cleaned;
      setFieldError('roomCodeInput', 'roomCodeError', null);
      refreshJoinFormState();
      refreshJoinAvatarAvailability();
    }));
  }
  applyAvatarAvailability({}, 'Enter a room code to see which avatars are available.');
  refreshJoinFormState();
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — LOBBY RENDERING & GAME START                        (task 6.3)
// ═════════════════════════════════════════════════════════════════════════════
// Requirements: 2.1 - 2.5, 3.1 - 3.4, 12.4, 20.2

/**
 * Player ids in slot order.
 * @param {Object|null|undefined} players - Firebase `players` node
 * @returns {string[]}
 */
function sortedPlayerIds(players) {
  if (!players || typeof players !== 'object') return [];
  return Object.keys(players)
    .map((key) => ({ key, index: playerIndexOf(key) }))
    .filter(({ index }) => index >= 0 && index < MAX_PLAYERS)
    .sort((a, b) => a.index - b.index)
    .map(({ key }) => key);
}

/**
 * Single entry point for a `players` snapshot (Req 12.4).
 * Keeps the mirrors fresh, then refreshes whichever surface is on screen.
 *
 * @param {Object} players - Firebase `players` node
 */
function handlePlayersUpdate(players) {
  if (leavingRoom) return;
  currentPlayers = players && typeof players === 'object' ? players : {};
  gameState.players = currentPlayers;
  syncCurrentRoundChairs();
  trackDisconnections(currentPlayers);
  // Task 7.3 / 8.3 — connection reactions and the abandoned-room marker (§13).
  handleDisconnectedPlayers(currentPlayers);

  const screen = getCurrentScreen();
  if (screen === SCREENS.LOBBY) renderLobby();
  else if (screen === SCREENS.GAME) {
    updatePlayerGrid();
    // The roster only reshapes the ring while the music plays — rebuilding
    // during the claiming phase would throw away the frozen positions.
    if (gameState.phase === PHASES.MUSIC) buildStage();
    refreshStageState();
    renderSpectatorView();
  } else if (screen === SCREENS.VICTORY) renderVictoryContent();

  routeToRoomState();
}

/**
 * Note when a player first went offline so the lobby can drop them inside the
 * 5 second budget (Req 2.2) while still showing the state change first.
 * @param {Object} players
 */
function trackDisconnections(players) {
  const now = Date.now();
  const next = {};
  let pruneNeeded = false;

  sortedPlayerIds(players).forEach((id) => {
    if (players[id]?.connected === false) {
      next[id] = disconnectedSince[id] || now;
      if (now - next[id] < LOBBY_PRUNE_DELAY_MS) pruneNeeded = true;
    }
  });
  disconnectedSince = next;

  if (!pruneNeeded || getCurrentScreen() !== SCREENS.LOBBY) return;
  if (lobbyPruneTimer !== null) return;
  lobbyPruneTimer = setTimeout(() => {
    lobbyPruneTimer = null;
    if (getCurrentScreen() === SCREENS.LOBBY) renderLobby();
  }, LOBBY_PRUNE_DELAY_MS);
}

/**
 * Whether a player should still appear in the LOBBY list.
 * Connected players always do; a player who just dropped lingers briefly with
 * the `.disconnected` treatment and is then removed (Req 2.1, 2.2).
 *
 * @param {string} id
 * @param {Object} player
 * @returns {boolean}
 */
function isVisibleInLobby(id, player) {
  if (player?.connected !== false) return true;
  const since = disconnectedSince[id];
  return typeof since === 'number' && Date.now() - since < LOBBY_PRUNE_DELAY_MS;
}

/** Refresh every part of the lobby from the mirrored snapshot (Req 2.1). */
export function renderLobby() {
  const code = el('lobbyRoomCode');
  if (code) code.textContent = gameState.roomCode || '----';
  updatePlayersList(currentPlayers);
  updateStartButtonState(currentPlayers);
}

/**
 * Rebuild `#playersList` (Req 2.1, 2.3).
 * Rows carry `.player-item` plus `.is-host` / `.is-you` / `.disconnected`.
 *
 * @param {Object} players - Firebase `players` node
 */
export function updatePlayersList(players) {
  const list = el('playersList');
  const counter = el('playerCount');
  const ids = sortedPlayerIds(players).filter((id) => isVisibleInLobby(id, players[id]));
  const connectedCount = connectedPlayerIds(players).length;

  if (counter) counter.textContent = `${connectedCount}/${MAX_PLAYERS}`;
  if (!list) return;

  const localId = Number.isInteger(gameState.playerIndex) ? playerKey(gameState.playerIndex) : null;
  const fragment = document.createDocumentFragment();

  ids.forEach((id) => {
    const player = players[id] || {};
    const item = document.createElement('li');
    const classes = ['player-item'];
    if (id === playerKey(0)) classes.push('is-host');
    if (id === localId) classes.push('is-you');
    if (player.connected === false) classes.push('disconnected');
    else classes.push('active');
    item.className = classes.join(' ');

    item.appendChild(makeSpan('player-chair', CHAIR_GLYPH, true));
    item.appendChild(makeSpan('player-avatar', avatarFor(id, player), true));
    item.appendChild(makeSpan('player-name', player.name || 'Player'));
    if (id === playerKey(0)) item.appendChild(makeSpan('host-badge', 'Host'));
    if (id === localId) item.appendChild(makeSpan('you-badge', 'You'));
    item.appendChild(makeSpan('player-status', player.connected === false ? 'Offline' : 'Ready'));

    fragment.appendChild(item);
  });

  list.replaceChildren(fragment);
}

/**
 * `<span>` factory — text is assigned, never interpolated into HTML, so player
 * names cannot inject markup.
 *
 * @param {string} className
 * @param {string} text
 * @param {boolean} [decorative=false] - Hide from assistive tech
 * @returns {HTMLSpanElement}
 */
function makeSpan(className, text, decorative = false) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = String(text ?? '');
  if (decorative) span.setAttribute('aria-hidden', 'true');
  return span;
}

/**
 * `#startGameBtn` is host-only and needs MIN_PLAYERS connected (Req 2.4, 2.5).
 * @param {Object} players - Firebase `players` node
 */
export function updateStartButtonState(players) {
  const button = document.getElementById('startGameBtn');
  const hint = document.getElementById('startGameHint');

  if (!gameState.isHost) {
    if (button) {
      button.setAttribute('hidden', '');
      button.disabled = true;
    }
    if (hint) hint.textContent = 'The host starts the game when everyone is in.';
    return;
  }

  const ready = hasEnoughPlayers(players) && !isHostLossActive();
  if (button) {
    button.removeAttribute('hidden');
    button.disabled = !ready;
  }
  if (hint) {
    hint.textContent = isHostLossActive()
      ? 'Waiting for the host connection to recover.'
      : (ready
        ? 'Everyone in? Start the game.'
        : `Need at least ${MIN_PLAYERS} connected players to start.`);
  }
}

/**
 * HOST ONLY. Atomically starts the room with status "playing" and round one
 * directly in the music phase, using a 30–60 second duration and server
 * timestamp while clearing chairs (Req 3.1, 3.2, 3.3, 3.4). This prevents a
 * transient schema-v2 playing/lobby state.
 */
export async function handleStartGame() {
  if (!gameState.isHost || !gameState.roomCode || isHostLossActive()) return;

  const activePlayerIds = connectedPlayerIds(currentPlayers);
  if (activePlayerIds.length < MIN_PLAYERS) {
    showToast(`Need at least ${MIN_PLAYERS} connected players to start`, true);
    return;
  }

  const button = document.getElementById('startGameBtn');
  if (button) button.disabled = true;
  showLoading('Starting game…');

  // Req 3.3 — every connected player, the host included, starts round one.
  // Status and game phase transition atomically to the first music phase so
  // schema-v2 observers never see the forbidden playing/lobby combination.
  const initialGame = buildMusicPhaseState(1, activePlayerIds);

  try {
    await startGame(gameState.roomCode, initialGame);
  } catch (error) {
    logError('handleStartGame', error, { roomCode: gameState.roomCode });
    showToast('Could not start the game. Please try again.', true);
    hideLoading();
    if (button) button.disabled = false;
    return;
  }

  resetRoundViewState();
  eliminationHistory = [];
  gameState.round = initialGame.round;
  gameState.activePlayerIds = [...initialGame.activePlayerIds];
  hideLoading();
}

/** Leave the room from the lobby (Req 17.4). */
export async function handleLeaveLobby() {
  await leaveRoom();
}

/**
 * Tear down every room subscription/timer and reset local state.
 * @param {Object} [options]
 * @param {boolean} [options.keepSession=false]
 */
function teardownRoom({ keepSession = false } = {}) {
  leavingRoom = true;
  stopRoomListener();
  cancelDisconnectHandlerRegistration().catch(() => {});
  clearRoomLifecycleTimers();
  try { stopMusic(); } catch (_) {}
  if (!keepSession) {
    clearSession();
    resetJoinRoomEntry();
  }

  endDrag({ reason: 'leave-room' });
  renderedStageSignature = null;
  currentMeta = {};
  currentPlayers = {};
  currentChairsSnapshot = {};
  currentChairs = {};
  currentRankings = [];
  currentGame = null;
  currentRoomStatus = 'lobby';
  hostLossMarker = null;
  hostLossDeletionLatched = false;
  disconnectedSince = {};
  eliminationHistory = [];
  roomAbandoned = false;
  resetRoundViewState();
  unlockGameControls();
  resetLocalGameState();
  leavingRoom = false;
}

/**
 * Leave the room: remove the player record, clear the session, return to menu
 * (Req 15.x "Return to Menu", 17.4).
 */
async function leaveRoom() {
  const { roomCode, playerIndex, isHost } = gameState;
  const hadPlayer = Boolean(roomCode) && Number.isInteger(playerIndex);
  leavingRoom = true;
  stopRoomListener();
  clearRoomLifecycleTimers();

  // Intentional leave must disarm the queued disconnect write before changing
  // room state. A host closes the room immediately; guests remove only self.
  await cancelDisconnectHandlerRegistration();
  if (hadPlayer) {
    try {
      if (isHost) await deleteRoom(roomCode);
      else await removePlayer(roomCode, playerIndex);
    } catch (error) {
      logError('leaveRoom', error, { roomCode, playerIndex, isHost });
    }
  }

  teardownRoom();
  showScreen(SCREENS.MENU);
}

/** Wire the lobby footer + invite buttons (Req 20.2). */
function initLobbyControls() {
  const share = el('shareRoomBtn');
  if (share) {
    share.addEventListener('click', () => {
      if (!gameState.roomCode) return;
      createShareHandler(gameState.roomCode, GAME_NAME)();
    });
  }

  const qr = el('qrCodeBtn');
  if (qr) {
    qr.addEventListener('click', () => {
      if (!gameState.roomCode) return;
      showQRCode(gameState.roomCode, GAME_NAME);
    });
  }

  const start = el('startGameBtn');
  if (start) start.addEventListener('click', handleStartGame);

  const leave = el('leaveLobbyBtn');
  if (leave) leave.addEventListener('click', handleLeaveLobby);
}

/**
 * Put the player on the right screen for the current room state.
 * `meta/status` is the coarse gate; `game.phase` decides game vs victory.
 */
function routeToRoomState() {
  if (leavingRoom || !gameState.roomCode) return;

  const phase = currentGame?.phase || null;
  const inLobby = currentRoomStatus === 'lobby' && (!phase || phase === PHASES.LOBBY);

  if (inLobby) {
    if (getCurrentScreen() !== SCREENS.LOBBY) {
      resetRoundViewState();
      eliminationHistory = [];
      showScreen(SCREENS.LOBBY);
    }
    renderLobby();
    return;
  }

  if (phase === PHASES.VICTORY || currentRoomStatus === 'finished') {
    showVictoryScreen();
    return;
  }

  if (getCurrentScreen() !== SCREENS.GAME) showScreen(SCREENS.GAME);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — GAME SCREEN, STAGE & DRAG-TO-CLAIM                 (task 6.4)
// ═════════════════════════════════════════════════════════════════════════════
// Requirements: 4.5, 5.1, 5.2, 6.1 - 6.7, 9.5, 12.2, 14.5, 14.6, 19.1, 19.2
//
// #phaseIndicator, #roundIndicator, #stageHint and #eliminationBanner are all
// aria-live in index.html, so text is written straight into them — calling
// announce() with the same copy would speak it twice.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MECHANIC
// ─────────────────────────────────────────────────────────────────────────────
// N active players, N-1 chairs. During the music phase the avatars orbit
// OUTSIDE the chair ring (a CSS animation on `#stageOrbit`). When the music
// stops they freeze exactly where they are and each player DRAGS THEIR OWN
// avatar onto a free chair. The claim fires the moment the avatar enters a
// chair's capture zone — not on release. Whoever holds no chair when the round
// resolves is eliminated.
//
// ─────────────────────────────────────────────────────────────────────────────
// GEOMETRY CONTRACT WITH style.css (§12b)
// ─────────────────────────────────────────────────────────────────────────────
//   * JS owns POSITION, CSS owns APPEARANCE. Every `.chair` / `.actor` gets
//     inline `left` / `top` as PERCENTAGES of the stage box; style.css sets
//     neither, so the two never fight.
//   * left = 50 + R * cos(theta), top = 50 + R * sin(theta), theta starting at
//     -90deg (12 o'clock) and stepping by 360/count.
//   * The radii are UNITLESS percentages read from `--chair-radius` /
//     `--orbit-radius` on `#stage`, so retuning the look is a CSS-only change.
//   * Both elements are `position: absolute; transform: translate(-50%, -50%)`.
//     Any inline transform written here MUST preserve that translate.
//   * The whole ring rotates, so an actor's inline coordinate is NOT its visual
//     position while the music plays — see {@link freezeActorsInPlace}.

/** The `.game-container` element inside #gameScreen. */
function gameContainer() {
  return document.querySelector('#gameScreen .game-container');
}

/** Local player's Firebase key, or null before a room is joined. */
function localPlayerId() {
  return Number.isInteger(gameState.playerIndex) ? playerKey(gameState.playerIndex) : null;
}

/** Authoritative context required to reject stale or malformed chair claims. */
function currentChairContext(players = currentPlayers) {
  return {
    schemaVersion: currentMeta?.schemaVersion === 2 ? 2 : 1,
    round: gameState.round,
    phase: gameState.phase,
    activePlayerIds: gameState.activePlayerIds,
    players,
  };
}

/** Re-project the latest raw chairs snapshot onto the current round. */
function syncCurrentRoundChairs() {
  const context = currentChairContext();
  currentChairs = normalizeChairs(currentChairsSnapshot, context);
  gameState.chairs = currentChairs;

  const localId = localPlayerId();
  const myChairId = localId ? chairOf(currentChairs, localId, context) : null;
  if (myChairId) {
    isClaimRecorded = true;
    gameState.hasLocalPlayerClaimed = true;
    gameState.claimedChairId = myChairId;
    endDrag({ reason: 'seated' });
  }
  Object.entries(currentChairs).forEach(([chairId, record]) => {
    if (record.playerId !== localId) blockedChairIds.add(chairId);
  });
  return currentChairs;
}

/**
 * Whether the local player is out of the game (Req 6.2, spectator view).
 * @returns {boolean}
 */
function isLocalPlayerEliminated() {
  const id = localPlayerId();
  if (!id) return false;
  if (currentPlayers[id]?.eliminated === true) return true;
  const active = Array.isArray(gameState.activePlayerIds) ? gameState.activePlayerIds : [];
  const started = Boolean(currentGame) && currentGame.phase !== PHASES.LOBBY;
  return started && active.length > 0 && !active.includes(id);
}

/* --------------------------- stage geometry ------------------------------- */

/** Fallbacks matching the `.stage` defaults in style.css §12b. */
const DEFAULT_CHAIR_RADIUS = 23;
const DEFAULT_ORBIT_RADIUS = 39;

/**
 * Capture zone multiplier on the chair's own radius (Req 6.3 "feels right").
 * A finger drags the avatar, not a mouse cursor, so the zone is deliberately
 * more generous than the chair's painted size.
 */
const CHAIR_CAPTURE_SCALE = 1.5;

/** Keeps a dragged avatar inside the stage box, as a percentage. */
const DRAG_MIN_PERCENT = 3;
const DRAG_MAX_PERCENT = 97;

/** `actor-reject` keyframe length in style.css (420ms) + a frame of slack. */
const REJECT_ANIMATION_MS = 460;

/** Clear per-round view state (used on entry, round change and teardown). */
function resetRoundViewState() {
  renderedPhase = null;
  renderedRound = 0;
  isClaimRecorded = false;
  claimPhaseResolving = false;
  victoryRendered = false;
  victoryPersisted = false;
  blockedChairIds = new Set();
  gameState.hasLocalPlayerClaimed = false;
  gameState.claimedChairId = null;
  endDrag({ reason: 'reset' });
}

/**
 * Cancel the timers this module owns (elimination, lobby prune, and the
 * `.actor.rejected` class removals the drag layer schedules). Any new gameplay
 * timer belongs here — there is no parallel cleanup mechanism.
 */
function clearGameplayTimers() {
  if (eliminationTimer !== null) {
    clearTimeout(eliminationTimer);
    eliminationTimer = null;
  }
  if (lobbyPruneTimer !== null) {
    clearTimeout(lobbyPruneTimer);
    lobbyPruneTimer = null;
  }
  rejectTimers.forEach((timer) => clearTimeout(timer));
  rejectTimers.clear();
}

/** Cancel host-loss, reconnect-grace, and game timers on lifecycle boundaries. */
function clearRoomLifecycleTimers() {
  clearHostLossTimer();
  clearAllGameTimers();
  clearGameplayTimers();
  clearRecoveryTimers();
}

/**
 * THE single entry point for game state changes (Req 12.2).
 * Every device runs this; only the host's branches write back to Firebase.
 *
 * @param {Object} gameData - Firebase `game` node
 */
export function updateGameFromFirebase(gameData) {
  if (leavingRoom || !gameData || typeof gameData !== 'object') return;

  currentGame = gameData;

  const round = Number.isFinite(gameData.round) && gameData.round >= 1 ? Math.floor(gameData.round) : 1;
  const phase = Object.values(PHASES).includes(gameData.phase) ? gameData.phase : PHASES.LOBBY;

  // Mirror onto the shared local state so game-manager's helpers (canClaimChair,
  // resolveClaimPhase, checkVictory) all see the authoritative values.
  gameState.round = round;
  gameState.activePlayerIds = Array.isArray(gameData.activePlayerIds) ? [...gameData.activePlayerIds] : [];
  gameState.musicDuration = Number.isFinite(gameData.musicDuration) ? gameData.musicDuration : 0;
  gameState.musicStartTime = Number.isFinite(gameData.musicStartTime) ? gameData.musicStartTime : 0;
  gameState.eliminatedThisRound = Array.isArray(gameData.eliminatedThisRound)
    ? [...gameData.eliminatedThisRound]
    : [];
  gameState.phase = phase;

  // New round → release the per-round latches (Property 15 on the view side).
  if (round !== renderedRound) {
    isClaimRecorded = false;
    claimPhaseResolving = false;
    blockedChairIds = new Set();
    gameState.hasLocalPlayerClaimed = false;
    gameState.claimedChairId = null;
    endDrag({ reason: 'new-round' });
  }
  syncCurrentRoundChairs();

  routeToRoomState();
  if (getCurrentScreen() !== SCREENS.GAME) {
    renderedPhase = phase;
    renderedRound = round;
    return;
  }

  const changed = phase !== renderedPhase || round !== renderedRound;
  renderedPhase = phase;
  renderedRound = round;

  renderGameHeader(round);
  renderPhase(phase, gameData, changed);
  updatePlayerGrid();
  refreshStageState();
  renderSpectatorView();
}

/** Round number + room code in the game header (Req 9.5). */
function renderGameHeader(round) {
  const indicator = document.getElementById('roundIndicator');
  if (indicator) {
    const text = `Round ${round}`;
    if (indicator.textContent !== text) indicator.textContent = text;
  }
  const code = document.getElementById('gameRoomCode');
  if (code) code.textContent = gameState.roomCode || '----';
}

/**
 * Apply the phase-level container classes and run the phase entry work once
 * per phase/round (Req 14.3).
 *
 * @param {string} phase - One of {@link PHASES}
 * @param {Object} gameData - Firebase `game` node
 * @param {boolean} changed - True when the phase or round just changed
 */
function renderPhase(phase, gameData, changed) {
  const container = gameContainer();
  if (container) {
    container.classList.remove('phase-music', 'phase-claiming', 'phase-elimination');
    if (phase === PHASES.MUSIC) container.classList.add('phase-music');
    else if (phase === PHASES.CLAIMING) container.classList.add('phase-claiming');
    else if (phase === PHASES.ELIMINATION) container.classList.add('phase-elimination');
  }

  if (!changed) return;

  switch (phase) {
    case PHASES.MUSIC:
      renderMusicPhase(gameData);
      break;
    case PHASES.CLAIMING:
      renderClaimingPhase(gameData);
      break;
    case PHASES.ELIMINATION:
      renderEliminationPhase(gameData);
      break;
    default: {
      // Defensive fallback for legacy-v1 or malformed state; schema-v2 starts
      // atomically in the music phase.
      clearMusicCountdown();
      setPhaseText('Get ready…');
      setStageIdle('Get ready — the music is about to start.');
    }
  }
}

/**
 * Music phase: audio on, animated indicator, avatars orbiting OUTSIDE the chair
 * ring (Req 4.5, 5.1, 14.5).
 *
 * Deliberately shows no time-remaining readout. The music stops at a random
 * point in a 30-60s window and not knowing when is the whole game, so the only
 * cues are the animated indicator and the spinning ring.
 *
 * @param {Object} gameData - Firebase `game` node
 */
function renderMusicPhase(gameData) {
  clearClaimPhaseTimeout();
  unlockGameControls();
  clearEliminationBanner();
  endDrag({ reason: 'music' });
  isClaimRecorded = false;
  blockedChairIds = new Set();
  gameState.hasLocalPlayerClaimed = false;
  gameState.claimedChairId = null;

  setPhaseText('🎵 Music playing — keep dancing');
  setMusicIndicatorVisible(true);
  setStageHint('Music is playing. When it stops, drag yourself onto a chair.');

  // N-1 chairs, one actor per active player, then hand the ring to the CSS animation.
  buildStage({ force: true });
  setStageMode('orbiting');

  // Audio failures never block the round (Req 5.4) — startMusic swallows them.
  try { startMusic(0.3); } catch (_) {}

  const duration = Number.isFinite(gameData.musicDuration) && gameData.musicDuration > 0
    ? gameData.musicDuration
    : MUSIC_DURATION_MIN_MS;

  // The timer still runs on every device — it is what ends the phase. Only the
  // host's expiry writes the flip (Req 4.4, 19.2). No onTick handler: nothing
  // on screen tracks the remaining time any more.
  startMusicCountdown(duration, {
    onExpire: () => {
      if (!gameState.isHost || isHostLossActive()) return;
      startClaimPhase(gameState.roomCode).then((result) => {
        if (!result.ok && !result.skipped) {
          showToast(result.message || 'Could not stop the music', true);
        }
      });
    },
  });
}

/**
 * Claiming phase: music off inside 200ms, avatars frozen exactly where they
 * were, the drag window open for ACTIVE players only (Req 5.2, 6.1, 6.2, 14.6).
 *
 * @param {Object} gameData - Firebase `game` node
 */
function renderClaimingPhase(gameData) {
  clearMusicCountdown();
  unlockGameControls();
  clearEliminationBanner();

  // First statement of the phase — `stopMusic()` pauses synchronously.
  try { stopMusic(); } catch (_) {}
  // No dedicated "stop" asset ships with the game, so the short tap cue doubles
  // as the audible stop marker at a lower volume.
  try { playSound('tap', 0.5); } catch (_) {}

  setMusicIndicatorVisible(false);
  setPhaseText('🛑 MUSIC STOPPED — GRAB A CHAIR!');

  // A device that joined mid-round may never have rendered the ring.
  buildStage();
  // Order matters: measure and pin the avatars BEFORE the classes swap, or they
  // snap back to their un-rotated coordinates (Req 6.1).
  freezeActorsInPlace();
  setStageMode('claiming');

  const id = localPlayerId();
  const active = Array.isArray(gameData.activePlayerIds) ? gameData.activePlayerIds : [];
  const seatedChairId = id ? chairOf(currentChairs, id, currentChairContext()) : null;
  const canPlay = Boolean(id) && active.includes(id) && !isLocalPlayerEliminated();

  if (seatedChairId) {
    // Already seated (reconnect mid-phase, or a claim that landed early).
    isClaimRecorded = true;
    gameState.hasLocalPlayerClaimed = true;
    gameState.claimedChairId = seatedChairId;
    setStageHint('You have a chair. Sit tight!', 'success');
  } else if (canPlay) {
    isClaimRecorded = false;
    setStageHint('Drag your avatar onto a free chair!');
  } else {
    // Spectators and eliminated players get no drag surface at all (Req 6.2).
    setStageHint('Watching this round');
  }

  refreshStageState();

  // Runs everywhere so state stays aligned; only the host's handler writes
  // (Req 7.2 — the 10 second deadline).
  startClaimPhaseTimeout({
    onExpire: () => resolveClaimPhaseAsHost('timeout'),
  });
}

/** Write `#phaseIndicator` (already aria-live — do not also announce). */
function setPhaseText(text) {
  const node = document.getElementById('phaseIndicator');
  if (node) node.textContent = String(text);
}

/**
 * Write `#stageHint` — the claim feedback line (already `role="status"`
 * `aria-live="polite"`, so this must not also be announced).
 *
 * @param {string} text
 * @param {''|'success'|'late'|'error'} [variant='']
 */
function setStageHint(text, variant = '') {
  const node = document.getElementById('stageHint');
  if (!node) return;
  node.className = variant ? `stage-hint ${variant}` : 'stage-hint';
  node.textContent = String(text || '');
}

/**
 * Neutral stage: no orbit or drag window, just the supplied hint.
 * @param {string} hint
 */
function setStageIdle(hint) {
  setStageMode('idle');
  setStageHint(hint);
}

/** Show/hide the animated music indicator (Req 4.5, 14.5). */
function setMusicIndicatorVisible(visible) {
  const node = document.getElementById('musicIndicator');
  if (!node) return;
  if (visible) node.removeAttribute('hidden');
  else node.setAttribute('hidden', '');
}

/**
 * Rebuild `#playerGrid` as the compact gameplay roster (Req 14.3, 14.4).
 * Each card contains only the player's avatar and truncated name. State is
 * conveyed by `.active` / `.seated` / `.eliminated` / `.disconnected` /
 * `.is-host` / `.is-you` / `.winner` visual classes.
 *
 * Skipped while the elimination animation runs: a rebuild would restart the
 * `.eliminating` keyframe (Req 8.1).
 *
 * @param {Object} [players=currentPlayers]
 * @param {Object} [chairs=currentChairs] - `chairs` node; a player holding a
 *   chair reads as seated
 */
export function updatePlayerGrid(players = currentPlayers, chairs = currentChairs) {
  const grid = el('playerGrid');
  if (!grid || isAnimatingElimination) return;

  const localId = localPlayerId();
  const active = Array.isArray(gameState.activePlayerIds) ? gameState.activePlayerIds : [];
  const winnerId = currentGame?.winnerId || null;
  const seated = new Set(seatedPlayerIds(chairs, currentChairContext(players)));
  const fragment = document.createDocumentFragment();

  sortedPlayerIds(players).forEach((id) => {
    const player = players[id] || {};
    const eliminated = player.eliminated === true || (active.length > 0 && !active.includes(id));
    const hasChair = seated.has(id);

    const card = document.createElement('li');
    const classes = ['player-card'];
    if (eliminated) classes.push('eliminated');
    else if (hasChair) classes.push('seated');
    else classes.push('active');
    if (player.connected === false) classes.push('disconnected');
    if (id === playerKey(0)) classes.push('is-host');
    if (id === localId) classes.push('is-you');
    if (winnerId && id === winnerId) classes.push('winner');
    card.className = classes.join(' ');
    card.dataset.playerId = id;

    card.appendChild(makeSpan('player-avatar', avatarFor(id, player), true));
    card.appendChild(makeSpan('player-name', player.name || 'Player'));

    fragment.appendChild(card);
  });

  grid.replaceChildren(fragment);
  updateStagePlayerList();
}

/** Spectator view for eliminated players (Req 6.2, 8.x follow-along). */
export function renderSpectatorView() {
  const notice = document.getElementById('spectatorNotice');
  const out = isLocalPlayerEliminated();

  if (notice) {
    if (out) notice.removeAttribute('hidden');
    else notice.setAttribute('hidden', '');
  }
  if (!out) return;

  // No drag surface for a player who is out (Req 6.2): the pointerdown guard
  // rejects them, and any drag already in flight is dropped here.
  endDrag({ reason: 'eliminated' });
}

/* ------------------------------ stage geometry ---------------------------- */

/** The stage `<button>`; every radius custom property lives on it. */
function stageEl() {
  return document.getElementById('stage');
}

/** The rotating layer that holds active-player actors. */
function stageOrbitEl() {
  return document.getElementById('stageOrbit');
}

/** The static layer that holds the chairs. */
function stageChairsEl() {
  return document.getElementById('stageChairs');
}

/**
 * Ring radii from the CSS custom properties on `#stage`, as unitless
 * percentages of the stage box. style.css owns the look, so the numbers are read
 * rather than duplicated; the defaults only cover a missing stylesheet.
 *
 * @returns {{ chairRadius: number, orbitRadius: number }}
 */
function readStageRadii() {
  const stage = stageEl();
  let chairRadius = DEFAULT_CHAIR_RADIUS;
  let orbitRadius = DEFAULT_ORBIT_RADIUS;
  if (!stage || typeof getComputedStyle !== 'function') return { chairRadius, orbitRadius };

  try {
    const style = getComputedStyle(stage);
    const chair = Number.parseFloat(style.getPropertyValue('--chair-radius'));
    const orbit = Number.parseFloat(style.getPropertyValue('--orbit-radius'));
    if (Number.isFinite(chair) && chair > 0) chairRadius = chair;
    if (Number.isFinite(orbit) && orbit > 0) orbitRadius = orbit;
  } catch (_) { /* keep the defaults */ }

  return { chairRadius, orbitRadius };
}

/**
 * Position on a ring, evenly distributed and starting at 12 o'clock:
 * `theta_i = -90deg + i * 360/count`.
 *
 * @param {number} index - 0-based slot
 * @param {number} count - Total slots on the ring
 * @param {number} radius - Unitless percentage radius from the stage centre
 * @returns {{ left: number, top: number }} Percentages of the stage box
 */
function ringPosition(index, count, radius) {
  const total = Number.isFinite(count) && count > 0 ? count : 1;
  const theta = (-90 + (index * 360) / total) * (Math.PI / 180);
  return {
    left: 50 + radius * Math.cos(theta),
    top: 50 + radius * Math.sin(theta),
  };
}

/**
 * Write a stage coordinate. Percentages only — this is the whole of the JS side
 * of the geometry contract.
 *
 * @param {HTMLElement} node - A `.chair` or `.actor`
 * @param {number} left - Percentage of the stage width
 * @param {number} top - Percentage of the stage height
 */
function setStagePosition(node, left, top) {
  if (!node) return;
  node.style.left = `${round2(left)}%`;
  node.style.top = `${round2(top)}%`;
}

/** Two decimals is well under a device pixel and keeps the DOM readable. */
function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 50;
}

/* ------------------------------ stage rendering --------------------------- */

/** Active players this round, in a stable order. */
function activeStagePlayerIds() {
  const active = Array.isArray(gameState.activePlayerIds) ? gameState.activePlayerIds : [];
  const roster = sortedPlayerIds(currentPlayers);
  if (active.length > 0) return roster.filter((id) => active.includes(id));
  return roster.filter((id) => currentPlayers[id]?.eliminated !== true);
}

/**
 * Identity of the stage currently in the DOM. A rebuild only happens when this
 * changes, so a `players` snapshot cannot yank the element out from under a
 * finger mid-drag.
 *
 * @returns {string}
 */
function stageSignature() {
  const active = activeStagePlayerIds();
  return [
    gameState.round,
    chairCountFor(active),
    sortedPlayerIds(currentPlayers).join(','),
    active.join(','),
  ].join('|');
}

/**
 * Build the ring: N-1 chairs and one actor per active player (Req 6.1).
 * Active players are distributed evenly around `--orbit-radius`.
 *
 * @param {Object} [options]
 * @param {boolean} [options.force=false] - Rebuild even if the signature matches
 */
function buildStage({ force = false } = {}) {
  const chairsLayer = stageChairsEl();
  const orbit = stageOrbitEl();
  if (!chairsLayer || !orbit) return;

  const signature = stageSignature();
  const actorCount = orbit.children.length;
  if (!force && signature === renderedStageSignature && actorCount > 0) return;
  // Never rebuild under a live drag unless the round itself moved on.
  if (dragState && !force) return;

  const { chairRadius, orbitRadius } = readStageRadii();
  const active = activeStagePlayerIds();

  // Chairs: N-1, evenly spaced on the inner ring.
  const ids = chairIds(chairCountFor(active));
  const chairFragment = document.createDocumentFragment();
  ids.forEach((chairId, index) => {
    const chair = document.createElement('div');
    chair.className = 'chair available';
    chair.dataset.chairId = chairId;
    const { left, top } = ringPosition(index, ids.length, chairRadius);
    setStagePosition(chair, left, top);
    chairFragment.appendChild(chair);
  });
  chairsLayer.replaceChildren(chairFragment);

  // Only active actors live in the rotating layer.
  const activeFragment = document.createDocumentFragment();
  active.forEach((playerId, index) => {
    const { left, top } = ringPosition(index, active.length, orbitRadius);
    activeFragment.appendChild(buildActor(playerId, left, top));
  });
  orbit.replaceChildren(activeFragment);

  // A fresh active ring must not inherit the inline overrides the freeze wrote.
  orbit.style.animation = '';
  orbit.style.transform = '';

  renderedStageSignature = signature;
  refreshStageState();
}

/**
 * One `.actor` for a player, positioned and classed for its current state.
 * @param {string} playerId - e.g. `player_2`
 * @param {number} left - Percentage of the stage width
 * @param {number} top - Percentage of the stage height
 * @returns {HTMLElement}
 */
function buildActor(playerId, left, top) {
  const player = currentPlayers[playerId] || {};
  const actor = document.createElement('div');
  actor.className = 'actor';
  actor.dataset.playerId = playerId;
  setStagePosition(actor, left, top);

  const avatar = document.createElement('span');
  avatar.className = 'actor-avatar';
  avatar.textContent = avatarFor(playerId, player);
  actor.appendChild(avatar);
  return actor;
}

/**
 * Switch the stage between its three visual modes (all styled in style.css).
 *   `orbiting` — music playing, the ring spins
 *   `claiming` — music stopped, everything frozen and the drag window open
 *   `idle`     — no round in flight
 *
 * @param {'orbiting'|'claiming'|'idle'} mode
 */
function setStageMode(mode) {
  const stage = stageEl();
  if (!stage) return;

  stage.classList.remove('orbiting', 'frozen', 'claiming');
  if (mode === 'orbiting') {
    // Hand the ring back to CSS: the freeze pinned it with inline styles.
    const orbit = stageOrbitEl();
    if (orbit) {
      orbit.style.animation = '';
      orbit.style.transform = '';
    }
    orbit?.querySelectorAll('.actor').forEach((actor) => {
      actor.style.animation = '';
      actor.style.transform = '';
    });
    stage.classList.add('orbiting');
  } else if (mode === 'claiming') {
    stage.classList.add('frozen', 'claiming');
  }
}

/**
 * Re-render chair and actor STATE (never geometry) from the `chairs` mirror, so
 * every device agrees on who is sitting where (Req 6.4, 7.1).
 *
 * `resolveDuplicateClaims` is defense-in-depth for historical, malformed, or
 * partially synchronized duplicate data. Schema-v2 rules reject a second
 * chair for the same player; reconciliation keeps rendering deterministic if
 * older or invalid data is encountered.
 */
function refreshStageState() {
  const stage = stageEl();
  const chairsLayer = stageChairsEl();
  const orbit = stageOrbitEl();
  if (!stage || !chairsLayer || !orbit) return;

  const { chairs } = resolveDuplicateClaims(currentChairs, currentChairContext());
  const localId = localPlayerId();
  const active = activeStagePlayerIds();

  // ── chairs ──────────────────────────────────────────────────────────────
  chairsLayer.querySelectorAll('.chair').forEach((chair) => {
    const chairId = chair.dataset.chairId;
    const taken = Boolean(chairId && chairs[chairId]);
    chair.classList.toggle('claimed', taken);
    chair.classList.toggle('available', !taken);
    // A chair someone else just took stops being a valid capture target.
    if (taken) chair.classList.remove('target');
  });

  // ── actors ──────────────────────────────────────────────────────────────
  stage.querySelectorAll('.actor').forEach((actor) => {
    const playerId = actor.dataset.playerId;
    if (!playerId) return;
    const player = currentPlayers[playerId] || {};
    const seatChairId = chairOf(chairs, playerId, currentChairContext());
    const isDragging = Boolean(dragState && dragState.actor === actor);

    actor.classList.toggle('is-you', playerId === localId);
    actor.classList.toggle('is-host', playerId === playerKey(0));
    actor.classList.toggle('disconnected', player.connected === false);
    actor.classList.toggle('eliminated', !active.includes(playerId));
    actor.classList.toggle('seated', Boolean(seatChairId));

    // Snap a seated avatar onto its chair's coordinate — the same numbers the
    // chair carries, so the two can never drift apart.
    if (seatChairId && !isDragging) snapActorToChair(actor, seatChairId);
  });

  updateStagePlayerList();
}

/**
 * Park an actor exactly on a chair, copying the chair's own inline coordinates.
 * @param {HTMLElement} actor
 * @param {string} chairId
 */
function snapActorToChair(actor, chairId) {
  const chair = stageChairsEl()?.querySelector(`.chair[data-chair-id="${chairId}"]`);
  if (!chair || !actor) return;
  actor.style.left = chair.style.left;
  actor.style.top = chair.style.top;
  // The ring may still be mid-lap; a seated avatar must not be carried away.
  actor.style.animation = 'none';
  actor.style.transform = 'translate(-50%, -50%)';
}

/**
 * Keep `#stagePlayerList` in step with the ring (Req a11y: the visual ring is
 * `aria-hidden`, so this sr-only list is the only equivalent).
 * One `<li>` per player: name plus state (seated / out / host / you).
 */
function updateStagePlayerList() {
  const list = document.getElementById('stagePlayerList');
  if (!list) return;

  const { chairs } = resolveDuplicateClaims(currentChairs, currentChairContext());
  const localId = localPlayerId();
  const active = activeStagePlayerIds();
  const fragment = document.createDocumentFragment();

  sortedPlayerIds(currentPlayers).forEach((playerId) => {
    const player = currentPlayers[playerId] || {};
    const seatChairId = chairOf(chairs, playerId, currentChairContext());
    const tags = [];
    if (playerId === localId) tags.push('you');
    if (playerId === playerKey(0)) tags.push('host');

    let state;
    if (!active.includes(playerId)) state = 'out';
    else if (seatChairId) state = `seated on chair ${Number(seatChairId.split('_')[1]) + 1}`;
    else if (player.connected === false) state = 'offline';
    else if (gameState.phase === PHASES.CLAIMING) state = 'looking for a chair';
    else state = 'in play';

    const item = document.createElement('li');
    item.dataset.playerId = playerId;
    item.textContent = tags.length
      ? `${player.name || 'Player'} (${tags.join(', ')}) — ${state}`
      : `${player.name || 'Player'} — ${state}`;
    fragment.appendChild(item);
  });

  list.replaceChildren(fragment);
}

/* ------------------------------ freeze in place --------------------------- */

/**
 * Freeze every avatar EXACTLY where it appears when the music stops (Req 6.1).
 *
 * THE PROBLEM: the orbit is a CSS animation on `#stageOrbit`, so an actor's
 * on-screen position is its inline coordinate rotated by the ring's current
 * angle. Simply dropping the animation would teleport every avatar back to the
 * coordinate it was laid out on.
 *
 * THE FIX, in this order and all inside one synchronous task so no intermediate
 * state is ever painted:
 *   1. MEASURE first — `getBoundingClientRect()` on each actor and on the stage
 *      gives the real, post-rotation position. The ring's rotate(θ) and the
 *      actor's counter-rotate(-θ) cancel, so each box is axis-aligned and its
 *      centre IS the avatar's visual centre.
 *   2. Convert every centre back into percentages of the stage box — the same
 *      units the geometry contract uses.
 *   3. Drop the animations (`animation: none` on the ring and on each actor)
 *      while re-declaring `translate(-50%, -50%)`, which is the centring half of
 *      the contract. Net rotation was zero, so nothing turns.
 *   4. Write the measured percentages back as inline left/top.
 *
 * Reduced motion and "no animation running" are non-events: the measured rect
 * then equals the laid-out position, so step 4 rewrites the same numbers.
 */
function freezeActorsInPlace() {
  const stage = stageEl();
  const orbit = stageOrbitEl();
  if (!stage || !orbit) return;

  const actors = Array.from(orbit.querySelectorAll('.actor'));
  const box = stage.getBoundingClientRect();
  const measurable = box.width > 0 && box.height > 0;

  // 1 + 2 — measure everything BEFORE touching a single style.
  const frozen = measurable
    ? actors.map((actor) => {
      const rect = actor.getBoundingClientRect();
      return {
        actor,
        left: ((rect.left + rect.width / 2) - box.left) / box.width * 100,
        top: ((rect.top + rect.height / 2) - box.top) / box.height * 100,
      };
    })
    : [];

  // 3 — the ring stops rotating; its transform goes with it.
  orbit.style.animation = 'none';
  orbit.style.transform = 'none';
  actors.forEach((actor) => {
    actor.style.animation = 'none';
    actor.style.transform = 'translate(-50%, -50%)';
  });

  // 4 — and each avatar keeps the position it actually had.
  frozen.forEach(({ actor, left, top }) => setStagePosition(actor, left, top));
}

/* -------------------------------- dragging ------------------------------- */

/**
 * `pointerdown` on the ring (Req 6.3). Delegated, so actors can be rebuilt
 * between rounds without re-wiring anything.
 *
 * ONLY the local player's own avatar is draggable — the `data-player-id` guard
 * below is the single place that is enforced.
 *
 * Pointer events only: no touch+mouse pair, so nothing can double-fire.
 *
 * @param {PointerEvent} event
 */
function onStagePointerDown(event) {
  if (!event || event.isPrimary === false || dragState) return;

  const node = event.target instanceof Element ? event.target : null;
  const actor = node ? node.closest('.actor') : null;
  if (!actor) return;

  // Never anyone else's avatar.
  if (actor.dataset.playerId !== localPlayerId()) return;
  if (isAnimatingElimination) return;
  if (gameState.phase !== PHASES.CLAIMING) return;
  if (isLocalPlayerEliminated()) return;
  if (isClaimRecorded || gameState.hasLocalPlayerClaimed) return;

  if (typeof event.preventDefault === 'function') event.preventDefault();
  beginDrag(actor, event);
}

/**
 * Take over the pointer and start following it.
 *
 * `setPointerCapture` keeps every later move/up targeted at the avatar even when
 * the finger runs ahead of it, which is what makes a fast flick to a far chair
 * reliable. The listeners themselves sit on `window`: captured events still
 * bubble there, so one set of handlers covers both the captured and the
 * (theoretical) uncaptured case without ever double-firing.
 *
 * @param {HTMLElement} actor
 * @param {PointerEvent} event
 */
function beginDrag(actor, event) {
  const onMove = (moveEvent) => onDragMove(moveEvent);
  const onEnd = (endEvent) => onDragEnd(endEvent);

  dragState = {
    actor,
    pointerId: event.pointerId,
    claiming: false,
    targetChairId: null,
    onMove,
    onEnd,
  };

  try { actor.setPointerCapture(event.pointerId); } catch (_) { /* capture is a nicety */ }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onEnd);
  window.addEventListener('pointercancel', onEnd);
  actor.addEventListener('lostpointercapture', onEnd);

  actor.classList.remove('rejected');
  actor.classList.add('dragging');
  // The inline coordinates are the only thing that may move the avatar now.
  actor.style.animation = 'none';
  actor.style.transform = 'translate(-50%, -50%)';

  moveActorToPointer(event);
}

/**
 * Follow the pointer and claim on entry into a capture zone (Req 6.3).
 * The claim fires HERE — on move, not on release.
 * @param {PointerEvent} event
 */
function onDragMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  if (typeof event.preventDefault === 'function') event.preventDefault();

  moveActorToPointer(event);

  const chairId = hitTestChair(event.clientX, event.clientY);
  setTargetChair(chairId);
  if (chairId && !dragState.claiming) attemptClaim(chairId);
}

/**
 * Release the pointer. A drag that ends over open floor leaves the avatar at its
 * final dragged position; releasing never creates a claim because claims happen
 * only on capture-zone entry while moving.
 * @param {PointerEvent} event
 */
function onDragEnd(event) {
  if (!dragState) return;
  if (event && event.pointerId !== undefined && event.pointerId !== dragState.pointerId) return;
  endDrag({ reason: event?.type || 'pointerup' });
}

/**
 * Tear a drag down: pointer capture, listeners, `.dragging` and any leftover
 * `.chair.target` all go together. Idempotent, so every teardown path can call
 * it unconditionally.
 *
 * @param {Object} [options]
 * @param {string} [options.reason] - Log/diagnostic label only
 */
function endDrag({ reason = 'end' } = {}) {
  if (!dragState) return;
  const { actor, pointerId, onMove, onEnd } = dragState;
  dragState = null;

  try {
    if (actor.hasPointerCapture && actor.hasPointerCapture(pointerId)) {
      actor.releasePointerCapture(pointerId);
    }
  } catch (_) { /* the pointer is already gone */ }

  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onEnd);
  window.removeEventListener('pointercancel', onEnd);
  actor.removeEventListener('lostpointercapture', onEnd);
  actor.classList.remove('dragging');
  clearChairTargets();
}

/**
 * Move the dragged avatar so its CENTRE sits under the pointer, in stage
 * percentages, clamped to the stage box.
 * @param {PointerEvent} event
 */
function moveActorToPointer(event) {
  if (!dragState) return;
  const stage = stageEl();
  if (!stage) return;

  const box = stage.getBoundingClientRect();
  if (!(box.width > 0) || !(box.height > 0)) return;

  const left = clampPercent(((event.clientX - box.left) / box.width) * 100);
  const top = clampPercent(((event.clientY - box.top) / box.height) * 100);
  setStagePosition(dragState.actor, left, top);
}

/** Keep a dragged avatar inside the stage box. */
function clampPercent(value) {
  if (!Number.isFinite(value)) return 50;
  return Math.min(Math.max(value, DRAG_MIN_PERCENT), DRAG_MAX_PERCENT);
}

/**
 * Which free chair the avatar's centre is inside (Req 6.3).
 *
 * The avatar's centre tracks the pointer exactly (see
 * {@link moveActorToPointer}), so the pointer coordinates ARE the avatar centre.
 * The capture zone is a circle of `CHAIR_CAPTURE_SCALE ×` the chair's own radius
 * — deliberately more forgiving than the painted chair, because a thumb is not
 * a mouse cursor. When two zones overlap the nearest chair wins.
 *
 * Chairs that are already claimed (locally or per the last snapshot) are never
 * returned, so a lost race cannot be re-fired at the same chair.
 *
 * @param {number} clientX
 * @param {number} clientY
 * @returns {string|null} chairId, or null when the avatar is over open floor
 */
function hitTestChair(clientX, clientY) {
  const chairsLayer = stageChairsEl();
  if (!chairsLayer || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;

  let best = null;
  let bestDistance = Infinity;

  chairsLayer.querySelectorAll('.chair').forEach((chair) => {
    const chairId = chair.dataset.chairId;
    if (!chairId || blockedChairIds.has(chairId)) return;
    if (chair.classList.contains('claimed')) return;

    const rect = chair.getBoundingClientRect();
    if (!(rect.width > 0)) return;

    const centreX = rect.left + rect.width / 2;
    const centreY = rect.top + rect.height / 2;
    const capture = (rect.width / 2) * CHAIR_CAPTURE_SCALE;
    const distance = Math.hypot(clientX - centreX, clientY - centreY);

    if (distance <= capture && distance < bestDistance) {
      best = chairId;
      bestDistance = distance;
    }
  });

  return best;
}

/**
 * Mark the chair the avatar is hovering (`.chair.target`), or clear the marker.
 * @param {string|null} chairId
 */
function setTargetChair(chairId) {
  if (dragState) dragState.targetChairId = chairId || null;
  const chairsLayer = stageChairsEl();
  if (!chairsLayer) return;

  chairsLayer.querySelectorAll('.chair').forEach((chair) => {
    chair.classList.toggle('target', Boolean(chairId) && chair.dataset.chairId === chairId);
  });
}

/** Clear every `.chair.target` capture marker. */
function clearChairTargets() {
  stageChairsEl()?.querySelectorAll('.chair.target').forEach((chair) => {
    chair.classList.remove('target');
  });
}

/**
 * Claim a chair the instant the avatar enters its capture zone
 * (Req 6.3, 6.4, 6.6, 6.7).
 *
 * Three outcomes:
 *   - `claimed`      → seat the avatar, snap it to the chair, end the drag.
 *   - `chair-taken`  → EXPECTED. Someone reached that chair first: the deployed
 *     rules make `chairs/{chairId}` create-only, so the loser's write comes back
 *     PERMISSION_DENIED and game-manager reports it as this reason. It is NOT an
 *     error: no toast, no log. The avatar bounces (`.actor.rejected`), the chair
 *     is remembered as gone, and the drag CONTINUES so the player can go
 *     straight for another chair.
 *   - anything else  → surfaced in the hint; the player may try again.
 *
 * `claimChair` latches `hasLocalPlayerClaimed` / `claimedChairId` before its own
 * await, and `dragState.claiming` blocks a second attempt while one is in
 * flight, so a fast drag across three chairs still writes at most once.
 *
 * @param {string} chairId - `chair_0` .. `chair_6`
 */
async function attemptClaim(chairId) {
  if (!dragState || dragState.claiming) return;
  if (!isValidChairId(chairId) || blockedChairIds.has(chairId)) return;
  if (!canClaimChair(gameState, chairId)) return;

  dragState.claiming = true;
  const actor = dragState.actor;

  const result = await claimChair(gameState.roomCode, chairId, gameState.playerIndex);

  if (result.claimed) {
    isClaimRecorded = true;
    seatLocalActor(actor, chairId);
    setStageHint('You got a chair!', 'success');
    try { playSound('tap'); } catch (_) {}
    endDrag({ reason: 'claimed' });
    updatePlayerGrid();
    return;
  }

  if (result.reason === 'chair-taken') {
    // Expected race loss — bounce back and keep dragging (Req 6.7).
    blockedChairIds.add(chairId);
    markChairClaimed(chairId);
    bounceActor(actor);
    setStageHint('Too slow — that chair is taken. Try another!', 'late');
  } else if (result.reason === 'write-failed') {
    setStageHint('That did not register — try another chair.', 'error');
  }

  if (dragState) {
    dragState.claiming = false;
    dragState.targetChairId = null;
  }
}

/**
 * Paint a successful claim: the avatar parks on the chair and the chair reads as
 * taken, both before the Firebase snapshot comes back (Req 6.5, 19.1).
 *
 * @param {HTMLElement} actor
 * @param {string} chairId
 */
function seatLocalActor(actor, chairId) {
  markChairClaimed(chairId);
  if (!actor) return;
  actor.classList.remove('dragging', 'rejected');
  actor.classList.add('seated');
  snapActorToChair(actor, chairId);
}

/**
 * Locally mark a chair as taken so it stops being a capture target immediately.
 * @param {string} chairId
 */
function markChairClaimed(chairId) {
  const chair = stageChairsEl()?.querySelector(`.chair[data-chair-id="${chairId}"]`);
  if (!chair) return;
  chair.classList.remove('available', 'target');
  chair.classList.add('claimed');
}

/**
 * Bounce an avatar that lost a race. `.actor.rejected` plays the CSS bounce
 * (and, under reduced motion, a static dotted danger ring instead), and the
 * class is removed again so a second race can replay it.
 *
 * @param {HTMLElement} actor
 */
function bounceActor(actor) {
  if (!actor) return;
  actor.classList.remove('rejected');
  // The freeze pinned this actor with an inline `animation: none`, which would
  // beat the stylesheet's bounce, so the property is handed back to CSS for the
  // length of the keyframe. (An inline `transform` is safe: a running animation
  // outranks inline declarations in the cascade.)
  actor.style.animation = '';
  // Reading a layout value restarts the keyframe on a repeat rejection.
  void actor.offsetWidth;
  actor.classList.add('rejected');

  const timer = setTimeout(() => {
    rejectTimers.delete(timer);
    actor.classList.remove('rejected');
    // Re-pin, or the paused orbit keyframe would tilt a frozen avatar.
    actor.style.animation = 'none';
    actor.style.transform = 'translate(-50%, -50%)';
  }, REJECT_ANIMATION_MS);
  rejectTimers.add(timer);
}

/**
 * Handle a `chairs` snapshot (Req 6.4, 7.1). Runs on every device: the seating
 * every player sees comes from here, never from local optimism alone.
 *
 * @param {Object} chairs - Firebase `chairs` node
 */
function handleChairsUpdate(chairs) {
  if (leavingRoom) return;
  currentChairsSnapshot = chairs && typeof chairs === 'object' && !Array.isArray(chairs)
    ? chairs
    : {};
  syncCurrentRoundChairs();

  if (getCurrentScreen() === SCREENS.GAME) {
    refreshStageState();
    updatePlayerGrid();
  }

  // HOST ONLY: resolve once every valid current-round chair is occupied.
  if (!gameState.isHost || isHostLossActive() || gameState.phase !== PHASES.CLAIMING) return;
  const active = Array.isArray(gameState.activePlayerIds) ? gameState.activePlayerIds : [];
  if (active.length === 0) return;

  const chairsThisRound = chairCountFor(active);
  if (chairsThisRound <= 0) return;
  if (seatedPlayerIds(currentChairs, currentChairContext()).length >= chairsThisRound) {
    resolveClaimPhaseAsHost('all-seated');
  }
}

/**
 * HOST ONLY. Resolve the claiming phase and write the elimination
 * (Req 7.1 - 7.6). Non-hosts fall out at the `isHost` check — game-manager would
 * skip the write anyway, but bailing early keeps the console clean.
 *
 * @param {'all-seated'|'timeout'|string} reason
 */
async function resolveClaimPhaseAsHost(reason) {
  if (!gameState.isHost || isHostLossActive() || claimPhaseResolving) return;
  if (gameState.phase !== PHASES.CLAIMING) return;

  claimPhaseResolving = true;
  clearClaimPhaseTimeout();

  const { write } = await finalizeClaimPhase(gameState.roomCode, {
    state: gameState,
    chairs: currentChairs,
    players: currentPlayers,
  });

  if (!write.ok && !write.skipped) {
    claimPhaseResolving = false;
    logError('resolveClaimPhaseAsHost', write.error || new Error('write failed'), { reason });
    showToast(write.message || 'Could not resolve the round', true);
  }
}

/**
 * Wire the game screen controls: one delegated `pointerdown` on `#stageOrbit`.
 * Pointer events only (Req 13.3 without the touch/click de-dupe dance). Per-drag
 * move/up/cancel listeners live on `window`; the actor supplies only the
 * `lostpointercapture` cleanup listener.
 */
function initGameControls() {
  if (stageDragWired) return;
  const orbit = el('stageOrbit');
  if (!orbit) return;
  orbit.addEventListener('pointerdown', onStagePointerDown);
  stageDragWired = true;
}

/** Remove the delegated drag listener (teardown only). */
function unwireStageDrag() {
  const orbit = document.getElementById('stageOrbit');
  if (orbit) orbit.removeEventListener('pointerdown', onStagePointerDown);
  stageDragWired = false;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 11 — ELIMINATION ANIMATION & ROUND ADVANCE              (task 6.5)
// ═════════════════════════════════════════════════════════════════════════════
// Requirements: 8.1 - 8.5, 9.1, 9.2, 9.3

/**
 * Entry point for `phase === 'elimination'`. Runs on every device: the
 * animation is local, only the host advances the round afterwards.
 *
 * @param {Object} gameData - Firebase `game` node
 */
function renderEliminationPhase(gameData) {
  clearMusicCountdown();
  clearClaimPhaseTimeout();
  endDrag({ reason: 'elimination' });
  try { stopMusic(); } catch (_) {}
  setMusicIndicatorVisible(false);
  setPhaseText('💥 Elimination');

  // Keep `.frozen` so eliminated actors remain visible while the result reads,
  // but the drag window is over: `.claiming` and every capture marker go away.
  stageEl()?.classList.remove('claiming');
  clearChairTargets();
  setStageHint('');
  refreshStageState();

  const eliminated = Array.isArray(gameData.eliminatedThisRound)
    ? gameData.eliminatedThisRound.filter((id) => typeof id === 'string')
    : [];

  recordEliminationRound(gameData.round, eliminated);
  displayEliminationAnimation(eliminated);
}

/**
 * Remember who went out in which round so the final rankings can be rebuilt
 * locally if the host's `rankings` write is unavailable (Req 10.5).
 *
 * @param {number} round - 1-based round number
 * @param {string[]} playerIds
 */
function recordEliminationRound(round, playerIds) {
  const index = Number.isFinite(round) && round >= 1 ? Math.floor(round) - 1 : eliminationHistory.length;
  while (eliminationHistory.length <= index) eliminationHistory.push([]);
  eliminationHistory[index] = [...playerIds];
}

/**
 * Keep eliminated stage actors frozen and visible for the 2200ms result window
 * while roster cards animate and the sound/name/rank banner plays. At timeout,
 * only eliminated stage actors are removed; bottom-roster and accessible state
 * remain before controls unlock and progression continues (Req 8.1–8.5).
 *
 * @param {string[]} playerIds - Players eliminated this round
 */
export function displayEliminationAnimation(playerIds) {
  const ids = Array.isArray(playerIds) ? playerIds : [];

  // Repaint the grid BEFORE the lock, because updatePlayerGrid() deliberately
  // no-ops while the animation is running.
  updatePlayerGrid();
  lockGameControls();

  try { playSound('eliminate'); } catch (_) {}

  const grid = document.getElementById('playerGrid');
  const names = [];
  ids.forEach((id) => {
    names.push(currentPlayers[id]?.name || 'Player');
    const card = grid?.querySelector(`[data-player-id="${id}"]`);
    if (card) card.classList.add('eliminating');
  });

  // Competition ranking: everyone still active finishes above them (Req 8.2).
  const remaining = Array.isArray(gameState.activePlayerIds) ? gameState.activePlayerIds.length : 0;
  showEliminationBanner(names, remaining + 1);

  if (eliminationTimer !== null) clearTimeout(eliminationTimer);
  eliminationTimer = setTimeout(() => {
    eliminationTimer = null;
    document.querySelectorAll('#stage .actor.eliminated').forEach((actor) => actor.remove());
    unlockGameControls();
    // Req 8.5 / 9.2 — after the result window, the host progresses directly
    // to the next round or victory, comfortably inside the 3 second budget.
    advanceRoundIfHost();
  }, ELIMINATION_ANIMATION_MS);
}

/**
 * Write `#eliminationBanner` (already aria-live — no announce() call).
 * @param {string[]} names - Eliminated player names
 * @param {number} rank - Shared finishing rank
 */
export function showEliminationBanner(names, rank) {
  const banner = document.getElementById('eliminationBanner');
  if (!banner) return;

  if (!names.length) {
    banner.textContent = 'No one was eliminated this round';
    banner.removeAttribute('hidden');
    return;
  }

  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const verb = names.length === 1 ? 'is out' : 'are out';
  banner.textContent = `${who} ${verb} — rank ${rank}`;
  banner.removeAttribute('hidden');
}

/** Hide the elimination banner before the next music or claiming phase. */
function clearEliminationBanner() {
  const banner = document.getElementById('eliminationBanner');
  if (!banner) return;
  banner.textContent = '';
  banner.setAttribute('hidden', '');
}

/**
 * Disable every game control while the animation runs (Req 8.4).
 * `.locked` on `.game-container` kills pointer events on the stage and any
 * button inside it; the flag makes {@link onStagePointerDown} a no-op as well,
 * and a drag already in flight is dropped.
 */
export function lockGameControls() {
  isAnimatingElimination = true;
  gameState.isAnimatingElimination = true;
  const container = gameContainer();
  if (container) container.classList.add('locked');
  endDrag({ reason: 'locked' });
}

/** Release the animation lock. */
export function unlockGameControls() {
  isAnimatingElimination = false;
  gameState.isAnimatingElimination = false;
  const container = gameContainer();
  if (container) container.classList.remove('locked');
}

/**
 * HOST ONLY. Next round, or victory when one player is left
 * (Req 8.5, 9.1, 9.2, 9.3).
 */
async function advanceRoundIfHost() {
  if (!gameState.isHost || !gameState.roomCode || isHostLossActive()) return;
  if (gameState.phase !== PHASES.ELIMINATION) return;

  const active = Array.isArray(gameState.activePlayerIds) ? [...gameState.activePlayerIds] : [];
  const winnerId = checkVictory(active);

  if (winnerId || active.length === 0) {
    await finishGameAsHost(winnerId);
    return;
  }

  // `startMusicPhase` bumps the round, stamps serverTimestamp and clears the
  // previous round's chairs in one atomic update (Req 9.1, 9.4).
  const next = buildMusicPhaseState(gameState.round + 1, active);
  const result = await startMusicPhase(gameState.roomCode, {
    round: next.round,
    activePlayerIds: next.activePlayerIds,
    musicDuration: next.musicDuration,
  });

  if (!result.ok && !result.skipped) {
    showToast(result.message || 'Could not start the next round', true);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 12 — VICTORY SCREEN & REPLAY                            (task 6.6)
// ═════════════════════════════════════════════════════════════════════════════
// Requirements: 10.1 - 10.5, 15.1 - 15.6

/**
 * HOST ONLY. Persist the victory state and the final rankings
 * (Req 10.1, 10.2, 10.5).
 *
 * `persistVictory` atomically writes the strict game victory fields, root-level
 * `rankings`, and a server-owned activity timestamp. Root rankings are the only
 * ranking source consumed by the listener and victory UI.
 *
 * @param {string|null} winnerId
 */
async function finishGameAsHost(winnerId) {
  if (!gameState.isHost || !gameState.roomCode || isHostLossActive()) return;
  if (victoryPersisted) return;
  victoryPersisted = true;

  const rankings = computeFinalRankings(eliminationHistory, {
    winnerId,
    players: currentPlayers,
  });

  const result = await persistVictory(gameState.roomCode, { winnerId, rankings });
  if (!result.ok && !result.skipped) {
    victoryPersisted = false;
    showToast(result.message || 'Could not save the result', true);
    return;
  }

  // The room is done. `finished` → `lobby` is legal for Play Again; only
  // `lobby` → `playing` is allowed in the other direction, which is why the
  // replay path below must go through `lobby`.
  if (isHostLossActive()) return;
  try {
    await endGame(gameState.roomCode);
  } catch (error) {
    logError('endGame', error, { roomCode: gameState.roomCode });
  }
}

/**
 * Show the victory screen to EVERY player (Req 10.3, 10.4, 15.1).
 * Idempotent: the sound and screen switch happen once, the content refreshes on
 * every later snapshot.
 */
export function showVictoryScreen() {
  renderVictoryContent();

  if (victoryRendered) return;
  victoryRendered = true;

  clearAllGameTimers();
  clearGameplayTimers();
  unlockGameControls();
  try { stopMusic(); } catch (_) {}

  showScreen(SCREENS.VICTORY);
  try { playSound('victory'); } catch (_) {}

  const winnerId = currentGame?.winnerId || checkVictory(gameState.activePlayerIds);
  const name = winnerId ? (currentPlayers[winnerId]?.name || 'Player') : null;
  // #winnerName is a plain <output>, not a live region, so this is the one
  // place an explicit announcement is needed.
  announce(name ? `${name} wins the game` : 'The game is over');
}

/** Winner card + rankings + host-only Play Again button. */
function renderVictoryContent() {
  const winnerId = currentGame?.winnerId || checkVictory(gameState.activePlayerIds);
  const winner = winnerId ? currentPlayers[winnerId] : null;

  const avatar = document.getElementById('winnerAvatar');
  if (avatar) avatar.textContent = winnerId ? avatarFor(winnerId, winner) : '🎉';

  const name = document.getElementById('winnerName');
  if (name) name.textContent = winner?.name || (winnerId ? 'Player' : '—');

  renderRankings(currentRankings);

  // Req 15.1 — Play Again is host-only.
  const playAgain = document.getElementById('playAgainBtn');
  if (playAgain) {
    if (gameState.isHost) {
      playAgain.removeAttribute('hidden');
      playAgain.disabled = isHostLossActive();
    } else {
      playAgain.setAttribute('hidden', '');
      playAgain.disabled = true;
    }
  }
}

/**
 * Render `#rankingsList` (Req 10.3, 10.5). The winner's row gets `.rank-1`.
 * @param {Array<{playerId: string, name: string|null, rank: number}>} rankings
 */
export function renderRankings(rankings) {
  const list = el('rankingsList');
  if (!list) return;

  const rows = Array.isArray(rankings) ? rankings : [];
  const fragment = document.createDocumentFragment();

  rows.forEach((entry) => {
    const playerId = entry?.playerId;
    const rank = Number.isFinite(entry?.rank) ? entry.rank : rows.indexOf(entry) + 1;
    const player = playerId ? currentPlayers[playerId] : null;

    const item = document.createElement('li');
    item.className = `ranking-item rank-${rank}`;
    item.appendChild(makeSpan('rank-position', `${rank}.`));
    item.appendChild(makeSpan('player-avatar', avatarFor(playerId, player), true));
    item.appendChild(makeSpan('player-name', player?.name || entry?.name || 'Player'));
    if (rank === 1) item.appendChild(makeSpan('player-status', 'Winner'));
    fragment.appendChild(item);
  });

  list.replaceChildren(fragment);
}

/**
 * HOST ONLY. Reset for a rematch and return the room to the lobby
 * (Req 15.2, 15.3, 15.4, 15.5, 15.6).
 *
 * One atomic multi-path update: `meta/status` back to `lobby` (a direct
 * `finished`/`playing` → `playing` transition is rejected by the rules), a fresh
 * `game` node, `chairs` and `rankings` cleared, and `eliminated: false` on every
 * player. Connected players stay exactly where they are (Req 15.6).
 */
export async function handlePlayAgain() {
  if (!gameState.isHost || !gameState.roomCode || isHostLossActive()) return;

  const button = document.getElementById('playAgainBtn');
  if (button) button.disabled = true;
  showLoading('Resetting the room…');

  const roomCode = gameState.roomCode;
  const reset = resetGame(currentPlayers);
  const { serverTimestamp } = await loadRtdb();
  if (isHostLossActive()) {
    hideLoading();
    if (button) button.disabled = false;
    return;
  }
  const updates = {
    [roomPath(roomCode, 'meta/status')]: 'lobby',
    [roomPath(roomCode, 'game')]: toFirebaseGameState(reset),
    [roomPath(roomCode, 'chairs')]: null,
    [roomPath(roomCode, 'rankings')]: null,
    [roomPath(roomCode, 'meta/lastActivity')]: serverTimestamp(),
  };
  Object.keys(reset.players || {}).forEach((id) => {
    updates[roomPath(roomCode, `players/${id}/eliminated`)] = false;
  });

  const result = await applyRootUpdates(updates, 'handlePlayAgain');
  hideLoading();
  if (button) button.disabled = false;

  if (!result.ok) {
    showToast(result.message || 'Could not reset the room', true);
    return;
  }

  // Local view state; the Firebase snapshot routes everyone back to the lobby.
  eliminationHistory = [];
  resetRoundViewState();
  currentRankings = [];
  currentChairsSnapshot = {};
  currentChairs = {};
  currentGame = null;
  currentRoomStatus = 'lobby';
  gameState.phase = PHASES.LOBBY;
  gameState.round = 1;
  gameState.eliminatedThisRound = [];
}

/** Clear the session, leave the room and go back to the menu (Req 15.x). */
export async function handleReturnToMenu() {
  await leaveRoom();
}

/** Wire the victory screen buttons. */
function initVictoryControls() {
  const playAgain = el('playAgainBtn');
  if (playAgain) playAgain.addEventListener('click', handlePlayAgain);

  const returnToMenu = el('returnToMenuBtn');
  if (returnToMenu) returnToMenu.addEventListener('click', handleReturnToMenu);
}

/* ------------------------- gameplay bootstrap (6.2 - 6.6) ----------------- */

/**
 * Wire sections 8-12. Kept separate from {@link bootstrap} so the task 6.1
 * bootstrap ordering stays untouched: this only attaches DOM listeners and
 * registers the error-context provider, and it never touches the network.
 */
function initGameplay() {
  if (gameplayInitialized) return;
  gameplayInitialized = true;

  // Tag every recovery log with the ambient room/player/phase.
  setErrorContextProvider(() => ({
    roomCode: gameState.roomCode,
    playerIndex: gameState.playerIndex,
    phase: gameState.phase,
  }));

  initRoomForms();
  initLobbyControls();
  initGameControls();
  initVictoryControls();

  teardownCallbacks.push(teardownGameplay);
}

/**
 * Release listeners and timers — no leaks between games (tests/teardown).
 * The stage/drag layer rides this same machinery: the live drag is dropped, the
 * delegated `pointerdown` comes off `#stageOrbit`, and `clearGameplayTimers`
 * cancels the pending `.actor.rejected` removals.
 */
export function teardownGameplay() {
  stopRoomListener();
  cancelDisconnectHandlerRegistration().catch(() => {});
  clearRoomLifecycleTimers();
  endDrag({ reason: 'teardown' });
  unwireStageDrag();
  renderedStageSignature = null;
  try { stopMusic(); } catch (_) {}
  unlockGameControls();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGameplay, { once: true });
} else {
  initGameplay();
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 13 — SESSION PERSISTENCE, REJOIN & RECOVERY      (tasks 7.2 - 8.3)
// ═════════════════════════════════════════════════════════════════════════════
// Requirements: 11.1 - 11.8, 16.4, 16.5, 17.1, 17.3, 17.4
//
// Storage lives in session.js (key `musical_chairs_session`, 24h expiry). This
// section wires rejoin, connection recovery, the stall watchdog, and the strict
// room lifecycle: immediate host deletion or marker-gated 30-second host-loss
// deletion only. There is no client authority to reap a room merely because its
// last activity is old.

/* ------------------------------- constants -------------------------------- */

/** Grace a dropped player gets before the round resolves without them (Req 11.4). */
const RECONNECT_GRACE_MS = 5000;

/** Minimum spacing between `connected: true` self-heal writes. */
const CONNECTED_REASSERT_THROTTLE_MS = 2000;

/** A phase transition later than this is a stall (design §Timing, Req 16.5). */
const PHASE_STALL_MS = 2000;

/** Total stall after which the overlay offers a Refresh action. */
const PHASE_STALL_REFRESH_MS = 10000;

/** Watchdog cadence. Cheap: one comparison per tick unless a stall is live. */
const STALL_POLL_MS = 500;

/** Exact copy from design §Timing and Synchronization Errors. */
const SYNCING_MESSAGE = 'Syncing game state...';

/** Zero connected players plus this much silence reads as abandoned locally. */
const ROOM_ABANDONED_IDLE_MS = 60 * 1000;

/** Longer dwell for the "reconnected" confirmation than a routine toast. */
const REJOIN_TOAST_MS = 4000;

/**
 * Longest legal music phase, used when `musicDuration` has not arrived yet.
 * Must track {@link MUSIC_DURATION_MAX_MS}: if it were smaller, the stall
 * watchdog would raise a false "Syncing game state..." overlay part-way through
 * a perfectly normal music phase.
 */
const MUSIC_STALL_FALLBACK_MS = MUSIC_DURATION_MAX_MS;

/* ------------------------------ room helpers ------------------------------ */

/**
 * Current anonymous uid, or null before auth settles.
 * Read through the namespace import so a missing export degrades quietly.
 * @returns {string|null}
 */
function authUid() {
  try {
    return firebaseConfig.auth?.currentUser?.uid || null;
  } catch (_) {
    return null;
  }
}

/**
 * `meta/lastActivity` off a room snapshot value.
 * @param {Object|null|undefined} room - Value of `musical-chairs-rooms/{code}`
 * @returns {number|null}
 */
function roomLastActivity(room) {
  const value = room?.meta?.lastActivity;
  return Number.isFinite(value) ? value : null;
}

/**
 * Missing lifecycle metadata is malformed and therefore unusable. Age alone is
 * never deletion authority and does not make an otherwise valid room unusable.
 */
function isRoomUnusable(room) {
  return !room || typeof room !== 'object' || roomLastActivity(room) === null;
}

/**
 * Treat malformed rooms, or rooms with no connected players and a full minute
 * of silence, as unavailable to a new joiner. This is a local fail-closed read;
 * it never attempts deletion.
 */
export function isRoomAbandoned(room) {
  if (isRoomUnusable(room)) return true;
  if (connectedPlayerIds(room.players).length > 0) return false;
  return Date.now() - roomLastActivity(room) > ROOM_ABANDONED_IDLE_MS;
}

/* ------------------------- task 7.2: auto-rejoin -------------------------- */

/**
 * Restore a session on page load (Req 11.3, 11.7, 11.8, 16.4).
 *
 * Called at the end of {@link bootstrap}, after auth and after
 * {@link initGameplay} has wired the DOM. Runs at most once per load.
 *
 * Failure modes are deliberately different:
 *   - room gone, malformed, or slot taken → clear the session and show
 *     "Previous room no longer exists" (Req 11.8, design §Session Restore
 *     Failure). Local session expiry is handled independently by session.js.
 *   - the verifying READ itself failed → keep the session and say so, because a
 *     dead network is not evidence the room disappeared.
 *
 * @returns {Promise<boolean>} true when the player is back in their room
 */
export async function attemptAutoRejoin() {
  if (sessionRestoreAttempted) return false;
  sessionRestoreAttempted = true;

  const session = loadSession();
  if (!session) {
    // Private browsing: say once that a refresh will need a manual rejoin.
    const status = getStorageStatus();
    if (!status.available && status.message) showToast(status.message);
    return false;
  }

  sessionRestoreInFlight = true;
  showLoading('Reconnecting…');
  try {
    const read = await readRoomOnce(session.roomCode);
    if (!read.ok) {
      showToast('Could not reconnect. Check your connection and rejoin.', true);
      return false;
    }

    const snapshot = read.value;
    const exists = snapshot && typeof snapshot.exists === 'function' && snapshot.exists();
    const room = exists ? (snapshot.val() || {}) : null;

    if (!room || isRoomUnusable(room)) {
      clearSession();
      showToast(SESSION_EXPIRED_MESSAGE, true);
      return false;
    }

    // The slot has to still be ours: the host may have removed us, or the index
    // may have been recycled by a different player.
    const player = room.players?.[playerKey(session.playerIndex)];
    const uid = authUid();
    if (!player || (uid && typeof player.uid === 'string' && player.uid !== uid)) {
      clearSession();
      showToast(SESSION_EXPIRED_MESSAGE, true);
      return false;
    }

    const { reconnected } = await restoreRoom(session, room);
    if (reconnected) {
      showToast(`Reconnected to room ${session.roomCode}`, 'success', REJOIN_TOAST_MS);
    } else {
      showToast('Reconnected, but your status could not be updated. Please refresh.', true);
    }
    return true;
  } catch (error) {
    // Unexpected: a half-restored room is worse than none, so tear the whole
    // thing down and land on the menu (Req 16.5).
    failToMenu('Reconnection failed', error, 'attemptAutoRejoin');
    return false;
  } finally {
    sessionRestoreInFlight = false;
    hideLoading();
  }
}

/**
 * Put the local device back into a verified room (Req 11.3, 11.7, 12.5).
 *
 * Order matters and mirrors {@link afterRoomEntry}: identity → connection
 * write → disconnect handler → session refresh → listener → render. The final
 * render runs off the snapshot already in hand rather than waiting for the
 * first listener callback, which is what keeps the restore inside the 2 second
 * budget (Req 11.7) on a slow connection.
 *
 * @param {{roomCode: string, playerIndex: number, isHost: boolean, playerName: string}} session
 * @param {Object} room - Verified room snapshot value
 * @returns {Promise<{reconnected: boolean}>}
 */
async function restoreRoom(session, room) {
  clearRoomLifecycleTimers();
  hostLossMarker = null;
  hostLossDeletionLatched = false;
  const roomCode = session.roomCode;
  const uid = authUid();
  const hostUid = typeof room?.meta?.hostUid === 'string' ? room.meta.hostUid : null;

  leavingRoom = false;
  roomAbandoned = false;
  gameState.roomCode = roomCode;
  gameState.playerIndex = session.playerIndex;
  // Firebase is the authority on who hosts; the stored flag is only a fallback.
  gameState.isHost = (hostUid && uid) ? hostUid === uid : session.isHost === true;
  gameState.phase = PHASES.LOBBY;
  gameState.hasLocalPlayerClaimed = false;
  gameState.claimedChairId = null;
  resetRoundViewState();
  eliminationHistory = [];

  currentMeta = room.meta && typeof room.meta === 'object' ? { ...room.meta } : {};
  gameState.schemaVersion = currentMeta.schemaVersion === 2 ? 2 : 1;
  currentPlayers = room.players && typeof room.players === 'object' ? room.players : {};
  currentChairsSnapshot = room.chairs && typeof room.chairs === 'object' ? room.chairs : {};
  currentChairs = {};
  currentRankings = Array.isArray(room.rankings) ? room.rankings : [];
  currentGame = null;
  currentRoomStatus = room.meta?.status || 'lobby';
  gameState.players = currentPlayers;
  gameState.chairs = currentChairs;

  // restoreConnection atomically marks the player present, stamps activity with
  // server time, and clears hostDisconnectedAt when this is the host.
  const reconnected = await reassertConnected('rejoin');

  // The previous onDisconnect registration died with that socket. Re-arm only
  // after the atomic restore cleared any host-loss marker successfully.
  if (reconnected) await attachDisconnectHandler();

  // Req 11.8 — rewrite the session so `savedAt` (and any corrected host flag)
  // is fresh for the next reload.
  saveSession({
    roomCode,
    playerIndex: session.playerIndex,
    isHost: gameState.isHost,
    playerName: session.playerName,
  });

  startRoomListener(roomCode);
  routeToRestoredScreen(room);

  return { reconnected };
}

/**
 * Lobby or game/victory screen for a restored room (Req 11.7).
 * `updateGameFromFirebase` owns the game/victory routing, so a playing room is
 * handed straight to it rather than duplicating the phase logic here.
 *
 * @param {Object} room - Room snapshot value
 */
function routeToRestoredScreen(room) {
  const status = room?.meta?.status || 'lobby';
  const game = room?.game;

  if (status !== 'lobby' && game && typeof game === 'object') {
    updateGameFromFirebase(game);
    return;
  }

  showScreen(SCREENS.LOBBY);
  renderLobby();
}

/* --------------------- task 7.3: live disconnect handling ------------------ */

/**
 * Write `players/player_N/connected = true` for the local player
 * (Req 11.2, 11.3).
 *
 * Permitted for every player, host or not — the rules scope a
 * `players/player_N` write by uid, not by host status. `meta/lastActivity`
 * rides along so a reconnect counts as activity (Req 17.1).
 *
 * @param {'rejoin'|'reconnect'|'self-heal'|'visible'} reason - Log label; only
 *   `rejoin` bypasses the throttle
 * @returns {Promise<boolean>} true when the write landed
 */
async function reassertConnected(reason) {
  const { roomCode, playerIndex } = gameState;
  if (!roomCode || !Number.isInteger(playerIndex)) return false;
  if (reassertInFlight) return false;

  const now = Date.now();
  const mustRestoreHostMarker = reason === 'rejoin' || reason === 'reconnect';
  if (!mustRestoreHostMarker && now - lastReassertAt < CONNECTED_REASSERT_THROTTLE_MS) return false;

  reassertInFlight = true;
  lastReassertAt = now;
  try {
    await restoreConnection(roomCode, playerIndex);
    return true;
  } catch (error) {
    logError(`reassertConnected:${reason}`, error, { roomCode, playerIndex });
    return false;
  } finally {
    reassertInFlight = false;
  }
}

/**
 * Connection-restored hook (Req 11.3, 16.4).
 *
 * `firebase-recovery.onReconnect` awaits the returned promise inside its 2
 * second resync budget and calls `markResynced()` for us, so this must stay
 * short: re-arm the things a dropped socket loses, then re-announce ourselves.
 * The room listener re-attaches on its own — it is only restarted if it was
 * torn down while offline.
 *
 * @param {{downtimeMs: number|null, reconnectCount: number, deadlineMs: number}} info
 * @returns {Promise<void>}
 */
async function handleReconnect(info) {
  if (!gameState.roomCode || leavingRoom) return;

  clearRoomLifecycleTimers();
  const restored = await reassertConnected('reconnect');
  if (restored) await attachDisconnectHandler();
  if (!unsubscribeRoom) startRoomListener(gameState.roomCode);
  scheduleHostLossCleanup();

  if (currentGame) {
    renderedPhase = null;
    updateGameFromFirebase(currentGame);
  }
  console.log(`[ui] resynced room ${gameState.roomCode} after ${info?.downtimeMs ?? '?'}ms offline`);
}

/**
 * React to a `players` snapshot (Req 11.1, 11.2, 11.4, 11.6, 16.5, 17.1).
 * Called from {@link handlePlayersUpdate}, so it sees every connection change
 * Firebase reports — which is inside the 5 second detection budget because
 * `onDisconnect` fires server-side as soon as the socket drops (Req 11.1).
 *
 * A disconnected HOST is not special-cased anywhere here: hosts flow through
 * the same three branches as everyone else (Req 11.6).
 *
 * @param {Object} players - Firebase `players` node
 */
export function handleDisconnectedPlayers(players) {
  if (leavingRoom || !gameState.roomCode) return;

  const roster = players && typeof players === 'object' ? players : {};
  const ids = Object.keys(roster);
  const localId = Number.isInteger(gameState.playerIndex) ? playerKey(gameState.playerIndex) : null;

  // Our record is gone while the room still has players: we were removed, so
  // there is no game left to play on this device (Req 16.5).
  if (localId && ids.length > 0 && !roster[localId] && !sessionRestoreInFlight) {
    failToMenu('You are no longer in that room', new Error('local player record removed'), 'playerRemoved');
    return;
  }

  // Firebase says we are offline but this device is online — that is the
  // onDisconnect write landing after a brief drop. Undo it (Req 11.3).
  if (localId && roster[localId]?.connected === false && isOnline()) {
    reassertConnected('self-heal').catch(() => {});
  }

  // Req 17.1 — nobody connected means abandoned. Marked locally only: no
  // client may write an abandoned state (see the section header), so the room
  // simply stops being kept alive and ages out.
  const abandoned = ids.length > 0 && connectedPlayerIds(roster).length === 0;
  if (abandoned !== roomAbandoned) {
    roomAbandoned = abandoned;
    if (abandoned) {
      console.warn(`[ui] room ${gameState.roomCode} has no connected players — abandoned`);
    }
  }

  updateReconnectGrace(roster);
}

/** Whether the room currently has no connected players (Req 17.1). */
export function isRoomMarkedAbandoned() {
  return roomAbandoned;
}

/**
 * HOST ONLY. Hold the claiming phase open briefly when an active player drops
 * (Req 11.4, 11.5).
 *
 * Why a hold is needed: a player who claims a chair and *then* drops still holds
 * that chair, so section 10's "every chair is taken" path would resolve
 * instantly — and `determineElimination` treats a disconnected player as
 * UNSEATED (Req 11.5), eliminating someone who really did sit down in time.
 * Waiting {@link RECONNECT_GRACE_MS} first gives them the reconnection window
 * Req 11.4 asks for; after that, Req 11.5 applies as written.
 *
 * The hold reuses `claimPhaseResolving` — the exact latch
 * {@link resolveClaimPhaseAsHost} checks — so both resolution paths (all chairs
 * taken and the 10 second timeout) are blocked by one flag instead of a parallel
 * mechanism. `holdingResolution` records that the latch is ours, so a real
 * in-flight resolution is never cleared out from under itself.
 *
 * One window per round: a round cannot be deferred indefinitely by players
 * dropping in sequence, and {@link CLAIM_PHASE_TIMEOUT_MS} still caps the round.
 *
 * @param {Object} players - Firebase `players` node
 */
function updateReconnectGrace(players) {
  if (!gameState.isHost || isHostLossActive()) {
    releaseResolutionHold();
    return;
  }

  if (gameState.phase !== PHASES.CLAIMING) {
    releaseResolutionHold();
    return;
  }

  const active = Array.isArray(gameState.activePlayerIds) ? gameState.activePlayerIds : [];
  const dropped = active.filter((id) => players[id]?.connected === false);

  if (dropped.length === 0) {
    // Everyone is back before the window closed (Req 11.4).
    if (holdingResolution) closeReconnectGrace('reconnected');
    return;
  }

  if (holdingResolution || reconnectGraceRound === gameState.round) return;

  reconnectGraceRound = gameState.round;
  holdingResolution = true;
  claimPhaseResolving = true;
  console.log(`[ui] holding round ${gameState.round} for ${RECONNECT_GRACE_MS}ms — ${dropped.join(', ')} dropped`);

  clearReconnectGraceTimer();
  reconnectGraceTimer = setTimeout(() => {
    reconnectGraceTimer = null;
    closeReconnectGrace('grace-expired');
  }, RECONNECT_GRACE_MS);
}

/**
 * End the grace window and resolve if the round was only waiting on the players
 * who dropped (Req 11.5). Otherwise the normal paths take over: the remaining
 * claims, or the 10 second deadline.
 *
 * @param {'reconnected'|'grace-expired'} reason
 */
function closeReconnectGrace(reason) {
  releaseResolutionHold();
  if (!gameState.isHost || isHostLossActive() || gameState.phase !== PHASES.CLAIMING) return;

  const active = Array.isArray(gameState.activePlayerIds) ? gameState.activePlayerIds : [];
  if (active.length === 0) return;

  const seated = new Set(seatedPlayerIds(currentChairs, currentChairContext()));
  const waitingOnlyOnDropped = active.every(
    (id) => currentPlayers[id]?.connected === false || seated.has(id),
  );
  if (waitingOnlyOnDropped) resolveClaimPhaseAsHost(`reconnect-${reason}`);
}

/** Drop the grace timer and release the resolution latch if we own it. */
function releaseResolutionHold() {
  clearReconnectGraceTimer();
  if (!holdingResolution) return;
  holdingResolution = false;
  claimPhaseResolving = false;
}

function clearReconnectGraceTimer() {
  if (reconnectGraceTimer !== null) {
    clearTimeout(reconnectGraceTimer);
    reconnectGraceTimer = null;
  }
}

/**
 * Cancel every timer/overlay this section owns. Called from
 * {@link teardownRoom} and {@link teardownGameplay} so recovery state rides the
 * existing teardown machinery instead of a parallel one.
 */
function clearRecoveryTimers() {
  releaseResolutionHold();
  reconnectGraceRound = 0;
  releaseSyncOverlay();
}

/* ------------------ task 8.2: critical errors & phase stalls --------------- */

/**
 * Critical failure during gameplay (Req 16.5).
 *
 * index.html has no error screen, so {@link showCriticalError} uses the menu
 * plus a long error toast as the "Return to Home" surface. This adds the part
 * that matters when a game is in flight: the room listener, the game timers and
 * the stale session all go away first, so the menu is genuinely usable.
 *
 * @param {string} message - Player-facing explanation
 * @param {any} [error] - Underlying error, logged for diagnostics
 * @param {string} [context='criticalError'] - Label for the log entry
 */
export function failToMenu(message, error, context = 'criticalError') {
  teardownRoom();
  showCriticalError(message, error, context);
}

/**
 * Expected wall-clock length of a phase, from the moment this device first sees
 * it. Used to decide whether a phase transition is overdue.
 *
 * @param {string} phase - One of {@link PHASES}
 * @returns {number|null} Budget in ms, or null when the phase has no deadline
 */
function phaseBudgetMs(phase) {
  switch (phase) {
    case PHASES.MUSIC:
      return Number.isFinite(gameState.musicDuration) && gameState.musicDuration > 0
        ? gameState.musicDuration
        : MUSIC_STALL_FALLBACK_MS;
    // The 10 second deadline, plus the grace window a late disconnect can
    // legitimately add on the host (see {@link updateReconnectGrace}).
    case PHASES.CLAIMING:
      return CLAIM_PHASE_TIMEOUT_MS + RECONNECT_GRACE_MS;
    case PHASES.ELIMINATION:
      return ELIMINATION_ANIMATION_MS;
    // Defensive budget for legacy-v1 or malformed state; schema-v2 starts
    // atomically in the music phase.
    case PHASES.LOBBY:
      return 0;
    default:
      return null; // victory: nothing further is expected
  }
}

/**
 * Watch for a phase that overstays its budget (Req 16.5, design §Phase
 * Transition Delay): overlay at 2 seconds past due, Refresh action at 10.
 *
 * Polled rather than event-driven on purpose — the failure being detected is
 * "no further Firebase updates arrive", so a detector that only runs on
 * Firebase updates would never fire. `resyncOverdue` from firebase-recovery is
 * folded in as a second signal, because a resync that blew its 2 second budget
 * (Req 16.4) is a stall whether or not the phase clock says so.
 */
function stallWatchdogTick() {
  if (!gameState.roomCode || leavingRoom || getCurrentScreen() !== SCREENS.GAME) {
    watchedPhase = null;
    watchedRound = 0;
    releaseSyncOverlay();
    return;
  }

  const phase = gameState.phase;
  const round = gameState.round;
  if (phase !== watchedPhase || round !== watchedRound) {
    watchedPhase = phase;
    watchedRound = round;
    watchedSince = Date.now();
    releaseSyncOverlay();
    return;
  }

  const budget = phaseBudgetMs(phase);
  const status = getConnectionStatus();
  if (budget === null) {
    releaseSyncOverlay();
    return;
  }

  const overdueBy = Date.now() - watchedSince - budget;
  if (overdueBy <= PHASE_STALL_MS && !status.resyncOverdue) {
    releaseSyncOverlay();
    return;
  }

  const message = (status.resyncPending || status.resyncOverdue)
    ? CONNECTION_RESTORED_MESSAGE
    : SYNCING_MESSAGE;
  if (!claimSyncOverlay(message)) return;

  // The overlay appears at PHASE_STALL_MS, so this lands at PHASE_STALL_REFRESH_MS
  // of total stall.
  if (Date.now() - syncOverlaySince >= PHASE_STALL_REFRESH_MS - PHASE_STALL_MS) {
    injectRefreshAction();
  }
}

/**
 * Take ownership of `#loadingOverlay` for the syncing message.
 *
 * The overlay is shared with the join/start/reset flows, so it is only claimed
 * when it is currently hidden. An overlay another flow put up is left alone —
 * and never hidden by {@link releaseSyncOverlay}.
 *
 * @param {string} message
 * @returns {boolean} true when the overlay is ours
 */
function claimSyncOverlay(message) {
  const overlay = document.getElementById('loadingOverlay');
  if (!overlay) return false;

  if (!syncOverlayOwned) {
    if (!overlay.hasAttribute('hidden')) return false;
    syncOverlayOwned = true;
    syncOverlaySince = Date.now();
    syncOverlayMessage = null;
  }
  if (syncOverlayMessage !== message) {
    syncOverlayMessage = message;
    showLoading(message);
  }
  return true;
}

/** Hand the overlay back, if it was ours. */
function releaseSyncOverlay() {
  if (!syncOverlayOwned) return;
  removeRefreshAction();
  syncOverlayOwned = false;
  syncOverlayMessage = null;
  syncOverlaySince = 0;
  hideLoading();
}

/**
 * Add a Refresh button to the loading overlay for a stall past 10 seconds
 * (design §Phase Transition Delay).
 *
 * index.html is a fixed contract with no error screen and no refresh control,
 * so the button is built here and appended to `#loadingOverlay .loading-content`
 * (a flex column, so it lays out under the spinner and message with no CSS
 * changes). It carries `.menu-btn.primary` for the existing look, and it is
 * removed again with the overlay so nothing lingers in the DOM.
 */
function injectRefreshAction() {
  if (refreshActionButton && refreshActionButton.isConnected) return;

  const content = document.querySelector('#loadingOverlay .loading-content');
  if (!content) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'menu-btn primary';
  button.textContent = '🔄 Refresh';
  button.setAttribute('aria-label', 'Refresh the page to resynchronize the game');
  button.addEventListener('click', () => {
    try { window.location.reload(); } catch (_) {}
  });

  content.appendChild(button);
  refreshActionButton = button;
  // The overlay is role="alert"; move focus so the escape hatch is reachable
  // without hunting for it.
  try { button.focus({ preventScroll: true }); } catch (_) {}
}

/** Remove the injected Refresh button. */
function removeRefreshAction() {
  if (!refreshActionButton) return;
  try { refreshActionButton.remove(); } catch (_) {}
  refreshActionButton = null;
}

/* ------------------------------- section init ----------------------------- */

/**
 * Wire the recovery hooks. Called from {@link bootstrap} before
 * {@link attemptAutoRejoin}, and every subscription/timer it creates is
 * registered in `teardownCallbacks` so {@link teardownUI} releases them.
 */
function initSessionRecovery() {
  // Req 16.4 — the resync hook. Returning a promise lets firebase-recovery
  // hold us to its 2 second budget and call markResynced() itself.
  teardownCallbacks.push(onReconnect(handleReconnect));

  // Req 16.5 — phase-stall watchdog. Runs for the app's lifetime and no-ops
  // unless a game screen is up; see {@link stallWatchdogTick}.
  if (stallWatchdogTimer === null) {
    stallWatchdogTimer = setInterval(stallWatchdogTick, STALL_POLL_MS);
  }
  teardownCallbacks.push(() => {
    if (stallWatchdogTimer !== null) {
      clearInterval(stallWatchdogTimer);
      stallWatchdogTimer = null;
    }
    releaseSyncOverlay();
  });

  // Mobile browsers suspend sockets in a background tab; coming back to the
  // foreground is the cheapest moment to re-announce ourselves (Req 11.3).
  const onVisibilityChange = async () => {
    if (document.visibilityState !== 'visible') return;
    if (!gameState.roomCode || leavingRoom) return;
    const restored = await reassertConnected('visible');
    if (restored) await attachDisconnectHandler();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  teardownCallbacks.push(() => document.removeEventListener('visibilitychange', onVisibilityChange));
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 14 — PWA / SERVICE WORKER REGISTRATION                  (task 9.2)
// ═════════════════════════════════════════════════════════════════════════════
// Requirements: 13.2, 20.6
// The update prompt has its own persistent surface so gameplay/status toasts
// cannot replace it while a new worker is waiting for consent.

/** Ask the installed waiting worker to activate. The page reloads only after
 * `controllerchange` confirms that this explicit request succeeded. */
export function reloadForUpdate() {
  if (!waitingServiceWorker) return false;
  updateActivationRequested = true;
  try {
    waitingServiceWorker.postMessage({ type: 'SKIP_WAITING' });
    return true;
  } catch (error) {
    updateActivationRequested = false;
    console.warn('[App] Could not activate the waiting service worker:', error);
    return false;
  }
}

if (typeof window !== 'undefined') window.reloadForUpdate = reloadForUpdate;

/** Hide the update prompt without activating the waiting worker. */
function dismissUpdateToast() {
  const toast = document.getElementById('updateToast');
  if (updateToastCleanup) updateToastCleanup();
  if (!toast) return;
  toast.classList.remove('show');
  toast.setAttribute('hidden', '');
}

/**
 * Show a colourful, persistent update prompt. The current app remains active
 * until the player chooses `Update app`; `Later` only dismisses the prompt.
 * @param {ServiceWorker|null} worker
 */
function showUpdateToast(worker = null) {
  if (worker) waitingServiceWorker = worker;
  if (!waitingServiceWorker) return;

  const toast = document.getElementById('updateToast');
  const updateButton = document.getElementById('applyUpdateBtn');
  const laterButton = document.getElementById('dismissUpdateBtn');
  const updateMessage = document.getElementById('updateToastMessage');
  if (!toast || !updateButton || !laterButton) return;

  if (updateToastCleanup) updateToastCleanup();

  updateButton.disabled = false;
  updateButton.textContent = 'Update app';
  updateButton.removeAttribute('aria-busy');
  laterButton.disabled = false;
  toast.removeAttribute('aria-busy');
  if (updateMessage) updateMessage.textContent = 'Update now, or keep playing and choose Later.';

  const onUpdate = () => {
    updateButton.disabled = true;
    updateButton.textContent = 'Updating…';
    updateButton.setAttribute('aria-busy', 'true');
    laterButton.disabled = true;
    toast.setAttribute('aria-busy', 'true');
    if (updateMessage) updateMessage.textContent = 'Applying update… The app will reload automatically.';

    if (!reloadForUpdate()) {
      updateButton.disabled = false;
      updateButton.textContent = 'Try again';
      updateButton.removeAttribute('aria-busy');
      laterButton.disabled = false;
      toast.removeAttribute('aria-busy');
      if (updateMessage) updateMessage.textContent = 'Update could not start. Please try again.';
    }
  };
  const onLater = () => dismissUpdateToast();

  updateButton.addEventListener('click', onUpdate);
  laterButton.addEventListener('click', onLater);
  updateToastCleanup = () => {
    updateButton.removeEventListener('click', onUpdate);
    laterButton.removeEventListener('click', onLater);
    updateToastCleanup = null;
  };

  toast.removeAttribute('hidden');
  requestFrame(() => {
    void toast.offsetHeight;
    toast.classList.add('show');
  });
}

/**
 * Register `public/sw.js` and watch for a fully installed waiting worker.
 * Updates never activate automatically; activation and reload require the
 * player's explicit `Update app` action.
 */
function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateActivationRequested) {
      console.log('[App] Service worker controller changed without an in-page update request');
      return;
    }
    updateActivationRequested = false;
    console.log('[App] Requested update active; reloading');
    try { window.location.reload(); } catch (_) {}
  });

  const start = () => {
    navigator.serviceWorker.register('/sw.js')
      .then((registration) => {
        console.log('✅ Service Worker registered:', registration.scope);

        // A worker that finished installing before this listener attached.
        if (registration.waiting && navigator.serviceWorker.controller) {
          showUpdateToast(registration.waiting);
        }

        // Re-check every 5 minutes so a long-lived tab still discovers updates.
        const updateTimer = setInterval(() => {
          registration.update().catch(() => {});
        }, 5 * 60 * 1000);
        teardownCallbacks.push(() => clearInterval(updateTimer));

        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (!newWorker) return;
          console.log('[App] New service worker found');

          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('[App] New service worker installed and waiting for user action');
              showUpdateToast(registration.waiting || newWorker);
            }
          });
        });
      })
      .catch((error) => {
        console.log('❌ Service Worker registration failed:', error);
      });
  };

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

registerServiceWorker();
