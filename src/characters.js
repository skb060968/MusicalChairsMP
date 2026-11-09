/**
 * Shared character rig — 2.5D cartoon players (v2).
 *
 * Each player is a small 3D skeleton drawn with flat, code-drawn parts on its own
 * canvas (src/rig25d.js), with the player's SVG face (src/avatars.js) as the head.
 * Real knees and elbows, smooth turning to any angle, walk / jog / run / sprint
 * picked from the actual movement speed (feet don't slide), throws, pick-ups,
 * catches, sitting, cheering and sulking.
 *
 * SHARED PLATFORM FILE. Copy avatars.js + rig25d.js + characters.js into a game's
 * src/ UNCHANGED, and keep every game's copies identical (edit one, copy to the rest).
 * It injects its own styles (classes are prefixed `chr-`); no other dependencies.
 * Dev page: SevenStones/lab/rig.html (all moves, poses and a timing readout).
 *
 *   import { createCharacter } from './characters.js';
 *   const ch = createCharacter({ avatarId: 'f2', jersey: '#1e88e5', label: 'Meera' });
 *   container.appendChild(ch.el);            // container: position:relative
 *   ch.moveTo(40, 60);                       // field %, the point is the FEET
 *   ch.setPose('sit');  ch.emote('happy', '🏆');
 *
 * Coordinates are % of the containing element (left/top). The character is drawn
 * above that point, so keep players ~15% away from the container's top edge.
 * Size: set `--chr-scale` on the character or any ancestor (default 1 ≈ 40×62 px).
 * Depth: players lower on screen draw in front (z-index = zBase + y). With the
 * `depth` option they also get smaller toward the top of the field.
 *
 * Cost: all characters share one requestAnimationFrame loop. A standing player
 * redraws ~11 times a second (breathing), a moving one every frame; a player that
 * is not on screen is skipped.
 */
import { avatarInfo } from './avatars.js';
import { createRig25d, GAIT_SPEEDS, BALL_RADIUS } from './rig25d.js';

/** Radius of a held ball in box px at --chr-scale 1; draw field balls this size × scale. */
export { BALL_RADIUS };

export const CHARACTER_RIG_VERSION = '2.0.0';
/** A move longer than this (in %) with no glide is a teleport: no run, no turn. */
export const TELEPORT_PCT = 20;

/* Layout box (scale 1): 40 × 62 px with the feet at the bottom centre. The canvas
   reaches past the box so raised arms, jumps and long strides are not cut off. */
const BOX_H = 62;
const CV_W = 80;
const CV_H = 90;
const CV_LEFT = -20;                 // canvas position inside the box
const CV_TOP = -20;
const FEET_X = 20 - CV_LEFT;         // feet inside the canvas
const FEET_Y = BOX_H - CV_TOP;
const IDLE_FRAME_MS = 90;            // standing still: ~11 fps is enough for breathing
const MEASURE_MS = 1500;             // re-check on-screen size this often

/* ======================= STYLES ======================= */

