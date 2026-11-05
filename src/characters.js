/**
 * Shared character rig — cartoon players with a drawn face (src/avatars.js) on a
 * body that runs, walks, sits, turns around and shows emotions.
 *
 * SHARED PLATFORM FILE. Self-contained: it injects its own styles (all classes are
 * prefixed `chr-`) and depends only on avatars.js. To use it in another game, copy
 * avatars.js + characters.js into that game's src/ unchanged.
 *
 *   import { createCharacter } from './characters.js';
 *   const ch = createCharacter({ avatarId: 'f2', jersey: '#1e88e5', label: 'Meera' });
 *   container.appendChild(ch.el);            // container: position:relative
 *   ch.moveTo(40, 60);                       // field %, the point is the FEET
 *   ch.setPose('sit');  ch.emote('happy', '🏆');
 *
 * Coordinates are % of the containing element (left/top). The character is drawn
 * above that point, so keep players ~15% away from the container's top edge.
 * Size: set `--chr-scale` on the character or any ancestor (default 1 = 40×62 px).
 * Depth: players lower on screen draw in front (z-index = zBase + y).
 */
import { avatarInfo, avatarSvg, avatarBackSvg } from './avatars.js';

/* ======================= STYLES ======================= */

const STYLE_ID = 'chr-styles';
const STYLES = `
.chr {
  position: absolute; width: 40px; height: 62px;
  transform: translate(-50%, -100%) scale(calc(var(--chr-scale, 1) * var(--chr-boost, 1)));
  transform-origin: 50% 100%;
  pointer-events: none; -webkit-user-select: none; user-select: none;
  --chr-jersey: #e53935; --chr-jersey-dark: #a31f1c; --chr-skin: #c98b5d; --chr-shorts: #33261f;
  --chr-gait: 0.3s;
}
.chr.chr-glide { transition: left var(--chr-glide, 0.28s) ease-out, top var(--chr-glide, 0.28s) ease-out; }
.chr-shadow { position: absolute; left: 50%; bottom: -4px; width: 30px; height: 9px; transform: translateX(-50%);
  border-radius: 50%; background: rgba(0, 0, 0, 0.35); filter: blur(1px); }
.chr-ring { display: none; }
.chr-body, .chr-bob, .chr-rig { position: absolute; inset: 0; transform-origin: 50% 100%; }
.chr-head { position: absolute; left: 50%; top: -3px; width: 28px; height: 31px; transform: translateX(-50%);
  z-index: 3; filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.35)); }
.chr-face, .chr-face-back { display: block; width: 100%; height: 100%; }
.chr-face svg, .chr-face-back svg { display: block; width: 100%; height: 100%; }
.chr-face-back { display: none; }
.chr-torso { position: absolute; left: 10px; top: 21px; width: 20px; height: 19px; border-radius: 8px 8px 5px 5px; z-index: 2;
  background: linear-gradient(180deg, var(--chr-jersey) 0%, var(--chr-jersey) 70%, var(--chr-jersey-dark) 100%);
  box-shadow: inset -3px 0 0 rgba(0, 0, 0, 0.15); }
.chr-leg, .chr-arm { position: absolute; transform-origin: 50% 0; border-radius: 3px 3px 4px 4px; }
.chr-leg { top: 38px; width: 7px; height: 21px; z-index: 1;
  background: linear-gradient(180deg, var(--chr-shorts) 0 38%, var(--chr-skin) 38% 82%, #1d1d1d 82%); }
.chr-leg-l { left: 12px; } .chr-leg-r { left: 21px; }
.chr-arm { top: 23px; width: 6px; height: 17px; background: linear-gradient(180deg, var(--chr-jersey) 0 40%, var(--chr-skin) 40%); }
.chr-arm-back { left: 7px; z-index: 1; filter: brightness(0.8); }
.chr-arm-front { left: 27px; z-index: 3; }
.chr-hand { position: absolute; left: 50%; bottom: -6px; transform: translateX(-50%); line-height: 0; }
.chr-hat { position: absolute; left: 50%; top: -12px; transform: translateX(-50%); z-index: 5; line-height: 0; }
.chr-label { position: absolute; left: 50%; top: calc(100% + 7px); transform: translateX(-50%);
  max-width: 78px; padding: 0 4px; border-radius: 999px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font: 800 10px/1.35 system-ui, sans-serif; color: #fff; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8); }
.chr-label[hidden] { display: none; }

/* facing */
.chr.chr-face-left .chr-rig { transform: scaleX(-1); }
.chr.chr-away .chr-face { display: none; }
.chr.chr-away .chr-face-back { display: block; }
.chr.chr-away .chr-torso { background: linear-gradient(180deg, var(--chr-jersey-dark) 0 12%, var(--chr-jersey) 12% 72%, var(--chr-jersey-dark) 100%); }

/* gait — one cycle = two steps (2 × --chr-gait); left and right are half a cycle apart.
   SIDE view (walking left/right): legs and arms swing forward/back, body leans in.
   FRONT / BACK view (walking toward / away from the camera): knees lift in turn and
   the arms swing toward / away from the camera (foreshortened), no lean. */
.chr.chr-running .chr-bob { animation: chr-bob calc(var(--chr-gait) / 2) ease-in-out infinite alternate; }
.chr.chr-running.chr-side .chr-leg-l     { animation: chr-leg var(--chr-gait) ease-in-out infinite alternate; }
.chr.chr-running.chr-side .chr-leg-r     { animation: chr-leg var(--chr-gait) ease-in-out calc(var(--chr-gait) * -1) infinite alternate; }
.chr.chr-running.chr-side .chr-arm-back  { animation: chr-arm var(--chr-gait) ease-in-out calc(var(--chr-gait) * -1) infinite alternate; }
.chr.chr-running.chr-side .chr-arm-front { animation: chr-arm var(--chr-gait) ease-in-out infinite alternate; }
.chr.chr-running.chr-side .chr-rig       { rotate: 6deg; }
.chr.chr-running.chr-side.chr-face-left .chr-rig { rotate: -6deg; }
.chr.chr-side .chr-leg-l { left: 13px; }      /* side on, the legs overlap more */
.chr.chr-side .chr-leg-r { left: 20px; }
.chr.chr-running:not(.chr-side) .chr-leg-l     { animation: chr-march calc(var(--chr-gait) * 2) ease-in-out infinite; }
.chr.chr-running:not(.chr-side) .chr-leg-r     { animation: chr-march calc(var(--chr-gait) * 2) ease-in-out calc(var(--chr-gait) * -1) infinite; }
.chr.chr-running:not(.chr-side) .chr-arm-back  { animation: chr-arm-fb calc(var(--chr-gait) * 2) ease-in-out calc(var(--chr-gait) * -1) infinite; }
.chr.chr-running:not(.chr-side) .chr-arm-front { animation: chr-arm-fb calc(var(--chr-gait) * 2) ease-in-out infinite; }
.chr:not(.chr-running):not(.chr-sit) .chr-bob { animation: chr-idle 1.8s ease-in-out infinite; }
@keyframes chr-leg { from { transform: rotate(34deg); } to { transform: rotate(-34deg); } }
@keyframes chr-arm { from { transform: rotate(-40deg); } to { transform: rotate(40deg); } }
/* knee lift seen from the front: the leg shortens from the hip, the foot rises */
@keyframes chr-march { 0%, 100% { transform: translateY(0) scaleY(1); } 50% { transform: translateY(-1px) scaleY(0.72); } }
/* arm swinging toward the camera looks shorter */
@keyframes chr-arm-fb { 0%, 100% { transform: scaleY(1); } 50% { transform: scaleY(0.7); } }
@keyframes chr-bob { from { transform: translateY(0); } to { transform: translateY(-3px); } }
@keyframes chr-idle { 0%, 100% { transform: scaleY(1); } 50% { transform: scaleY(0.97); } }

/* sitting (seen from the front: thighs toward the camera, body lowered) */
.chr.chr-sit .chr-bob { animation: none !important; transform: translateY(8px); }
.chr.chr-sit .chr-rig { rotate: 0deg !important; }
.chr.chr-sit .chr-leg { animation: none !important; top: 37px; height: 13px;
  background: linear-gradient(180deg, var(--chr-shorts) 0 46%, var(--chr-skin) 46% 74%, #1d1d1d 74%); }
.chr.chr-sit .chr-leg-l { transform: rotate(16deg); }
.chr.chr-sit .chr-leg-r { transform: rotate(-16deg); }
.chr.chr-sit .chr-arm { animation: none !important; transform: rotate(-14deg); }
.chr.chr-sit .chr-arm-front { transform: rotate(14deg); }

/* throwing (ball games) */
.chr.chr-aim .chr-arm-front { animation: none !important; transform: rotate(-155deg); }
.chr.chr-aim .chr-arm-back  { animation: none !important; transform: rotate(25deg); }
.chr.chr-throw .chr-arm-front { animation: chr-throw-arm 0.45s ease-out both !important; }
.chr.chr-throw .chr-body      { animation: chr-lunge 0.45s ease-out both; }
@keyframes chr-throw-arm { 0% { transform: rotate(-155deg); } 35% { transform: rotate(-200deg); } 70% { transform: rotate(-30deg); } 100% { transform: rotate(0); } }
@keyframes chr-lunge { 40% { transform: translateY(-4px) scale(1.03, 1.05); } 70% { transform: translateY(1px) scale(1.04, 0.95); } }

/* flags */
.chr.chr-self { --chr-boost: 1.15; }
.chr.chr-self .chr-body { filter: drop-shadow(0 0 1.5px #fff) drop-shadow(0 0 1.5px #fff) drop-shadow(0 0 6px rgba(255, 235, 59, 0.6)); }
.chr.chr-self .chr-ring, .chr.chr-highlight .chr-ring {
  display: block; position: absolute; left: 50%; bottom: -8px; width: 44px; height: 16px; transform: translateX(-50%);
  border-radius: 50%; border: 3px solid #ffeb3b;
  box-shadow: 0 0 10px rgba(255, 235, 59, 0.7), inset 0 0 6px rgba(255, 235, 59, 0.5);
  animation: chr-ring 1.4s ease-in-out infinite; }
.chr.chr-highlight .chr-ring { border-color: #ffd700; animation-duration: 0.7s; }
.chr.chr-self .chr-label { background: #ffeb3b; color: #3e2723; text-shadow: none; }
.chr.chr-offline { opacity: 0.45; filter: grayscale(0.8); }
.chr.chr-faded { opacity: 0.4; filter: grayscale(0.85); }
.chr.chr-speaking .chr-head { filter: drop-shadow(0 0 3px #4ade80) drop-shadow(0 0 6px #4ade80); }
@keyframes chr-ring { 0%, 100% { transform: translateX(-50%) scale(1); opacity: 1; } 50% { transform: translateX(-50%) scale(1.18); opacity: 0.65; } }

/* emotions */
.chr.chr-happy .chr-body { animation: chr-jump 1.3s cubic-bezier(.3, .7, .4, 1) both; }
.chr.chr-happy .chr-arm-front { animation: chr-arms-up 1.3s ease-out both !important; }
.chr.chr-happy .chr-arm-back  { animation: chr-arms-up-back 1.3s ease-out both !important; }
@keyframes chr-jump {
  0% { transform: translateY(0) scale(1); filter: drop-shadow(0 0 0 rgba(255, 215, 0, 0)); }
  12% { transform: translateY(0) scale(1.1, 0.85); }
  28% { transform: translateY(-26px) scale(1.05); filter: drop-shadow(0 0 10px rgba(255, 215, 0, 1)); }
  42% { transform: translateY(0) scale(1.1, 0.88); }
  56% { transform: translateY(-16px) scale(1.03); filter: drop-shadow(0 0 12px rgba(124, 255, 120, 0.9)); }
  70% { transform: translateY(0) scale(1.05, 0.95); }
  100% { transform: translateY(0) scale(1); filter: drop-shadow(0 0 0 rgba(255, 215, 0, 0)); } }
@keyframes chr-arms-up      { 0%, 100% { transform: rotate(0); } 15%, 80% { transform: rotate(-160deg); } }
@keyframes chr-arms-up-back { 0%, 100% { transform: rotate(0); } 15%, 80% { transform: rotate(160deg); } }
.chr.chr-sad .chr-body { animation: chr-sad 1.6s ease-out both; }
.chr.chr-sad .chr-head { animation: chr-droop 1.6s ease-out both; }
.chr.chr-sad .chr-arm  { animation: none !important; transform: rotate(8deg); }
@keyframes chr-sad {
  0% { transform: translateX(0); filter: saturate(1) drop-shadow(0 0 0 rgba(229, 57, 53, 0)); }
  8% { transform: translateX(-5px) scale(0.97); filter: saturate(0.6) drop-shadow(0 0 10px rgba(229, 57, 53, 1)); }
  16% { transform: translateX(5px); } 24% { transform: translateX(-4px); } 32% { transform: translateX(3px); }
  45%, 80% { transform: translateX(0) scale(0.92, 0.88); filter: saturate(0.5) brightness(0.85) drop-shadow(0 0 8px rgba(229, 57, 53, 0.85)); }
  100% { transform: translateX(0) scale(1); filter: saturate(1) drop-shadow(0 0 0 rgba(229, 57, 53, 0)); } }
@keyframes chr-droop { 0%, 100% { transform: translateX(-50%) rotate(0); } 40%, 85% { transform: translateX(-50%) translateY(4px) rotate(-14deg); } }
.chr-float { position: absolute; left: 50%; bottom: 100%; transform: translate(-50%, 0); z-index: 6;
  font-size: 22px; line-height: 1; pointer-events: none; filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.5));
  animation: chr-rise 1.5s ease-out forwards; }
.chr-float.sad { animation-name: chr-sink; }
@keyframes chr-rise { 0% { transform: translate(-50%, 10px) scale(0.4); opacity: 0; } 20% { transform: translate(-50%, -14px) scale(1.25); opacity: 1; }
  70% { transform: translate(-50%, -34px) scale(1); opacity: 1; } 100% { transform: translate(-50%, -52px) scale(0.9); opacity: 0; } }
@keyframes chr-sink { 0% { transform: translate(-50%, -14px) scale(0.5); opacity: 0; } 20% { transform: translate(-50%, -20px) scale(1.15); opacity: 1; }
  75% { transform: translate(-50%, -12px) scale(1); opacity: 1; } 100% { transform: translate(-50%, 0) scale(0.9); opacity: 0; } }

@media (prefers-reduced-motion: reduce) {
  .chr .chr-body, .chr .chr-bob, .chr .chr-leg, .chr .chr-arm, .chr .chr-head, .chr .chr-ring {
    animation-duration: 0.01s !important; animation-iteration-count: 1 !important; }
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

/* ======================= RIG ======================= */

const RIG_HTML = '<span class="chr-ring"></span><span class="chr-shadow"></span>'
  + '<span class="chr-body"><span class="chr-bob"><span class="chr-rig">'
  + '<span class="chr-arm chr-arm-back"></span><span class="chr-leg chr-leg-l"></span><span class="chr-leg chr-leg-r"></span>'
  + '<span class="chr-torso"></span><span class="chr-arm chr-arm-front"><span class="chr-hand"></span></span>'
  + '</span><span class="chr-head"><span class="chr-face"></span><span class="chr-face-back"></span><span class="chr-hat"></span></span>'
  + '</span></span><span class="chr-label" hidden></span>';

/** Shirt colours that read well on dark and light fields (pick one per player or per team). */
export const JERSEYS = Object.freeze([
  ['#e53935', '#a31f1c'], ['#1e88e5', '#0d47a1'], ['#43a047', '#1b5e20'], ['#fb8c00', '#c25e00'],
  ['#8e24aa', '#5c007a'], ['#00acc1', '#007c91'], ['#fdd835', '#c6a700'], ['#d81b60', '#a00037'],
]);

function darken(hex, amount = 0.3) {
  const n = Number.parseInt(String(hex).replace('#', ''), 16);
  if (!Number.isFinite(n)) return hex;
  const c = (s) => Math.round(((n >> s) & 255) * (1 - amount));
  return `#${((c(16) << 16) | (c(8) << 8) | c(0)).toString(16).padStart(6, '0')}`;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.avatarId]   face id from avatars.js
 * @param {string} [opts.jersey]     shirt colour (hex); [opts.jerseyDark] its shade
 * @param {string} [opts.label]      name tag under the feet
 * @param {number} [opts.zBase=20]   depth sort base (z-index = zBase + y%)
 * @returns character handle (see methods below); `handle.el` is the element to append
 */
