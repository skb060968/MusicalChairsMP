/**
 * Firebase room synchronization for Musical Chairs.
 * Schema-v2 rooms use atomic lifecycle writes and server-owned timestamps.
 */

import { db, auth, authReady } from './firebase-config.js';
import { toFirebaseGameState } from './game-manager.js';
import {
  ref,
  get,
  update,
  remove,
  onValue,
  onDisconnect,
  runTransaction,
  serverTimestamp,
} from 'firebase/database';

const ROOM_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const GAME_ID = 'musical-chairs';
const MAX_PLAYERS = 8;
const CREATE_ROOM_MAX_ATTEMPTS = 10;
const LEGACY_SCHEMA_VERSION = 1;

export const SCHEMA_VERSION = 2;
export const HOST_LOSS_GRACE_MS = 30000;
export const PLAYER_AVATARS = Object.freeze(['🐵', '🐱', '🦊', '🐼', '🐸', '🐧', '🦄', '🐯']);

function requestedAvatar(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !PLAYER_AVATARS.includes(value)) {
    throw new Error('Please choose a valid avatar');
  }
  return value;
}

function playerIndexFromKey(playerId) {
  const match = /^player_([0-7])$/.exec(String(playerId || ''));
  return match ? Number(match[1]) : -1;
}
function resolvedAvatar(playerId, player) {
  if (player && PLAYER_AVATARS.includes(player.emoji)) return player.emoji;
  const index = playerIndexFromKey(playerId);
  return index >= 0 ? PLAYER_AVATARS[index] : null;
}

function isAvatarTaken(players, avatar) {
  if (!avatar || !players || typeof players !== 'object') return false;
  return Object.entries(players).some(([playerId, player]) => resolvedAvatar(playerId, player) === avatar);
}

async function getAuthUid() {
  const readyUser = await authReady;
  let user = auth.currentUser || readyUser;
  if (!user?.uid) {
    throw new Error('Not signed in — cannot reach the game server. Check your connection and try again.');
  }

  // Refresh the token before binding ownership fields to the UID. If Auth ever
  // changed identity while startup settled, use the current token owner rather
  // than a stale user returned by the readiness promise.
  if (typeof user.getIdToken === 'function') await user.getIdToken();
  if (auth.currentUser?.uid && auth.currentUser.uid !== user.uid) {
    user = auth.currentUser;
    if (typeof user.getIdToken === 'function') await user.getIdToken();
  }
  return user.uid;
}

/** Missing schemaVersion is the recognized, read-compatible v1 legacy shape. */
function roomSchemaVersion(meta) {
  if (!meta || !Object.prototype.hasOwnProperty.call(meta, 'schemaVersion')) {
    return LEGACY_SCHEMA_VERSION;
  }
  if (meta.schemaVersion === SCHEMA_VERSION) return SCHEMA_VERSION;
  throw new Error(`Unsupported room schema version: ${String(meta.schemaVersion)}`);
}

function assertSupportedRoom(room) {
  if (!room || typeof room !== 'object') throw new Error('Room not found');
  return roomSchemaVersion(room.meta);
}

function playerKey(playerIndex) {
  if (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex >= MAX_PLAYERS) {
    throw new Error('Invalid player index');
  }
  return `player_${playerIndex}`;
}

export function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += ROOM_CODE_CHARSET[Math.floor(Math.random() * ROOM_CODE_CHARSET.length)];
  }
  return code;
}

/** Creates a schema-v2 room without ever replacing a colliding room code. */
export async function createRoom(hostName, avatar) {
  const uid = await getAuthUid();
  const selectedAvatar = requestedAvatar(avatar);

  for (let attempt = 0; attempt < CREATE_ROOM_MAX_ATTEMPTS; attempt++) {
    const roomCode = generateRoomCode();
    const roomRef = ref(db, `${GAME_ID}-rooms/${roomCode}`);
    const timestamp = serverTimestamp();
    const roomData = {
      meta: {
        schemaVersion: SCHEMA_VERSION,
        hostUid: uid,
        hostName,
        status: 'lobby',
        createdAt: timestamp,
        lastActivity: timestamp,
      },
      players: {
        player_0: {
          name: hostName,
          uid,
          connected: true,
          eliminated: false,
          ...(selectedAvatar ? { emoji: selectedAvatar } : {}),
        },
      },
      game: null,
      chairs: {},
    };

    const result = await runTransaction(roomRef, (currentRoom) => (
      currentRoom === null ? roomData : undefined
    ), { applyLocally: false });
    if (result.committed) return { roomCode, playerIndex: 0 };
  }

  throw new Error('Could not create a unique room code. Please try again.');
}

