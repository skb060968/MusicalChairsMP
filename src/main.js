/* Musical Chairs — entry point.
 *
 * ── Platform glue (home → create/join → lobby → game → results, presence, voice,
 *    service-worker updates, deep links) plus the PEER-RUN game loop. ──
 *
 * There is no host during play. Every device runs the same clock: when the current
 * phase's deadline passes, the first connected seat fires the transition and the
 * rest follow a few hundred ms later only if the phase is still unchanged — so one
 * commit lands and the others abort quietly. A sleeping or absent host changes
 * nothing; they are simply a player who does not grab a chair.
 *
 * To rebrand: SESSION_KEY, ROOM_NS (= firebase-sync ROOM_PATH = rules block),
 * GAME_NAME, VOICE_ID.
 */
// On-device diagnostics: records failures to localStorage and adds a 5-tap
// viewer with a Copy button. Import-only integration; must come first so
// startup errors are captured too.
import './diagnostics.js';

import { showScreen, showToast } from './platform-ui.js';
import { initDeepLinkHandler, createShareHandler, showQRCode } from './deep-link-handler.js';
import {
  createRoom, joinRoom, listenRoom, listenPlayers, setupDisconnectHandler, stopPresenceTracking,
  leavePlayer, removePlayer, deleteRoom, endRoom, resetRoom, startGame, advanceGame, claimChair,
  markSelfOffline, watchReconnect, watchServerClock, serverNow, fetchRoomForRestore,
  PLAYER_AVATARS, MAX_PLAYERS,
} from './firebase-sync.js';
import {
  MIN_PLAYERS, PHASES, activeKeys, orderKeys, chairCount, phaseDeadline, dueTransition, standings,
} from './engine.js';
import {
  renderGame, setStatus, setBanner, setRoundLabel, resetStage, isMuted, toggleMute, playSound,
  startMusic, stopMusic, setActiveSpeakers, initAudio,
} from './ui.js';
import { authReady } from './firebase-config.js';
import { mountVoiceChat } from './voice-chat-widget.js';

const SESSION_KEY = 'chairs_mp_session';
const ROOM_NS = 'chairs-rooms';           // = firebase-sync ROOM_PATH = rules block
const GAME_NAME = 'Musical Chairs';
const VOICE_ID = 'chairs';
const RESULT_MS = 1800;
const LOBBY_PRUNE_DELAY_MS = 2500;
// Deadline race: seat k (among CONNECTED seats, in order) fires k × STAGGER_MS after
// the deadline, so normally exactly one device writes and the rest see it land.
const STAGGER_MS = 400;
// A write refused by the rules usually means our clock is a hair ahead of the
// server's; try again shortly rather than waiting for the next snapshot.
const RETRY_MS = 700;
const MAX_RETRIES = 4;

/* ======= STATE ======= */
let roomCode = null;
let playerIndex = null;
let isHost = false;
let roomPlayers = {};
let currentGame = null;
let unsubscribeRoom = null;
let unsubscribeReconnect = null;
let unsubscribeClock = null;
let unsubscribeJoinPreview = null;
let voiceWidget = null;

let resultsTimer = null;
let resultsShown = false;
let lastPhaseKey = '';          // `${roundId}:${round}:${phase}` last reacted to
let transitionTimer = null;
let transitionKey = null;       // generation the timer was armed for
let transitionRetries = 0;

let lobbyDisconnectedSince = {};
let lobbyPruneTimer = null;

const localSlot = () => (playerIndex != null ? `player_${playerIndex}` : null);

/* ======= SESSION ======= */
function saveSession() {
  if (roomCode != null && playerIndex != null) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode, playerIndex })); } catch (_) {}
  }
}
function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (_) {} }
function loadSession() {
  try { const r = localStorage.getItem(SESSION_KEY); return r ? JSON.parse(r) : null; } catch (_) { return null; }
}

