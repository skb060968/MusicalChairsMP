/**
 * Seven Stones — player faces (head-only SVG art).
 *
 * Players pick one of these ids; the id is stored in players/player_N/emoji
 * (field name kept for the Firebase rules). Each face is drawn the same on
 * every device, sits on the character's body as its head, and sets the
 * body's skin colour to match.
 *
 * All markup here is static and built only from this table — ids coming from
 * the database are looked up, never interpolated into HTML.
 */

const EYE   = '#2b1b10';
const MOUTH = '#7a2e1f';
const LIPS  = '#c2185b';

/** viewBox 0 0 40 44 — face centre (20, 22), chin at y≈35, neck to the bottom. */
export const AVATARS = Object.freeze([
  {
    id: 'm1', label: 'Boy with short hair', gender: 'male', skin: '#e0ac69', hair: '#1b1b1b',
    back: '',
    front: '<path d="M7.5 22C7 11 13 6.5 20 6.5S33 11 32.5 22C31 17 29 14.5 26 14C22 15.5 16 15.5 12 14C10 15 8.5 18 7.5 22Z"/>',
    extra: '',
  },
  {
    id: 'm2', label: 'Boy with curly hair', gender: 'male', skin: '#c68642', hair: '#2b1b10',
    back: '',
    front: '<circle cx="10" cy="15" r="5"/><circle cx="15" cy="10" r="5.5"/><circle cx="21" cy="8.5" r="6"/>'
      + '<circle cx="27" cy="10.5" r="5.5"/><circle cx="31" cy="16" r="4.5"/><circle cx="8.8" cy="19.5" r="3.2"/><circle cx="31.4" cy="20" r="3"/>',
    extra: '',
  },
  {
    id: 'm3', label: 'Man with turban and beard', gender: 'male', skin: '#d9a066', hair: '#222',
    back: '',
    front: '<path fill="#ff8f00" d="M7 20C6 9 13 4 20 4S34 9 33 20C29 17 24 16 20 16S11 17 7 20Z"/>'
      + '<path fill="none" stroke="#e65100" stroke-width="1.2" d="M9 15Q20 8 31 15M11 10.5Q20 5.5 29 10.5"/>',
    // From behind the turban covers the whole head down to the nape.
    rear: '<path fill="#ff8f00" d="M7.4 26C5.5 9 13 4 20 4S34.5 9 32.6 26C28 29.5 12 29.5 7.4 26Z"/>'
      + '<path fill="none" stroke="#e65100" stroke-width="1.2" d="M8.5 19Q20 11 31.5 19M9.5 13Q20 6.5 30.5 13M8.5 24.5Q20 18 31.5 24.5"/>',
    // Beard + moustache over the lower face; the mouth is a light line on top.
    extra: '<path d="M9 25C10 34 15 37.5 20 37.5S30 34 31 25C28 30 24 31 20 31S12 30 9 25Z"/>'
      + '<path fill="none" stroke="#e8b38a" stroke-width="1.2" stroke-linecap="round" d="M17.5 31.5Q20 33 22.5 31.5"/>',
    noMouth: true,
  },
  {
    id: 'm4', label: 'Man with moustache', gender: 'male', skin: '#8d5524', hair: '#111',
    back: '',
    front: '<path d="M7.5 21L8 13L11 9L14 10L16 6L19 8.5L22 5.5L24.5 8.5L28 7L29.5 11L32 13.5L32.5 21C30 16 26 14.5 20 14.5S10 16 7.5 21Z"/>',
    extra: '<path d="M14.5 27.6C16.5 25.8 19 26 20 27C21 26 23.5 25.8 25.5 27.6C23.5 28.8 21.5 28.6 20 27.9C18.5 28.6 16.5 28.8 14.5 27.6Z"/>',
    mouthY: 1.6,
  },
  {
    id: 'f1', label: 'Girl with long hair and bindi', gender: 'female', skin: '#f1c27d', hair: '#1a1110',
    back: '<path d="M6 22C5 10 12 5 20 5S35 10 34 22L35 40C31 42 27 41 26 38H14C13 41 9 42 5 40Z"/>',
    front: '<path d="M8 20C8 10 14 7 20 7S32 10 32 20C29 14 25 12.5 20.6 12.5L20 14L19.4 12.5C15.5 12.8 11.5 15 8 20Z"/>',
    extra: '<circle cx="20" cy="17.8" r="1.25" fill="#d50000"/>',
    noEars: true,
  },
  {
    id: 'f2', label: 'Woman with hair bun and earrings', gender: 'female', skin: '#c68642', hair: '#111',
    back: '<circle cx="20" cy="5" r="5.5"/>',
    front: '<path d="M7.5 22C7 11 13 7 20 7S33 11 32.5 22C31 15 27 12 20 12S9 15 7.5 22Z"/>',
    extra: '<circle cx="8" cy="28.5" r="1.7" fill="#ffc107"/><circle cx="32" cy="28.5" r="1.7" fill="#ffc107"/>'
      + '<circle cx="20" cy="17.6" r="1.15" fill="#d50000"/>',
  },
  {
    id: 'f3', label: 'Girl with ponytail', gender: 'female', skin: '#e0ac69', hair: '#3b2314',
    back: '<path d="M28 12C39 11 39 29 33 37C33.5 28 33 20 28.5 16Z"/>',
    // From behind the ponytail hangs down the middle from a pink tie.
    rear: '<path d="M17 13C13.5 21 15 32 20 41C25 32 26.5 21 23 13Z"/><circle cx="20" cy="13.5" r="2.4" fill="#ec407a"/>',
    front: '<path d="M7.5 22C7 11 13 7 20 7S33 11 32.5 22C31 15 27 12 20 12S9 15 7.5 22Z"/>',
    extra: '<circle cx="29.5" cy="11.5" r="2.2" fill="#ec407a"/>',
  },
  {
    id: 'f4', label: 'Woman with bob cut', gender: 'female', skin: '#a0663a', hair: '#2a1a12',
    back: '<path d="M6.5 22C6 10 12.5 5.5 20 5.5S34 10 33.5 22L33 32C30 33 29 30 29 27H11C11 30 10 33 7 32Z"/>',
    front: '<path d="M8 19C8 10 13.5 7.5 20 7.5S32 10 32 19L31 17C28 15 24 15.5 20 15.5S12 15 9 17Z"/>',
    extra: '<circle cx="8.6" cy="29" r="1.5" fill="#e0e0e0"/><circle cx="31.4" cy="29" r="1.5" fill="#e0e0e0"/>',
    noEars: true,
  },
]);

