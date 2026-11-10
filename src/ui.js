/**
 * View layer: sound engine + the Musical Chairs stage. Pure DOM, no Firebase.
 *
 *  1. SOUND  — the reusable iPad-safe Web Audio engine for short cues, plus a looping
 *     HTML <audio> for the music track (too long to decode into a buffer).
 *  2. STAGE  — a round dance floor: N−1 chairs on an inner ring and one CHARACTER
 *     (shared rig, src/characters.js) per player. While the music plays everyone
 *     walks round the chairs; when it stops they freeze, the local player taps one
 *     free chair and their avatar runs to it — the first to arrive gets it — and
 *     seated players sit down. At the
 *     reveal the player left standing slumps, and the winner celebrates.
 *     Positions are local; the only thing that leaves the device is "I claim chair i",
 *     sent when our avatar reaches it.
 *  3. ROSTER — every seat, with YOU / HOST / OUT / OFFLINE badges and the speaking glow.
 *
 * JS owns POSITION (inline left/top as % of the stage box), CSS owns APPEARANCE.
 */
import {
  // The stage draws THIS ROUND's players and chairs (roundKeys / roundChairCount):
  // they stay unchanged through the reveal, so the eliminated player is still shown
  // standing and the survivors stay on their chairs until the next round starts.
  PHASES, roundKeys, roundChairCount, orderKeys, chairOwner, canClaim,
} from './engine.js';
import { avatarElement } from './avatars.js';
import { createCharacter, orbitPoint, JERSEYS } from './characters.js';

/* ============================ SOUND ============================ */
const MUTE_KEY = 'chairs_muted';
const SOUND_FILES = {
  tap: '/sounds/tap.mp3',          // a chair was claimed
  out: '/sounds/eliminate.mp3',    // someone was left standing
  win: '/sounds/victory.mp3',      // last one seated
};
const MUSIC_FILE = '/sounds/music.mp3';
const MUSIC_VOLUME = 0.35;

let audioCtx = null;
const soundBuffers = {};
const htmlAudioCache = {};
let silentBuffer = null;
let buffersRequested = false;
let music = null;

function getAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  return audioCtx;
}
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
  if (!ctx) return;
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    soundBuffers[name] = await ctx.decodeAudioData(await res.arrayBuffer());
  } catch (_) { /* HTML audio fallback */ }
}
function preloadBuffers() {
  if (buffersRequested) return;
  buffersRequested = true;
  Object.entries(SOUND_FILES).forEach(([name, url]) => loadBuffer(name, url));
  // Warm the music element too, so the first round does not start silent.
  try { ensureMusic().load(); } catch (_) {}
}
export function initAudio() {
  getAudioContext();
  const handler = () => {
    const ctx = getAudioContext();
    if (ctx) {
      if (ctx.state === 'suspended') { try { ctx.resume(); } catch (_) {} }
      kickSilent();
    }
    preloadBuffers();
  };
  ['click', 'touchstart', 'keydown', 'pointerdown'].forEach((evt) =>
    document.addEventListener(evt, handler, { passive: true }));
}
export function isMuted() {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch (_) { return false; }
}
export function setMuted(muted) {
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (_) {}
  if (music) music.muted = muted;
}
export function toggleMute() {
  const next = !isMuted();
  setMuted(next);
  return next;
}
export function playSound(name) {
  if (isMuted() || !SOUND_FILES[name]) return;
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (_) {} }
  if (ctx && ctx.state === 'running' && soundBuffers[name]) {
    try {
      const src = ctx.createBufferSource();
      src.buffer = soundBuffers[name];
      src.connect(ctx.destination);
      src.start(0);
      return;
    } catch (_) {}
  }
  try {
    let audio = htmlAudioCache[name];
    if (!audio) { audio = new Audio(SOUND_FILES[name]); audio.preload = 'auto'; htmlAudioCache[name] = audio; }
    audio.currentTime = 0;
    const played = audio.play();
    if (played?.catch) played.catch(() => {});
  } catch (_) {}
}
function ensureMusic() {
  if (!music) {
    music = new Audio(MUSIC_FILE);
    music.loop = true;
    music.preload = 'auto';
    music.volume = MUSIC_VOLUME;
    music.muted = isMuted();
  }
  return music;
}
/** Start (or keep) the music loop. Idempotent — safe on every render. */
export function startMusic() {
  const m = ensureMusic();
  m.muted = isMuted();
  if (!m.paused) return;
  try { const p = m.play(); if (p?.catch) p.catch(() => {}); } catch (_) {}
}
export function stopMusic() {
  if (!music || music.paused) return;
  try { music.pause(); music.currentTime = 0; } catch (_) {}
}