function isPermissionDenied(error) {
  const blob = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  return blob.includes('permission');
}

/**
 * Reserves the lowest free player slot with a PER-CHILD create transaction.
 * Each attempt writes only its own `players/player_N` node, so it can never
 * displace another player; the rules' per-slot validate still enforces a unique
 * uid and avatar. The room preflight and re-reads give clear, specific errors.
 */
export async function joinRoom(roomCode, playerName, avatar) {
  const uid = await getAuthUid();
  const selectedAvatar = requestedAvatar(avatar);
  const roomRef = ref(db, `${GAME_ID}-rooms/${roomCode}`);
  const snapshot = await get(roomRef);
  if (!snapshot.exists()) throw new Error('Room not found');

  const room = snapshot.val();
  assertSupportedRoom(room);
  if (room.meta?.status !== 'lobby') throw new Error('Game already started');

  let players = room.players || {};

  // Already in this room (e.g. re-open) — keep the existing slot.
  const ownedKey = Object.keys(players).find((key) => players[key]?.uid === uid);
  if (ownedKey) return { playerIndex: playerIndexFromKey(ownedKey) };
  if (selectedAvatar && isAvatarTaken(players, selectedAvatar)) {
    throw new Error('That avatar is already taken');
  }

  const record = {
    name: playerName,
    uid,
    connected: true,
    eliminated: false,
    ...(selectedAvatar ? { emoji: selectedAvatar } : {}),
  };
  const playersRef = ref(db, `${GAME_ID}-rooms/${roomCode}/players`);

  for (let index = 1; index < MAX_PLAYERS; index += 1) {
    const key = `player_${index}`;
    if (players[key]) continue;
    try {
      const result = await runTransaction(
        ref(db, `${GAME_ID}-rooms/${roomCode}/players/${key}`),
        (current) => (current === null ? record : undefined),
        { applyLocally: false },
      );
      if (result.committed) {
        await update(ref(db, `${GAME_ID}-rooms/${roomCode}/meta`), {
          lastActivity: serverTimestamp(),
        });
        return { playerIndex: index };
      }
      // Slot taken between our read and the write — refresh and try the next.
      players = (await get(playersRef)).val() || {};
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      // Rules rejected (slot raced, avatar taken, or the lobby just closed).
      players = (await get(playersRef)).val() || {};
      const mine = Object.keys(players).find((k) => players[k]?.uid === uid);
      if (mine) return { playerIndex: playerIndexFromKey(mine) };
      if (selectedAvatar && isAvatarTaken(players, selectedAvatar)) {
        throw new Error('That avatar is already taken');
      }
      const status = (await get(ref(db, `${GAME_ID}-rooms/${roomCode}/meta/status`))).val();
      if (status !== 'lobby') throw new Error('Game already started');
    }
  }

  const occupied = Object.keys(players).filter((k) => /^player_[0-7]$/.test(k)).length;
  if (occupied >= MAX_PLAYERS) throw new Error(`Room is full (${MAX_PLAYERS} players maximum)`);
  throw new Error('Could not reserve a player slot. Please try again.');
}

/** Returns the exact unsubscribe function supplied by the Firebase SDK. */
export function listenRoom(roomCode, callbacks = {}) {
  const roomRef = ref(db, `${GAME_ID}-rooms/${roomCode}`);
  return onValue(roomRef, (snapshot) => {
    if (!snapshot.exists()) {
      callbacks.onRoomDeleted?.();
      return;
    }

    const data = snapshot.val();
    try {
      assertSupportedRoom(data);
    } catch (error) {
      callbacks.onError?.(error);
      return;
    }

    const meta = data.meta || {};
    const status = meta.status || 'lobby';
    callbacks.onMetaChange?.(meta);
    callbacks.onStatusChange?.(status);
    callbacks.onPlayersChange?.(data.players || {});
    callbacks.onChairsChange?.(data.chairs || {});
    callbacks.onRankingsChange?.(data.rankings || []);
    if (data.game) callbacks.onGameUpdate?.(data.game, status);
  });
}