/* ======= TEARDOWN ======= */
function clearTransitionTimer() {
  if (transitionTimer) { clearTimeout(transitionTimer); transitionTimer = null; }
  transitionKey = null;
  transitionRetries = 0;
}
function resetLoopState() {
  if (resultsTimer) { clearTimeout(resultsTimer); resultsTimer = null; }
  resultsShown = false;
  lastPhaseKey = '';
  clearTransitionTimer();
  stopMusic();
  resetStage();
}
function cleanupAndGoHome() {
  if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
  if (unsubscribeReconnect) { unsubscribeReconnect(); unsubscribeReconnect = null; }
  if (voiceWidget) { try { voiceWidget.stop(); } catch (_) {} }
  stopPresenceTracking();
  clearSession();
  roomCode = null;
  playerIndex = null;
  isHost = false;
  roomPlayers = {};
  currentGame = null;
  lobbyDisconnectedSince = {};
  if (lobbyPruneTimer) { clearTimeout(lobbyPruneTimer); lobbyPruneTimer = null; }
  resetLoopState();
  showScreen('home');
}

/* ======= PEER-RUN GAME LOOP =======
 * Re-evaluated on EVERY room snapshot (game or presence). Decides which transition
 * is due — `stop` when the music has run its time, `reveal` when the claim window
 * has closed OR every chair is taken OR everyone still standing is offline, `next`
 * once the result has been shown — and arms one timer for it, staggered by this
 * device's rank among the connected seats. The rules make the same decision
 * server-side, so a device that is early is refused, not obeyed.
 * ================================================================ */
function connectedRank() {
  const me = localSlot();
  const connected = Object.keys(roomPlayers)
    .filter((k) => roomPlayers[k]?.name && roomPlayers[k]?.connected !== false)
    .sort();
  const i = connected.indexOf(me);
  return i < 0 ? connected.length : i;
}

function scheduleTransition() {
  if (!roomCode || !currentGame || currentGame.status !== 'playing' || playerIndex == null) { clearTransitionTimer(); return; }
  const game = currentGame;
  const key = `${game.roundId}:${game.revision}:${game.phase}`;
  const now = serverNow();
  const dueNow = dueTransition(game, roomPlayers, now);
  const deadline = phaseDeadline(game);
  // Nothing due and no deadline to wait for (should not happen) → nothing to arm.
  if (!dueNow && !Number.isFinite(deadline)) { clearTransitionTimer(); return; }
  const wait = Math.max(0, dueNow ? 0 : deadline - now) + connectedRank() * STAGGER_MS + 60;
  // Same generation and a timer already armed → keep it (snapshots arrive constantly).
  // A NEW reason to fire early (e.g. the last chair just got taken) re-arms sooner.
  if (transitionKey === key && transitionTimer && !dueNow) return;
  if (transitionTimer) clearTimeout(transitionTimer);
  transitionKey = key;
  transitionTimer = setTimeout(() => { transitionTimer = null; fireTransition(key); }, wait);
}

async function fireTransition(key) {
  if (!roomCode || !currentGame || currentGame.status !== 'playing') return;
  if (`${currentGame.roundId}:${currentGame.revision}:${currentGame.phase}` !== key) return; // moved on
  const type = dueTransition(currentGame, roomPlayers, serverNow());
  if (!type) { scheduleTransition(); return; }             // not due after all — re-arm
  let result = 'denied';
  try { result = await advanceGame(roomCode, type, localSlot()); }
  catch (err) { console.error(`advanceGame(${type}) failed:`, err); }
  if (result === 'denied' && transitionRetries < MAX_RETRIES
    && `${currentGame.roundId}:${currentGame.revision}:${currentGame.phase}` === key) {
    transitionRetries += 1;
    transitionTimer = setTimeout(() => { transitionTimer = null; fireTransition(key); }, RETRY_MS);
  }
}

/* ======= RECONNECT RECONCILE ======= */
async function reconcileAfterReconnect() {
  if (!roomCode || playerIndex == null) return;
  let room = null;
  try { room = await fetchRoomForRestore(roomCode, playerIndex); }
  catch (err) { console.warn('reconnect reconcile fetch failed:', err); return; }
  if (!room || room.meta?.status === 'ended') {
    showToast('The room was closed.', 3000);
    cleanupAndGoHome();
    return;
  }
  // The room listener re-syncs game/players itself; re-arm the loop against fresh data.
  scheduleTransition();
}

