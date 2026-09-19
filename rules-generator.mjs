// Generates the `chairs-rooms` rules block (peer-run Musical Chairs) and merges it into
// skb-games/firebase-rules.json. Everything player-indexed is enumerated 0..7 because the
// rules language has no loops.
import fs from 'node:fs';
const file = 'c:/Users/sunil/OneDrive/Desktop/my games/skb-games/firebase-rules.json';
const BLOCK = 'chairs-rooms';
const R = `root.child('${BLOCK}').child($roomCode)`;
const G = `${R}.child('game')`;
const P = (k) => `${R}.child('players/${k}')`;
const keys = Array.from({ length: 8 }, (_, i) => `player_${i}`);
const AVATARS = ['🥷', '🧙', '🦸', '👷', '🤴', '👸', '🧝', '🧛'];
const and = (xs) => xs.join(' && ');
const or = (xs) => `(${xs.join(' || ')})`;
const sum = (xs) => `(${xs.join(' + ')})`;

// ---- writer identity ----
const member = or(keys.map((k) => `${P(k)}.child('uid').val() === auth.uid`));
const connectedMember = or(keys.map((k) => `(${P(k)}.child('uid').val() === auth.uid && ${P(k)}.child('connected').val() === true)`));
const ACTOR = `newData.child('operation/actorKey').val()`;
const actorOk = `newData.child('operation/actorKey').isString() && ${ACTOR}.matches(/^player_[0-7]$/) && ${R}.child('players').child(${ACTOR}).child('uid').val() === auth.uid && ${R}.child('players').child(${ACTOR}).child('connected').val() === true`;

// ---- "unchanged" helpers that are safe when a child is absent on either side ----
const same = (path) => `((!data.child('${path}').exists() && !newData.child('${path}').exists()) || newData.child('${path}').val() === data.child('${path}').val())`;
const pinnedAll = (prefix) => and(keys.map((k) => same(`${prefix}/${k}`)));
const pinnedOrder = and(Array.from({ length: 8 }, (_, i) => same(`order/${i}`)));
const playersPinned = and(keys.map((k) => `((!data.child('players/${k}').exists() && !newData.child('players/${k}').exists()) || newData.child('players/${k}/uid').val() === data.child('players/${k}/uid').val())`));

// ---- counts over the CURRENT node ----
const claimsCount = sum(keys.map((k) => `(data.child('claims/${k}').exists() ? 1 : 0)`));
const activeCount = sum(keys.map((k) => `(data.child('active/${k}').val() === true ? 1 : 0)`));
const remainingCount = sum(keys.map((k) => `(newData.child('active/${k}').val() === true ? 1 : 0)`));
const anyClaims = `${claimsCount} > 0`;
const settledAll = and(keys.map((k) => `(data.child('active/${k}').val() !== true || data.child('claims/${k}').exists() || ${P(k)}.child('connected').val() === false)`));
// Someone claimed → everyone still in without a chair is out this round.
// Nobody claimed (a whole table asleep) → nothing changes and the round replays.
const elim = (k) => `(data.child('active/${k}').val() === true && !data.child('claims/${k}').exists())`;
const withElims = and(keys.map((k) => and([
  `((newData.child('active/${k}').val() === true) === (data.child('active/${k}').val() === true && data.child('claims/${k}').exists()))`,
  `((${elim(k)} && newData.child('out/${k}').val() === data.child('round').val()) || (!${elim(k)} && ${same(`out/${k}`)}))`,
])));
const revealPerPlayer = `((${anyClaims} && ${withElims}) || (!(${anyClaims}) && ${pinnedAll('active')} && ${pinnedAll('out')}))`;

// ---- game envelope shared by every transition ----
const envelope = and([
  `data.exists() && newData.exists()`,
  `data.child('status').val() === 'playing'`,
  `newData.child('revision').val() === data.child('revision').val() + 1`,
  `newData.child('roundId').val() === data.child('roundId').val()`,
  `newData.child('operation/ownerUid').val() === auth.uid`,
  `newData.child('operation/revision').val() === newData.child('revision').val()`,
  actorOk,
  pinnedOrder,
  `newData.child('phaseAt').isNumber() && newData.child('phaseAt').val() >= now - 15000 && newData.child('phaseAt').val() <= now + 15000`,
]);

