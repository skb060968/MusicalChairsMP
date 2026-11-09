/**
 * 2.5D character rig — a small 3D skeleton drawn with flat, code-drawn parts on a
 * Canvas 2D context. SHARED PLATFORM FILE (with avatars.js and characters.js):
 * games normally use the handle in characters.js, not this file directly.
 *
 *   - The skeleton is solved in 3D (hips, knees, ankles, toes, spine, shoulders,
 *     elbows, hands, head), so the character can face any angle and turns smoothly.
 *   - Every part is drawn in code: limbs are outlined capsules, the torso is a
 *     shaded jersey shape, the head is the player's SVG face from avatars.js.
 *   - Animation is keyframe data (joint angles) with smooth interpolation and
 *     crossfades. Feet are kept on the ground ("ground lock"); crouching and
 *     reaching use 2-bone inverse kinematics.
 *   - Locomotion is driven by speed: idle → walk → jog → run → sprint, and the step
 *     rate follows the measured stride so the planted foot does not slide.
 *   - Held poses (sit, aim, crouch) blend over the locomotion; one-shot actions
 *     (throw, pickup, catch, cheer, sad) play on top, whole body or upper body only.
 *
 *   const rig = createRig25d({ avatarId: 'f2', jersey: '#1e88e5' });
 *   rig.setSpeed(120);              // rig units per second (≈ px at scale 1)
 *   rig.faceToward(dx, dy);         // screen direction of travel
 *   rig.hold('sit');                // held until rig.hold(null)
 *   rig.play('throw', { onEvent: (name) => name === 'release' && launchBall() });
 *   // every frame:
 *   rig.update(dt);  rig.draw(ctx, feetX, feetY, scale);
 *
 * Units: 1 rig unit ≈ 1 px at scale 1. The character is about RIG_HEIGHT tall.
 * Angles in pose data are degrees. Yaw 0 = facing the camera, 90 = facing screen
 * right, 180 = facing away, 270 = facing screen left.
 */
import { avatarInfo, avatarSvg, avatarBackSvg } from './avatars.js';

/* ======================= CONSTANTS ======================= */

const D2R = Math.PI / 180;
const PITCH = 20 * D2R;                         // camera looks down at the players this much
const SINP = Math.sin(PITCH);
const COSP = Math.cos(PITCH);
export const CAMERA = Object.freeze({ pitch: PITCH, sin: SINP, cos: COSP });

/** Body dimensions in rig units. */
const DIM = Object.freeze({
  thigh: 12, shin: 11.5, ankleH: 1.9, foot: 5.4,
  hipHW: 3.4, hipDrop: 1.0, waistHW: 5.4, waistHD: 3.3,
  torso: 16.5, shHW: 6.4, shHD: 3.4, shDrop: 1.3,
  upper: 9.2, fore: 8.6, hand: 1.9,
  neckHead: 9.8, headRy: 8.3,
  thighW: 5.6, shinW: 4.4, shoeW: 3.2, upperW: 3.7, foreW: 3.2,
});
const H_STAND = DIM.thigh + DIM.shin + DIM.ankleH + DIM.hipDrop;
/**
 * Radius of a ball held in the hand (rig units ≈ px at scale 1): a 15 px ball, the
 * same size games draw it on the field, so it does not change size when thrown.
 */
export const BALL_RADIUS = 7.5;
export const RIG_HEIGHT = Math.round(H_STAND + DIM.torso + DIM.neckHead + DIM.headRy + 1.5);

/* ======================= SMALL MATH ======================= */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const smoothstep = (a, b, v) => smooth(clamp01((v - a) / (b - a)));
const angDiff = (to, from) => ((((to - from) % 360) + 540) % 360) - 180;
const lerpAng = (a, b, t) => a + angDiff(b, a) * t;
const norm360 = (a) => ((a % 360) + 360) % 360;

