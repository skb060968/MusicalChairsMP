/**
 * Firebase synchronisation for Musical Chairs — PEER-RUN model.
 *
 * ── Platform file: room lifecycle, presence and the game transactions. ──
 *
 * There is no host authority during play. The host owns the LOBBY (start, remove
 * players, close the room) and nothing else: once the game is running, every
 * phase change is written by whichever connected player's timer fires first, and
 * every chair claim is written by the player who grabbed it. The Firebase rules
 * re-check each write against the shared clock (`now`) and the current state, so
 * the client just has to agree with them — it never needs to be trusted.
 *
 * Rebrand checklist: ROOM_PATH here must equal the rules block name and ROOM_NS in
 * main.js.
 */
import { db, auth, authReady } from './firebase-config.js';
import {
  get, off, onDisconnect, onValue, ref, remove, runTransaction, serverTimestamp, set, update,
} from 'firebase/database';
import {
  MAX_PLAYERS, PLAYER_KEY_RE, createGame, stopMusic, reveal, nextRound,
} from './engine.js';

const ROOM_PATH = 'chairs-rooms';              // ← must match the rules block + main.js ROOM_NS
const ROOM_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const ROOM_CODE_RE = /^[A-HJ-NP-Z]{4}$/;
/** Avatars are UNIQUE in this game (8 seats, 8 avatars). Must match index.html and the rules. */
export const PLAYER_AVATARS = Object.freeze(['🥷', '🧙', '🦸', '👷', '🤴', '👸', '🧝', '🧛']);
const TRANSIENT_CODES = new Set([
  'database/disconnected', 'database/network-error', 'database/unavailable',
  'unavailable', 'network-request-failed',
]);

const roomPath = (code, suffix = '') => `${ROOM_PATH}/${normalizeRoomCode(code)}${suffix ? `/${suffix}` : ''}`;
const playerKeyFor = (index) => `player_${index}`;
const playerIndexFrom = (key) => Number.parseInt(key.replace('player_', ''), 10);
const now = () => Date.now();
let stopPresence = null;

export { MAX_PLAYERS };

export function normalizeRoomCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!ROOM_CODE_RE.test(code)) throw new Error('Invalid room code');
  return code;
}

function cleanText(value, fallback, maxLength) {
  const text = String(value || '').trim();
  return (text || fallback).slice(0, maxLength);
}

async function requireUser() {
  const user = await authReady;
  if (!user?.uid || auth.currentUser?.uid !== user.uid) throw new Error('Authentication unavailable');
  return user;
}

export async function firebaseRetry(fn, maxRetries = 2, delayMs = 500) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await fn(); } catch (error) {
      const code = String(error?.code || '').toLowerCase();
      if (attempt >= maxRetries || !TRANSIENT_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
}

export function isPermissionError(error) {
  return String(error?.code || error?.message || '').toLowerCase().includes('permission');
}

export function generateRoomCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => ROOM_CODE_CHARSET[byte % ROOM_CODE_CHARSET.length]).join('');
}

/* ======================= SERVER CLOCK ======================= */

let serverOffsetMs = 0;
/** Keeps a live estimate of (server time − local time). Every deadline in this game
 *  is measured on the server clock, so local timers must be corrected by this. */
export function watchServerClock(onChange) {
  const infoRef = ref(db, '.info/serverTimeOffset');
  const handler = (snap) => {
    const v = snap.val();
    if (Number.isFinite(v)) { serverOffsetMs = v; onChange?.(v); }
  };
  onValue(infoRef, handler);
  return () => off(infoRef, 'value', handler);
}
export const serverNow = () => Date.now() + serverOffsetMs;

/* ======================= ROOM LIFECYCLE ======================= */