const stop = and([
  `newData.child('operation/type').val() === 'stop'`,
  `data.child('phase').val() === 'music' && newData.child('phase').val() === 'claiming'`,
  `data.child('phaseAt').isNumber() && now >= data.child('phaseAt').val() + data.child('musicMs').val() - 1500`,
  `!newData.child('claims').exists()`,
  `newData.child('status').val() === 'playing' && !newData.child('winnerKey').exists()`,
  `newData.child('round').val() === data.child('round').val() && newData.child('musicMs').val() === data.child('musicMs').val()`,
  pinnedAll('active'), pinnedAll('out'),
]);

const reveal = and([
  `newData.child('operation/type').val() === 'reveal'`,
  `data.child('phase').val() === 'claiming' && newData.child('phase').val() === 'reveal'`,
  or([
    `(data.child('phaseAt').isNumber() && now >= data.child('phaseAt').val() + 10000 - 1500)`,
    `${claimsCount} >= ${activeCount} - 1`,
    settledAll,
  ]),
  `newData.child('round').val() === data.child('round').val() && newData.child('musicMs').val() === data.child('musicMs').val()`,
  pinnedAll('claims'),
  revealPerPlayer,
  or([
    `(${remainingCount} === 1 && newData.child('status').val() === 'finished' && newData.child('active').child(newData.child('winnerKey').val()).val() === true)`,
    `(${remainingCount} > 1 && newData.child('status').val() === 'playing' && !newData.child('winnerKey').exists())`,
  ]),
]);

const next = and([
  `newData.child('operation/type').val() === 'next'`,
  `data.child('phase').val() === 'reveal' && newData.child('phase').val() === 'music'`,
  `data.child('phaseAt').isNumber() && now >= data.child('phaseAt').val() + 3500 - 1500`,
  `newData.child('round').val() === data.child('round').val() + 1`,
  `(newData.child('musicMs').val() === 10000 || newData.child('musicMs').val() === 20000 || newData.child('musicMs').val() === 30000)`,
  `!newData.child('claims').exists()`,
  `newData.child('status').val() === 'playing' && !newData.child('winnerKey').exists()`,
  `${activeCount} >= 2`,
  pinnedAll('active'), pinnedAll('out'),
]);

const gameWrite = `auth != null && ${envelope} && (${stop} || ${reveal} || ${next})`;

// ---- a player's own chair claim ----
const claimWrite = and([
  `auth != null && $playerKey.matches(/^player_[0-7]$/)`,
  `!data.exists() && newData.isNumber() && newData.val() % 1 === 0 && newData.val() >= 0`,
  `${R}.child('players').child($playerKey).child('uid').val() === auth.uid`,
  `${G}.child('status').val() === 'playing' && ${G}.child('phase').val() === 'claiming'`,
  `${G}.child('active').child($playerKey).val() === true`,
  `${G}.child('phaseAt').isNumber() && now <= ${G}.child('phaseAt').val() + 10000 + 1500`,
  `newData.val() < ${sum(keys.map((k) => `(${G}.child('active/${k}').val() === true ? 1 : 0)`))} - 1`,
  and(keys.map((k) => `($playerKey === '${k}' || ${G}.child('claims/${k}').val() !== newData.val())`)),
]);

// ---- room-level writes: create / delete / start / reset ----
const noJoiners = and(keys.slice(1).map((k) => `!newData.child('players/${k}').exists()`));
const create = and([
  `!data.exists() && newData.exists()`,
  `newData.child('schemaVersion').val() === 2`,
  `newData.child('meta/hostUid').val() === auth.uid && newData.child('meta/status').val() === 'lobby'`,
  `newData.child('players/player_0/uid').val() === auth.uid`, noJoiners,
  `!newData.child('game').exists()`,
]);
const del = `data.exists() && !newData.exists() && data.child('meta/hostUid').val() === auth.uid`;
const start = and([
  `data.exists() && newData.exists() && data.child('meta/hostUid').val() === auth.uid`,
  `data.child('meta/status').val() === 'lobby' && newData.child('meta/status').val() === 'active'`,
  `!data.child('game').exists() && newData.child('game/status').val() === 'playing' && newData.child('game/revision').val() === 0`,
  `newData.child('game/operation/type').val() === 'start' && newData.child('game/operation/ownerUid').val() === auth.uid`,
  `newData.child('game/phase').val() === 'music' && newData.child('game/round').val() === 1 && !newData.child('game/claims').exists() && !newData.child('game/out').exists() && !newData.child('game/winnerKey').exists()`,
  `newData.child('game/phaseAt').isNumber() && newData.child('game/phaseAt').val() >= now - 15000 && newData.child('game/phaseAt').val() <= now + 15000`,
  `newData.child('game/order/1').exists()`,
  playersPinned,
]);
const reset = and([
  `data.exists() && newData.exists()`,
  `data.child('meta/status').val() === 'active' && data.child('game/status').val() === 'finished'`,
  `newData.child('meta/status').val() === 'lobby' && !newData.child('game').exists()`,
  playersPinned,
  or([`data.child('meta/hostUid').val() === auth.uid`, `(data.child('players/player_0/connected').val() === false && ${connectedMember})`]),
]);
const roomWrite = `auth != null && $roomCode.matches(/^[A-HJ-NP-Z]{4}$/) && ((${create}) || (${del}) || (${start}) || (${reset}))`;

