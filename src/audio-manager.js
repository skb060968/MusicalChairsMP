/**
 * Audio Manager — Musical Chairs
 *
 * Adapted from RouletteMP `src/sound-manager.js` plus the BollywoodBeats
 * `AudioManager` patterns (mute persistence, HTML5 Audio looping, silent
 * failure on every play path).
 *
 * Design split:
 *   - Background music  → HTML5 <audio> element with `loop = true`.
 *     Reliable, instant start/stop across every browser (Req 5.1, 5.2).
 *   - Sound effects     → AudioContext buffer sources for low latency,
 *     with pre-warmed <audio> elements and fresh Audio() as fallbacks.
 *
 * Mobile-browser workarounds preserved from the reference files:
 *   - AudioContext gets suspended after inactivity on iOS. We resume it on
 *     every user gesture and push a 1-sample silent buffer to keep it alive.
 *   - <audio> elements created inside a real user gesture stay "authorised"
 *     on iOS Safari, so the first gesture pre-warms one element per sound and
 *     one dedicated, reusable music element.
 *   - Every `play()` call is wrapped and its promise rejection swallowed.
 *     Audio never throws into game logic (Req 5.4).
 *
 * Failure handling:
 *   - Autoplay blocked  → the request is remembered as "pending" and retried
 *     on the next user gesture. Status flips to `pendingGesture` so the UI can
 *     show "Tap anywhere to enable sound".
 *   - Load failure      → the file is marked unavailable via `onerror` and the
 *     game continues in silent mode with visual indicators only.
 */

/** Audio assets live in `public/sounds/` and are served from `/sounds/`. */
const SOUND_FILES = {
  music: '/sounds/music.mp3',
  tap: '/sounds/tap.mp3',
  eliminate: '/sounds/eliminate.mp3',
  victory: '/sounds/victory.mp3',
};

const MUTE_KEY = 'musical_chairs_muted';

/** DOM event the UI can listen for instead of importing a subscriber. */
export const AUDIO_STATUS_EVENT = 'musical-chairs:audio-status';

/** Message the UI is expected to surface when a gesture is required. */
export const GESTURE_PROMPT = 'Tap anywhere to enable sound';
/** Message the UI is expected to surface when audio files cannot load. */
export const SILENT_MODE_MESSAGE = 'Audio unavailable - visual mode only';

let audioCtx = null;
let silentBuffer = null;
let initialized = false;
let warmedHtmlAudio = false;

/** Decoded AudioContext buffers for effects, keyed by sound name. */
const soundBuffers = {};
/** Pre-warmed HTML <audio> elements, keyed by sound name. */
const audioEls = {};
/** Sound names whose file failed to load (onerror / fetch failure). */
const unavailable = new Set();

/** Reusable music element (pre-warmed inside a gesture when possible). */
let musicEl = null;
/** True while music is supposed to be playing (survives autoplay blocks). */
let musicWanted = false;
/** Volume the caller asked for, replayed on a retry. */
let musicVolume = 0.3;
/** Set when a play() promise was rejected and we owe a retry on next gesture. */
let pendingGesture = false;
/** Effects that were blocked; replayed once on the next gesture. */
const pendingSounds = [];

const statusListeners = new Set();

/* ============================ status plumbing ============================ */

function clamp(volume) {
  const n = Number(volume);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Current audio status. The UI polls this or subscribes via
 * `onAudioStatusChange` / the `AUDIO_STATUS_EVENT` DOM event.
 *
 * @returns {{
 *   ready: boolean,            // initAudio() has run
 *   muted: boolean,            // user muted (persisted)
 *   musicPlaying: boolean,     // music element actively playing
 *   pendingGesture: boolean    // blocked by autoplay policy, needs a tap
 *   silentMode: boolean,       // every file failed to load
 *   unavailable: string[],     // names of files that failed to load
 *   message: string|null       // ready-to-display hint, or null
 * }}
 */
export function getAudioStatus() {
  const names = Array.from(unavailable);
  const silentMode = names.length >= Object.keys(SOUND_FILES).length;
  let message = null;
  if (silentMode) message = SILENT_MODE_MESSAGE;
  else if (pendingGesture) message = GESTURE_PROMPT;
  return {
    ready: initialized,
    muted: isMuted(),
    musicPlaying: !!(musicEl && !musicEl.paused),
    pendingGesture,
    silentMode,
    unavailable: names,
    message,
  };
}

function emitStatus() {
  const status = getAudioStatus();
  statusListeners.forEach((fn) => {
    try { fn(status); } catch (_) {}
  });
  try {
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(AUDIO_STATUS_EVENT, { detail: status }));
    }
  } catch (_) {}
}