/* ======= PICKERS (avatars are UNIQUE in this game) ======= */
function wireEmojiPicker(selector) {
  const picker = document.querySelector(selector);
  if (!picker) return;
  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('.emoji-btn');
    if (!btn || btn.classList.contains('taken')) return;
    picker.querySelectorAll('.emoji-btn').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
  });
}
function getSelectedEmoji(selector) {
  const picker = document.querySelector(selector);
  const sel = picker?.querySelector('.emoji-btn.selected:not(.taken)');
  if (sel) return sel.dataset.emoji;
  const free = picker?.querySelector('.emoji-btn:not(.taken)');
  return free?.dataset.emoji || null;
}
/** Grey out avatars already in the room; move the selection if it just got taken. */
function applyTakenAvatars(selector, players) {
  const picker = document.querySelector(selector);
  if (!picker) return;
  const taken = new Set(Object.values(players || {}).map((p) => p?.emoji).filter(Boolean));
  picker.querySelectorAll('.emoji-btn').forEach((b) => b.classList.toggle('taken', taken.has(b.dataset.emoji)));
  if (picker.querySelector('.emoji-btn.selected.taken')) {
    picker.querySelectorAll('.emoji-btn').forEach((b) => b.classList.remove('selected'));
    picker.querySelector('.emoji-btn:not(.taken)')?.classList.add('selected');
  }
  const hint = document.getElementById('join-avatar-hint');
  if (hint) hint.textContent = taken.size ? `· ${PLAYER_AVATARS.length - taken.size} free` : '';
}
function stopJoinPreview() {
  if (unsubscribeJoinPreview) { unsubscribeJoinPreview(); unsubscribeJoinPreview = null; }
  applyTakenAvatars('.join-emoji-picker', {});
}
function startJoinPreview(code) {
  stopJoinPreview();
  if (!/^[A-HJ-NP-Z]{4}$/.test(code)) return;
  unsubscribeJoinPreview = listenPlayers(code, (players) => applyTakenAvatars('.join-emoji-picker', players));
}

/* ======= HOME / CREATE / JOIN ======= */
function wireHome() {
  document.getElementById('btn-home-host')?.addEventListener('click', () => showScreen('create-room'));
  document.getElementById('btn-home-join')?.addEventListener('click', () => {
    showScreen('join-room');
    const code = document.getElementById('room-code-input')?.value.trim().toUpperCase();
    if (code) startJoinPreview(code);
  });
  document.getElementById('btn-home-help')?.addEventListener('click', () => showScreen('how-to'));
  document.getElementById('btn-back-help')?.addEventListener('click', () => showScreen('home'));
}

function wireCreateRoom() {
  document.getElementById('btn-create-submit')?.addEventListener('click', async () => {
    const name = document.getElementById('create-name-input')?.value.trim();
    if (!name) { showToast('Please enter your name'); return; }
    const btn = document.getElementById('btn-create-submit');
    if (btn) btn.disabled = true;
    try {
      const result = await createRoom(name, getSelectedEmoji('.create-emoji-picker'));
      roomCode = result.roomCode;
      playerIndex = result.playerIndex;
      isHost = true;
      saveSession();
      setupLobby();
    } catch (err) { console.error('Create room failed:', err); showToast('Failed to create room.'); }
    finally { if (btn) btn.disabled = false; }
  });
  document.getElementById('btn-back-create')?.addEventListener('click', () => showScreen('home'));
}

function wireJoinRoom() {
  const codeInput = document.getElementById('room-code-input');
  codeInput?.addEventListener('input', () => {
    const code = codeInput.value.trim().toUpperCase();
    if (code.length === 4) startJoinPreview(code); else stopJoinPreview();
  });
  document.getElementById('btn-join-submit')?.addEventListener('click', async () => {
    const code = codeInput?.value.trim().toUpperCase();
    const name = document.getElementById('join-name-input')?.value.trim();
    if (!code || code.length !== 4) { showToast('Enter a valid 4-character room code'); return; }
    if (!name) { showToast('Please enter your name'); return; }
    const emoji = getSelectedEmoji('.join-emoji-picker');
    if (!emoji) { showToast('All avatars are taken — the room is full'); return; }
    const btn = document.getElementById('btn-join-submit');
    if (btn) btn.disabled = true;
    try {
      const result = await joinRoom(code, name, emoji);
      if (!result.success) { showToast(result.reason || 'Failed to join'); return; }
      stopJoinPreview();
      roomCode = code;
      playerIndex = result.playerIndex;
      isHost = result.playerIndex === 0;
      saveSession();
      setupLobby();
    } catch (err) { console.error('Join failed:', err); showToast('Failed to join room.'); }
    finally { if (btn) btn.disabled = false; }
  });
  document.getElementById('btn-back-join')?.addEventListener('click', () => { stopJoinPreview(); showScreen('home'); });
}