// ---- players ----
const playerWrite = `auth != null && $playerId.matches(/^player_[0-7]$/) && $playerId !== 'player_0' && ((!data.exists() && newData.exists() && ${R}.child('meta/status').val() === 'lobby' && newData.child('uid').val() === auth.uid) || (data.exists() && !newData.exists() && (${R}.child('meta/status').val() === 'lobby' || ${R}.child('game/status').val() === 'finished' || ${R}.child('meta/status').val() === 'ended') && (data.child('uid').val() === auth.uid || ${R}.child('meta/hostUid').val() === auth.uid)))`;
const emojiUnique = and(keys.map((k) => `($playerId === '${k}' || newData.parent().child('${k}/emoji').val() !== newData.child('emoji').val())`));
const uidUnique = and(keys.map((k) => `($playerId === '${k}' || newData.parent().child('${k}/uid').val() !== newData.child('uid').val())`));
const playerValidate = and([
  `$playerId.matches(/^player_[0-7]$/) && newData.hasChildren(['name','emoji','uid','connected','joinedAt'])`,
  `(!data.exists() || (newData.child('name').val() === data.child('name').val() && newData.child('emoji').val() === data.child('emoji').val() && newData.child('uid').val() === data.child('uid').val() && newData.child('joinedAt').val() === data.child('joinedAt').val()))`,
  emojiUnique, uidUnique,
]);
const emojiWhitelist = `newData.isString() && ${or(AVATARS.map((e) => `newData.val() === '${e}'`))}`;

const orderIndex = `$idx.matches(/^[0-7]$/) && newData.isString() && newData.val().matches(/^player_[0-7]$/) && ${R}.child('players').child(newData.val()).exists()`;