/**
 * Subscribe to audio status changes (autoplay blocked, file unavailable,
 * mute toggled, music started/stopped).
 *
 * @param {(status: ReturnType<typeof getAudioStatus>) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onAudioStatusChange(listener) {
  if (typeof listener !== 'function') return () => {};
  statusListeners.add(listener);
  try { listener(getAudioStatus()); } catch (_) {}
  return () => statusListeners.delete(listener);
}

/** True when a sound's file loaded successfully (or has not failed yet). */
export function isAudioAvailable(name) {
  if (!name) return unavailable.size < Object.keys(SOUND_FILES).length;
  return !unavailable.has(name);
}

/** True when audio is blocked and waiting for a user gesture. */
export function needsUserGesture() {
  return pendingGesture;
}

function markUnavailable(name) {
  if (unavailable.has(name)) return;
  unavailable.add(name);
  console.warn(`[audio] "${name}" unavailable (${SOUND_FILES[name]}) - continuing silently`);
  emitStatus();
}

function markPending(kind) {
  if (pendingGesture) return;
  pendingGesture = true;
  console.log(`[audio] ${kind} blocked by autoplay policy - retrying on next gesture`);
  emitStatus();
}

function clearPending() {
  if (!pendingGesture) return;
  pendingGesture = false;
  emitStatus();
}

/* ========================== AudioContext helpers ========================= */

function getAudioContext() {
  if (audioCtx) return audioCtx;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  } catch (_) {
    audioCtx = null;
  }
  return audioCtx;
}

/** iOS keeps the context alive if we keep pushing sound through it. */
function kickSilent() {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (!silentBuffer) silentBuffer = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = silentBuffer;
    src.connect(ctx.destination);
    src.start(0);
  } catch (_) {}
}

async function loadBuffer(name, url) {
  const ctx = getAudioContext();
  if (!ctx) return null;
  try {
    const res = await fetch(url);
    if (!res || !res.ok) {
      markUnavailable(name);
      return null;
    }
    const bytes = await res.arrayBuffer();
    return await ctx.decodeAudioData(bytes);
  } catch (_) {
    // Decode failures still leave the HTML <audio> path viable, so only the
    // fetch-level failure above marks the file unavailable.
    return null;
  }
}

/* ============================== preloading =============================== */

function preloadBuffers() {
  Object.entries(SOUND_FILES).forEach(([name, url]) => {
    if (name === 'music') return; // music plays through HTML5 Audio only
    loadBuffer(name, url).then((buf) => {
      if (buf) soundBuffers[name] = buf;
    });
  });
}

function createAudioEl(name, url, { loop = false } = {}) {
  try {
    const el = new Audio();
    el.preload = 'auto';
    el.loop = loop;
    el.onerror = () => markUnavailable(name);
    el.addEventListener('canplaythrough', () => {
      if (unavailable.delete(name)) emitStatus();
    }, { once: true });
    el.src = url;
    try { el.load(); } catch (_) {}
    return el;
  } catch (_) {
    markUnavailable(name);
    return null;
  }
}

/** Create one <audio> per sound so `onerror` can report load failures. */
function preloadAudioElements() {
  Object.entries(SOUND_FILES).forEach(([name, url]) => {
    if (audioEls[name]) return;
    const el = createAudioEl(name, url, { loop: name === 'music' });
    if (el) audioEls[name] = el;
  });
  if (!musicEl && audioEls.music) musicEl = audioEls.music;
}