/* ======= LOBBY ======= */
function isLobbyPlayerVisible(key, player) {
  if (player?.connected !== false) return true;
  if (key === 'player_0' || key === `player_${playerIndex}`) return true;
  const since = lobbyDisconnectedSince[key];
  return typeof since === 'number' && Date.now() - since < LOBBY_PRUNE_DELAY_MS;
}
function trackLobbyDisconnections(players) {
  const stamp = Date.now();
  const next = {};
  let pruneNeeded = false;
  Object.keys(players).forEach((key) => {
    if (players[key]?.name && players[key]?.connected === false) {
      next[key] = lobbyDisconnectedSince[key] || stamp;
      const prunable = key !== 'player_0' && key !== `player_${playerIndex}`;
      if (prunable && stamp - next[key] < LOBBY_PRUNE_DELAY_MS) pruneNeeded = true;
    }
  });
  lobbyDisconnectedSince = next;
  if (!pruneNeeded || lobbyPruneTimer !== null) return;
  lobbyPruneTimer = setTimeout(() => { lobbyPruneTimer = null; refreshLobby(roomPlayers); }, LOBBY_PRUNE_DELAY_MS);
}
function renderLobbyPlayers(playersArr, playerKeys) {
  const list = document.getElementById('lobby-player-list');
  if (!list) return;
  list.replaceChildren();
  playersArr.forEach((player, index) => {
    const li = document.createElement('li');
    if (player.connected === false) li.classList.add('disconnected');
    const emoji = document.createElement('span');
    emoji.textContent = player.emoji || '🧑';
    const name = document.createElement('span');
    name.textContent = player.name || `Player ${index + 1}`;
    name.style.flex = '1';
    li.append(emoji, name);
    if (player.connected === false) {
      const off = document.createElement('span');
      off.className = 'offline-badge';
      off.textContent = 'OFFLINE';
      li.appendChild(off);
    }
    if (playerKeys[index] === 'player_0') {
      const badge = document.createElement('span');
      badge.className = 'host-badge';
      badge.textContent = 'HOST';
      li.appendChild(badge);
    } else if (isHost) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-player-btn';
      removeBtn.textContent = '✕';
      removeBtn.title = 'Remove player';
      removeBtn.dataset.playerIndex = String(Number.parseInt(playerKeys[index].replace('player_', ''), 10));
      removeBtn.dataset.playerName = player.name || 'Player';
      li.appendChild(removeBtn);
    }
    list.appendChild(li);
  });
}
function refreshLobby(players) {
  const namedKeys = Object.keys(players).filter((k) => players[k] && players[k].name).sort();
  trackLobbyDisconnections(players);
  const visibleKeys = namedKeys.filter((k) => isLobbyPlayerVisible(k, players[k]));
  const connectedCount = namedKeys.filter((k) => players[k]?.connected !== false).length;
  const startBtn = document.getElementById('btn-start-online');
  if (startBtn && isHost) startBtn.disabled = connectedCount < MIN_PLAYERS;
  const note = document.getElementById('lobby-note');
  if (note) {
    note.hidden = false;
    note.textContent = connectedCount < MIN_PLAYERS
      ? `Need ${MIN_PLAYERS} players to start · ${MAX_PLAYERS} seats`
      : `${connectedCount} of ${MAX_PLAYERS} seats · ${Math.max(0, connectedCount - 1)} chairs in round 1`;
  }
  renderLobbyPlayers(visibleKeys.map((k) => players[k]), visibleKeys);
}