const STYLE_ID = 'chr-styles-v2';
const STYLES = `
.chr {
  position: absolute; width: 40px; height: 62px;
  transform: translate(-50%, -100%) scale(calc(var(--chr-scale, 1) * var(--chr-boost, 1) * var(--chr-depth, 1)));
  transform-origin: 50% 100%;
  pointer-events: none; -webkit-user-select: none; user-select: none;
}
.chr.chr-glide { transition: left var(--chr-glide, 0.28s) var(--chr-glide-ease, ease-out), top var(--chr-glide, 0.28s) var(--chr-glide-ease, ease-out); }
.chr-shadow { position: absolute; left: 50%; bottom: -4px; width: 30px; height: 9px; transform: translateX(-50%);
  border-radius: 50%; background: rgba(0, 0, 0, 0.32); filter: blur(1px); }
.chr-canvas { position: absolute; left: ${CV_LEFT}px; top: ${CV_TOP}px; width: ${CV_W}px; height: ${CV_H}px; display: block; z-index: 1; }
.chr-hand, .chr-hat { position: absolute; left: 0; top: 0; z-index: 2; line-height: 0; pointer-events: none; }
.chr-ring { display: none; }
.chr-burst { position: absolute; left: 50%; bottom: -8px; width: 44px; height: 16px; margin-left: -22px; border-radius: 50%;
  border: 3px solid var(--chr-burst, #ffd700); opacity: 0; pointer-events: none; }
.chr-label { position: absolute; left: 50%; top: calc(100% + 7px); transform: translateX(-50%); z-index: 3;
  max-width: 78px; padding: 0 4px; border-radius: 999px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font: 800 10px/1.35 system-ui, sans-serif; color: #fff; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8); }
.chr-label[hidden] { display: none; }

/* flags */
.chr.chr-self { --chr-boost: 1.15; }
.chr.chr-self .chr-canvas { filter: drop-shadow(0 0 1.2px #fff) drop-shadow(0 0 1.2px #fff) drop-shadow(0 0 5px rgba(255, 235, 59, 0.6)); }
.chr.chr-highlight .chr-canvas { filter: drop-shadow(0 0 6px rgba(255, 215, 0, 0.95)); }
.chr.chr-speaking .chr-canvas { filter: drop-shadow(0 0 3px #4ade80) drop-shadow(0 0 6px #4ade80); }
.chr.chr-self.chr-speaking .chr-canvas { filter: drop-shadow(0 0 1.2px #fff) drop-shadow(0 0 3px #4ade80) drop-shadow(0 0 6px #4ade80); }
.chr.chr-self .chr-ring, .chr.chr-highlight .chr-ring {
  display: block; position: absolute; left: 50%; bottom: -8px; width: 44px; height: 16px; transform: translateX(-50%);
  border-radius: 50%; border: 3px solid #ffeb3b;
  box-shadow: 0 0 10px rgba(255, 235, 59, 0.7), inset 0 0 6px rgba(255, 235, 59, 0.5);
  animation: chr-ring 1.4s ease-in-out infinite; }
.chr.chr-highlight .chr-ring { border-color: #ffd700; animation-duration: 0.7s; }
.chr.chr-self .chr-label { background: #ffeb3b; color: #3e2723; text-shadow: none; }
.chr.chr-label-above .chr-label { top: auto; bottom: calc(100% + 4px); }
.chr.chr-offline { opacity: 0.45; filter: grayscale(0.8); }
.chr.chr-faded { opacity: 0.4; filter: grayscale(0.85); }
@keyframes chr-ring { 0%, 100% { transform: translateX(-50%) scale(1); opacity: 1; } 50% { transform: translateX(-50%) scale(1.18); opacity: 0.65; } }

/* floating emoji (emote) */
.chr-float { position: absolute; left: 50%; bottom: 100%; transform: translate(-50%, 0); z-index: 6;
  font-size: 22px; line-height: 1; pointer-events: none; filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.5));
  animation: chr-rise 1.5s ease-out forwards; }
.chr-float.sad { animation-name: chr-sink; }
/* float drawn in a separate layer (above every player), anchored at the feet */
.chr-float-anchor { position: absolute; width: 0; height: 0; z-index: var(--chr-float-z, 210); pointer-events: none; }
@keyframes chr-rise { 0% { transform: translate(-50%, 10px) scale(0.4); opacity: 0; } 20% { transform: translate(-50%, -14px) scale(1.25); opacity: 1; }
  70% { transform: translate(-50%, -34px) scale(1); opacity: 1; } 100% { transform: translate(-50%, -52px) scale(0.9); opacity: 0; } }
@keyframes chr-sink { 0% { transform: translate(-50%, -14px) scale(0.5); opacity: 0; } 20% { transform: translate(-50%, -20px) scale(1.15); opacity: 1; }
  75% { transform: translate(-50%, -12px) scale(1); opacity: 1; } 100% { transform: translate(-50%, 0) scale(0.9); opacity: 0; } }

@media (prefers-reduced-motion: reduce) {
  .chr .chr-ring { animation: none; }
  .chr-float { animation-duration: 1s; }
}
`;

export function injectCharacterStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

/** Shirt colours that read well on dark and light fields (pick one per player or per team). */
export const JERSEYS = Object.freeze([
  ['#e53935', '#a31f1c'], ['#1e88e5', '#0d47a1'], ['#43a047', '#1b5e20'], ['#fb8c00', '#c25e00'],
  ['#8e24aa', '#5c007a'], ['#00acc1', '#007c91'], ['#fdd835', '#c6a700'], ['#d81b60', '#a00037'],
]);

