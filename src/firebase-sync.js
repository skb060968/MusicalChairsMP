/**
 * Firebase Sync Module for Musical Chairs Multiplayer
 * Handles room management and real-time game state synchronization
 *
 * Rooms are stored under `musical-chairs-rooms/{roomCode}` with the nodes
 * meta / players / game / chairs.
 *
 * `chairs/{chairId}` is CREATE-ONLY for players under the deployed rules, which
 * is what arbitrates the drag-to-claim race: the second device to reach a chair
 * is rejected with PERMISSION_DENIED. `listenRoom` therefore exposes
 * `onChairsChange` so every device renders the same seating.
 */

import { db, auth, authReady } from './firebase-config.js';
import {
  ref,
  set,
  get,
  update,
  remove,
  onValue,
  off,
  onDisconnect,
  runTransaction,
} from 'firebase/database';

const ROOM_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const GAME_ID = 'musical-chairs';
const MAX_PLAYERS = 8;

/** Emoji identities offered by the create/join forms. */
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

/** Explicit selections win; legacy records retain their deterministic fallback. */
function resolvedAvatar(playerId, player) {
  if (player && PLAYER_AVATARS.includes(player.emoji)) return player.emoji;
  const index = playerIndexFromKey(playerId);
  return index >= 0 ? PLAYER_AVATARS[index] : null;
}

function isAvatarTaken(players, avatar) {
  if (!avatar || !players || typeof players !== 'object') return false;
  return Object.entries(players).some(([playerId, player]) => resolvedAvatar(playerId, player) === avatar);
}

/**
 * Waits for anonymous auth to finish and returns the signed-in uid.
 * Security rules compare this uid against `meta/hostUid` and
 * `players/player_N/uid`, so writes must never run before it is available.
 * @returns {Promise<string>} The authenticated uid
 * @throws {Error} If there is no signed-in user
 */
async function getAuthUid() {
  const user = await authReady;
  const uid = user?.uid || auth.currentUser?.uid;
  if (!uid) {
    throw new Error('Not signed in — cannot reach the game server. Check your connection and try again.');
  }
  return uid;
}

/**
 * Generates a 4-character room code
 */
export function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    const idx = Math.floor(Math.random() * ROOM_CODE_CHARSET.length);
    code += ROOM_CODE_CHARSET[idx];
  }
  return code;
}

/**
 * Creates a new multiplayer room.
 * @param {string} hostName - Display name of the host
 * @param {string} [avatar] - Selected emoji identity
 * @returns {Promise<{ roomCode: string, playerIndex: number }>}
 */
export async function createRoom(hostName, avatar) {
  const uid = await getAuthUid();
  const selectedAvatar = requestedAvatar(avatar);
  const roomCode = generateRoomCode();
  const roomRef = ref(db, `${GAME_ID}-rooms/${roomCode}`);

  const roomData = {
    meta: {
      hostUid: uid,
      hostName: hostName,
      status: 'lobby', // lobby, playing, finished
      createdAt: Date.now(),
      lastActivity: Date.now(),
    },
    players: {
      player_0: {
        name: hostName,
        uid: uid,
        connected: true,
        eliminated: false,
        ...(selectedAvatar ? { emoji: selectedAvatar } : {}),
      },
    },
    game: null,
    chairs: {},
  };

  await set(roomRef, roomData);
  return { roomCode, playerIndex: 0 };
}

/**
 * Joins an existing room. Slot allocation and avatar uniqueness are decided in
 * one transaction on the complete players collection, so concurrent clients
 * retry against the latest committed roster instead of overwriting each other.
 *
 * @param {string} roomCode - 4-character room code
 * @param {string} playerName - Display name of the joining player
 * @param {string} [avatar] - Selected emoji identity
 * @returns {Promise<{ playerIndex: number }>}
 */