function setupLobby() {
  resetLoopState();
  showScreen('lobby');
  const codeEl = document.getElementById('lobby-room-code');
  if (codeEl) codeEl.textContent = roomCode;
  const mcCode = document.getElementById('mc-room-code');
  if (mcCode) mcCode.textContent = roomCode;
  const btnStart = document.getElementById('btn-start-online');
  const waiting = document.getElementById('lobby-waiting');
  if (btnStart) btnStart.hidden = !isHost;
  if (waiting) waiting.hidden = isHost;
  const btnLeave = document.getElementById('btn-leave-lobby');
  if (btnLeave) btnLeave.disabled = false;

  const list = document.getElementById('lobby-player-list');
  if (list && !list.dataset.removeWired) {
    list.dataset.removeWired = 'true';
    list.addEventListener('click', async (event) => {
      const btn = event.target.closest('.remove-player-btn');
      if (!btn || btn.disabled || !roomCode) return;
      const idx = Number.parseInt(btn.dataset.playerIndex, 10);
      if (Number.isNaN(idx)) return;
      btn.disabled = true;
      try { await removePlayer(roomCode, idx); showToast(`${btn.dataset.playerName} removed`); }
      catch (err) { console.error('Remove failed:', err); showToast('Failed to remove player'); btn.disabled = false; }
    });
  }

  setupDisconnectHandler(roomCode, playerIndex).catch((e) => console.warn('Presence setup failed:', e.message));
  if (!unsubscribeClock) unsubscribeClock = watchServerClock(() => { if (currentGame) scheduleTransition(); });
  if (unsubscribeReconnect) unsubscribeReconnect();
  unsubscribeReconnect = watchReconnect(reconcileAfterReconnect);
  if (unsubscribeRoom) unsubscribeRoom();
  unsubscribeRoom = listenRoom(roomCode, {
    onPlayersChange: (players) => {
      roomPlayers = players;
      isHost = playerIndex === 0;
      refreshLobby(players);
      if (currentGame) { renderGameView(); scheduleTransition(); }   // presence changes what is due
      refreshPlayAgain();
    },
    onGameUpdate: (game) => handleGameUpdate(game),
    onStatusChange: (status, room) => {
      if (room?.meta?.status === 'ended' && room?.game?.status !== 'finished') {
        showToast('The host closed the room.', 3000);
        cleanupAndGoHome();
        return;
      }
      if (status === 'lobby') {
        currentGame = null;
        resetLoopState();
        const lobby = document.getElementById('lobby');
        if (!lobby || lobby.hasAttribute('hidden')) setupLobby();
      }
    },
    onRoomDeleted: () => { showToast('The host closed the room.', 3000); cleanupAndGoHome(); },
    onError: (err) => { console.error('Room listener error:', err); showToast('Connection error.'); },
  });
}

function wireLobby() {
  document.getElementById('btn-share-code')?.addEventListener('click', () => {
    if (roomCode) createShareHandler(roomCode, GAME_NAME)();
  });
  document.getElementById('btn-qr-code')?.addEventListener('click', () => {
    if (roomCode) showQRCode(roomCode, GAME_NAME);
  });
  document.getElementById('btn-start-online')?.addEventListener('click', async () => {
    if (!isHost || !roomCode) return;
    const btn = document.getElementById('btn-start-online');
    try {
      // Drop at start: only players connected right now are dealt in.
      const connectedKeys = Object.keys(roomPlayers)
        .filter((k) => roomPlayers[k] && roomPlayers[k].name && roomPlayers[k].connected !== false)
        .sort();
      if (connectedKeys.length < MIN_PLAYERS) { showToast(`Need ${MIN_PLAYERS} connected players to start`); return; }
      if (btn) btn.disabled = true;
      await startGame(roomCode, connectedKeys);
    } catch (err) {
      console.error('Start failed:', err);
      showToast('Failed to start game.');
      if (btn) btn.disabled = false;
    }
  });
  document.getElementById('btn-leave-lobby')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-leave-lobby');
    if (btn) btn.disabled = true;
    try {
      if (isHost && roomCode) await deleteRoom(roomCode);
      else if (roomCode && playerIndex != null) await leavePlayer(roomCode, playerIndex);
    } catch (err) { console.error('Leave failed:', err); }
    finally { cleanupAndGoHome(); }
  });
}