const FLAG_CLASSES = Object.freeze({
  self: 'chr-self', highlight: 'chr-highlight', offline: 'chr-offline',
  faded: 'chr-faded', speaking: 'chr-speaking', labelAbove: 'chr-label-above',
});

/** Yaw for the named views (0 = facing the camera, 90 = screen right). */
const VIEW_YAW = Object.freeze({ front: 0, right: 90, away: 180, left: 270 });
/** Poses that are one-shot clips (the rest of setPose's names are held). */
const POSE_CLIPS = new Set(['throw', 'pickup', 'catch']);
const HELD_POSES = new Set(['sit', 'aim', 'crouch']);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const reduceMotion = () => typeof window !== 'undefined'
  && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/** Legacy stride time (ms per step, ~300 run / ~450 walk) → ground speed (rig units / s). */
function speedForStride(ms) {
  const table = [[240, GAIT_SPEEDS.sprint], [300, GAIT_SPEEDS.run], [340, GAIT_SPEEDS.jog], [450, GAIT_SPEEDS.walk]];
  if (ms <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i += 1) {
    const [m1, s1] = table[i];
    if (ms <= m1) {
      const [m0, s0] = table[i - 1];
      return s0 + ((s1 - s0) * (ms - m0)) / (m1 - m0);
    }
  }
  return table[table.length - 1][1];
}

/* ======================= SHARED FRAME LOOP ======================= */

const live = new Set();
let raf = 0;
let lastTs = 0;
const stats = { characters: 0, drawn: 0, ms: 0 };

function wakeLoop() {
  if (raf || !live.size || typeof requestAnimationFrame !== 'function') return;
  raf = requestAnimationFrame(tick);
}
function tick(ts) {
  raf = 0;
  const dt = lastTs ? Math.min(0.1, Math.max(0, (ts - lastTs) / 1000)) : 1 / 60;
  lastTs = ts;
  const t0 = now();
  let drawn = 0;
  live.forEach((c) => { if (c._frame(ts, dt)) drawn += 1; });
  stats.characters = live.size;
  stats.drawn = drawn;
  stats.ms = now() - t0;
  if (live.size) raf = requestAnimationFrame(tick);
  else lastTs = 0;
}

/** Timing of the last frame: { characters, drawn, ms } (for diagnostics). */
export function characterStats() {
  return { ...stats };
}

/* ======================= CHARACTER ======================= */

/**
 * @param {object} [opts]
 * @param {string} [opts.avatarId]   face id from avatars.js
 * @param {string} [opts.jersey]     shirt colour (hex); [opts.jerseyDark] its shade
 * @param {string} [opts.label]      name tag under the feet
 * @param {number} [opts.zBase=20]   depth sort base (z-index = zBase + y%)
 * @param {number[]} [opts.depth]    [scaleAtTop, scaleAtBottom], e.g. [0.86, 1.12]:
 *   players shrink toward the top of the field (perspective). Default: no change.
 * @returns character handle (see methods below); `handle.el` is the element to append
 */