export async function createRoom(hostName, hostEmoji) {
  const user = await requireUser();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const roomCode = generateRoomCode();
    const createdAt = now();
    const room = {
      schemaVersion: 2,
      meta: {
        hostUid: user.uid,
        hostName: cleanText(hostName, 'Host', 12),
        status: 'lobby',
        createdAt,
        lastActivity: createdAt,
      },
      players: {
        player_0: {
          name: cleanText(hostName, 'Host', 12),
          emoji: PLAYER_AVATARS.includes(hostEmoji) ? hostEmoji : PLAYER_AVATARS[0],
          uid: user.uid,
          connected: true,
          joinedAt: createdAt,
        },
      },
    };
    try {
      // The create rule requires !data.exists(); a taken code is denied → retry.
      await set(ref(db, roomPath(roomCode)), room);
      return { roomCode, playerIndex: 0 };
    } catch (error) {
      if (attempt === 11) throw error;
    }
  }
  throw new Error('Unable to reserve a room code. Try again.');
}

export async function joinRoom(roomCode, playerName, playerEmoji) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const roomSnap = await firebaseRetry(() => get(ref(db, roomPath(code))));
  if (!roomSnap.exists()) return { success: false, reason: 'Room not found' };
  const room = roomSnap.val();
  if (room.schemaVersion !== 2) return { success: false, reason: 'Room version is outdated' };

  let players = room.players || {};
  const ownedKey = Object.keys(players).find((key) => players[key]?.uid === user.uid);
  if (ownedKey) {
    await set(ref(db, roomPath(code, `players/${ownedKey}/connected`)), true);
    return { success: true, playerIndex: playerIndexFrom(ownedKey) };
  }
  if (room.meta?.status !== 'lobby') return { success: false, reason: 'Game already in progress' };
  if (Object.keys(players).length >= MAX_PLAYERS) return { success: false, reason: `Room is full (${MAX_PLAYERS})` };

  const emoji = PLAYER_AVATARS.includes(playerEmoji) ? playerEmoji : null;
  if (!emoji) return { success: false, reason: 'Pick an avatar' };
  if (Object.values(players).some((p) => p?.emoji === emoji)) return { success: false, reason: 'That avatar is taken' };

  const playersRef = ref(db, roomPath(code, 'players'));
  for (let index = 1; index < MAX_PLAYERS; index += 1) {
    const key = `player_${index}`;
    if (players[key]) continue;
    const joinedAt = now();
    try {
      const result = await runTransaction(ref(db, roomPath(code, `players/${key}`)), (current) => {
        if (current !== null) return undefined;
        return { name: cleanText(playerName, 'Player', 12), emoji, uid: user.uid, connected: true, joinedAt };
      }, { applyLocally: false });
      if (result.committed) return { success: true, playerIndex: index };
    } catch (error) {
      // The rules refuse a duplicate avatar or a room that just started.
      if (isPermissionError(error)) return { success: false, reason: 'Could not join — the avatar may be taken or the game has started' };
      throw error;
    }
    players = (await get(playersRef)).val() || {}; // slot raced — refresh, try next
  }
  return { success: false, reason: `Room is full (${MAX_PLAYERS})` };
}

/**
 * One listener on the room. Fires on ANY change (presence, lastActivity …) so every
 * consumer must be idempotent. Emits: onPlayersChange(players), onGameUpdate(game),
 * onStatusChange(status, room), onRoomDeleted().
 */
export function listenRoom(roomCode, callbacks = {}) {
  const roomRef = ref(db, roomPath(roomCode));
  let deleted = false;
  const handler = (snap) => {
    if (!snap.exists()) { if (!deleted) { deleted = true; callbacks.onRoomDeleted?.(); } return; }
    const room = snap.val();
    callbacks.onPlayersChange?.(room.players || {}, room);
    if (room.game) callbacks.onGameUpdate?.(room.game, room);
    const status = room.meta?.status === 'ended' || room.game?.status === 'finished'
      ? 'ended'
      : room.game?.status === 'playing' ? 'active' : (room.meta?.status || 'lobby');
    callbacks.onStatusChange?.(status, room);
  };
  onValue(roomRef, handler, (e) => callbacks.onError?.(e));
  return () => off(roomRef, 'value', handler);
}

/** Live view of the players node only — used by the Join screen's taken-avatar preview. */
export function listenPlayers(roomCode, onPlayers) {
  let playersRef;
  try { playersRef = ref(db, roomPath(roomCode, 'players')); } catch (_) { return () => {}; }
  const handler = (snap) => onPlayers(snap.val() || {});
  onValue(playersRef, handler, () => onPlayers({}));
  return () => off(playersRef, 'value', handler);
}