/* ======= GAME SCREEN ======= */
function showGameScreen() {
  const gameplay = document.getElementById('gameplay');
  if (gameplay && !gameplay.hasAttribute('hidden')) return;
  showScreen('gameplay');
  if (!voiceWidget) {
    voiceWidget = mountVoiceChat({
      mount: '#voice-widget',
      game: VOICE_ID,
      getRoomCode: () => roomCode,
      getIdentity: () => localSlot(),
      getDisplayName: () => roomPlayers[localSlot()]?.name || `Player ${playerIndex + 1}`,
      getIdToken: async () => (await authReady).getIdToken(),
      onSpeakers: (ids) => setActiveSpeakers(ids),
      notify: (m) => showToast(m),
    });
  }
}

/** The local player grabbed a chair (drag or tap). Optimistic in the UI; the rules
 *  are the referee — a refusal means someone else got there first. */
function doClaim(chair) {
  if (!roomCode || playerIndex == null) return;
  claimChair(roomCode, playerIndex, chair).then((ok) => {
    if (ok) { playSound('tap'); return; }
    showToast('Too slow — that chair was taken!', 1800);
    renderGameView();                                   // snap back to the truth
  }).catch((err) => {
    console.error('Claim failed:', err);
    showToast('Could not claim the chair.');
    renderGameView();
  });
}

function renderGameView() {
  if (!currentGame) return;
  renderGame({ game: currentGame, players: roomPlayers, localSlot: localSlot(), onClaim: doClaim });
}

function nameOf(key) { return roomPlayers[key]?.name || 'A player'; }

/** Status line for the local player's situation this phase. */
function setPlayMessage(game) {
  const me = localSlot();
  const inGame = game.active?.[me] === true;
  const seated = Number.isInteger(game.claims?.[me]);
  const chairs = chairCount(game);
  const players = activeKeys(game).length;
  setRoundLabel(`Round ${game.round} · ${players} players · ${chairs} ${chairs === 1 ? 'chair' : 'chairs'}`);
  if (game.status === 'finished') { setStatus(`${nameOf(game.winnerKey)} takes the last chair!`); return; }
  if (game.phase === PHASES.MUSIC) {
    setStatus(inGame ? '🎵 Music playing — get ready to grab a chair…' : '🎵 Music playing — you are watching this round.');
  } else if (game.phase === PHASES.CLAIMING) {
    if (!inGame) setStatus('Music stopped — watching them scramble…');
    else if (seated) setStatus('🪑 You are seated! Waiting for the others…');
    else setStatus('🛑 Music stopped — drag your avatar to a free chair, or tap one!');
  } else if (game.phase === PHASES.REVEAL) {
    const out = orderKeys(game).filter((k) => game.out?.[k] === game.round);
    if (!out.length) setStatus('Everyone found a chair — again!');
    else setStatus(`${out.map(nameOf).join(', ')} ${out.length === 1 ? 'is' : 'are'} out!`);
  }
}

/** Sounds, music and banners fire once per phase (snapshots repeat constantly). */
function reactToPhase(game) {
  const key = `${game.roundId}:${game.round}:${game.phase}:${game.status}`;
  if (key === lastPhaseKey) return;
  lastPhaseKey = key;
  if (game.status === 'finished') {
    stopMusic();
    setBanner(`🏆 ${nameOf(game.winnerKey)} wins!`);
    playSound('win');
    return;
  }
  if (game.phase === PHASES.MUSIC) {
    setBanner(`Round ${game.round}`);
    setTimeout(() => { if (lastPhaseKey === key) setBanner(''); }, 1600);
    startMusic();
  } else if (game.phase === PHASES.CLAIMING) {
    stopMusic();
    const me = localSlot();
    setBanner(game.active?.[me] === true ? '🛑 Grab a chair!' : '🛑 Music stopped!');
    setTimeout(() => { if (lastPhaseKey === key) setBanner(''); }, 1400);
  } else if (game.phase === PHASES.REVEAL) {
    stopMusic();
    const out = orderKeys(game).filter((k) => game.out?.[k] === game.round);
    if (out.length) {
      playSound('out');
      setBanner(`🙈 ${out.map(nameOf).join(' & ')} ${out.length === 1 ? 'is' : 'are'} out!`);
    } else {
      setBanner('Nobody sat down — again!');
    }
  }
}