export const AVATAR_IDS = Object.freeze(AVATARS.map((a) => a.id));
const BY_ID = new Map(AVATARS.map((a) => [a.id, a]));
const FALLBACK = AVATARS[0];

function shade(hex, amount) {
  const n = Number.parseInt(hex.slice(1), 16);
  const c = (s) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * (1 + amount))));
  return `#${((c(16) << 16) | (c(8) << 8) | c(0)).toString(16).padStart(6, '0')}`;
}

function buildSvg(a) {
  const dark = shade(a.skin, -0.18);
  const female = a.gender === 'female';
  const my = a.mouthY || 0;
  const eyes = `<ellipse cx="15.5" cy="23" rx="1.6" ry="2" fill="${EYE}"/><ellipse cx="24.5" cy="23" rx="1.6" ry="2" fill="${EYE}"/>`
    + '<circle cx="16.1" cy="22.3" r="0.55" fill="#fff"/><circle cx="25.1" cy="22.3" r="0.55" fill="#fff"/>'
    + (female ? `<path fill="none" stroke="${EYE}" stroke-width="0.9" stroke-linecap="round" d="M13.9 21.6L12.6 20.7M26.1 21.6L27.4 20.7"/>` : '');
  const brows = `<path fill="none" stroke="${a.hair}" stroke-width="${female ? 1 : 1.5}" stroke-linecap="round" d="M13 19.6Q15.5 18.1 18 19.4M22 19.4Q24.5 18.1 27 19.6"/>`;
  const nose = `<path fill="none" stroke="${dark}" stroke-width="1" stroke-linecap="round" d="M20.2 24.2Q21.4 26.4 19.4 26.9"/>`;
  const mouth = a.noMouth ? ''
    : `<path fill="none" stroke="${female ? LIPS : MOUTH}" stroke-width="${female ? 1.7 : 1.4}" stroke-linecap="round" d="M16.3 ${29 + my}Q20 ${32.2 + my} 23.7 ${29 + my}"/>`;
  const cheeks = '<circle cx="12.4" cy="27.4" r="2" fill="#ff8a80" opacity="0.35"/><circle cx="27.6" cy="27.4" r="2" fill="#ff8a80" opacity="0.35"/>';
  const ears = a.noEars ? '' : `<circle cx="8.2" cy="23.5" r="3" fill="${a.skin}"/><circle cx="31.8" cy="23.5" r="3" fill="${a.skin}"/>`
    + `<circle cx="8.2" cy="23.5" r="1.4" fill="${dark}" opacity="0.5"/><circle cx="31.8" cy="23.5" r="1.4" fill="${dark}" opacity="0.5"/>`;
  return '<svg viewBox="0 0 40 44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">'
    + `<g fill="${a.hair}">${a.back}</g>`
    + `<rect x="16" y="31" width="8" height="13" rx="3" fill="${dark}"/>`
    + ears
    + `<ellipse cx="20" cy="22.5" rx="12" ry="13" fill="${a.skin}"/>`
    + cheeks + eyes + brows + nose + mouth
    + `<g fill="${a.hair}">${a.front}${a.extra}</g>`
    + '</svg>';
}