/* ======================= PRESENCE ======================= */

export async function setupDisconnectHandler(roomCode, playerIndex) {
  await stopPresenceTracking();
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const key = playerKeyFor(playerIndex);
  if (!PLAYER_KEY_RE.test(key)) throw new Error('Invalid player slot');
  const playerSnapshot = await get(ref(db, roomPath(code, `players/${key}`)));
  if (!playerSnapshot.exists() || playerSnapshot.val()?.uid !== user.uid) {
    throw new Error('Player session is no longer valid');
  }
  const connectedRef = ref(db, roomPath(code, `players/${key}/connected`));
  const infoRef = ref(db, '.info/connected');
  let registration = null;
  let disposed = false;
  const handler = async (snapshot) => {
    if (!snapshot.val() || disposed) return;
    try {
      registration = onDisconnect(connectedRef);
      await registration.set(false);
      if (!disposed) await set(connectedRef, true);
    } catch (error) {
      console.warn('Presence update failed:', error.message);
    }
  };
  onValue(infoRef, handler);
  stopPresence = async () => {
    disposed = true;
    off(infoRef, 'value', handler);
    try { await registration?.cancel(); } catch (_) {}
  };
  return stopPresence;
}

/** Fires `onRestore()` each time THIS device regains its connection after losing it.
 *  The first emission after subscribing is the baseline, so a page load never counts. */
export function watchReconnect(onRestore) {
  const infoRef = ref(db, '.info/connected');
  let wasOffline = false;
  const handler = (snapshot) => {
    if (snapshot.val() !== true) { wasOffline = true; return; }
    if (!wasOffline) return;
    wasOffline = false;
    try { onRestore(); } catch (error) { console.warn('reconnect handler failed:', error); }
  };
  onValue(infoRef, handler);
  return () => off(infoRef, 'value', handler);
}

export async function stopPresenceTracking() {
  const cleanup = stopPresence;
  stopPresence = null;
  if (cleanup) await cleanup();
}

/* ======================= GAME ======================= */

/**
 * HOST ONLY (lobby duty). Deals in the connected players and starts round 1.
 * A ROOM-level transaction, because the rules authorise "lobby → active + game"
 * as one branch on the room; a multi-path update would be checked path by path.
 * `serverTimestamp()` inside a transaction is resolved by the SDK from its server
 * clock estimate — that is why the rules accept `phaseAt` within a window of `now`.
 */
export async function startGame(roomCode, connectedKeys) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const result = await runTransaction(ref(db, roomPath(code)), (room) => {
    if (!room || room.meta?.status !== 'lobby' || room.game) return undefined;
    const game = createGame(connectedKeys, user.uid, now());
    game.phaseAt = serverTimestamp();
    game.operation.timestamp = serverTimestamp();
    return { ...room, game, meta: { ...room.meta, status: 'active', lastActivity: now() } };
  }, { applyLocally: false });
  if (!result.committed) throw new Error('Could not start — the room is not in the lobby.');
  return result.snapshot.val()?.game || null;
}

/**
 * ANY CONNECTED PLAYER. Applies the phase transition that is due — `stop`
 * (music → claiming), `reveal` (claiming → reveal/finished) or `next` (reveal →
 * next round). The transaction re-derives the change from the CURRENT node, so when
 * several devices fire together the first commit lands and the rest see the phase
 * already moved on and abort quietly. The rules independently check the deadline
 * against the server clock and that nothing else changed.
 *
 * @returns {Promise<'committed'|'aborted'|'denied'>}
 */
export async function advanceGame(roomCode, type, actorKey) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const reducers = { stop: stopMusic, reveal, next: nextRound };
  const reducer = reducers[type];
  if (!reducer) throw new Error(`Unknown transition ${type}`);
  try {
    const result = await runTransaction(ref(db, roomPath(code, 'game')), (current) => {
      if (!current) return undefined;
      const next = reducer(current, actorKey, user.uid, now());
      if (!next) return undefined;                       // phase already moved on
      next.phaseAt = serverTimestamp();                  // the shared clock, never ours
      next.operation.timestamp = serverTimestamp();
      return next;
    }, { applyLocally: false });
    return result.committed ? 'committed' : 'aborted';
  } catch (error) {
    if (isPermissionError(error)) return 'denied';       // lost the race, or not due yet
    throw error;
  }
}