function handleGameUpdate(game) {
  if (!game) return;
  currentGame = game;
  // Once the results screen is up, later room snapshots (a player leaving via
  // Home, a presence flip) must not drag everyone back to the finished stage.
  if (game.status === 'finished' && resultsShown) return;
  showGameScreen();
  renderGameView();
  setPlayMessage(game);
  reactToPhase(game);
  scheduleTransition();

  if (game.status === 'finished' && !resultsShown && !resultsTimer) {
    resultsTimer = setTimeout(() => { resultsTimer = null; showResults(currentGame); }, RESULT_MS);
  }
}

/* ======= RESULTS ======= */
/** Play Again belongs to the host — or, if the host has gone, to the first connected seat. */
function mayRestart() {
  if (!currentGame || currentGame.status !== 'finished') return false;
  if (isHost) return true;
  if (roomPlayers.player_0?.connected !== false) return false;
  const connected = Object.keys(roomPlayers).filter((k) => roomPlayers[k]?.name && roomPlayers[k]?.connected !== false).sort();
  return connected[0] === localSlot();
}

function showResults(game) {
  if (resultsShown) return;
  resultsShown = true;
  clearTransitionTimer();
  const me = localSlot();
  const winner = game.winnerKey;
  const wp = roomPlayers[winner] || {};

  const display = document.getElementById('winner-display');
  if (display) {
    display.replaceChildren();
    const line = document.createElement('div');
    line.textContent = `${wp.emoji || '🏆'} ${wp.name || 'Someone'} wins!${winner === me ? ' 🎉' : ''}`;
    display.appendChild(line);
    const others = orderKeys(game).filter((k) => k !== winner && roomPlayers[k]?.connected === false);
    if (others.length && others.length === orderKeys(game).length - 1) {
      const note = document.createElement('div');
      note.className = 'results-note';
      note.textContent = 'Everyone else went offline';
      display.appendChild(note);
    }
  }
  const list = document.getElementById('results-list');
  if (list) {
    list.replaceChildren();
    standings(game).forEach((row) => {
      const p = roomPlayers[row.key] || {};
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.textContent = `${row.winner ? '🏆 ' : ''}${p.emoji || '🧑'} ${p.name || 'Player'}${row.key === me ? ' (you)' : ''}`;
      const right = document.createElement('span');
      right.textContent = row.winner ? 'last one seated' : `🪑 out in round ${row.survived}`;
      li.append(left, right);
      if (row.winner) li.classList.add('winner');
      list.appendChild(li);
    });
  }
  refreshPlayAgain();
  showScreen('results');
}

/** Re-evaluated on presence changes too: if the host drops on the results screen,
 *  the first connected seat inherits Play Again. */
function refreshPlayAgain() {
  const playAgain = document.getElementById('btn-play-again');
  if (!playAgain || !resultsShown) return;
  if (playAgain.textContent === 'Restarting…') return;
  playAgain.hidden = false;
  const can = mayRestart();
  playAgain.textContent = can ? 'Play Again' : (roomPlayers.player_0?.connected === false ? 'Waiting…' : 'Waiting for host…');
  playAgain.disabled = !can;
}

function wireResults() {
  document.getElementById('btn-play-again')?.addEventListener('click', async () => {
    if (!roomCode || !mayRestart()) return;
    const btn = document.getElementById('btn-play-again');
    if (btn) { btn.disabled = true; btn.textContent = 'Restarting…'; }
    try {
      await resetRoom(roomCode);
      resetLoopState();
      setupLobby();
    } catch (err) { console.error('Restart failed:', err); showToast('Could not restart.'); if (btn) btn.disabled = false; }
  });
  document.getElementById('btn-home')?.addEventListener('click', async () => {
    try {
      if (isHost && roomCode) { await endRoom(roomCode); await deleteRoom(roomCode); }
      else if (roomCode && playerIndex != null) await leavePlayer(roomCode, playerIndex);
    } catch (err) { console.error('Leave from results failed:', err); }
    cleanupAndGoHome();
  });
}