/* ============================ HELPERS ============================ */
const el = (id) => document.getElementById(id);
function makeSpan(className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = String(text ?? '');
  return span;
}
/** Point i of n on a ring of `radius` (% of the stage), starting at 12 o'clock. */
function ringPosition(i, n, radius) {
  const theta = (-90 + (i * 360) / Math.max(1, n)) * (Math.PI / 180);
  return { left: 50 + radius * Math.cos(theta), top: 50 + radius * Math.sin(theta) };
}
function place(node, { left, top }) {
  node.style.left = `${left.toFixed(2)}%`;
  node.style.top = `${top.toFixed(2)}%`;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const CHAIR_RADIUS = 24;   // % of the stage
/**
 * The race to a chair: every avatar runs at this speed (% of the stage per second)
 * from where it stood when the music stopped. The nearest chair is ~0.35 s away, one
 * across the floor ~1.5 s, so the player closest to a chair gets there first.
 */
const RACE_RUN_PCT_PER_S = 40;
/** The walking circle. Characters are drawn ABOVE their feet, so the circle sits a
 *  little low and is slightly flattened — heads stay on the floor at the top. */
const ORBIT = Object.freeze({ cx: 50, cy: 55, rx: 40, ry: 35 });
/** Feet of a seated player relative to the chair centre: on the front of the seat. */
const SEAT_DROP = 4;       // % down from the chair centre
const GATHER_MS = 700;     // stand up and walk back to the circle at the start of a round
/** Another player's claim landed: they run to it on this screen (shortest / longest run). */
const SIT_RUN_MIN_MS = 450;
const SIT_RUN_MAX_MS = 1500;
const WALK_GAIT_MS = 440;  // stride while circling (a walk; racing to a chair runs)
const spinMs = () => (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 40000 : 14000);

/* ============================ STAGE ============================ */
let selfSlot = null;
let onClaimHandler = null;
let currentGame = null;
let currentPlayers = {};
let stageSig = '';           // structural signature the stage was built for
let run = null;              // local player's race: { chair, pos:{x,y}, to:{x,y}, lastTs, raf }
let canAct = false;          // the local player may pick a chair right now
let onTakenHandler = null;   // the chair we were running to was taken first
let stageWired = false;

/**
 * slot → { ch, seat, home, optimistic, sitTimer }
 *   ch          character handle (src/characters.js)
 *   seat        chair index the character currently sits on (or null)
 *   home        where it stood when the music stopped (the race starts here)
 *   optimistic  moved to a chair locally, waiting for the claim to land
 * Kept across rounds of one game so players stand up and walk back to the circle.
 */
const actors = new Map();
const emoted = new Set();    // `${slot}:${roundId}:${round}:${phase}:${status}` already played

const orbit = { raf: 0, gatherTimer: 0, phase: 0, last: 0, running: false };

function chairPositions(n) {
  if (n === 1) return [{ left: 50, top: 50 }];   // the final chair sits dead centre
  return Array.from({ length: n }, (_, i) => ringPosition(i, n, CHAIR_RADIUS));
}
function seatPoint(chairIndex) {
  const p = chairPositions(roundChairCount(currentGame))[chairIndex];
  return p ? { x: p.left, y: p.top + SEAT_DROP } : null;
}
const slotIndex = (key) => Number.parseInt(String(key).replace('player_', ''), 10) || 0;

/** Characters scale with the stage (400 px ≈ 1). */
function updateScale() {
  const stage = el('mc-stage');
  if (!stage) return;
  const w = stage.getBoundingClientRect().width || 400;
  stage.style.setProperty('--chr-scale', clamp(w / 400, 0.72, 1.12).toFixed(3));
}

function buildStage(game, players) {
  const chairsLayer = el('mc-chairs');
  const floor = el('mc-floor');
  if (!chairsLayer || !floor) return;
  const n = roundChairCount(game);
  chairsLayer.replaceChildren(...chairPositions(n).map((pos, i) => {
    const chair = document.createElement('button');
    chair.type = 'button';
    chair.className = 'mc-chair';
    chair.dataset.chair = String(i);
    chair.setAttribute('aria-label', `Chair ${i + 1}`);
    place(chair, pos);
    return chair;
  }));

  // Players no longer in the game leave the floor; the rest are reused.
  const keys = roundKeys(game);
  [...actors.keys()].forEach((key) => {
    if (!keys.includes(key)) { actors.get(key).ch.destroy(); actors.delete(key); }
  });
  keys.forEach((key, i) => {
    let entry = actors.get(key);
    if (!entry) {
      const [jersey, dark] = JERSEYS[slotIndex(key) % JERSEYS.length];
      const ch = createCharacter({ avatarId: players[key]?.emoji, jersey, jerseyDark: dark, zBase: 10 });
      ch.el.classList.add('mc-actor');
      ch.el.dataset.slot = key;
      floor.appendChild(ch.el);
      const start = orbitPoint(i, keys.length, orbit.phase, ORBIT);
      ch.moveTo(start.x, start.y, { animate: false });
      ch.setFacing(start.facing);
      entry = { ch, seat: null, home: { x: start.x, y: start.y }, optimistic: false, sitTimer: 0 };
      actors.set(key, entry);
    }
    entry.ch.setAvatar(players[key]?.emoji).setLabel(players[key]?.name || 'Player');
  });
  updateScale();
}

/* ---- the walk round the chairs (music phase) ---- */
function startOrbit() {
  if (orbit.running) return;
  orbit.running = true;
  const keys = roundKeys(currentGame);
  // Everyone stands up and walks back to their place on the circle…
  keys.forEach((key, i) => {
    const entry = actors.get(key);
    if (!entry) return;
    clearTimeout(entry.sitTimer);
    entry.seat = null;
    entry.optimistic = false;
    entry.ch.setPose(null).setFacing('auto').setGait(300);
    const p = orbitPoint(i, keys.length, orbit.phase, ORBIT);
    entry.ch.moveTo(p.x, p.y, { glide: GATHER_MS });
  });
  // …then they all set off round the chairs together.
  orbit.gatherTimer = setTimeout(() => {
    orbit.gatherTimer = 0;
    if (!orbit.running) return;
    actors.forEach(({ ch }) => ch.setGait(WALK_GAIT_MS).setRunning(true));
    orbit.last = performance.now();
    const frame = (ts) => {
      if (!orbit.running) return;
      const dt = Math.min(100, ts - orbit.last);
      orbit.last = ts;
      orbit.phase += (dt / spinMs()) * Math.PI * 2;
      const ks = roundKeys(currentGame);
      ks.forEach((key, i) => {
        const entry = actors.get(key);
        if (!entry) return;
        // Facing 'auto': each walker turns smoothly along the circle (characters.js).
        const p = orbitPoint(i, ks.length, orbit.phase, ORBIT);
        entry.ch.moveTo(p.x, p.y);
      });
      orbit.raf = requestAnimationFrame(frame);
    };
    orbit.raf = requestAnimationFrame(frame);
  }, GATHER_MS);
}

/** Music stopped: everyone freezes where they are, turned toward the chairs. */
function stopOrbit() {
  if (!orbit.running) return;
  orbit.running = false;
  cancelAnimationFrame(orbit.raf);
  clearTimeout(orbit.gatherTimer);
  orbit.gatherTimer = 0;
  actors.forEach((entry) => {
    entry.ch.setRunning(false).setGait(300).setFacing('auto');
    const p = entry.ch.position;
    if (p) {
      entry.home = p;
      entry.ch.faceToward(50 - p.x, 50 - p.y);         // turn in toward the chairs
    }
  });
}

/* ---- seating ---- */
function sitOn(entry, chairIndex, { optimistic = false } = {}) {
  const p = seatPoint(chairIndex);
  if (!p) return;
  clearTimeout(entry.sitTimer);
  entry.seat = chairIndex;
  entry.optimistic = optimistic;
  // Run there at a steady, readable pace (the time grows with the distance), so the
  // stride, the arrival and the sit can all be seen. Linear: the legs match the slide.
  const from = entry.ch.position || p;
  const dist = Math.hypot(p.x - from.x, p.y - from.y);
  const ms = Math.round(Math.max(SIT_RUN_MIN_MS, Math.min(SIT_RUN_MAX_MS, (dist / RACE_RUN_PCT_PER_S) * 1000)));
  entry.ch.setPose(null).moveTo(p.x, p.y, { glide: ms, ease: 'linear' });
  // Sit once they arrive, facing the camera.
  entry.sitTimer = setTimeout(() => entry.ch.setFacing('front').setPose('sit').setFacing('auto'), ms);
}
function standUp(entry) {
  clearTimeout(entry.sitTimer);
  entry.seat = null;
  entry.optimistic = false;
  entry.ch.setPose(null);
}

/** Sync chairs + characters to the claims, flags and phase. Idempotent. */
function syncStage(game, players) {
  const stage = el('mc-stage');
  if (!stage) return;
  const phase = game.phase;
  const claims = game.claims || {};
  const chairs = roundChairCount(game);
  const me = selfSlot;
  const finished = game.status === 'finished';
  const revealing = phase === PHASES.REVEAL || finished;
  const iCanAct = phase === PHASES.CLAIMING && game.status === 'playing'
    && game.active?.[me] === true && !Number.isInteger(claims[me]);

  stage.classList.toggle('claiming', phase === PHASES.CLAIMING);
  stage.classList.toggle('reveal', revealing);
  stage.classList.toggle('can-act', iCanAct);
  canAct = iCanAct;

  // The chair we are running to was taken first, or the window closed: stop where we are.
  if (run && (phase !== PHASES.CLAIMING || chairOwner(game, run.chair) !== null)) {
    const taken = phase === PHASES.CLAIMING;
    stopRun();
    if (taken) onTakenHandler?.();
  }

  stage.querySelectorAll('.mc-chair').forEach((chair) => {
    const owner = chairOwner(game, Number(chair.dataset.chair));
    chair.classList.toggle('taken', Boolean(owner));
    chair.classList.toggle('free', !owner && phase === PHASES.CLAIMING);
    chair.disabled = !iCanAct || Boolean(owner);
  });

  const roundTag = `${game.roundId}:${game.round}:${phase}:${game.status}`;
  roundKeys(game).forEach((key) => {
    const entry = actors.get(key);
    if (!entry) return;
    const { ch } = entry;
    const seat = claims[key];
    const seated = Number.isInteger(seat) && seat < chairs;
    const running = key === me && run !== null;
    const eliminated = revealing && game.out?.[key] === game.round;

    ch.setFlags({
      self: key === me,
      offline: players[key]?.connected === false,
      faded: eliminated,
    });
    // "Pick a chair!": your avatar hops while it is your turn and you have not picked yet.
    ch.el.classList.toggle('ready', iCanAct && key === me && !running && entry.seat === null);
    ch.el.classList.toggle('seated', seated);

    if (phase !== PHASES.MUSIC && !running) {
        if (seated && entry.seat === seat) entry.optimistic = false;      // our claim was confirmed
      if (seated && entry.seat !== seat) sitOn(entry, seat);            // a claim landed
      else if (!seated && entry.seat !== null && !entry.optimistic) standUp(entry);
    }

    // Reactions, once per player per phase.
    const tag = `${key}:${roundTag}`;
    if (revealing && !emoted.has(tag)) {
      if (eliminated) { emoted.add(tag); ch.emote('sad', '😢'); }
      else if (finished && key === game.winnerKey) { emoted.add(tag); ch.emote('happy', '🏆'); }
    }
  });
}

/* ---- the race to a chair ----
 * When the music stops the local player taps ONE free chair. Their avatar then runs
 * to it at RACE_RUN_PCT_PER_S from where it stood, and the claim is sent only when it
 * ARRIVES. The first claim to reach the server wins (the rules refuse later ones), so
 * a nearer player gets there first. Taps during the music, during a run, or after
 * sitting do nothing; a player whose chair is taken first stops and may pick another.
 */
function setTarget(i) {
  el('mc-chairs')?.querySelectorAll('.mc-chair').forEach((c) => c.classList.toggle('target', Number(c.dataset.chair) === i));
}
function stopRun() {
  if (!run) return;
  cancelAnimationFrame(run.raf);
  run = null;
  setTarget(null);
  const entry = actors.get(selfSlot);
  if (entry) {
    entry.ch.setRunning(false);
    const p = entry.ch.position;
    if (p) entry.home = p;                       // a new pick starts from here
  }
}
function runStep(ts) {
  if (!run) return;
  const dt = Math.min(0.05, Math.max(0, (ts - run.lastTs) / 1000));
  run.lastTs = ts;
  const entry = actors.get(selfSlot);
  if (!entry) { stopRun(); return; }
  const dx = run.to.x - run.pos.x;
  const dy = run.to.y - run.pos.y;
  const d = Math.hypot(dx, dy);
  const step = RACE_RUN_PCT_PER_S * dt;
  if (d <= step) {
    // Arrived: claim it, and sit (the rules may still refuse it if someone was faster).
    const { chair } = run;
    entry.ch.moveTo(run.to.x, run.to.y);
    stopRun();
    if (currentGame && canClaim(currentGame, selfSlot, chair)) {
      clearTimeout(entry.sitTimer);
      entry.seat = chair;
      entry.optimistic = true;
      entry.ch.setFacing('front').setPose('sit').setFacing('auto');
      onClaimHandler?.(chair);
    } else {
      onTakenHandler?.();
    }
    return;
  }
  run.pos = { x: run.pos.x + (dx / d) * step, y: run.pos.y + (dy / d) * step };
  entry.ch.moveTo(run.pos.x, run.pos.y);       // the gait and facing follow the real speed
  run.raf = requestAnimationFrame(runStep);
}
/** The local player picked chair `i`: run there. Returns false if the pick is not allowed. */
function startRun(i) {
  if (!canAct || run || !currentGame || selfSlot == null) return false;
  if (!canClaim(currentGame, selfSlot, i)) return false;
  const entry = actors.get(selfSlot);
  const to = seatPoint(i);
  if (!entry || !to || entry.seat !== null) return false;
  const from = entry.ch.position || entry.home || to;
  entry.ch.setPose(null).setFacing('auto').setGait(260);
  run = { chair: i, pos: { ...from }, to, lastTs: performance.now(), raf: 0 };
  setTarget(i);
  run.raf = requestAnimationFrame(runStep);
  return true;
}
function wireStage() {
  const stage = el('mc-stage');
  if (!stage || stageWired) return;
  stageWired = true;
  // One tap on a free chair = "run to that chair". Nothing else claims a chair.
  stage.addEventListener('click', (e) => {
    const chair = e.target.closest('.mc-chair');
    if (!chair || chair.disabled) return;
    startRun(Number(chair.dataset.chair));
  });
  window.addEventListener('resize', updateScale);
}

/* ============================ ROSTER ============================ */
function renderRoster(game, players) {
  const wrap = el('mc-roster');
  if (!wrap) return;
  const keys = orderKeys(game);
  wrap.replaceChildren(...keys.map((slot) => {
    const p = players?.[slot] || {};
    const card = document.createElement('div');
    card.className = 'mc-player';
    card.dataset.slot = slot;
    if (p.connected === false) card.classList.add('disconnected');
    if (game.active?.[slot] !== true) card.classList.add('out');
    card.appendChild(avatarElement(p.emoji, 'mc-avatar'));
    card.appendChild(makeSpan('mc-pname', p.name || 'Player'));
    if (slot === 'player_0') card.appendChild(makeSpan('host-badge', 'HOST'));
    if (slot === selfSlot) card.appendChild(makeSpan('you-badge', 'YOU'));
    if (game.active?.[slot] !== true) card.appendChild(makeSpan('out-badge', 'OUT'));
    else if (p.connected === false) card.appendChild(makeSpan('offline-badge', 'OFFLINE'));
    return card;
  }));
}

/* ============================ PUBLIC ============================ */
export function setStatus(text) {
  const node = el('mc-status');
  if (node) node.textContent = String(text ?? '');
}
/** Big transient line over the stage (round intro, "X is out!"). Empty string hides it. */
export function setBanner(text) {
  const node = el('mc-banner');
  if (!node) return;
  node.textContent = String(text ?? '');
  node.hidden = !text;
}
export function setRoundLabel(text) {
  const node = el('mc-round');
  if (node) node.textContent = String(text ?? '');
}
/**
 * The local claim was refused (someone reached the chair first): stand up where you
 * are, by that chair; you may pick another chair from here.
 */
export function cancelClaimPreview() {
  const entry = actors.get(selfSlot);
  if (!entry?.optimistic) return;
  standUp(entry);
  const p = entry.ch.position;
  if (p) entry.home = p;
}
/** Forget the stage between games so the next round is built fresh. */
export function resetStage() {
  orbit.running = false;
  cancelAnimationFrame(orbit.raf);
  clearTimeout(orbit.gatherTimer);
  orbit.phase = 0;
  actors.forEach(({ ch, sitTimer }) => { clearTimeout(sitTimer); ch.destroy(); });
  actors.clear();
  emoted.clear();
  stageSig = '';
  if (run) cancelAnimationFrame(run.raf);
  run = null;
  canAct = false;
  el('mc-chairs')?.replaceChildren();
  el('mc-orbit')?.replaceChildren();
  el('mc-floor')?.replaceChildren();
  el('mc-stage')?.classList.remove('spinning', 'claiming', 'reveal', 'can-act');
  setBanner('');
}

/**
 * @param {object} view
 * @param {object} view.game      game node
 * @param {object} view.players   room players
 * @param {string} view.localSlot
 * @param {(chair:number)=>void} view.onClaim   our avatar reached chair `chair`: claim it
 * @param {()=>void} [view.onTaken]  the chair we were running to was taken first
 */
export function renderGame({ game, players, localSlot, onClaim, onTaken = null }) {
  if (!game) return;
  selfSlot = localSlot || null;
  onClaimHandler = onClaim;
  onTakenHandler = onTaken;
  currentGame = game;
  currentPlayers = players || {};
  wireStage();
  renderRoster(game, currentPlayers);

  // Rebuild chairs only when the STRUCTURE changes (new round / players in).
  const sig = `${game.roundId}:${game.round}:${roundKeys(game).join(',')}`;
  if (sig !== stageSig) {
    stageSig = sig;
    orbit.running = false;                 // a new round always restarts the walk
    cancelAnimationFrame(orbit.raf);
    clearTimeout(orbit.gatherTimer);
    buildStage(game, currentPlayers);
  }

  if (game.phase === PHASES.MUSIC && game.status === 'playing') startOrbit();
  else stopOrbit();
  syncStage(game, currentPlayers);
}

export function setActiveSpeakers(ids = []) {
  const speaking = new Set(ids);
  document.querySelectorAll('.mc-player[data-slot]').forEach((card) => {
    card.classList.toggle('speaking', speaking.has(card.dataset.slot));
  });
  actors.forEach(({ ch }, key) => ch.setFlags({ speaking: speaking.has(key) }));
}