export function createCharacter(opts = {}) {
  injectCharacterStyles();
  const el = document.createElement('div');
  el.className = 'chr';
  el.innerHTML = RIG_HTML;
  const q = (sel) => el.querySelector(sel);
  const face = q('.chr-face');
  const faceBack = q('.chr-face-back');
  const label = q('.chr-label');
  const hand = q('.chr-hand');
  const hat = q('.chr-hat');
  const zBase = Number.isFinite(opts.zBase) ? opts.zBase : 20;

  let avatarId = null;
  let pos = null;
  let facing = 'auto';      // requested: 'auto' or a fixed view
  let view = 'front';       // what is drawn: 'front' | 'away' | 'left' | 'right'
  const applyView = (v) => {
    view = v;
    el.classList.toggle('chr-away', v === 'away');
    el.classList.toggle('chr-face-left', v === 'left');
    el.classList.toggle('chr-side', v === 'left' || v === 'right');
  };
  let runTimer = null;
  let poseTimer = null;
  let emoteTimer = null;
  let glideTimer = null;

  const api = {
    el,

    setAvatar(id) {
      const info = avatarInfo(id);
      if (info.id === avatarId) return api;
      avatarId = info.id;
      face.innerHTML = avatarSvg(info.id);
      faceBack.innerHTML = avatarBackSvg(info.id);
      el.style.setProperty('--chr-skin', info.skin);   // arms and legs match the face
      return api;
    },

    setJersey(color, dark) {
      if (!color) return api;
      el.style.setProperty('--chr-jersey', color);
      el.style.setProperty('--chr-jersey-dark', dark || darken(color));
      return api;
    },

    setLabel(text) {
      label.textContent = text ? String(text) : '';
      label.hidden = !text;
      return api;
    },

    /** Current feet position ({x, y} in %), or null before the first moveTo. */
    get position() { return pos ? { ...pos } : null; },

    /**
     * Place the feet at (x, y) %. Moving switches the run cycle on and (with
     * facing 'auto') turns the body toward the direction of travel.
     * @param {object} [o]
     * @param {number}  [o.glide=0]   ms to slide there (CSS transition) — 0 = jump
     * @param {boolean} [o.animate=true] play the run cycle / auto-facing for this move
     */
    moveTo(x, y, { glide = 0, animate = true } = {}) {
      const prev = pos;
      pos = { x, y };
      clearTimeout(glideTimer);
      if (glide > 0) {
        el.style.setProperty('--chr-glide', `${glide}ms`);
        el.classList.add('chr-glide');
        glideTimer = setTimeout(() => el.classList.remove('chr-glide'), glide + 40);
      } else {
        el.classList.remove('chr-glide');
      }
      el.style.left = `${x}%`;
      el.style.top = `${y}%`;
      el.style.zIndex = String(zBase + Math.max(0, Math.min(100, Math.round(y))));
      if (!animate || !prev) return api;
      const dx = x - prev.x;
      const dy = y - prev.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.02 || (d > 20 && glide === 0)) return api;           // still, or a teleport
      if (facing === 'auto') applyView(viewForMotion(dx, dy, view));
      api.setRunning(true, Math.max(260, glide + 80));
      return api;
    },

    /** 'auto' (follow movement) | 'front' | 'left' | 'right' | 'away' */
    setFacing(f) {
      facing = f || 'auto';
      if (facing !== 'auto') applyView(facing);
      return api;
    },

    /** The view currently drawn: 'front' | 'away' | 'left' | 'right'. */
    get facing() { return view; },

    /** Run cycle on/off. `holdMs` turns it off again after that long (0 = until told). */
    setRunning(on, holdMs = 0) {
      clearTimeout(runTimer);
      el.classList.toggle('chr-running', Boolean(on));
      if (on && holdMs > 0) runTimer = setTimeout(() => el.classList.remove('chr-running'), holdMs);
      return api;
    },

    /** Stride length in ms per step: ~300 = run, ~450 = walk. */
    setGait(ms) {
      el.style.setProperty('--chr-gait', `${Math.max(120, Number(ms) || 300)}ms`);
      return api;
    },

    /** null | 'sit' | 'aim' | 'throw' (throw plays once, ~0.45 s). */
    setPose(pose) {
      clearTimeout(poseTimer);
      el.classList.remove('chr-sit', 'chr-aim', 'chr-throw');
      if (pose === 'sit') el.classList.add('chr-sit');
      else if (pose === 'aim') el.classList.add('chr-aim');
      else if (pose === 'throw') {
        void el.offsetWidth;
        el.classList.add('chr-throw');
        poseTimer = setTimeout(() => el.classList.remove('chr-throw'), 500);
      }
      return api;
    },

    /** Boolean flags: self (YOU ring + bigger), highlight (gold ring), offline, faded, speaking. */
    setFlags(flags = {}) {
      Object.entries(flags).forEach(([k, v]) => {
        if (['self', 'highlight', 'offline', 'faded', 'speaking'].includes(k)) el.classList.toggle(`chr-${k}`, Boolean(v));
      });
      return api;
    },

    /** Something held in the throwing hand (a ball…) or carried on the head (a stone…). Node or null. */
    setHandItem(node) { hand.replaceChildren(...(node ? [node] : [])); return api; },
    setHeadItem(node) { hat.replaceChildren(...(node ? [node] : [])); return api; },

    /** 'happy' (double jump, arms up, gold glow) or 'sad' (shake, slump, red glow); optional floating emoji. */
    emote(kind, icon) {
      const cls = kind === 'sad' ? 'chr-sad' : 'chr-happy';
      el.classList.remove('chr-sad', 'chr-happy');
      void el.offsetWidth;                       // restart if already playing
      el.classList.add(cls);
      clearTimeout(emoteTimer);
      emoteTimer = setTimeout(() => el.classList.remove(cls), kind === 'sad' ? 1700 : 1400);
      if (icon) {
        const f = document.createElement('span');
        f.className = `chr-float${kind === 'sad' ? ' sad' : ''}`;
        f.textContent = icon;
        el.appendChild(f);
        f.addEventListener('animationend', () => f.remove(), { once: true });
        setTimeout(() => f.remove(), 2000);
      }
      return api;
    },

    destroy() {
      [runTimer, poseTimer, emoteTimer, glideTimer].forEach(clearTimeout);
      el.remove();
    },
  };

  if (opts.avatarId) api.setAvatar(opts.avatarId);
  else api.setAvatar(null);
  if (opts.jersey) api.setJersey(opts.jersey, opts.jerseyDark);
  if (opts.label) api.setLabel(opts.label);
  return api;
}

/**
 * Which way a character should face for a movement of (dx, dy) on screen:
 *   down the screen → 'front' (walking toward the camera)
 *   up the screen   → 'away'  (back of the head)
 *   sideways        → 'left' / 'right' (side-on stride)
 * The four views each cover a 90° sector. HYSTERESIS: the current view is kept
 * until the new direction is clearly (≈10°) inside another sector, so a walker
 * near a sector edge does not flicker between views.
 */
const VIEW_DIRS = { front: [0, 1], away: [0, -1], left: [-1, 0], right: [1, 0] };
const VIEW_STICKINESS = 0.25;   // in dot-product units ≈ 10° past the 45° sector edge
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
 * screen). Pass the character's current view as `prev` so the hysteresis in
 * viewForMotion keeps it steady.
 */
export function orbitPoint(i, n, phase, { cx = 50, cy = 50, rx = 40, ry = 40, prev = null } = {}) {
  const a = phase + (i * Math.PI * 2) / Math.max(1, n) - Math.PI / 2;
  const vx = -rx * Math.sin(a);                  // clockwise travel direction on screen
  const vy = ry * Math.cos(a);
  return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), facing: viewForMotion(vx, vy, prev) };
}
