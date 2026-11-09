/**
 * View layer: sound engine + the Musical Chairs stage. Pure DOM, no Firebase.
 *
 *  1. SOUND  — the reusable iPad-safe Web Audio engine for short cues, plus a looping
 *     HTML <audio> for the music track (too long to decode into a buffer).
 *  2. STAGE  — a round dance floor: N−1 chairs on an inner ring and one CHARACTER
 *     (shared rig, src/characters.js) per player. While the music plays everyone
 *     walks round the chairs; when it stops they freeze, the local player drags
 *     (or taps) their way onto a free chair, and seated players sit down. At the
 *     reveal the player left standing slumps, and the winner celebrates.
 *     Positions are cosmetic and local; the only thing that leaves the device is
 *     "I claim chair i".
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
const HIT_RADIUS = 12;     // % — how close a dragged character's feet must be to a chair
/** The walking circle. Characters are drawn ABOVE their feet, so the circle sits a
 *  little low and is slightly flattened — heads stay on the floor at the top. */
const ORBIT = Object.freeze({ cx: 50, cy: 55, rx: 40, ry: 35 });
/** Feet of a seated player relative to the chair centre: on the front of the seat. */
const SEAT_DROP = 4;       // % down from the chair centre
const GATHER_MS = 700;     // stand up and walk back to the circle at the start of a round
const SIT_GLIDE_MS = 320;  // run to a chair
const WALK_GAIT_MS = 440;  // stride while circling (a walk; dragging and racing to chairs runs)
const spinMs = () => (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 40000 : 14000);

/* ============================ STAGE ============================ */
let selfSlot = null;
let onClaimHandler = null;
let currentGame = null;
let currentPlayers = {};
let stageSig = '';           // structural signature the stage was built for
let drag = null;             // { key, pointerId, origin:{x,y}, target }
let stageWired = false;

/**
 * slot → { ch, seat, home, optimistic, sitTimer }
 *   ch          character handle (src/characters.js)
 *   seat        chair index the character currently sits on (or null)
 *   home        where it stood when the music stopped (drag cancels return here)
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
  entry.ch.setPose(null).moveTo(p.x, p.y, { glide: SIT_GLIDE_MS });
  // Sit once they arrive, facing the camera.
  entry.sitTimer = setTimeout(() => entry.ch.setFacing('front').setPose('sit').setFacing('auto'), SIT_GLIDE_MS);
}
function standUp(entry, { returnHome = false } = {}) {
  clearTimeout(entry.sitTimer);
  entry.seat = null;
  entry.optimistic = false;
  entry.ch.setPose(null);
  if (returnHome && entry.home) entry.ch.moveTo(entry.home.x, entry.home.y, { glide: 300 });
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
    const dragging = drag?.key === key;
    const eliminated = revealing && game.out?.[key] === game.round;

    ch.setFlags({
      self: key === me,
      offline: players[key]?.connected === false,
      faded: eliminated,
    });
    ch.el.classList.toggle('draggable', iCanAct && key === me);
    ch.el.classList.toggle('seated', seated);

    if (phase !== PHASES.MUSIC && !dragging) {
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

/* ---- drag / tap to claim ---- */
function stagePoint(clientX, clientY) {
  const box = el('mc-stage').getBoundingClientRect();
  return { left: ((clientX - box.left) / box.width) * 100, top: ((clientY - box.top) / box.height) * 100 };
}
function nearestFreeChair(pt) {
  if (!currentGame) return null;
  const positions = chairPositions(roundChairCount(currentGame));
  let best = null;
  positions.forEach((pos, i) => {
    if (chairOwner(currentGame, i) !== null) return;
    const d = Math.hypot(pos.left - pt.left, pos.top + SEAT_DROP - pt.top);
    if (d <= HIT_RADIUS && (!best || d < best.d)) best = { i, d };
  });
  return best ? best.i : null;
}
function setTarget(i) {
  el('mc-chairs')?.querySelectorAll('.mc-chair').forEach((c) => c.classList.toggle('target', Number(c.dataset.chair) === i));
  if (drag) drag.target = i;
}
function tryClaim(chair) {
  if (!currentGame || selfSlot == null) return false;
  if (!canClaim(currentGame, selfSlot, chair)) return false;
  onClaimHandler?.(chair);
  return true;
}
function endDrag(claimed) {
  if (!drag) return;
  const { key, origin, target } = drag;
  drag = null;
  setTarget(null);
  const entry = actors.get(key);
  if (!entry) return;
  entry.ch.el.classList.remove('dragging');
  entry.ch.setGait(300);
  if (claimed && target != null) sitOn(entry, target, { optimistic: true });
  else entry.ch.moveTo(origin.x, origin.y, { glide: 280 });
}
function wireStage() {
  const stage = el('mc-stage');
  if (!stage || stageWired) return;
  stageWired = true;
  stage.addEventListener('pointerdown', (e) => {
    const node = e.target.closest('.mc-actor.draggable');
    if (!node || drag) return;
    const entry = actors.get(node.dataset.slot);
    if (!entry) return;
    e.preventDefault();
    const at = entry.ch.position || { x: 50, y: 50 };
    drag = { key: node.dataset.slot, pointerId: e.pointerId, target: null, origin: at };
    node.classList.add('dragging');
    entry.ch.setFacing('auto').setGait(260);
    try { stage.setPointerCapture(e.pointerId); } catch (_) {}
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const pt = stagePoint(e.clientX, e.clientY);
    // The finger is at the FEET, so the body stays visible above the finger.
    actors.get(drag.key)?.ch.moveTo(clamp(pt.left, 4, 96), clamp(pt.top, 14, 97));
    setTarget(nearestFreeChair(pt));
  });
  const finish = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const target = drag.target;
    endDrag(target != null && tryClaim(target));
  };
  stage.addEventListener('pointerup', finish);
  stage.addEventListener('pointercancel', finish);
  // Tap a free chair: the accessible route, and quicker on a small screen.
  stage.addEventListener('click', (e) => {
    const chair = e.target.closest('.mc-chair');
    if (!chair || chair.disabled) return;
    const i = Number(chair.dataset.chair);
    if (tryClaim(i)) {
      const entry = actors.get(selfSlot);
      if (entry) sitOn(entry, i, { optimistic: true });   // runs over and sits
    }
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
/** The local claim was refused (someone was faster): stand up and walk back. */
export function cancelClaimPreview() {
  const entry = actors.get(selfSlot);
  if (entry?.optimistic) standUp(entry, { returnHome: true });
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
  drag = null;
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
 * @param {(chair:number)=>void} view.onClaim
 */
export function renderGame({ game, players, localSlot, onClaim }) {
  if (!game) return;
  selfSlot = localSlot || null;
  onClaimHandler = onClaim;
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