const block = {
  $roomCode: {
    '.read': `auth != null && $roomCode.matches(/^[A-HJ-NP-Z]{4}$/)`,
    '.write': roomWrite,
    '.validate': `newData.hasChildren(['schemaVersion','meta','players']) && newData.child('players/player_0').exists() && (newData.child('meta/status').val() !== 'active' || newData.child('game').exists())`,
    schemaVersion: { '.validate': `newData.val() === 2 && (!data.exists() || newData.val() === data.val())` },
    meta: {
      // The host may flag the room ended (endRoom) — everything else about meta is
      // written through the room-level start/reset branches.
      '.write': `auth != null && data.exists() && newData.exists() && ${R}.child('meta/hostUid').val() === auth.uid && newData.child('hostUid').val() === data.child('hostUid').val() && (newData.child('status').val() === data.child('status').val() || newData.child('status').val() === 'ended')`,
      '.validate': `newData.hasChildren(['hostUid','hostName','status','createdAt','lastActivity'])`,
      hostUid: { '.validate': `newData.isString() && newData.val().length >= 1 && newData.val().length <= 128 && (!data.exists() || newData.val() === data.val())` },
      hostName: { '.validate': `newData.isString() && newData.val().length >= 1 && newData.val().length <= 16 && (!data.exists() || newData.val() === data.val())` },
      status: { '.validate': `newData.isString() && (newData.val() === 'lobby' || newData.val() === 'active' || newData.val() === 'ended')` },
      createdAt: { '.validate': `newData.isNumber() && newData.val() % 1 === 0 && (!data.exists() || newData.val() === data.val())` },
      lastActivity: { '.validate': `newData.isNumber() && newData.val() % 1 === 0 && newData.val() <= now + 60000` },
      $other: { '.validate': false },
    },
    players: {
      $playerId: {
        '.write': playerWrite,
        '.validate': playerValidate,
        name: { '.validate': `newData.isString() && newData.val().length >= 1 && newData.val().length <= 16` },
        emoji: { '.validate': emojiWhitelist },
        uid: { '.validate': `newData.isString() && newData.val().length >= 1 && newData.val().length <= 128` },
        // Own .write so onDisconnect registrations are accepted (never rely on the parent).
        connected: { '.write': `auth != null && data.parent().child('uid').val() === auth.uid`, '.validate': `newData.isBoolean()` },
        joinedAt: { '.validate': `newData.isNumber() && newData.val() % 1 === 0 && (!data.exists() || newData.val() === data.val())` },
        $other: { '.validate': false },
      },
    },
    game: {
      '.write': gameWrite,
      // Kept to fields that are ALWAYS present, so a player's claim (a child write)
      // still satisfies it. Phase-specific shape is enforced by the .write branches.
      '.validate': `newData.hasChildren(['status','roundId','revision','round','phase','phaseAt','musicMs','order','active','operation'])`,
      status: { '.validate': `newData.val() === 'playing' || newData.val() === 'finished'` },
      roundId: { '.validate': `newData.isNumber() && (!data.exists() || newData.val() === data.val())` },
      revision: { '.validate': `newData.isNumber() && newData.val() % 1 === 0 && newData.val() >= 0` },
      round: { '.validate': `newData.isNumber() && newData.val() % 1 === 0 && newData.val() >= 1 && newData.val() <= 200` },
      phase: { '.validate': `newData.val() === 'music' || newData.val() === 'claiming' || newData.val() === 'reveal'` },
      phaseAt: { '.validate': `newData.isNumber()` },
      musicMs: { '.validate': `newData.val() === 10000 || newData.val() === 20000 || newData.val() === 30000` },
      order: { $idx: { '.validate': orderIndex } },
      active: { $playerKey: { '.validate': `$playerKey.matches(/^player_[0-7]$/) && newData.val() === true` } },
      claims: { $playerKey: { '.write': claimWrite, '.validate': `$playerKey.matches(/^player_[0-7]$/) && newData.isNumber() && newData.val() % 1 === 0 && newData.val() >= 0 && newData.val() <= 6` } },
      out: { $playerKey: { '.validate': `$playerKey.matches(/^player_[0-7]$/) && newData.isNumber() && newData.val() % 1 === 0 && newData.val() >= 1` } },
      winnerKey: { '.validate': `newData.isString() && newData.val().matches(/^player_[0-7]$/)` },
      operation: {
        '.validate': `newData.hasChildren(['type','ownerUid','actorKey','roundId','revision','timestamp']) && (newData.child('type').val() === 'start' || newData.child('type').val() === 'stop' || newData.child('type').val() === 'reveal' || newData.child('type').val() === 'next') && newData.child('ownerUid').isString() && newData.child('actorKey').val().matches(/^player_[0-7]$/) && newData.child('roundId').val() === newData.parent().child('roundId').val() && newData.child('revision').val() === newData.parent().child('revision').val() && newData.child('timestamp').isNumber() && newData.child('timestamp').val() >= now - 120000 && newData.child('timestamp').val() <= now + 60000`,
        $other: { '.validate': false },
      },
      // Free-form extras (future tuning without a rules change).
      state: { '.validate': true },
      $other: { '.validate': false },
    },
    $other: { '.validate': false },
  },
};

// ---- sanity + merge ----
const balanced = (s) => { let d = 0; for (const ch of s) { if (ch === '(') d += 1; else if (ch === ')') d -= 1; if (d < 0) return false; } return d === 0; };
const walk = (node, path = '') => {
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string') { if (!balanced(v)) { console.log(`UNBALANCED ${path}/${k}`); process.exit(1); } }
    else if (v && typeof v === 'object') walk(v, `${path}/${k}`);
  }
};
walk(block);
const raw = fs.readFileSync(file, 'utf8');
const json = JSON.parse(raw);
const existed = Boolean(json.rules[BLOCK]);
json.rules[BLOCK] = block;
const indent = /^\n?( +)"rules"/m.exec(raw)?.[1]?.length || 2;
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
fs.writeFileSync(file, JSON.stringify(json, null, indent).replace(/\n/g, eol) + eol);
console.log(`${existed ? 'REPLACED' : 'ADDED'} block "${BLOCK}" — game .write ${gameWrite.length} chars, claim .write ${claimWrite.length} chars, room .write ${roomWrite.length} chars; all expressions balanced`);