/**
 * Re-issue load() on every element from inside a real gesture. iOS Safari
 * treats gesture-touched elements as authorised for later programmatic play.
 */
function warmHtmlAudio() {
  if (warmedHtmlAudio) return;
  warmedHtmlAudio = true;
  preloadAudioElements();
  Object.values(audioEls).forEach((el) => {
    try { el.load(); } catch (_) {}
  });
}

/* ============================ initialization ============================= */

/**
 * Set up the AudioContext, preload every asset, and install the gesture
 * handler that unlocks/keeps-alive audio and retries anything blocked.
 * Safe to call more than once. Never throws.
 */
export function initAudio() {
  if (initialized) return;
  initialized = true;

  try {
    getAudioContext();
    preloadAudioElements();
    preloadBuffers();

    const handler = () => {
      const ctx = getAudioContext();
      if (ctx) {
        if (ctx.state === 'suspended') {
          try { ctx.resume(); } catch (_) {}
        }
        kickSilent();
      }
      warmHtmlAudio();
      retryPending();
    };

    ['pointerdown', 'touchstart', 'click', 'keydown'].forEach((ev) => {
      document.addEventListener(ev, handler, { passive: true });
    });
  } catch (err) {
    console.warn('[audio] initAudio failed - continuing in silent mode', err);
  }

  emitStatus();
}

/** Replay whatever autoplay blocked, now that we have a gesture. */
function retryPending() {
  if (isMuted()) {
    pendingSounds.length = 0;
    clearPending();
    return;
  }

  const queued = pendingSounds.splice(0, pendingSounds.length);
  queued.forEach(({ name, volume }) => playSound(name, volume));

  if (musicWanted) {
    startMusic(musicVolume);
    return;
  }
  clearPending();
}

/* ================================= mute ================================== */

/** Persisted mute state. localStorage access is guarded (private browsing). */
export function isMuted() {
  try {
    const v = localStorage.getItem(MUTE_KEY);
    return v === '1' || v === 'true';
  } catch (_) {
    return false;
  }
}

function setMuted(muted) {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch (_) {
    // Private browsing / quota: mute still applies for this session.
  }
  if (muted) {
    pauseMusic();
    pendingSounds.length = 0;
  } else if (musicWanted) {
    // Unmuting mid-phase: resume the existing element, or start fresh if the
    // phase began while muted and no element was ever created.
    if (musicEl) resumeMusic();
    else startMusic(musicVolume);
  }
  emitStatus();
}

/**
 * Flip mute and persist it.
 * @returns {boolean} the new muted state
 */
export function toggleMute() {
  const next = !isMuted();
  setMuted(next);
  return next;
}

/* ============================ background music =========================== */

function getMusicEl() {
  if (musicEl) return musicEl;
  preloadAudioElements();
  if (!musicEl) musicEl = createAudioEl('music', SOUND_FILES.music, { loop: true });
  return musicEl;
}

/**
 * Start looping background music.
 * Called at the top of every Music_Phase. Never throws.
 *
 * @param {number} volume 0.0 - 1.0
 */
export function startMusic(volume = 0.3) {
  musicVolume = clamp(volume);
  musicWanted = true;

  if (isMuted()) return;
  if (unavailable.has('music')) {
    // Silent mode: the phase still runs on visual indicators only.
    emitStatus();
    return;
  }

  const el = getMusicEl();
  if (!el) return;

  try {
    el.loop = true;
    el.volume = musicVolume;
    if (el.currentTime) el.currentTime = 0;
    const p = el.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        clearPending();
        emitStatus();
      }).catch(() => {
        // Autoplay policy (or a mid-gesture-less call). Keep musicWanted set
        // so the next gesture resumes exactly where the game expects.
        markPending('music');
      });
    } else {
      emitStatus();
    }
  } catch (_) {
    markPending('music');
  }
}

/**
 * Stop music immediately and reset it to the start.
 * Synchronous pause, so it takes effect well inside the 200ms budget.
 */