export function createCharacter(opts = {}) {
  injectCharacterStyles();
  const el = document.createElement('div');
  el.className = 'chr';
  const ring = document.createElement('span');
  ring.className = 'chr-ring';
  const shadow = document.createElement('span');
  shadow.className = 'chr-shadow';
  const burst = document.createElement('span');
  burst.className = 'chr-burst';
  const canvas = document.createElement('canvas');
  canvas.className = 'chr-canvas';
  const hand = document.createElement('span');
  hand.className = 'chr-hand';
  hand.hidden = true;
  const hat = document.createElement('span');
  hat.className = 'chr-hat';
  hat.hidden = true;
  const label = document.createElement('span');
  label.className = 'chr-label';
  label.hidden = true;
  el.append(ring, shadow, burst, canvas, hand, hat, label);

  const ctx = canvas.getContext('2d');
  const rig = createRig25d({ avatarId: opts.avatarId || null });
  rig.shadow = false;                           // the HTML shadow above is styleable by games
  rig.idleMotion = !reduceMotion();
  const zBase = Number.isFinite(opts.zBase) ? opts.zBase : 20;
  const depthRange = Array.isArray(opts.depth) && opts.depth.length === 2 ? opts.depth.map(Number) : null;

  let pos = null;
  let facing = 'auto';                          // 'auto' or 'fixed'
  let labelText = '';
  let glideTimer = null;
  let depthNow = 1;
  const floats = new Set();                     // emoji anchors that follow the player

  // Movement → speed.
  let lastMoveAt = 0;
  let measured = 0;                             // rig units / s from the last moves
  let autoUntil = 0;                            // animate:true moves keep the gait on until then
  let seenUntil = 0;                            // any recent move (for forced running)
  let runForced = false;
  let runUntil = 0;
  let strideMs = 300;

  // Drawing.
  let res = 0;                                  // canvas px per box px
  let visible = true;
  let parentW = 0;
  let parentH = 0;
  let baseScale = 1;                            // box px → container px, without depth
  let lastMeasure = -Infinity;
  let lastDraw = -Infinity;
  let pending = 0;
  let dirty = true;
  let drewSettled = false;
  let faceReady = false;
  let detachedAt = 0;
  const hatAt = { x: NaN, y: NaN };
  const handAt = { x: NaN, y: NaN };

  const wake = () => {
    dirty = true;
    if (!live.has(api)) live.add(api);
    wakeLoop();
  };

  function measure(t) {
    lastMeasure = t;
    const parent = el.parentElement;
    if (!parent) return;
    parentW = parent.clientWidth;
    parentH = parent.clientHeight;
    const er = el.getBoundingClientRect();
    visible = er.width > 0 && er.height > 0;
    if (!visible) return;
    const pr = parent.getBoundingClientRect();
    const parentScale = parentW ? pr.width / parentW : 1;
    const screen = er.height / BOX_H;                         // on-screen px per box px
    baseScale = screen / (parentScale || 1) / (depthNow || 1);
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const want = clamp(screen * dpr, 0.75, 6);
    if (!res || Math.abs(want - res) / res > 0.08) {
      res = want;
      canvas.width = Math.round(CV_W * res);
      canvas.height = Math.round(CV_H * res);
      dirty = true;
    }
  }

  /** Box px → container px for this player right now. */
  const localScale = () => baseScale * depthNow;

  function drive(t) {
    if (runForced && runUntil && t > runUntil) { runForced = false; runUntil = 0; }
    let sp = t < autoUntil ? measured : 0;
    if (runForced) sp = t < seenUntil && measured > 2 ? measured : speedForStride(strideMs);
    if (rig.holdName === 'sit') sp = 0;
    rig.setSpeed(sp);
  }

  function placeOverlays() {
    const cx = (x) => x + CV_LEFT;
    const cy = (y) => y + CV_TOP;
    if (!hat.hidden) {
      const x = cx(rig.headTop.x);
      const y = cy(rig.headTop.y);                           // the item's bottom edge sits on the hair
      if (Math.abs(x - hatAt.x) > 0.3 || Math.abs(y - hatAt.y) > 0.3) {
        hatAt.x = x;
        hatAt.y = y;
        hat.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      }
    }
    if (!hand.hidden) {
      const x = cx(rig.hand.x);
      const y = cy(rig.hand.y);
      if (Math.abs(x - handAt.x) > 0.3 || Math.abs(y - handAt.y) > 0.3) {
        handAt.x = x;
        handAt.y = y;
        hand.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
      }
    }
  }

  function draw() {
    if (!res) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(res, 0, 0, res, 0, 0);
    rig.draw(ctx, FEET_X, FEET_Y, 1);
    placeOverlays();
  }

  const api = {
    el,

    /** @private Called by the shared loop. Returns true when it drew. */
    _frame(t, dt) {
      if (!el.isConnected) {
        if (!detachedAt) detachedAt = t;
        else if (t - detachedAt > 10000) live.delete(api);       // re-added by the next call
        return false;
      }
      detachedAt = 0;
      pending += dt;
      // Hidden players (display: none) are checked more often so they reappear at once.
      if (t - lastMeasure > (visible && res ? MEASURE_MS : 250)) measure(t);
      if (!visible) return false;
      drive(t);
      if (rig.face.ready !== faceReady) { faceReady = rig.face.ready; dirty = true; }
      const settled = rig.isSettled() && !dirty;
      if (settled && (rig.idleMotion ? t - lastDraw < IDLE_FRAME_MS : drewSettled)) return false;
      rig.update(pending);
      pending = 0;
      draw();
      lastDraw = t;
      dirty = false;
      drewSettled = settled;
      return true;
    },

    setAvatar(id) {
      if (avatarInfo(id).id === rig.avatarId) return api;      // games call this on every render
      rig.setAvatar(id);
      faceReady = false;
      wake();
      return api;
    },

    setJersey(color, dark) {
      if (!color) return api;
      rig.setJersey(color, dark);
      wake();
      return api;
    },

    setLabel(text) {
      const t = text ? String(text) : '';
      if (t === labelText) return api;
      labelText = t;
      label.textContent = t;
      label.hidden = !t;
      return api;
    },

    /** Current feet position ({x, y} in %), or null before the first moveTo. */
    get position() { return pos ? { ...pos } : null; },

    /**
     * Place the feet at (x, y) %. Moving plays the walk / run (chosen from the speed)
     * and, with facing 'auto', turns the body toward the direction of travel.
     * @param {object} [o]
     * @param {number}  [o.glide=0]   ms to slide there (CSS transition) — 0 = jump
     * @param {string}  [o.ease='ease-out'] glide timing; 'linear' suits a stream of network updates
     * @param {boolean} [o.animate=true] play the gait / auto-facing for this move
     */
    moveTo(x, y, { glide = 0, ease = 'ease-out', animate = true } = {}) {
      const t = now();
      const prev = pos;
      pos = { x, y };
      clearTimeout(glideTimer);
      if (glide > 0) {
        el.style.setProperty('--chr-glide', `${glide}ms`);
        el.style.setProperty('--chr-glide-ease', ease);
        el.classList.add('chr-glide');
        glideTimer = setTimeout(() => el.classList.remove('chr-glide'), glide + 40);
      } else {
        el.classList.remove('chr-glide');
      }
      el.style.left = `${x}%`;
      el.style.top = `${y}%`;
      el.style.zIndex = String(zBase + Math.max(0, Math.min(100, Math.round(y))));
      if (depthRange) {
        const d = depthRange[0] + (depthRange[1] - depthRange[0]) * clamp(y / 100, 0, 1);
        if (Math.abs(d - depthNow) > 0.004) {
          depthNow = d;
          el.style.setProperty('--chr-depth', d.toFixed(3));
        }
      }
      floats.forEach((n) => { n.style.left = `${x}%`; n.style.top = `${y}%`; });
      if (!live.has(api)) live.add(api);
      wakeLoop();

      if (!prev) { lastMoveAt = t; return api; }
      const dxp = x - prev.x;
      const dyp = y - prev.y;
      const d = Math.hypot(dxp, dyp);
      // Games re-render often without moving: only real moves count for the speed.
      if (d < 0.02) return api;                                   // still
      const since = t - lastMoveAt;
      lastMoveAt = t;
      if (d > TELEPORT_PCT && glide === 0) { measured = 0; autoUntil = 0; seenUntil = 0; return api; }
      if (!parentW && el.isConnected) measure(t);
      const W = parentW || 400;
      const H = parentH || 400;
      const dx = (dxp / 100) * W;
      const dy = (dyp / 100) * H;
      const px = Math.hypot(dx, dy);
      const dtMs = glide > 0 ? Math.max(glide, Math.min(since, 250)) : clamp(since, 8, 250);
      const inst = px / (dtMs / 1000) / (localScale() || 1);
      measured = t < seenUntil + 150 && measured > 0 ? measured * 0.5 + inst * 0.5 : inst;
      seenUntil = t + glide + 130;
      if (!animate) return api;
      autoUntil = seenUntil;
      if (facing === 'auto' && px > 0.2) rig.faceToward(dx, dy);
      dirty = true;
      return api;
    },

    /** 'auto' (follow movement) | 'front' | 'left' | 'right' | 'away' | an angle in degrees. */
    setFacing(f) {
      if (f == null || f === 'auto') { facing = 'auto'; return api; }
      const yaw = typeof f === 'number' ? f : VIEW_YAW[f];
      if (yaw == null) return api;
      facing = 'fixed';
      rig.setYaw(yaw);
      wake();
      return api;
    },

    /** The nearest named view to where the body is turning: 'front' | 'away' | 'left' | 'right'. */
    get facing() {
      const y = ((rig.targetYaw % 360) + 360) % 360;
      if (y < 45 || y >= 315) return 'front';
      if (y < 135) return 'right';
      if (y < 225) return 'away';
      return 'left';
    },

    /** Facing angle in degrees (0 = toward the camera, 90 = screen right). */
    get yaw() { return rig.targetYaw; },

    /**
     * Turn toward a direction on the field (dx, dy in %), e.g. where a player aims or
     * throws. With facing 'auto' the next move turns the body again.
     */
    faceToward(dx, dy) {
      if (!dx && !dy) return api;
      if (!parentW && el.isConnected) measure(now());
      rig.faceToward((dx / 100) * (parentW || 400), (dy / 100) * (parentH || 400));
      wake();
      return api;
    },

    /**
     * Keep the legs moving even when the position is driven another way (e.g. a group
     * walking in a circle). `holdMs` turns it off again after that long (0 = until told).
     */
    setRunning(on, holdMs = 0) {
      runForced = Boolean(on);
      runUntil = runForced && holdMs > 0 ? now() + holdMs : 0;
      wake();
      return api;
    },

    /**
     * Stride in ms per step: ~450 = walk, ~300 = run, ~240 = sprint. Moves still pick
     * the gait from the real speed; a slow stride (≥ 400 ms) keeps them walking.
     */
    setGait(ms) {
      strideMs = Math.max(120, Number(ms) || 300);
      rig.setGaitCap(strideMs >= 400 ? 'walk' : null);
      return api;
    },

    /**
     * Held: 'sit' | 'aim' (ready to throw) | 'crouch'. One-shot: 'throw' (from the
     * wind-up to the follow-through), 'pickup' (squat and reach), 'catch'. null = normal.
     * @param {object} [o]
     * @param {Function} [o.onRelease] throw: called as the ball leaves the hand
     * @param {number}   [o.rate=1]   one-shot playback speed
     */
    setPose(p, { onRelease = null, rate = 1 } = {}) {
      if (HELD_POSES.has(p)) {
        if (POSE_CLIPS.has(rig.actionName)) rig.stop();
        rig.hold(p);
      } else if (p === 'throw') {
        rig.hold(null);
        rig.play('throw', { from: 0.4, rate, onEvent: (n) => { if (n === 'release') onRelease?.(); } });
      } else if (POSE_CLIPS.has(p)) {
        rig.hold(null);
        rig.play(p, { rate });
      } else {
        rig.hold(null);
        if (POSE_CLIPS.has(rig.actionName)) rig.stop();
      }
      wake();
      return api;
    },

    /** The current pose: null | 'sit' | 'aim' | 'crouch' | 'throw' | 'pickup' | 'catch'. */
    get pose() {
      return rig.holdName || (POSE_CLIPS.has(rig.actionName) ? rig.actionName : null);
    },

    /**
     * Boolean flags: self (YOU ring + bigger), highlight (gold ring + glow), offline,
     * faded, speaking, labelAbove (name tag above the head, e.g. at the bottom edge).
     */
    setFlags(flags = {}) {
      Object.entries(flags).forEach(([k, v]) => {
        const cls = FLAG_CLASSES[k];
        if (cls && el.classList.contains(cls) !== Boolean(v)) el.classList.toggle(cls, Boolean(v));
      });
      return api;
    },

    /**
     * In the throwing hand: 'ball' (drawn with the body, behind or in front of it as
     * the arm swings), any DOM node (placed over the hand), or null.
     */
    setHandItem(item) {
      if (typeof item === 'string') {
        rig.setHandItem(item);
        hand.replaceChildren();
        hand.hidden = true;
      } else {
        rig.setHandItem(null);
        hand.replaceChildren(...(item ? [item] : []));
        hand.hidden = !item;
        handAt.x = NaN;
      }
      wake();
      return api;
    },

    /**
     * Balanced on the head: 'stone' (drawn), any DOM node (its bottom edge on the hair
     * line; nudge it down with `position: relative; top: Npx` to sink it in), or null.
     */
    setHeadItem(item) {
      if (typeof item === 'string') {
        rig.setHeadItem(item);
        hat.replaceChildren();
        hat.hidden = true;
      } else {
        rig.setHeadItem(null);
        hat.replaceChildren(...(item ? [item] : []));
        hat.hidden = !item;
        hatAt.x = NaN;
      }
      wake();
      return api;
    },

    /**
     * Carried in both hands in front of the body (e.g. a stone), or null. Sizes in rig
     * units (≈ px at --chr-scale 1): { w, d?, t, top: [c1, c2], side: [c1, c2] }. The
     * arms take a carry pose while the legs keep walking / running.
     */
    setCarryItem(item) {
      rig.setCarryItem(item || null);
      wake();
      return api;
    },

    /**
     * 'happy' (jumps with both arms up) or 'sad' (slumps, head down), with a ring
     * flash on the ground and an optional floating emoji. Seated or moving players
     * react with the upper body only.
     * @param {object} [o]
     * @param {Element} [o.layer] draw the emoji in this element (same coordinate box as the
     *   character's container) so it sits above every player; default: inside the character
     */
    emote(kind, icon, { layer = null } = {}) {
      const sad = kind === 'sad';
      const upper = rig.holdName === 'sit' || rig.speed > 5 || reduceMotion();
      rig.play(sad ? 'sad' : 'cheer', { mask: upper ? 'upper' : null });
      el.style.setProperty('--chr-burst', sad ? '#e53935' : '#ffd700');
      burst.animate?.([
        { transform: 'scale(0.4)', opacity: 0.95 },
        { transform: 'scale(2.1)', opacity: 0 },
      ], { duration: 900, easing: 'ease-out' });
      wake();
      if (icon) {
        const f = document.createElement('span');
        f.className = `chr-float${sad ? ' sad' : ''}`;
        f.textContent = icon;
        let node = f;
        if (layer && pos) {
          node = document.createElement('span');
          node.className = 'chr-float-anchor';
          node.style.left = `${pos.x}%`;
          node.style.top = `${pos.y}%`;
          f.style.bottom = `${Math.round(el.getBoundingClientRect().height) || BOX_H}px`;   // start at head height
          node.appendChild(f);
          layer.appendChild(node);
          floats.add(node);
        } else {
          el.appendChild(f);
        }
        const remove = () => { floats.delete(node); node.remove(); };
        f.addEventListener('animationend', remove, { once: true });
        setTimeout(remove, 2000);
      }
      return api;
    },

    destroy() {
      clearTimeout(glideTimer);
      live.delete(api);
      floats.forEach((n) => n.remove());
      floats.clear();
      el.remove();
    },
  };

  if (opts.jersey) rig.setJersey(opts.jersey, opts.jerseyDark);
  if (opts.label) api.setLabel(opts.label);
  live.add(api);
  wakeLoop();
  return api;
}