export async function joinRoom(roomCode, playerName, avatar) {
  const uid = await getAuthUid();
  const selectedAvatar = requestedAvatar(avatar);
  const roomRef = ref(db, `${GAME_ID}-rooms/${roomCode}`);

  const snapshot = await get(roomRef);
  if (!snapshot.exists()) {
    throw new Error('Room not found');
  }
  if (snapshot.val()?.meta?.status !== 'lobby') {
    throw new Error('Game already started');
  }

  const playerData = {
    name: playerName,
    uid,
    connected: true,
    eliminated: false,
    ...(selectedAvatar ? { emoji: selectedAvatar } : {}),
  };

  let reservedIndex = -1;
  let abortReason = 'join-conflict';
  const playersRef = ref(db, `${GAME_ID}-rooms/${roomCode}/players`);
  const result = await runTransaction(playersRef, (currentValue) => {
    const players = currentValue && typeof currentValue === 'object' ? currentValue : {};
    const occupied = Object.keys(players)
      .map((key) => playerIndexFromKey(key))
      .filter((index) => index >= 0);

    if (occupied.length >= MAX_PLAYERS) {
      abortReason = 'room-full';
      return undefined;
    }
    if (selectedAvatar && isAvatarTaken(players, selectedAvatar)) {
      abortReason = 'avatar-taken';
      return undefined;
    }

    const nextIndex = Array.from({ length: MAX_PLAYERS }, (_, index) => index)
      .find((index) => !occupied.includes(index));
    if (!Number.isInteger(nextIndex)) {
      abortReason = 'room-full';
      return undefined;
    }

    reservedIndex = nextIndex;
    abortReason = '';
    return {
      ...players,
      [`player_${nextIndex}`]: playerData,
    };
  }, { applyLocally: false });

  if (!result.committed || reservedIndex < 0) {
    if (abortReason === 'avatar-taken') throw new Error('That avatar is already taken');
    if (abortReason === 'room-full') throw new Error(`Room is full (${MAX_PLAYERS} players maximum)`);
    throw new Error('Could not reserve a player slot. Please try again.');
  }

  await update(ref(db, `${GAME_ID}-rooms/${roomCode}/meta`), { lastActivity: Date.now() });
  return { playerIndex: reservedIndex };
}

/**
 * Listens to room changes
 * @param {string} roomCode - Room code to listen to
 * @param {Object} callbacks - Callback functions
 * @param {Function} callbacks.onStatusChange - Called when room status changes
 * @param {Function} callbacks.onPlayersChange - Called when players join/leave
 * @param {Function} callbacks.onGameUpdate - Called when game state updates (receives game state and status)
 * @param {Function} callbacks.onChairsChange - Called when chair claims change
 *   (receives `chairs`: chairId → { playerId, claimedAt })
 * @param {Function} callbacks.onRoomDeleted - Called when room is deleted
 * @returns {Function} Unsubscribe function
 */
export function listenRoom(roomCode, callbacks) {
  const roomRef = ref(db, `${GAME_ID}-rooms/${roomCode}`);

  const unsubscribe = onValue(roomRef, (snapshot) => {
    if (!snapshot.exists()) {
      if (callbacks.onRoomDeleted) callbacks.onRoomDeleted();
      return;
    }

    const data = snapshot.val();
    const status = data.meta?.status || 'lobby';

    if (callbacks.onStatusChange) {
      callbacks.onStatusChange(status);
    }

    if (callbacks.onPlayersChange) {
      callbacks.onPlayersChange(data.players || {});
    }

    if (callbacks.onChairsChange) {
      callbacks.onChairsChange(data.chairs || {});
    }

    if (callbacks.onGameUpdate && data.game) {
      callbacks.onGameUpdate(data.game, status);
    }
  });

  return () => off(roomRef);
}

/**
 * Updates game state
 * @param {string} roomCode - Room code
 * @param {Object} gameState - Game state to write
 */
export async function writeGameState(roomCode, gameState) {
  const updates = {
    [`${GAME_ID}-rooms/${roomCode}/game`]: gameState,
    [`${GAME_ID}-rooms/${roomCode}/meta/lastActivity`]: Date.now(),
  };
  await update(ref(db), updates);
}

/**
 * Starts the game (host only)
 * @param {string} roomCode - Room code
 * @param {Object} initialGameState - Initial game state
 */
export async function startGame(roomCode, initialGameState) {
  const updates = {
    [`${GAME_ID}-rooms/${roomCode}/meta/status`]: 'playing',
    [`${GAME_ID}-rooms/${roomCode}/game`]: initialGameState,
    // A fresh game must never inherit a previous game's seating.
    [`${GAME_ID}-rooms/${roomCode}/chairs`]: null,
    [`${GAME_ID}-rooms/${roomCode}/meta/lastActivity`]: Date.now(),
  };
  await update(ref(db), updates);
}

/**
 * Ends the game
 * @param {string} roomCode - Room code
 */
export async function endGame(roomCode) {
  await update(ref(db, `${GAME_ID}-rooms/${roomCode}/meta`), {
    status: 'finished',
    lastActivity: Date.now(),
  });
}

/**
 * Deletes the room (host only)
 * @param {string} roomCode - Room code
 */
export async function deleteRoom(roomCode) {
  await remove(ref(db, `${GAME_ID}-rooms/${roomCode}`));
}

/**
 * Sets up disconnect handler for a player
 * @param {string} roomCode - Room code
 * @param {number} playerIndex - Player index
 */
export function setupDisconnectHandler(roomCode, playerIndex) {
  const playerRef = ref(db, `${GAME_ID}-rooms/${roomCode}/players/player_${playerIndex}/connected`);
  onDisconnect(playerRef).set(false);
}

/**
 * Removes a player from the room
 * @param {string} roomCode - Room code
 * @param {number} playerIndex - Player index to remove
 */
export async function removePlayer(roomCode, playerIndex) {
  await remove(ref(db, `${GAME_ID}-rooms/${roomCode}/players/player_${playerIndex}`));
}
