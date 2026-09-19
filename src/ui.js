/**
 * View layer: sound engine + the Musical Chairs stage. Pure DOM, no Firebase.
 *
 *  1. SOUND  — the reusable iPad-safe Web Audio engine for short cues, plus a looping
 *     HTML <audio> for the music track (too long to decode into a buffer).
 *  2. STAGE  — a square dance floor: N−1 chairs on an inner ring, one avatar per
 *     player still in on an outer ring that spins while the music plays. When the
 *     music stops the ring freezes where it is and the local player drags (or taps)
 *     their way onto a free chair. Positions are cosmetic and local; the only thing
 *     that leaves the device is "I claim chair i".
 *  3. ROSTER — every seat, with YOU / HOST / OUT / OFFLINE badges and the speaking glow.
 *
 * JS owns POSITION (inline left/top as % of the stage box), CSS owns APPEARANCE.
 */
import {
  PHASES, activeKeys, orderKeys, chairCount, chairOwner, canClaim,
} from './engine.js';

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
const CHAIR_RADIUS = 24;   // % of the stage
const ORBIT_RADIUS = 39;
const HIT_RADIUS = 12;     // % — how close a dragged avatar must be to a chair

/* ============================ STAGE ============================ */
let selfSlot = null;
let onClaimHandler = null;
let currentGame = null;
let currentPlayers = {};
let stageSig = '';           // structural signature the stage was built for
let frozenFor = '';          // `${roundId}:${round}` whose ring has been frozen
let drag = null;             // { actor, pointerId, origin:{left,top}, target }
let stageWired = false;

function chairPositions(n) {
  if (n === 1) return [{ left: 50, top: 50 }];   // the final chair sits dead centre
  return Array.from({ length: n }, (_, i) => ringPosition(i, n, CHAIR_RADIUS));
}

function buildStage(game, players) {
  const chairsLayer = el('mc-chairs');
  const orbit = el('mc-orbit');
  const floor = el('mc-floor');
  if (!chairsLayer || !orbit || !floor) return;
  const n = chairCount(game);
  chairsLayer.replaceChildren(...chairPositions(n).map((pos, i) => {
    const chair = document.createElement('button');
    chair.type = 'button';
    chair.className = 'mc-chair';
    chair.dataset.chair = String(i);
    chair.setAttribute('aria-label', `Chair ${i + 1}`);
    place(chair, pos);
    return chair;
  }));
  const keys = activeKeys(game);
  orbit.replaceChildren(...keys.map((key, i) => buildActor(key, players[key], ringPosition(i, keys.length, ORBIT_RADIUS))));
  floor.replaceChildren();
  orbit.style.animation = '';
  frozenFor = '';
}

function buildActor(key, player, pos) {
  const actor = document.createElement('div');
  actor.className = 'mc-actor';
  actor.dataset.slot = key;
  if (key === selfSlot) actor.classList.add('me');
  const face = makeSpan('mc-actor-face', player?.emoji || '🧑');
  const name = makeSpan('mc-actor-name', player?.name || 'Player');
  actor.append(face, name);
  place(actor, pos);
  return actor;
}

/** Stop the ring where it is: read each avatar's on-screen centre, then re-home it on
 *  the static floor layer at that spot, so dragging works in plain stage coordinates. */
function freezeRing() {
  const stage = el('mc-stage');
  const orbit = el('mc-orbit');
  const floor = el('mc-floor');
  if (!stage || !orbit || !floor) return;
  const box = stage.getBoundingClientRect();
  const actors = [...orbit.querySelectorAll('.mc-actor')];
  const spots = actors.map((a) => {
    const r = a.getBoundingClientRect();
    return {
      left: box.width ? ((r.left + r.width / 2 - box.left) / box.width) * 100 : 50,
      top: box.height ? ((r.top + r.height / 2 - box.top) / box.height) * 100 : 50,
    };
  });
  stage.classList.remove('spinning');
  actors.forEach((a, i) => { place(a, spots[i]); floor.appendChild(a); });
}

function actorFor(key) {
  return el('mc-stage')?.querySelector(`.mc-actor[data-slot="${key}"]`) || null;
}