// Vectors are [s, u, f] in the character's frame: s = character's right,
// u = up, f = forward (the way the character faces).
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const addS = (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
/** The spine, leaning forward by angle l (radians). */
const dirUp = (l) => [0, Math.cos(l), Math.sin(l)];
/**
 * Limb direction: spread outward to its own side by `ab`, then swung forward by
 * `a` (radians; side = +1 right, -1 left). Spreading first keeps a raised arm
 * outside the head instead of crossing over it.
 */
function limbDir(a, ab, side) {
  const cb = Math.cos(ab);
  return [side * Math.sin(ab), -cb * Math.cos(a), cb * Math.sin(a)];
}
/** Turn around the vertical axis; positive = toward the character's right. */
function yawV(v, y) {
  const c = Math.cos(y);
  const s = Math.sin(y);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

/**
 * Two-bone IK in the sagittal plane. (du, df) = target relative to the root
 * joint. Returns the first bone's swing `a` and the bend `k` (radians).
 * Legs bend the knee forward (a = α + β); arms bend the elbow back (a = α − β).
 */
function ik2(du, df, l1, l2, kneeForward) {
  const d = clamp(Math.hypot(du, df), 0.001, (l1 + l2) * 0.9995);
  const alpha = Math.atan2(df, -du);
  const beta = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
  const bend = Math.PI - Math.acos(clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
  return { a: kneeForward ? alpha + beta : alpha - beta, k: bend };
}

/* ======================= POSES ======================= */

const PARAMS = [
  'lift', 'fwd', 'lean', 'hipYaw', 'twist', 'headPitch', 'headYaw',
  'hipL', 'kneeL', 'footL', 'abdL', 'hipR', 'kneeR', 'footR', 'abdR',
  'shL', 'shAbdL', 'elbL', 'aimL', 'armYawL', 'shR', 'shAbdR', 'elbR', 'aimR', 'armYawR',
  'crouch', 'reach',
];
const LINEAR = new Set(['lift', 'fwd', 'aimL', 'aimR', 'crouch', 'reach']);
const IS_LIN = PARAMS.map((p) => LINEAR.has(p));

/**
 * hip/knee: thigh swing forward / knee bend. foot: sole pitch, + = toes up.
 * abd: leg spread. sh: arm swing forward (−150 = up behind, −180 = straight up).
 * elb: elbow bend. shAbd: arm out to the side. aim: 1 = the arm swings in the
 * plane of the facing direction instead of following the twisted shoulders
 * (overarm throws). lean: spine forward. twist: shoulders vs hips.
 * crouch / reach: 0..1 weights for the squat IK and the right-hand ground reach.
 */
const DEFAULT_POSE = Object.freeze({
  lift: 0, fwd: 0, lean: 3, hipYaw: 0, twist: 0, headPitch: 0, headYaw: 0,
  hipL: 1, kneeL: 4, footL: 0, abdL: 3, hipR: 1, kneeR: 4, footR: 0, abdR: 3,
  shL: 2, shAbdL: 9, elbL: 12, aimL: 0, armYawL: 0,
  shR: 2, shAbdR: 9, elbR: 12, aimR: 0, armYawR: 0,
  crouch: 0, reach: 0,
});

function copyPose(out, src) {
  for (let i = 0; i < PARAMS.length; i += 1) out[PARAMS[i]] = src[PARAMS[i]];
  return out;
}
function blendPose(out, a, b, w) {
  for (let i = 0; i < PARAMS.length; i += 1) {
    const p = PARAMS[i];
    out[p] = IS_LIN[i] ? lerp(a[p], b[p], w) : lerpAng(a[p], b[p], w);
  }
  return out;
}

/* ======================= KEYFRAME CHANNELS ======================= */

/**
 * Sample a channel [[t, v], ...] (t in 0..1) with a cubic Hermite curve.
 * Tangents are zeroed at peaks and flat stretches, so holds don't overshoot.
 * Looping channels must start at t = 0.
 */
function sampleCh(ch, t, loop) {
  const n = ch.length;
  if (n === 1) return ch[0][1];
  if (loop) t -= Math.floor(t);
  else {
    if (t <= ch[0][0]) return ch[0][1];
    if (t >= ch[n - 1][0]) return ch[n - 1][1];
  }
  let i = n - 1;
  for (let j = 0; j < n - 1; j += 1) if (t < ch[j + 1][0]) { i = j; break; }
  const key = (m) => {
    if (loop) {
      const w = Math.floor(m / n);
      const r = m - w * n;
      return [ch[r][0] + w, ch[r][1]];
    }
    return ch[clamp(m, 0, n - 1)];
  };
  const p0 = key(i - 1);
  const p1 = key(i);
  const p2 = key(i + 1);
  const p3 = key(i + 2);
  const h = p2[0] - p1[0];
  if (h <= 0) return p1[1];
  const d1 = (p2[1] - p1[1]) / h;
  const d0 = p1[0] > p0[0] ? (p1[1] - p0[1]) / (p1[0] - p0[0]) : d1;
  const d2 = p3[0] > p2[0] ? (p3[1] - p2[1]) / (p3[0] - p2[0]) : d1;
  const tangent = (a, b) => {
    if (a * b <= 0) return 0;
    const m = (a + b) / 2;
    const lim = 3 * Math.min(Math.abs(a), Math.abs(b));
    return clamp(m, -lim, lim);
  };
  const m1 = tangent(d0, d1);
  const m2 = tangent(d1, d2);
  const s = (t - p1[0]) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * p1[1] + (s3 - 2 * s2 + s) * h * m1
    + (-2 * s3 + 3 * s2) * p2[1] + (s3 - s2) * h * m2;
}

/* ======================= LOCOMOTION (gait cycles) ======================= */

/*
 * A gait is described for the RIGHT leg and RIGHT arm over one cycle
 * (phase 0 = right foot touches down). The left side plays the same curves
 * half a cycle later. Body channels (lift, hip yaw, twist) use the phase as is.
 */
const WALK = {
  leg: {
    hip:  [[0, 28], [0.1, 24], [0.3, 6], [0.5, -18], [0.6, -16], [0.73, 10], [0.88, 30]],
    knee: [[0, 3], [0.1, 15], [0.3, 5], [0.5, 8], [0.6, 38], [0.73, 62], [0.88, 12]],
    foot: [[0, 16], [0.1, 0], [0.3, 0], [0.5, -8], [0.6, -34], [0.73, -8], [0.88, 8]],
  },
  arm: { sh: [[0, -20], [0.5, 22]], elb: [[0, 14], [0.5, 30]] },
  body: { hipYaw: [[0, -5], [0.5, 5]], twist: [[0, 10], [0.5, -10]] },
  fixed: { lean: 4, abdL: 3, abdR: 3, shAbdL: 8, shAbdR: 8, headPitch: 0 },
};

/* Running: stance 0–0.30, flight 0.30–0.50 (then the left leg). */
const RUN = {
  leg: {
    hip:  [[0, 34], [0.08, 22], [0.18, 2], [0.3, -28], [0.42, -18], [0.55, 4], [0.7, 48], [0.85, 54], [0.94, 42]],
    knee: [[0, 14], [0.08, 34], [0.18, 30], [0.3, 14], [0.42, 72], [0.55, 112], [0.7, 96], [0.85, 46], [0.94, 18]],
    foot: [[0, 6], [0.08, 0], [0.18, -4], [0.3, -40], [0.42, -42], [0.55, -25], [0.7, -5], [0.85, 4], [0.94, 8]],
  },
  arm: {
    sh:  [[0, -48], [0.25, -6], [0.5, 52], [0.75, 6]],
    elb: [[0, 105], [0.25, 85], [0.5, 100], [0.75, 85]],
  },
  body: {
    lift:   [[0, 0], [0.3, 0], [0.4, 2.6], [0.5, 0], [0.8, 0], [0.9, 2.6]],
    hipYaw: [[0, -9], [0.5, 9]],
    twist:  [[0, 18], [0.5, -18]],
  },
  fixed: { lean: 15, headPitch: -6, abdL: 4, abdR: 4, shAbdL: 12, shAbdR: 12 },
};

/* Sprinting: short stance (0–0.22), long flight, high knee drive, big arm pump. */
const SPRINT = {
  leg: {
    hip:  [[0, 38], [0.06, 24], [0.14, 0], [0.22, -36], [0.34, -22], [0.46, 10], [0.62, 72], [0.78, 64], [0.9, 46]],
    knee: [[0, 16], [0.06, 36], [0.14, 30], [0.22, 16], [0.34, 92], [0.46, 132], [0.62, 112], [0.78, 42], [0.9, 18]],
    foot: [[0, 4], [0.06, 0], [0.14, -6], [0.22, -46], [0.34, -46], [0.46, -30], [0.62, -6], [0.78, 6], [0.9, 6]],
  },
  arm: {
    sh:  [[0, -62], [0.25, -10], [0.5, 72], [0.75, 10]],
    elb: [[0, 112], [0.25, 80], [0.5, 96], [0.75, 80]],
  },
  body: {
    lift:   [[0, 0], [0.22, 0], [0.36, 4.5], [0.5, 0], [0.72, 0], [0.86, 4.5]],
    hipYaw: [[0, -10], [0.5, 10]],
    twist:  [[0, 20], [0.5, -20]],
  },
  fixed: { lean: 18, headPitch: -8, abdL: 4, abdR: 4, shAbdL: 13, shAbdR: 13 },
};

/** A jog is a smaller run: shorter swings, less flight, less lean. */
function scaleGait(g, f, fixed) {
  const sc = (ch, fn) => ch.map(([t, v]) => [t, fn(v)]);
  return {
    leg: {
      hip: sc(g.leg.hip, (v) => v * f),
      knee: sc(g.leg.knee, (v) => 8 + (v - 8) * f),
      foot: sc(g.leg.foot, (v) => v * f),
    },
    arm: { sh: sc(g.arm.sh, (v) => v * f), elb: sc(g.arm.elb, (v) => v) },
    body: {
      lift: sc(g.body.lift, (v) => v * f * 0.6),
      hipYaw: sc(g.body.hipYaw, (v) => v * f),
      twist: sc(g.body.twist, (v) => v * f),
    },
    fixed: { ...g.fixed, ...fixed },
  };
}
const JOG = scaleGait(RUN, 0.66, { lean: 8, headPitch: -3 });
[WALK, JOG, RUN, SPRINT].forEach((g) => { g.bodyKeys = Object.keys(g.body); });

function sampleGait(g, p, out) {
  Object.assign(out, DEFAULT_POSE, g.fixed);
  const pl = p + 0.5;
  out.hipR = sampleCh(g.leg.hip, p, true);
  out.kneeR = sampleCh(g.leg.knee, p, true);
  out.footR = sampleCh(g.leg.foot, p, true);
  out.hipL = sampleCh(g.leg.hip, pl, true);
  out.kneeL = sampleCh(g.leg.knee, pl, true);
  out.footL = sampleCh(g.leg.foot, pl, true);
  out.shR = sampleCh(g.arm.sh, p, true);
  out.elbR = sampleCh(g.arm.elb, p, true);
  out.shL = sampleCh(g.arm.sh, pl, true);
  out.elbL = sampleCh(g.arm.elb, pl, true);
  for (let i = 0; i < g.bodyKeys.length; i += 1) {
    const k = g.bodyKeys[i];
    out[k] = sampleCh(g.body[k], p, true);
  }
  return out;
}

/* ======================= ACTIONS (one-shot clips) ======================= */

/*
 * Keys are cumulative: each key starts from the previous one and overrides
 * only what it lists. t is 0..1 of the clip; events fire at their t.
 */
const ACTION_DEFS = {
  idle: {
    dur: 3.6, loop: true,
    keys: [
      [0, { lean: 3, hipL: 2, hipR: 2, kneeL: 5, kneeR: 5, shAbdL: 9, shAbdR: 9, elbL: 12, elbR: 12, headYaw: 0 }],
      [0.3, { headYaw: 7 }],
      [0.5, { lean: 4.2, hipL: 3, hipR: 3, kneeL: 7, kneeR: 7, shAbdL: 10.5, shAbdR: 10.5, elbL: 15, elbR: 15 }],
      [0.72, { headYaw: -5 }],
    ],
  },

  /* Overarm throw (right-handed): set, side-on wind-up, release over the top, follow-through. */
  throw: {
    dur: 1.0, events: { release: 0.5 },
    keys: [
      [0, { shR: 35, elbR: 95, shAbdR: 14, shL: 25, elbL: 70, hipL: 4, kneeL: 8, hipR: -3, kneeR: 8, lean: 5 }],
      [0.32, {
        hipYaw: 55, twist: 30, lean: -8, fwd: -2, headPitch: -4,
        aimR: 1, shR: -150, shAbdR: 18, elbR: 12,
        aimL: 1, shL: 85, shAbdL: 12, elbL: 15,
        hipL: 10, abdL: 20, kneeL: 22, hipR: -8, abdR: 14, kneeR: 16,
      }],
      [0.5, {
        hipYaw: 5, twist: -20, lean: 18, fwd: 3, headPitch: 4,
        shR: -205, shAbdR: 14, elbR: 6,
        aimL: 0, shL: -30, shAbdL: 30, elbL: 90,
        hipL: 28, abdL: 5, kneeL: 14, footL: 4, hipR: -26, abdR: 6, kneeR: 24, footR: -30,
      }],
      [0.68, {
        hipYaw: -15, twist: -30, lean: 28, fwd: 4,
        aimR: 0.5, armYawR: -20, shR: -290, shAbdR: 12, elbR: 25,
        shL: -35, shAbdL: 20, elbL: 100,
        hipL: 26, kneeL: 26, hipR: -32, kneeR: 50, footR: -50,
      }],
      [1, {
        hipYaw: 0, twist: 0, lean: 6, fwd: 0, headPitch: 0,
        aimR: 0, armYawR: 0, shR: -350, shAbdR: 10, elbR: 18,
        shL: 4, shAbdL: 10, elbL: 18,
        hipL: 4, abdL: 4, kneeL: 6, footL: 0, hipR: -2, abdR: 4, kneeR: 6, footR: 0,
      }],
    ],
  },

  /* Squat down (feet planted by IK), right hand reaches the ground, stand up. */
  pickup: {
    dur: 1.25, events: { grab: 0.5 },
    keys: [
      [0, {}],
      [0.38, { crouch: 1, reach: 1, lean: 55, headPitch: 20, shL: 35, elbL: 45, shAbdL: 14 }],
      [0.62, {}],
      [1, { crouch: 0, reach: 0, lean: 4, headPitch: 0, shL: 2, elbL: 12, shAbdL: 9 }],
    ],
  },

  /* Two jumps with both arms up. */
  cheer: {
    dur: 1.5,
    keys: [
      [0, {}],
      [0.12, { hipL: 28, kneeL: 50, hipR: 28, kneeR: 50, lean: 14, shL: -20, shR: -20, elbL: 60, elbR: 60 }],
      [0.3, {
        lift: 10, hipL: 12, kneeL: 24, hipR: 12, kneeR: 24, footL: -20, footR: -20, lean: -4, headPitch: -12,
        shL: -170, shR: -170, shAbdL: 22, shAbdR: 22, elbL: 8, elbR: 8,
      }],
      [0.46, { lift: 0, hipL: 24, kneeL: 44, hipR: 24, kneeR: 44, footL: 0, footR: 0, lean: 10 }],
      [0.62, { lift: 7, hipL: 10, kneeL: 20, hipR: 10, kneeR: 20, footL: -18, footR: -18, lean: -2, elbL: 40, elbR: 40 }],
      [0.78, { lift: 0, hipL: 18, kneeL: 30, hipR: 18, kneeR: 30, footL: 0, footR: 0, lean: 6, elbL: 10, elbR: 10 }],
      [1, {
        hipL: 1, kneeL: 4, hipR: 1, kneeR: 4, lean: 3, headPitch: 0,
        shL: 2, shR: 2, shAbdL: 9, shAbdR: 9, elbL: 12, elbR: 12,
      }],
    ],
  },

  /* Catch: both hands reach toward the ball, then pull it in to the chest. */
  catch: {
    dur: 0.7, events: { catch: 0.4 },
    keys: [
      [0, {}],
      [0.35, {
        shL: 72, shR: 72, elbL: 22, elbR: 22, shAbdL: 15, shAbdR: 15, lean: 10, headPitch: 6,
        hipL: 9, hipR: 9, kneeL: 16, kneeR: 16,
      }],
      [0.62, { shL: 34, shR: 34, elbL: 100, elbR: 100, shAbdL: 12, shAbdR: 12, lean: 6, headPitch: 2 }],
      [1, {
        shL: 2, shR: 2, elbL: 12, elbR: 12, shAbdL: 9, shAbdR: 9, lean: 3, headPitch: 0,
        hipL: 1, hipR: 1, kneeL: 4, kneeR: 4,
      }],
    ],
  },

  /* Slump: head down, shoulders forward, arms hanging. */
  sad: {
    dur: 1.8,
    keys: [
      [0, {}],
      [0.25, {
        lean: 20, headPitch: 30, shL: 6, shR: 6, shAbdL: 4, shAbdR: 4, elbL: 6, elbR: 6,
        kneeL: 12, kneeR: 12, hipL: 8, hipR: 8,
      }],
      [0.8, {}],
      [1, {
        lean: 3, headPitch: 0, shL: 2, shR: 2, shAbdL: 9, shAbdR: 9, elbL: 12, elbR: 12,
        kneeL: 4, kneeR: 4, hipL: 1, hipR: 1,
      }],
    ],
  },
};

function compileAction(def) {
  let cur = { ...DEFAULT_POSE };
  const full = def.keys.map(([t, spec]) => { cur = { ...cur, ...spec }; return [t, cur]; });
  const channels = {};
  PARAMS.forEach((p) => {
    const ch = full.map(([t, pose]) => [t, pose[p]]);
    channels[p] = ch.every(([, v]) => v === ch[0][1]) ? [[0, ch[0][1]]] : ch;
  });
  return {
    dur: def.dur,
    loop: Boolean(def.loop),
    events: Object.entries(def.events || {}),
    channels,
  };
}
const ACTIONS = Object.fromEntries(Object.entries(ACTION_DEFS).map(([k, d]) => [k, compileAction(d)]));
const IDLE = ACTIONS.idle;
export const ACTION_NAMES = Object.freeze(Object.keys(ACTIONS).filter((k) => k !== 'idle'));

function sampleAction(c, t, out) {
  for (let i = 0; i < PARAMS.length; i += 1) out[PARAMS[i]] = sampleCh(c.channels[PARAMS[i]], t, c.loop);
  return out;
}

/** Parameters an upper-body action may change (legs keep walking / sitting). */
const UPPER = [
  'lean', 'twist', 'headPitch', 'headYaw',
  'shL', 'shAbdL', 'elbL', 'aimL', 'armYawL', 'shR', 'shAbdR', 'elbR', 'aimR', 'armYawR',
];

/* ======================= HELD POSES ======================= */

/** The full pose at key `index` of an action definition (keys are cumulative). */
function keyPose(def, index) {
  let cur = { ...DEFAULT_POSE };
  for (let i = 0; i <= index; i += 1) cur = { ...cur, ...def.keys[i][1] };
  return cur;
}

/* Poses that are held until released, blended over the locomotion. */
const HOLDS = {
  /* On a chair, seen from any side: thighs level, shins down, hands on the knees. */
  sit: {
    ...DEFAULT_POSE,
    lean: 5, headPitch: 2, hipL: 86, hipR: 86, kneeL: 88, kneeR: 88, footL: 0, footR: 0, abdL: 9, abdR: 9,
    shL: 36, shR: 36, shAbdL: 12, shAbdR: 12, elbL: 44, elbR: 44,
  },
  /* Ready to throw: the wind-up of the throw clip, frozen. */
  aim: keyPose(ACTION_DEFS.throw, 1),
  /* Low ready stance (fielding, hiding). */
  crouch: {
    ...DEFAULT_POSE,
    crouch: 0.75, lean: 32, headPitch: -14, shL: 42, shR: 42, elbL: 55, elbR: 55, shAbdL: 16, shAbdR: 16,
  },
};
export const HOLD_NAMES = Object.freeze(Object.keys(HOLDS));

/* Carrying something in both hands (setCarryItem): arms only, so the legs keep
   walking / running underneath. Forearms point forward, hands at belly height. */
const ARM_PARAMS = ['shL', 'shAbdL', 'elbL', 'aimL', 'armYawL', 'shR', 'shAbdR', 'elbR', 'aimR', 'armYawR'];
const CARRY_ARMS = Object.freeze({
  shL: 24, shAbdL: 7, elbL: 74, aimL: 0, armYawL: 0,
  shR: 24, shAbdR: 7, elbR: 74, aimR: 0, armYawR: 0,
});
const HOLD_BLEND_S = 0.28;
const GAIT_ORDER = ['walk', 'jog', 'run', 'sprint'];

/* ======================= SKELETON ======================= */

const LEG_KEYS = [
  { side: 1, hip: 'hipR', knee: 'kneeR', foot: 'footR', abd: 'abdR', stagger: -2.2 },
  { side: -1, hip: 'hipL', knee: 'kneeL', foot: 'footL', abd: 'abdL', stagger: 2.6 },
];
const ARM_KEYS = [
  { side: 1, sh: 'shR', elb: 'elbR', abd: 'shAbdR', aim: 'aimR', yaw: 'armYawR' },
  { side: -1, sh: 'shL', elb: 'elbL', abd: 'shAbdL', aim: 'aimL', yaw: 'armYawL' },
];
const LEG_POINTS = ['hip', 'knee', 'ankle', 'heel', 'toe', 'shoeA', 'shoeB'];
const REACH_TARGET = [3, 2.3, 12];      // where the right hand picks things up (in front of the feet)

function makeJoints() {
  return { legs: [{}, {}], arms: [{}, {}], P: null, C: null, Hc: null, y1: 0, y2: 0, fwd: 0, lift: 0 };
}

/** Pose → joint positions in the character frame (ground at u = 0). */
function solve(p, j) {
  const y1 = p.hipYaw * D2R;
  const y2 = (p.hipYaw + p.twist) * D2R;
  const cw = clamp01(p.crouch);
  const ikW = clamp01(cw * 4);
  const fwd = p.fwd - 3 * cw;

  // Legs, with the pelvis at height 0 for now.
  let minU = Infinity;
  for (let i = 0; i < 2; i += 1) {
    const K = LEG_KEYS[i];
    const L = j.legs[i];
    const side = K.side;
    let a = p[K.hip] * D2R;
    let k = p[K.knee] * D2R;
    let fp = p[K.foot] * D2R;
    let ab = p[K.abd] * D2R;
    if (ikW > 0) {
      const h = H_STAND * (1 - 0.58 * cw);
      const s = ik2(-h + DIM.ankleH + DIM.hipDrop, K.stagger - fwd, DIM.thigh, DIM.shin, true);
      a = lerp(a, s.a, ikW);
      k = lerp(k, s.k, ikW);
      fp = lerp(fp, 0, ikW);
      ab = lerp(ab, 11 * D2R, cw);
    }
    const hip = add(yawV([side * DIM.hipHW, -DIM.hipDrop, 0], y1), [0, 0, fwd]);
    const knee = addS(hip, yawV(limbDir(a, ab, side), y1), DIM.thigh);
    const shinDir = yawV(limbDir(a - k, ab, side), y1);
    const ankle = addS(knee, shinDir, DIM.shin);
    const cf = Math.cos(fp);
    const sf = Math.sin(fp);
    const fpt = (f, u) => add(ankle, yawV([0, f * sf + u * cf, f * cf - u * sf], y1));
    L.hip = hip;
    L.knee = knee;
    L.ankle = ankle;
    L.shinDir = shinDir;
    L.heel = fpt(-1.3, -DIM.ankleH);
    L.toe = fpt(DIM.foot - 0.6, -DIM.ankleH);
    L.shoeA = fpt(-0.1, -0.3);
    L.shoeB = fpt(DIM.foot - 1.6, -0.3);
    minU = Math.min(minU, L.heel[1], L.toe[1]);
  }

  // Ground lock: the lowest sole point touches the ground, then jumps/flight lift.
  const off = -minU + Math.max(0, p.lift);
  for (let i = 0; i < 2; i += 1) {
    const L = j.legs[i];
    for (let q = 0; q < LEG_POINTS.length; q += 1) L[LEG_POINTS[q]][1] += off;
  }

  // Spine and head.
  const P = [0, off, fwd];
  const C = addS(P, yawV(dirUp(p.lean * D2R), y1), DIM.torso);
  const Hc = addS(C, yawV(dirUp(p.lean * 0.4 * D2R), y1), DIM.neckHead);

  // Arms.
  for (let i = 0; i < 2; i += 1) {
    const K = ARM_KEYS[i];
    const A = j.arms[i];
    const side = K.side;
    const S = add(C, yawV([side * DIM.shHW, -DIM.shDrop, 0], y2));
    let sh = p[K.sh] * D2R;
    let el = p[K.elb] * D2R;
    let ab = p[K.abd] * D2R;
    const ay = y2 * (1 - clamp01(p[K.aim])) + p[K.yaw] * D2R;
    if (side > 0 && p.reach > 0) {
      const rw = clamp01(p.reach);
      const s = ik2(REACH_TARGET[1] - S[1], REACH_TARGET[2] - S[2], DIM.upper, DIM.fore, false);
      sh = lerp(sh, s.a, rw);
      el = lerp(el, s.k, rw);
      ab = lerp(ab, 6 * D2R, rw);
    }
    const E = addS(S, yawV(limbDir(sh, ab, side), ay), DIM.upper);
    const fd = yawV(limbDir(sh + el, ab, side), ay);
    A.S = S;
    A.E = E;
    A.H = addS(E, fd, DIM.fore);
    A.fd = fd;
  }

  j.P = P;
  j.C = C;
  j.Hc = Hc;
  j.y1 = y1;
  j.y2 = y2;
  j.fwd = fwd;
  j.lift = Math.max(0, p.lift);
  return j;
}

/**
 * Distance travelled per gait cycle, measured from the skeleton: how far the
 * planted foot moves backward under the body. Playing the cycle at
 * speed / stride keeps that foot still on the ground.
 */
function measureStride(g) {
  const pose = {};
  const j = makeJoints();
  const N = 240;
  let dist = 0;
  let prevFoot = -1;
  let prevF = 0;
  for (let i = 0; i <= N; i += 1) {
    solve(sampleGait(g, i / N, pose), j);
    const low = (L) => Math.min(L.heel[1], L.toe[1]);
    const foot = low(j.legs[0]) <= low(j.legs[1]) ? 0 : 1;
    const f = j.legs[foot].ankle[2];
    if (foot === prevFoot && f < prevF) dist += prevF - f;
    prevFoot = foot;
    prevF = f;
  }
  return dist;
}
export const STRIDE = Object.freeze({
  walk: measureStride(WALK), jog: measureStride(JOG), run: measureStride(RUN), sprint: measureStride(SPRINT),
});

/* Speed thresholds between the gaits (rig units per second). */
const GAIT_TH = (() => {
  const jogA = STRIDE.walk * 1.15;
  const jogB = Math.max(jogA + 4, STRIDE.jog * 1.25);
  const runA = Math.max(jogB + 4, STRIDE.jog * 1.6);
  const runB = Math.max(runA + 4, STRIDE.run * 1.6);
  const sprintA = Math.max(runB + 4, STRIDE.run * 2.1);
  const sprintB = Math.max(sprintA + 4, STRIDE.sprint * 1.25);
  return { jogA, jogB, runA, runB, sprintA, sprintB };
})();
export const GAIT_SPEEDS = Object.freeze({
  walk: Math.round(STRIDE.walk * 1.0),
  jog: Math.round((GAIT_TH.jogB + GAIT_TH.runA) / 2),
  run: Math.round((GAIT_TH.runB + GAIT_TH.sprintA) / 2),
  sprint: Math.round(Math.max(GAIT_TH.sprintB, STRIDE.sprint * 1.6)),
});

/* ======================= COLOURS & FACES ======================= */

function shade(hex, amt) {
  const n = Number.parseInt(String(hex).replace('#', ''), 16);
  if (!Number.isFinite(n)) return hex;
  const ch = (s) => {
    const c = (n >> s) & 255;
    return Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt);
  };
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

/** Faces are rasterised once per avatar (front + back, large + small). */
const FACE_CACHE = new Map();
function rasterize(svg, pxPerUnit, done) {
  const w = Math.round(40 * pxPerUnit);
  const h = Math.round(44 * pxPerUnit);
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const img = new Image();
  img.onload = () => { cv.getContext('2d').drawImage(img, 0, 0, w, h); done(); };
  img.onerror = done;
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace('<svg ', `<svg width="${w}" height="${h}" `))}`;
  return cv;
}
function faceArt(id) {
  const key = avatarInfo(id).id;
  let art = FACE_CACHE.get(key);
  if (art) return art;
  art = { ready: false };
  let pending = 4;
  const done = () => { pending -= 1; if (pending === 0) art.ready = true; };
  art.front = rasterize(avatarSvg(key), 5, done);
  art.back = rasterize(avatarBackSvg(key), 5, done);
  art.frontS = rasterize(avatarSvg(key), 1.6, done);
  art.backS = rasterize(avatarBackSvg(key), 1.6, done);
  FACE_CACHE.set(key, art);
  return art;
}

/* ======================= DRAWING HELPERS ======================= */

function seg(ctx, a, b, w) {
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
}
function dot(ctx, a, r) {
  ctx.beginPath();
  ctx.arc(a[0], a[1], Math.max(0.1, r), 0, Math.PI * 2);
  ctx.fill();
}
const mix2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/* ======================= THE RIG ======================= */

const SCRATCH = { idle: {}, g1: {}, g2: {}, loco: {}, base: {}, act: {}, mix: {} };

class Rig25d {
  constructor({ avatarId = null, jersey = '#e53935', jerseyDark = null } = {}) {
    this.yaw = 0;
    this.targetYaw = 0;
    this.turnRate = 600;              // degrees per second
    this.speed = 0;                   // requested
    this.speedNow = 0;                // smoothed
    this.phase = Math.random();
    this.idleT = Math.random() * IDLE.dur;
    this.action = null;
    this.actionName = null;
    this.actT = 0;
    this.onEvent = null;
    this.fade = null;
    this.pose = { ...DEFAULT_POSE };
    this.fadeFrom = { ...DEFAULT_POSE };
    this.j = solve(this.pose, makeJoints());
    this.actRate = 1;
    this.actMask = null;
    this.holdName = null;
    this.holdPose = null;
    this.holdW = 0;
    this.gaitCap = null;              // null | 'walk' | 'jog' | 'run' (fastest gait allowed)
    this.idleMotion = true;           // breathing / glancing while standing
    this.shadow = true;               // draw the ground shadow (off when the host draws its own)
    this.handItem = null;
    this.headItem = null;
    this.carryItem = null;
    this.carryW = 0;
    /** Last drawn positions (same px space as draw()): throwing hand, top of the head. */
    this.hand = { x: 0, y: 0 };
    this.headTop = { x: 0, y: 0 };
    this.col = { outline: 'rgba(28, 18, 12, 0.88)', shorts: '#2f2622', shortsFar: '#231b18',
      sock: '#f1f1f1', sockFar: '#cfcfcf', shoe: '#2a2a2a', shoeFar: '#1b1b1b' };
    this.setAvatar(avatarId);
    this.setJersey(jersey, jerseyDark);
  }

  setAvatar(id) {
    const info = avatarInfo(id);
    this.avatarId = info.id;
    this.face = faceArt(info.id);
    this.col.skin = info.skin;
    this.col.skinFar = shade(info.skin, -0.14);
    return this;
  }

  setJersey(color, dark) {
    if (!color) return this;
    this.col.jersey = color;
    this.col.jerseyDark = dark || shade(color, -0.3);
    this.col.jerseyLight = shade(color, 0.18);
    this.col.jerseyFar = shade(color, -0.2);
    return this;
  }

  /** Facing angle in degrees (0 front, 90 screen right, 180 away, 270 left). */
  setYaw(deg, { instant = false } = {}) {
    this.targetYaw = norm360(deg);
    if (instant) this.yaw = this.targetYaw;
    return this;
  }

  /** Face a direction on screen (dx right, dy down the screen = toward the camera). */
  faceToward(dx, dy, opts) {
    if (!dx && !dy) return this;
    return this.setYaw(Math.atan2(dx, dy) / D2R, opts);
  }

  /** Ground speed in rig units per second; picks idle / walk / jog / run. */
  setSpeed(unitsPerSec) {
    this.speed = Math.max(0, Number(unitsPerSec) || 0);
    return this;
  }

  /**
   * One-shot action: 'throw' | 'pickup' | 'catch' | 'cheer' | 'sad'.
   * @param {object} [o]
   * @param {Function} [o.onEvent] (name, rig) at 'release' (throw), 'grab' (pickup), 'catch'
   * @param {number} [o.from=0]   start part-way through (0..1), e.g. a throw from the wind-up
   * @param {number} [o.rate=1]   playback speed
   * @param {'upper'|null} [o.mask] 'upper' = arms, head and spine only; the legs keep
   *   walking / sitting underneath
   */
  play(name, { onEvent = null, from = 0, rate = 1, mask = null } = {}) {
    const c = ACTIONS[name];
    if (!c || c === IDLE) return this;
    this._startFade(0.12);
    this.action = c;
    this.actionName = name;
    this.actT = clamp01(from) * c.dur;
    this.actRate = clamp(Number(rate) || 1, 0.1, 5);
    this.actMask = mask === 'upper' ? 'upper' : null;
    this.onEvent = onEvent;
    return this;
  }

  stop() {
    if (!this.action) return this;
    this._startFade(0.2);
    this.action = null;
    this.actionName = null;
    return this;
  }

  /** Hold a pose until released: 'sit' | 'aim' | 'crouch' | null (back to moving / standing). */
  hold(name) {
    const pose = name ? HOLDS[name] : null;
    if (pose) {
      if (this.holdName && this.holdName !== name && this.holdW > 0) this._startFade(0.2);
      this.holdPose = pose;
      this.holdName = name;
    } else {
      this.holdName = null;          // holdPose stays while it blends out
    }
    return this;
  }

  /** Fastest gait to use: 'walk' | 'jog' | 'run' | null (any, chosen from the speed). */
  setGaitCap(cap) {
    this.gaitCap = GAIT_ORDER.includes(cap) ? cap : null;
    return this;
  }

  /** True when nothing is changing except the slow idle loop (the host may draw less often). */
  isSettled() {
    return !this.action && !this.fade && this.speed === 0 && this.speedNow < 0.2
      && (this.holdW === 0 || this.holdW === 1) && (this.carryW === 0 || this.carryW === 1)
      && Math.abs(angDiff(this.targetYaw, this.yaw)) < 0.5;
  }

  /** 'ball' or null (right hand). */
  setHandItem(item) { this.handItem = item || null; return this; }
  /** 'stone' or null (balanced on the head). */
  setHeadItem(item) { this.headItem = item || null; return this; }

  /**
   * A slab carried in both hands in front of the body, or null. Sizes in rig units:
   * { w (width), d (depth, default 0.75 w), t (thickness), top: [c1, c2], side: [c1, c2] }.
   * The arms take the carry pose; the legs keep moving.
   */
  setCarryItem(item) {
    this.carryItem = item && Number(item.w) > 0 ? { d: item.w * 0.75, t: 3, ...item } : null;
    return this;
  }

  /**
   * Jump straight to one moment, without blending (previews / pose sheets):
   * the gait for `speed` at cycle `phase`, or `action` at clip time t (0..1).
   */
  seek({ speed = 0, phase = 0, action = null, t = 0, idleT = 0 } = {}) {
    this.speed = speed;
    this.speedNow = speed;
    this.phase = phase - Math.floor(phase);
    this.idleT = idleT;
    this.fade = null;
    this.action = null;
    this.actionName = null;
    this.yaw = this.targetYaw;
    this.holdW = this.holdName ? 1 : 0;
    this.carryW = this.carryItem ? 1 : 0;
    const c = action ? ACTIONS[action] : null;
    if (c && c !== IDLE) {
      this.action = c;
      this.actionName = action;
      this.actT = clamp01(t) * c.dur - 1e-6;
      this.actRate = 1;
      this.actMask = null;
      this.onEvent = null;
    }
    return this.update(0);
  }

  _startFade(dur) {
    copyPose(this.fadeFrom, this.pose);
    this.fade = { t: 0, dur };
  }

  update(dt) {
    dt = clamp(dt, 0, 0.1);

    // Turning toward the requested facing.
    const diff = angDiff(this.targetYaw, this.yaw);
    const step = this.turnRate * dt;
    this.yaw = norm360(this.yaw + clamp(diff, -step, step));

    // Locomotion blend from the smoothed speed.
    this.speedNow += (this.speed - this.speedNow) * Math.min(1, dt * 9);
    const sp = this.speedNow;
    const cap = this.gaitCap ? GAIT_ORDER.indexOf(this.gaitCap) : 3;
    const wMove = smoothstep(1.5, 10, sp);
    const wJog = cap >= 1 ? smoothstep(GAIT_TH.jogA, GAIT_TH.jogB, sp) : 0;
    const wRun = cap >= 2 ? smoothstep(GAIT_TH.runA, GAIT_TH.runB, sp) : 0;
    const wSprint = cap >= 3 ? smoothstep(GAIT_TH.sprintA, GAIT_TH.sprintB, sp) : 0;
    const stride = lerp(lerp(lerp(STRIDE.walk, STRIDE.jog, wJog), STRIDE.run, wRun), STRIDE.sprint, wSprint);
    if (sp > 0.05) this.phase = (this.phase + (sp * dt) / stride) % 1;
    if (this.idleMotion) this.idleT += dt;

    const S = SCRATCH;
    let loco = sampleAction(IDLE, this.idleT / IDLE.dur, S.idle);
    if (wMove > 0) {
      let gait = sampleGait(WALK, this.phase, S.g1);
      if (wJog > 0) gait = blendPose(S.g1, gait, sampleGait(JOG, this.phase, S.g2), wJog);
      if (wRun > 0) gait = blendPose(S.g1, gait, sampleGait(RUN, this.phase, S.g2), wRun);
      if (wSprint > 0) gait = blendPose(S.g1, gait, sampleGait(SPRINT, this.phase, S.g2), wSprint);
      loco = blendPose(S.loco, S.idle, gait, wMove);
    }

    // Carrying: the arms blend into the carry pose (loco is scratch, safe to edit).
    const hs = dt / HOLD_BLEND_S;
    this.carryW = this.carryItem ? Math.min(1, this.carryW + hs) : Math.max(0, this.carryW - hs);
    if (this.carryW > 0) {
      const w = smooth(this.carryW);
      for (let i = 0; i < ARM_PARAMS.length; i += 1) {
        const p = ARM_PARAMS[i];
        loco[p] = LINEAR.has(p) ? lerp(loco[p], CARRY_ARMS[p], w) : lerpAng(loco[p], CARRY_ARMS[p], w);
      }
    }

    // Held pose (sit / aim / crouch) blended over the locomotion.
    this.holdW = this.holdName ? Math.min(1, this.holdW + hs) : Math.max(0, this.holdW - hs);
    let base = loco;
    if (this.holdW > 0 && this.holdPose) base = blendPose(S.base, loco, this.holdPose, smooth(this.holdW));

    // One-shot action on top (whole body, or arms / head / spine only).
    let target = base;
    if (this.action) {
      const c = this.action;
      const prevT = this.actT;
      this.actT += dt * this.actRate;
      for (let i = 0; i < c.events.length; i += 1) {
        const [name, et] = c.events[i];
        const at = et * c.dur;
        if (prevT < at && this.actT >= at) this.onEvent?.(name, this);
      }
      if (this.action === c) {
        if (this.actT >= c.dur) {
          this._startFade(0.22);
          this.action = null;
          this.actionName = null;
        } else {
          const a = sampleAction(c, this.actT / c.dur, S.act);
          if (this.actMask === 'upper') {
            copyPose(S.mix, base);
            for (let i = 0; i < UPPER.length; i += 1) S.mix[UPPER[i]] = a[UPPER[i]];
            target = S.mix;
          } else {
            target = a;
          }
        }
      }
    }

    if (this.fade) {
      this.fade.t += dt;
      const w = smooth(clamp01(this.fade.t / this.fade.dur));
      blendPose(this.pose, this.fadeFrom, target, w);
      if (this.fade.t >= this.fade.dur) this.fade = null;
    } else {
      copyPose(this.pose, target);
    }
    solve(this.pose, this.j);
    return this;
  }

  /** Draw with the feet at (x, y) px; k = px per rig unit. */
  draw(ctx, x, y, k) {
    const j = this.j;
    const col = this.col;
    const th = this.yaw * D2R;
    const ct = Math.cos(th);
    const st = Math.sin(th);
    const proj = (v) => {
      const wx = -v[0] * ct + v[2] * st;
      const wz = v[0] * st + v[2] * ct;
      return [x + k * wx, y + k * (wz * SINP - v[1] * COSP), wz];
    };
    const ow = Math.max(1.1, 0.8 * k) * 2;          // total outline width added to each stroke

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Shadow on the ground under the pelvis.
    if (this.shadow) {
      const g = proj([0, 0, j.fwd]);
      const sr = Math.max(2, (8.5 - j.lift * 0.18) * k);
      ctx.fillStyle = `rgba(0, 0, 0, ${(0.3 * (1 - clamp01(j.lift / 16))).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(g[0], g[1], sr, sr * SINP * 1.3, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    const pP = proj(j.P);
    const pC = proj(j.C);
    const torsoD = (pP[2] + pC[2]) / 2;

    // ---- Legs (farther leg first), then the shorts band.
    const legs = j.legs.map((L) => {
      const hip = proj(L.hip);
      const knee = proj(L.knee);
      const ankle = proj(L.ankle);
      return { hip, knee, ankle, sa: proj(L.shoeA), sb: proj(L.shoeB),
        sock: proj(addS(L.ankle, L.shinDir, -2.4)), d: (hip[2] + knee[2] + ankle[2]) / 3 };
    });
    legs.sort((a, b) => a.d - b.d);
    legs.forEach((L, i) => {
      const far = i === 0 && legs[1].d - L.d > 1.5;     // shade the leg clearly behind the other
      const mid = mix2(L.hip, L.knee, 0.42);
      ctx.strokeStyle = col.outline;
      seg(ctx, L.hip, L.knee, DIM.thighW * k + ow);
      seg(ctx, L.knee, L.ankle, DIM.shinW * k + ow);
      seg(ctx, L.sa, L.sb, DIM.shoeW * k + ow);
      ctx.strokeStyle = far ? col.skinFar : col.skin;
      seg(ctx, L.hip, L.knee, DIM.thighW * k);
      seg(ctx, L.knee, L.ankle, DIM.shinW * k);
      ctx.strokeStyle = far ? col.sockFar : col.sock;
      seg(ctx, L.sock, L.ankle, DIM.shinW * k * 0.98);
      ctx.strokeStyle = far ? col.shoeFar : col.shoe;
      seg(ctx, L.sa, L.sb, DIM.shoeW * k);
      ctx.strokeStyle = col.outline;
      seg(ctx, L.hip, mid, (DIM.thighW + 1.8) * k + ow);
      ctx.strokeStyle = far ? col.shortsFar : col.shorts;
      seg(ctx, L.hip, mid, (DIM.thighW + 1.8) * k);
    });
    const hipR = proj(j.legs[0].hip);
    const hipL = proj(j.legs[1].hip);
    ctx.strokeStyle = col.outline;
    seg(ctx, hipR, hipL, 5.2 * k + ow);
    ctx.strokeStyle = col.shorts;
    seg(ctx, hipR, hipL, 5.2 * k);

    // ---- Upper body: torso, arms and head sorted by depth.
    const arms = j.arms.map((A, i) => {
      const s = proj(A.S);
      const e = proj(A.E);
      const h = proj(A.H);
      return { i, s, e, h, d: (s[2] + e[2] + h[2]) / 3, A };
    });
    const head = proj(j.Hc);
    const items = [
      { kind: 'torso', d: torsoD },
      { kind: 'arm', a: arms[0], d: arms[0].d + 0.01 },
      { kind: 'arm', a: arms[1], d: arms[1].d + 0.01 },
      { kind: 'head', d: head[2] + 2.5 },
    ];
    // Carried slab: between the hands, resting on them. Hidden while a whole-body
    // action (e.g. the pick-up squat) moves the hands elsewhere.
    const carry = this.carryItem;
    let slab = null;
    if (carry && this.carryW > 0.6 && !(this.action && this.actMask !== 'upper')) {
      const c = add(mix3(j.arms[0].H, j.arms[1].H, 0.5), [0, 1.4, -1.2]);   // hands at its sides
      slab = { c, d: proj(c)[2] + 0.6 };
      items.push({ kind: 'carry', d: slab.d });
    }
    items.sort((a, b) => a.d - b.d);
    items.forEach((it) => {
      if (it.kind === 'torso') this._drawTorso(ctx, pP, pC, th, k, ow, proj);
      else if (it.kind === 'arm') this._drawArm(ctx, it.a, it.a.d < torsoD - 1.2, k, ow, proj);
      else if (it.kind === 'carry') this._drawSlab(ctx, slab.c, carry, k, proj);
      else this._drawHead(ctx, head, pP, pC, th, k);
    });

    ctx.restore();
    return this;
  }

  /** A flat slab (carried stone) centred at c, turning with the shoulders. */
  _drawSlab(ctx, c, item, k, proj) {
    const N = 18;
    const pts = [];
    for (let i = 0; i < N; i += 1) {
      const a = (i / N) * Math.PI * 2;
      pts.push(proj(add(c, yawV([Math.cos(a) * item.w * 0.5, 0, Math.sin(a) * item.d * 0.5], this.j.y2))));
    }
    const trace = (dy) => {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1] + dy);
      for (let i = 1; i < N; i += 1) ctx.lineTo(pts[i][0], pts[i][1] + dy);
      ctx.closePath();
    };
    const thick = item.t * COSP * k;
    const top = item.top || ['#a99c86', '#7d715d'];
    const side = item.side || ['#585042', '#39332a'];
    // Outline, then the side band (the top outline extruded downward), then the top face.
    ctx.fillStyle = this.col.outline;
    for (let s = 0; s <= 2; s += 1) { trace(thick * (s / 2) + 0.9); ctx.fill(); }
    trace(-0.9);
    ctx.fill();
    const steps = Math.max(1, Math.ceil(thick));
    for (let s = steps; s >= 1; s -= 1) {
      ctx.fillStyle = s === steps ? side[1] : side[0];
      trace((thick * s) / steps);
      ctx.fill();
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    pts.forEach(([px, py]) => { minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py); });
    const g = ctx.createLinearGradient(minX, minY, maxX, maxY);
    g.addColorStop(0, top[0]);
    g.addColorStop(1, top[1]);
    ctx.fillStyle = g;
    trace(0);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = Math.max(0.6, 0.5 * k);
    ctx.stroke();
  }

  _drawTorso(ctx, pP, pC, th, k, ow, proj) {
    const j = this.j;
    const col = this.col;
    const ax = pC[0] - pP[0];
    const ay = pC[1] - pP[1];
    const len = Math.hypot(ax, ay) || 1;
    const ux = ax / len;
    const uy = ay / len;
    const nx = -uy;
    const ny = ux;
    const psi1 = th - j.y1;
    const psi2 = th - j.y2;
    const hw1 = Math.hypot(DIM.waistHW * Math.cos(psi1), DIM.waistHD * Math.sin(psi1)) * k;
    const hw2 = Math.hypot((DIM.shHW + 0.8) * Math.cos(psi2), DIM.shHD * Math.sin(psi2)) * k;
    const down = 1.2 * k;
    const bl = [pP[0] - nx * hw1 - ux * down, pP[1] - ny * hw1 - uy * down];
    const br = [pP[0] + nx * hw1 - ux * down, pP[1] + ny * hw1 - uy * down];
    const tl = [pC[0] - nx * hw2, pC[1] - ny * hw2];
    const tr = [pC[0] + nx * hw2, pC[1] + ny * hw2];
    const cap = 2.4 * k;
    const top = [pC[0] + ux * cap, pC[1] + uy * cap];
    const bulge = Math.max(hw1, hw2) * 1.04;
    const mid = mix2(pP, pC, 0.55);

    ctx.beginPath();
    ctx.moveTo(bl[0], bl[1]);
    ctx.quadraticCurveTo(mid[0] - nx * bulge, mid[1] - ny * bulge, tl[0], tl[1]);
    ctx.quadraticCurveTo(tl[0] + ux * cap, tl[1] + uy * cap, top[0], top[1]);
    ctx.quadraticCurveTo(tr[0] + ux * cap, tr[1] + uy * cap, tr[0], tr[1]);
    ctx.quadraticCurveTo(mid[0] + nx * bulge, mid[1] + ny * bulge, br[0], br[1]);
    ctx.closePath();
    const wmax = Math.max(hw1, hw2);
    const grad = ctx.createLinearGradient(mid[0] - nx * wmax, mid[1] - ny * wmax, mid[0] + nx * wmax, mid[1] + ny * wmax);
    grad.addColorStop(0, col.jerseyLight);
    grad.addColorStop(0.5, col.jersey);
    grad.addColorStop(1, col.jerseyDark);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = ow / 2;
    ctx.strokeStyle = col.outline;
    ctx.stroke();

    // Hem.
    ctx.strokeStyle = col.jerseyDark;
    seg(ctx, [bl[0] + ux * 1.6 * k, bl[1] + uy * 1.6 * k], [br[0] + ux * 1.6 * k, br[1] + uy * 1.6 * k], 1.3 * k);

    const facing = Math.cos(psi2);
    const ang = Math.atan2(uy, ux) + Math.PI / 2;
    if (facing > 0.1) {
      // Neckline on the chest.
      const c = proj(add(j.C, yawV([0, -0.7, DIM.shHD * 0.85], j.y2)));
      ctx.globalAlpha = clamp01(facing * 3);
      ctx.fillStyle = this.col.skin;
      ctx.strokeStyle = col.jerseyDark;
      ctx.lineWidth = Math.max(1, 0.7 * k);
      ctx.beginPath();
      ctx.ellipse(c[0], c[1], (1.9 * Math.abs(facing) + 0.5) * k, 1.5 * k, ang, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (facing < -0.15) {
      // Shirt number on the back.
      const c = proj(add(j.C, yawV([0, -6.5, -DIM.shHD * 0.9], j.y2)));
      ctx.save();
      ctx.translate(c[0], c[1]);
      ctx.rotate(ang);
      ctx.scale(Math.max(0.15, -facing), 1);
      ctx.globalAlpha = clamp01((-facing - 0.15) * 3);
      ctx.fillStyle = '#ffffff';
      ctx.font = `900 ${Math.max(6, Math.round(7.5 * k))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('7', 0, 0);
      ctx.restore();
    }
  }

  _drawArm(ctx, arm, far, k, ow, proj) {
    const col = this.col;
    const { s, e, h } = arm;
    const mid = mix2(s, e, 0.5);
    ctx.strokeStyle = col.outline;
    ctx.fillStyle = col.outline;
    seg(ctx, s, e, DIM.upperW * k + ow);
    seg(ctx, e, h, DIM.foreW * k + ow);
    dot(ctx, h, DIM.hand * k + ow / 2);
    const skin = far ? col.skinFar : col.skin;
    ctx.strokeStyle = skin;
    ctx.fillStyle = skin;
    seg(ctx, s, e, DIM.upperW * k);
    seg(ctx, e, h, DIM.foreW * k);
    dot(ctx, h, DIM.hand * k);
    ctx.strokeStyle = col.outline;
    seg(ctx, s, mid, (DIM.upperW + 1.5) * k + ow);
    ctx.strokeStyle = far ? col.jerseyFar : col.jersey;
    seg(ctx, s, mid, (DIM.upperW + 1.5) * k);

    if (arm.i === 0) {
      this.hand.x = h[0];
      this.hand.y = h[1];
      if (this.handItem === 'ball') {
        // Same size as the ball on the field (BALL_RADIUS). Its centre sits just past the
        // hand, so the fingers hold the near side of the ball.
        const b = proj(addS(arm.A.H, arm.A.fd, BALL_RADIUS * 0.6));
        ctx.fillStyle = col.outline;
        dot(ctx, b, BALL_RADIUS * k + ow / 3);
        ctx.fillStyle = '#d32f2f';
        dot(ctx, b, BALL_RADIUS * k);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
        dot(ctx, [b[0] - 0.33 * BALL_RADIUS * k, b[1] - 0.33 * BALL_RADIUS * k], 0.32 * BALL_RADIUS * k);
      }
    }
  }

  _drawHead(ctx, hc, pP, pC, th, k) {
    const p = this.pose;
    const art = this.face;
    const sv = (DIM.headRy / 13) * k;          // px per SVG unit (face ellipse ry = 13)
    const W = 40 * sv;
    const H = 44 * sv;
    const psiH = th - (p.headYaw * D2R + this.j.y2 * 0.25);
    const c = Math.cos(psiH);
    const s = Math.sin(psiH);
    const spineAng = Math.atan2(pC[0] - pP[0], pP[1] - pC[1]);
    const rot = spineAng * 0.5 + p.headPitch * D2R * s * 0.7;
    const topR = 16 * sv;                        // hair line at the top of the face art
    this.headTop.x = hc[0] + Math.sin(rot) * topR;
    this.headTop.y = hc[1] - Math.cos(rot) * topR;

    ctx.save();
    ctx.translate(hc[0], hc[1]);
    ctx.rotate(rot);
    if (!art.ready) {
      ctx.fillStyle = this.col.skin;
      ctx.beginPath();
      ctx.ellipse(0, 0, 12 * sv, 13 * sv, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const dev = typeof ctx.getTransform === 'function' ? Math.abs(ctx.getTransform().a) || 1 : 1;
      const small = W * dev < 90;
      const fImg = small ? art.frontS : art.front;
      const bImg = small ? art.backS : art.back;
      if (c < 0.9) {
        const bx = 0.93 + 0.07 * Math.abs(s);
        ctx.drawImage(bImg, -20 * sv * bx - s * 0.05 * W, -22.5 * sv, W * bx, H);
      }
      if (c > -0.45) {
        const cc = Math.max(0, c);
        const fx = 0.58 + 0.42 * cc;
        const ox = s * 0.22 * W * (1 - cc);
        const dy = (p.headPitch / 30) * 1.3 * sv * cc;
        const clip = c < 0.9;
        if (clip) {
          ctx.save();
          ctx.beginPath();
          ctx.ellipse(0, -1.5 * sv, 13.4 * sv, 15.5 * sv, 0, 0, Math.PI * 2);
          ctx.clip();
        }
        ctx.globalAlpha = clamp01((c + 0.45) / 0.3);
        ctx.drawImage(fImg, ox - 20 * sv * fx, -22.5 * sv + dy, W * fx, H);
        ctx.globalAlpha = 1;
        if (clip) ctx.restore();
      }
    }
    if (this.headItem === 'stone') {
      const ty = -(DIM.headRy + 2.2) * k;
      ctx.fillStyle = this.col.outline;
      ctx.beginPath();
      ctx.ellipse(0, ty, 5.6 * k + 1, 2.5 * k + 1, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#9c8a74';
      ctx.beginPath();
      ctx.ellipse(0, ty, 5.6 * k, 2.5 * k, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.beginPath();
      ctx.ellipse(-1.2 * k, ty - 0.8 * k, 2.6 * k, 0.8 * k, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

export function createRig25d(opts = {}) {
  return new Rig25d(opts);
}