export async function writeGameState(roomCode, gameState) {
  await update(ref(db), {
    [`${GAME_ID}-rooms/${roomCode}/game`]: toFirebaseGameState(gameState),
    [`${GAME_ID}-rooms/${roomCode}/meta/lastActivity`]: serverTimestamp(),
  });
}

export async function startGame(roomCode, initialGameState) {
  const game = toFirebaseGameState(initialGameState);
  if (game.phase === 'music') game.musicStartTime = serverTimestamp();
  await update(ref(db), {
    [`${GAME_ID}-rooms/${roomCode}/meta/status`]: 'playing',
    [`${GAME_ID}-rooms/${roomCode}/game`]: game,
    [`${GAME_ID}-rooms/${roomCode}/chairs`]: null,
    [`${GAME_ID}-rooms/${roomCode}/meta/lastActivity`]: serverTimestamp(),
  });
}

export async function endGame(roomCode) {
  await update(ref(db, `${GAME_ID}-rooms/${roomCode}/meta`), {
    status: 'finished',
    lastActivity: serverTimestamp(),
  });
}

/** Immediate host-driven deletion remains available. */
export async function deleteRoom(roomCode) {
  await remove(ref(db, `${GAME_ID}-rooms/${roomCode}`));
}

/**
 * Arms a cancellable disconnect registration. Host loss is one atomic root
 * update so observers never see a marker without the corresponding flag.
 */
export async function setupDisconnectHandler(roomCode, playerIndex) {
  const key = playerKey(playerIndex);
  if (playerIndex === 0) {
    const registration = onDisconnect(ref(db));
    const timestamp = serverTimestamp();
    await registration.update({
      [`${GAME_ID}-rooms/${roomCode}/players/${key}/connected`]: false,
      [`${GAME_ID}-rooms/${roomCode}/meta/hostDisconnectedAt`]: timestamp,
      [`${GAME_ID}-rooms/${roomCode}/meta/lastActivity`]: timestamp,
    });
    return registration;
  }

  const registration = onDisconnect(ref(db, `${GAME_ID}-rooms/${roomCode}/players/${key}`));
  await registration.update({ connected: false });
  return registration;
}

/** Atomically marks a player present again and clears a recovered host marker. */
export async function restoreConnection(roomCode, playerIndex) {
  const key = playerKey(playerIndex);
  const updates = {
    [`${GAME_ID}-rooms/${roomCode}/players/${key}/connected`]: true,
    [`${GAME_ID}-rooms/${roomCode}/meta/lastActivity`]: serverTimestamp(),
  };
  if (playerIndex === 0) {
    updates[`${GAME_ID}-rooms/${roomCode}/meta/hostDisconnectedAt`] = null;
  }
  await update(ref(db), updates);
}

/**
 * Deletes only the exact host-loss generation observed by the requester.
 * Elapsed time is intentionally compared locally; no client timestamp is
 * written. The transaction rechecks every safety condition immediately before
 * committing the deletion.
 */
export async function deleteRoomAfterHostLossGrace(
  roomCode,
  expectedHostDisconnectedAt,
  requesterPlayerIndex,
  now = Date.now(),
) {
  const uid = await getAuthUid();
  const requesterKey = playerKey(requesterPlayerIndex);
  const roomRef = ref(db, `${GAME_ID}-rooms/${roomCode}`);
  const result = await runTransaction(roomRef, (room) => {
    if (!room || typeof room !== 'object') return undefined;
    try {
      assertSupportedRoom(room);
    } catch (_) {
      return undefined;
    }

    const marker = room.meta?.hostDisconnectedAt;
    const requester = room.players?.[requesterKey];
    const host = Object.values(room.players || {})
      .find((player) => player?.uid === room.meta?.hostUid);
    if (!Number.isFinite(marker) || marker !== expectedHostDisconnectedAt) return undefined;
    if (!Number.isFinite(now) || now - marker < HOST_LOSS_GRACE_MS) return undefined;
    if (!requester || requester.uid !== uid) return undefined;
    if (!host || host.connected !== false) return undefined;
    return null;
  }, { applyLocally: false });
  return result.committed && !result.snapshot.exists();
}

/** Descriptive alias for callers that phrase the operation as a predicate. */
export const deleteRoomIfHostDisconnected = deleteRoomAfterHostLossGrace;

export async function removePlayer(roomCode, playerIndex) {
  await remove(ref(db, `${GAME_ID}-rooms/${roomCode}/players/${playerKey(playerIndex)}`));
}