/**
 * THE PLAYER THEMSELVES. Grabs chair `chair` (0-based). The rules refuse it if the
 * chair is taken, the player already sits, they are out, or the window has closed.
 * @returns {Promise<boolean>} true if the chair is now ours
 */
export async function claimChair(roomCode, playerIndex, chair) {
  await requireUser();
  const code = normalizeRoomCode(roomCode);
  const key = playerKeyFor(playerIndex);
  if (!PLAYER_KEY_RE.test(key) || !Number.isInteger(chair)) throw new Error('Invalid claim');
  try {
    await set(ref(db, roomPath(code, `game/claims/${key}`)), chair);
    return true;
  } catch (error) {
    if (isPermissionError(error)) return false;
    throw error;
  }
}

/* ======================= RESET / LEAVE / END ======================= */

/** Back to the lobby after a finished game. The host, or — when the host is gone —
 *  any connected player (the rules allow it while player_0 reads offline). */
export async function resetRoom(roomCode) {
  await requireUser();
  const code = normalizeRoomCode(roomCode);
  const result = await runTransaction(ref(db, roomPath(code)), (room) => {
    if (!room || room.game?.status !== 'finished') return undefined;
    const next = { ...room, meta: { ...room.meta, status: 'lobby', lastActivity: now() } };
    delete next.game;
    delete next.ready;
    return next;
  }, { applyLocally: false });
  if (!result.committed) throw new Error('Could not restart — the game is not finished.');
}

export async function leavePlayer(roomCode, playerIndex) {
  await requireUser();
  const code = normalizeRoomCode(roomCode);
  const key = playerKeyFor(playerIndex);
  const connectedRef = ref(db, roomPath(code, `players/${key}/connected`));
  await stopPresenceTracking();
  try { await onDisconnect(connectedRef).cancel(); } catch (_) {}
  // Offline FIRST: if the removal is refused (mid-game), peers still see an honest
  // OFFLINE row instead of a ghost that looks present.
  try { await set(connectedRef, false); } catch (_) {}
  await remove(ref(db, roomPath(code, `players/${key}`)));
}

/** Marks the local player offline and stops presence WITHOUT removing the row — the
 *  way anyone (host included) leaves a running game. The game carries on without
 *  them; they are eliminated at the next chair deadline like any absent player. */
export async function markSelfOffline(roomCode, playerIndex) {
  await requireUser();
  const code = normalizeRoomCode(roomCode);
  const key = playerKeyFor(playerIndex);
  if (!PLAYER_KEY_RE.test(key)) throw new Error('Invalid player slot');
  const connectedRef = ref(db, roomPath(code, `players/${key}/connected`));
  await stopPresenceTracking();
  try { await onDisconnect(connectedRef).cancel(); } catch (_) {}
  await set(connectedRef, false);
}

/** HOST ONLY (lobby duty). */
export async function removePlayer(roomCode, playerIndex) {
  await requireUser();
  const code = normalizeRoomCode(roomCode);
  const key = playerKeyFor(playerIndex);
  if (key === 'player_0' || !PLAYER_KEY_RE.test(key)) throw new Error('Invalid player slot');
  await remove(ref(db, roomPath(code, `players/${key}`)));
}

/** HOST ONLY. Flags the room ended so peers get a signal before the delete lands. */
export async function endRoom(roomCode) {
  await requireUser();
  const code = normalizeRoomCode(roomCode);
  await update(ref(db, roomPath(code, 'meta')), { status: 'ended', lastActivity: now() });
}

export async function deleteRoom(roomCode) {
  await requireUser();
  await stopPresenceTracking();
  await remove(ref(db, roomPath(roomCode)));
}

/** Session restore: the room if it still exists and this uid still owns the seat. */
export async function fetchRoomForRestore(roomCode, playerIndex) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const snap = await get(ref(db, roomPath(code)));
  if (!snap.exists()) return null;
  const room = snap.val();
  const player = room.players?.[playerKeyFor(playerIndex)];
  if (room.schemaVersion !== 2 || !player || player.uid !== user.uid) return null;
  return room;
}