/* ======= MUTE + LEAVE ======= */
function wireGameControls() {
  const mute = document.getElementById('mute-toggle');
  const renderMute = () => {
    if (!mute) return;
    const muted = isMuted();
    mute.textContent = muted ? '🔇' : '🔊';
    mute.setAttribute('aria-pressed', String(muted));
    mute.setAttribute('aria-label', muted ? 'Unmute game sound' : 'Mute game sound');
  };
  renderMute();
  mute?.addEventListener('click', () => { toggleMute(); renderMute(); });

  // Leaving a running game — for the host too. The room stays alive and the game
  // carries on; whoever leaves is simply out at the next chair deadline.
  document.getElementById('btn-end-game')?.addEventListener('click', async () => {
    if (!roomCode || playerIndex == null) return;
    const inGame = currentGame?.active?.[localSlot()] === true && currentGame?.status === 'playing';
    const ok = window.confirm(inGame ? 'Leave the game? You will be out, but the others keep playing.' : 'Leave the game?');
    if (!ok) return;
    try { await markSelfOffline(roomCode, playerIndex); }
    catch (err) { console.error('markSelfOffline failed:', err); }
    cleanupAndGoHome();
  });
}

/* ======= SERVICE WORKER ======= */
function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let waiting = null;
  let approved = false;
  const toast = document.getElementById('updateToast');
  const reload = document.getElementById('btn-update-reload');
  const later = document.getElementById('btn-update-later');
  const message = document.getElementById('update-toast-message');
  const show = (w) => { waiting = w; if (toast) toast.hidden = false; };
  reload?.addEventListener('click', () => {
    if (!waiting || approved) return;
    approved = true;
    reload.disabled = true;
    reload.textContent = 'Updating…';
    reload.setAttribute('aria-busy', 'true');
    if (later) later.disabled = true;
    if (message) message.textContent = 'Applying update… the app will reload automatically.';
    if (toast) toast.setAttribute('aria-busy', 'true');
    try {
      waiting.postMessage({ type: 'SKIP_WAITING' });
    } catch (_) {
      approved = false;
      reload.disabled = false;
      reload.textContent = 'Try again';
      reload.removeAttribute('aria-busy');
      if (later) later.disabled = false;
      if (message) message.textContent = 'Update could not start. Please try again.';
    }
  });
  later?.addEventListener('click', () => { if (toast) toast.hidden = true; });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (approved) window.location.reload();
  });
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      if (reg.waiting) show(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) show(reg.waiting || w);
        });
      });
      setInterval(() => reg.update().catch(() => {}), 5 * 60 * 1000);
    } catch (_) {}
  }, { once: true });
}

/* ======= INIT ======= */
async function init() {
  wireHome();
  wireCreateRoom();
  wireJoinRoom();
  wireEmojiPicker('.create-emoji-picker');
  wireEmojiPicker('.join-emoji-picker');
  wireLobby();
  wireResults();
  wireGameControls();
  setupServiceWorker();
  initAudio();

  try { await authReady; } catch (_) {
    showToast('Could not connect. Check your connection and reload.', 4000);
    showScreen('home');
    return;
  }

  const linkedRoom = initDeepLinkHandler({
    roomInputId: 'room-code-input',
    joinScreenId: 'join-room',
    gameName: GAME_NAME,
    showScreenFn: showScreen,
  });
  // A prefilled code never fires the input event — start the taken-avatar preview here.
  if (linkedRoom) { showScreen('join-room'); startJoinPreview(String(linkedRoom).toUpperCase()); return; }

  const session = loadSession();
  if (session?.roomCode && session.playerIndex != null) {
    try {
      const restored = await fetchRoomForRestore(session.roomCode, session.playerIndex);
      if (restored && restored.meta?.status !== 'ended') {
        roomCode = session.roomCode;
        playerIndex = session.playerIndex;
        isHost = session.playerIndex === 0;
        roomPlayers = {};
        setupLobby();
        return;
      }
    } catch (_) {}
    clearSession();
  }

  // Anonymous sign-in takes a network round-trip on a first visit, and the home
  // buttons are already live — so the player may have opened Create/Join and started
  // typing. Only fall back to home if they have not moved on.
  if (!document.querySelector('.screen:not([hidden])') || !document.getElementById('home')?.hasAttribute('hidden')) showScreen('home');
}

init();