export function stopMusic() {
  musicWanted = false;
  const el = musicEl;
  if (el) {
    try {
      el.pause();
      el.currentTime = 0;
    } catch (_) {}
  }
  clearPending();
  emitStatus();
}

/** Pause without rewinding (used while reconnecting / backgrounded). */
export function pauseMusic() {
  if (musicEl) {
    try { musicEl.pause(); } catch (_) {}
  }
  emitStatus();
}

/** Resume paused music if the game still wants it and we are not muted. */
export function resumeMusic() {
  if (isMuted()) return;
  if (!musicEl || !musicEl.paused) return;
  try {
    musicWanted = true;
    const p = musicEl.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        clearPending();
        emitStatus();
      }).catch(() => markPending('music'));
    } else {
      emitStatus();
    }
  } catch (_) {
    markPending('music');
  }
}

/** Adjust music volume live (0.0 - 1.0). */
export function setMusicVolume(volume) {
  musicVolume = clamp(volume);
  if (musicEl) {
    try { musicEl.volume = musicVolume; } catch (_) {}
  }
}

/* ============================== sound effects ============================= */

/**
 * Play a one-shot effect: 'tap' | 'eliminate' | 'victory'.
 * Tries AudioContext first (lowest latency), then the pre-warmed element,
 * then a fresh Audio(). Silently gives up rather than throwing.
 *
 * @param {'tap'|'eliminate'|'victory'|'music'} name
 * @param {number} volume 0.0 - 1.0
 */
export function playSound(name, volume = 1.0) {
  if (isMuted()) return;
  const url = SOUND_FILES[name];
  if (!url) return;
  if (unavailable.has(name)) return;

  const vol = clamp(volume);
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    try { ctx.resume(); } catch (_) {}
  }

  // Path 1: AudioContext buffer source — lowest latency, best for tap feedback.
  if (ctx && ctx.state === 'running' && soundBuffers[name]) {
    try {
      const src = ctx.createBufferSource();
      src.buffer = soundBuffers[name];
      const gain = ctx.createGain();
      gain.gain.value = vol;
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start(0);
      return;
    } catch (_) {}
  }

  // Path 2: pre-warmed <audio> element — survives context suspension on iOS.
  const warmed = audioEls[name];
  if (warmed && warmed !== musicEl) {
    try {
      warmed.currentTime = 0;
      warmed.volume = vol;
      const p = warmed.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => queueBlockedSound(name, vol));
      }
      return;
    } catch (_) {}
  }

  // Path 3: fresh element — last resort.
  try {
    const a = new Audio(url);
    a.volume = vol;
    a.onerror = () => markUnavailable(name);
    const p = a.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => queueBlockedSound(name, vol));
    }
  } catch (_) {
    queueBlockedSound(name, vol);
  }
}

function queueBlockedSound(name, volume) {
  // Only 'victory' is worth replaying late; tap/eliminate feedback goes stale.
  if (name === 'victory' && pendingSounds.length < 4) {
    pendingSounds.push({ name, volume });
  }
  markPending(`sound "${name}"`);
}

/* ============================ test/reset helper ========================== */

/** Reset module state. Intended for tests only. */
export function __resetAudioForTests() {
  initialized = false;
  warmedHtmlAudio = false;
  audioCtx = null;
  silentBuffer = null;
  musicEl = null;
  musicWanted = false;
  musicVolume = 0.3;
  pendingGesture = false;
  pendingSounds.length = 0;
  unavailable.clear();
  statusListeners.clear();
  Object.keys(soundBuffers).forEach((k) => delete soundBuffers[k]);
  Object.keys(audioEls).forEach((k) => delete audioEls[k]);
}

export default {
  initAudio,
  startMusic,
  stopMusic,
  pauseMusic,
  resumeMusic,
  setMusicVolume,
  playSound,
  toggleMute,
  isMuted,
  isAudioAvailable,
  needsUserGesture,
  getAudioStatus,
  onAudioStatusChange,
  AUDIO_STATUS_EVENT,
  GESTURE_PROMPT,
  SILENT_MODE_MESSAGE,
};