/** Sync chairs + avatars to the claims, badges and phase. Idempotent. */
function syncStage(game, players) {
  const stage = el('mc-stage');
  if (!stage) return;
  const phase = game.phase;
  const claims = game.claims || {};
  const positions = chairPositions(chairCount(game));
  const me = selfSlot;
  const iCanAct = phase === PHASES.CLAIMING && game.status === 'playing'
    && game.active?.[me] === true && !Number.isInteger(claims[me]);

  stage.classList.toggle('claiming', phase === PHASES.CLAIMING);
  stage.classList.toggle('reveal', phase === PHASES.REVEAL || game.status === 'finished');
  stage.classList.toggle('can-act', iCanAct);

  stage.querySelectorAll('.mc-chair').forEach((chair) => {
    const owner = chairOwner(game, Number(chair.dataset.chair));
    chair.classList.toggle('taken', Boolean(owner));
    chair.classList.toggle('free', !owner && phase === PHASES.CLAIMING);
    chair.disabled = !iCanAct || Boolean(owner);
  });

  activeKeys(game).forEach((key) => {
    const actor = actorFor(key);
    if (!actor) return;
    const seat = claims[key];
    const seated = Number.isInteger(seat) && positions[seat];
    actor.classList.toggle('seated', Boolean(seated));
    actor.classList.toggle('offline', players[key]?.connected === false);
    actor.classList.toggle('draggable', iCanAct && key === me);
    actor.classList.toggle('standing', (phase === PHASES.REVEAL || game.status === 'finished') && !seated);
    if (seated && !(drag && drag.actor === actor)) place(actor, positions[seat]);
  });
}

/* ---- drag / tap to claim ---- */
function stagePoint(clientX, clientY) {
  const box = el('mc-stage').getBoundingClientRect();
  return { left: ((clientX - box.left) / box.width) * 100, top: ((clientY - box.top) / box.height) * 100 };
}
function nearestFreeChair(pt) {
  if (!currentGame) return null;
  const positions = chairPositions(chairCount(currentGame));
  let best = null;
  positions.forEach((pos, i) => {
    if (chairOwner(currentGame, i) !== null) return;
    const d = Math.hypot(pos.left - pt.left, pos.top - pt.top);
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
  const { actor, origin, target } = drag;
  drag = null;
  actor.classList.remove('dragging');
  setTarget(null);
  if (claimed && target != null) {
    place(actor, chairPositions(chairCount(currentGame))[target]);   // optimistic snap
  } else {
    place(actor, origin);
  }
}
function wireStage() {
  const stage = el('mc-stage');
  if (!stage || stageWired) return;
  stageWired = true;
  stage.addEventListener('pointerdown', (e) => {
    const actor = e.target.closest('.mc-actor.draggable');
    if (!actor || drag) return;
    e.preventDefault();
    drag = {
      actor, pointerId: e.pointerId, target: null,
      origin: { left: parseFloat(actor.style.left) || 50, top: parseFloat(actor.style.top) || 50 },
    };
    actor.classList.add('dragging');
    try { stage.setPointerCapture(e.pointerId); } catch (_) {}
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const pt = stagePoint(e.clientX, e.clientY);
    place(drag.actor, { left: Math.min(97, Math.max(3, pt.left)), top: Math.min(97, Math.max(3, pt.top)) });
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
      const actor = actorFor(selfSlot);
      if (actor) place(actor, chairPositions(chairCount(currentGame))[i]);
    }
  });
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
    card.appendChild(makeSpan('mc-avatar', p.emoji || '🧑'));
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
/** Forget the stage between games so the next round is built fresh. */
export function resetStage() {
  stageSig = '';
  frozenFor = '';
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

  // Rebuild the stage only when its STRUCTURE changes (new round / players in).
  const sig = `${game.roundId}:${game.round}:${activeKeys(game).join(',')}`;
  if (sig !== stageSig) { stageSig = sig; buildStage(game, currentPlayers); }

  const stage = el('mc-stage');
  const roundKey = `${game.roundId}:${game.round}`;
  if (game.phase === PHASES.MUSIC && game.status === 'playing') {
    stage?.classList.add('spinning');
  } else if (frozenFor !== roundKey) {
    // First sight of this round's music stop on this device: park the ring here.
    frozenFor = roundKey;
    freezeRing();
  }
  syncStage(game, currentPlayers);
}

export function setActiveSpeakers(ids = []) {
  const speaking = new Set(ids);
  document.querySelectorAll('.mc-player[data-slot]').forEach((card) => {
    card.classList.toggle('speaking', speaking.has(card.dataset.slot));
  });
}