/**
 * Which named view a movement of (dx, dy) on screen is closest to:
 *   down the screen → 'front' (walking toward the camera)
 *   up the screen   → 'away'  (back of the head)
 *   sideways        → 'left' / 'right'
 * HYSTERESIS: the current view is kept until the new direction is clearly (≈10°)
 * inside another sector. (The v2 rig turns to any angle by itself; this is kept
 * for game logic that wants a coarse direction.)
 */
const VIEW_DIRS = { front: [0, 1], away: [0, -1], left: [-1, 0], right: [1, 0] };
const VIEW_STICKINESS = 0.25;
export function viewForMotion(dx, dy, current = null) {
  const len = Math.hypot(dx, dy);
  if (!len) return current || 'front';
  const ux = dx / len;
  const uy = dy / len;
  let best = 'front';
  let bestScore = -Infinity;
  Object.entries(VIEW_DIRS).forEach(([v, [vx, vy]]) => {
    const s = ux * vx + uy * vy;
    if (s > bestScore) { bestScore = s; best = v; }
  });
  if (current && VIEW_DIRS[current]) {
    const [cx, cy] = VIEW_DIRS[current];
    if (ux * cx + uy * cy >= bestScore - VIEW_STICKINESS) return current;
  }
  return best;
}

/**
 * Positions on an ellipse for a group walking in a circle (e.g. around chairs).
 * Returns { x, y, facing } for point i of n at `phase` radians (clockwise on
 * screen). Move the characters there with moveTo() and facing 'auto': they turn
 * smoothly along the circle. `facing` is the coarse view, for game logic.
 */
export function orbitPoint(i, n, phase, { cx = 50, cy = 50, rx = 40, ry = 40, prev = null } = {}) {
  const a = phase + (i * Math.PI * 2) / Math.max(1, n) - Math.PI / 2;
  const vx = -rx * Math.sin(a);                  // clockwise travel direction on screen
  const vy = ry * Math.cos(a);
  return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), facing: viewForMotion(vx, vy, prev) };
}