/**
 * Back of the head (player facing away from the camera, e.g. the attacker
 * facing the pile): neck and nape in skin, the head covered by hair, then
 * the hairstyle's outline and anything that hangs at the back (long hair,
 * bun, ponytail, turban).
 */
function buildBackSvg(a) {
  const dark = shade(a.skin, -0.18);
  const ears = a.noEars ? '' : `<circle cx="8.2" cy="23.5" r="3" fill="${a.skin}"/><circle cx="31.8" cy="23.5" r="3" fill="${a.skin}"/>`;
  const rear = a.rear ?? a.back;
  return '<svg viewBox="0 0 40 44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">'
    + `<rect x="16" y="31" width="8" height="13" rx="3" fill="${a.skin}"/>`
    + ears
    + `<ellipse cx="20" cy="22.5" rx="12" ry="13" fill="${a.skin}"/>`
    + `<ellipse cx="20" cy="21" rx="12.3" ry="12.6" fill="${a.hair}"/>`
    + `<path fill="none" stroke="${dark}" stroke-width="0.8" opacity="0.5" d="M16 34Q20 35.5 24 34"/>`
    + `<g fill="${a.hair}">${a.rear ? '' : a.front}${rear}</g>`
    + '</svg>';
}

const SVG_CACHE = new Map(AVATARS.map((a) => [a.id, buildSvg(a)]));
const BACK_CACHE = new Map(AVATARS.map((a) => [a.id, buildBackSvg(a)]));

/** SVG markup for the back of a player's head. */
export function avatarBackSvg(id) {
  return BACK_CACHE.get(avatarInfo(id).id);
}

export function avatarInfo(id) {
  return BY_ID.get(id) || FALLBACK;
}

/** SVG markup for a face (unknown ids get the default face). */
export function avatarSvg(id) {
  return SVG_CACHE.get(avatarInfo(id).id);
}

/** Inline face for text rows (lobby, HUD, scores, results). */
export function avatarHtml(id, extraClass = '') {
  return `<span class="ss-av${extraClass ? ` ${extraClass}` : ''}">${avatarSvg(id)}</span>`;
}

/** DOM element version of avatarHtml (for places that build nodes). */
export function avatarElement(id, extraClass = '') {
  const span = document.createElement('span');
  span.className = `ss-av${extraClass ? ` ${extraClass}` : ''}`;
  span.innerHTML = avatarSvg(id);
  return span;
}
