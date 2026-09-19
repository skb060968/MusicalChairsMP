// Engine ↔ rules mirror for chairs-rooms/game. Re-implements the .write branches in JS
// and runs the engine's outputs through them, so a shape mismatch shows up here rather
// than as permission_denied on a phone. Run: node scripts/rules-mirror.mjs
import { fileURLToPath } from 'node:url';
const E = await import(new URL('../src/engine.js', import.meta.url));
let fails = 0;
const chk = (ok, l) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${l}`); if (!ok) fails += 1; };
const KEYS = Array.from({ length: 8 }, (_, i) => `player_${i}`);
const players = {
  player_0: { uid: 'U0', connected: true }, player_1: { uid: 'U1', connected: true }, player_2: { uid: 'U2', connected: true },
};
const v = (o, path) => path.split('/').reduce((x, k) => (x == null ? undefined : x[k]), o);
const ex = (o, path) => v(o, path) !== undefined && v(o, path) !== null;
const same = (d, n, path) => (!ex(d, path) && !ex(n, path)) || v(n, path) === v(d, path);
const pinnedAll = (d, n, p) => KEYS.every((k) => same(d, n, `${p}/${k}`));
const cnt = (o, p, pred) => KEYS.reduce((s, k) => s + (pred(v(o, `${p}/${k}`)) ? 1 : 0), 0);

function gameWrite(d, n, uid, now) {
  if (!d || !n || d.status !== 'playing') return 'envelope:status';
  if (n.revision !== d.revision + 1 || n.roundId !== d.roundId) return 'envelope:revision/roundId';
  const op = n.operation || {};
  if (op.ownerUid !== uid || op.revision !== n.revision) return 'envelope:operation';
  const a = players[op.actorKey];
  if (!a || a.uid !== uid || a.connected !== true) return 'envelope:actor';
  if (!Array.from({ length: 8 }).every((_, i) => same(d, n, `order/${i}`))) return 'envelope:order';
  if (!(Number.isFinite(n.phaseAt) && n.phaseAt >= now - 15000 && n.phaseAt <= now + 15000)) return 'envelope:phaseAt';
  const claimsCount = cnt(d, 'claims', (x) => x !== undefined && x !== null);
  const activeCount = cnt(d, 'active', (x) => x === true);
  const remaining = cnt(n, 'active', (x) => x === true);
  const anyClaims = claimsCount > 0;
  if (op.type === 'stop') {
    const ok = d.phase === 'music' && n.phase === 'claiming' && now >= d.phaseAt + d.musicMs - 1500 && !ex(n, 'claims')
      && n.status === 'playing' && !ex(n, 'winnerKey') && n.round === d.round && n.musicMs === d.musicMs && pinnedAll(d, n, 'active') && pinnedAll(d, n, 'out');
    return ok ? true : 'stop';
  }
  if (op.type === 'reveal') {
    if (!(d.phase === 'claiming' && n.phase === 'reveal')) return 'reveal:phase';
    const settled = KEYS.every((k) => v(d, `active/${k}`) !== true || ex(d, `claims/${k}`) || players[k]?.connected === false);
    if (!(now >= d.phaseAt + 10000 - 1500 || claimsCount >= activeCount - 1 || settled)) return 'reveal:not due';
    if (!(n.round === d.round && n.musicMs === d.musicMs && pinnedAll(d, n, 'claims'))) return 'reveal:pins';
    const per = anyClaims
      ? KEYS.every((k) => {
        const elim = v(d, `active/${k}`) === true && !ex(d, `claims/${k}`);
        const act = (v(n, `active/${k}`) === true) === (v(d, `active/${k}`) === true && ex(d, `claims/${k}`));
        const out = (elim && v(n, `out/${k}`) === d.round) || (!elim && same(d, n, `out/${k}`));
        return act && out;
      })
      : pinnedAll(d, n, 'active') && pinnedAll(d, n, 'out');
    if (!per) return 'reveal:per-player';
    const end = (remaining === 1 && n.status === 'finished' && v(n, `active/${n.winnerKey}`) === true)
      || (remaining > 1 && n.status === 'playing' && !ex(n, 'winnerKey'));
    return end ? true : 'reveal:end';
  }
  if (op.type === 'next') {
    const ok = d.phase === 'reveal' && n.phase === 'music' && now >= d.phaseAt + 3500 - 1500 && n.round === d.round + 1
      && [10000, 20000, 30000].includes(n.musicMs) && !ex(n, 'claims') && n.status === 'playing' && !ex(n, 'winnerKey')
      && activeCount >= 2 && pinnedAll(d, n, 'active') && pinnedAll(d, n, 'out');
    return ok ? true : 'next';
  }
  return 'type';
}
function claimWrite(g, key, chair, uid, now) {
  if (ex(g, `claims/${key}`)) return 'already seated';
  if (!(Number.isInteger(chair) && chair >= 0)) return 'shape';
  if (players[key]?.uid !== uid) return 'not owner';
  if (!(g.status === 'playing' && g.phase === 'claiming')) return 'phase';
  if (v(g, `active/${key}`) !== true) return 'not active';
  if (!(now <= g.phaseAt + 10000 + 1500)) return 'window closed';
  const activeCount = cnt(g, 'active', (x) => x === true);
  if (!(chair < activeCount - 1)) return 'no such chair';
  if (!KEYS.every((k) => k === key || v(g, `claims/${k}`) !== chair)) return 'chair taken';
  return true;
}
const apply = (reducer, g, actor, uid, now) => { const n = reducer(g, actor, uid, now); if (n) { n.phaseAt = now; n.operation.timestamp = now; } return n; };
const claim = (g, key, chair) => ({ ...g, claims: { ...(g.claims || {}), [key]: chair } });

let now = 1_000_000;
console.log('--- start: 3 players ---');
let g = E.createGame(['player_0', 'player_1', 'player_2'], 'U0', now); g.phaseAt = now;
chk(g.revision === 0 && g.phase === 'music' && E.chairCount(g) === 2 && [10000, 20000, 30000].includes(g.musicMs), `round 1, ${E.chairCount(g)} chairs, music ${g.musicMs / 1000}s`);

console.log('--- stop ---');
let n = apply(E.stopMusic, g, 'player_1', 'U1', now + 2000);
chk(gameWrite(g, n, 'U1', now + 2000) !== true, `stop 2 s in is refused: ${gameWrite(g, n, 'U1', now + 2000)}`);
now += g.musicMs;
n = apply(E.stopMusic, g, 'player_1', 'U1', now);
chk(gameWrite(g, n, 'U1', now) === true, 'stop at the deadline by a non-host peer is accepted');
players.player_1.connected = false;
chk(gameWrite(g, n, 'U1', now) === 'envelope:actor', 'an OFFLINE actor may not drive a transition');
players.player_1.connected = true;
chk(E.stopMusic(n, 'player_1', 'U1', now) === null, 'engine refuses a second stop (phase already claiming)');
g = n;

console.log('--- claims ---');
chk(claimWrite(g, 'player_0', 0, 'U0', now + 1000) === true, 'player_0 takes chair 0');
g = claim(g, 'player_0', 0);
chk(claimWrite(g, 'player_1', 0, 'U1', now + 1200) === 'chair taken', 'player_1 cannot take chair 0');
chk(claimWrite(g, 'player_0', 1, 'U0', now + 1200) === 'already seated', 'player_0 cannot take a second chair');
chk(claimWrite(g, 'player_1', 2, 'U1', now + 1200) === 'no such chair', 'chair 2 does not exist with 3 players');
chk(claimWrite(g, 'player_1', 1, 'U2', now + 1200) === 'not owner', 'U2 cannot claim for player_1');
chk(claimWrite(g, 'player_1', 1, 'U1', now + 20000) === 'window closed', 'claim after the window is refused');
chk(E.canClaim(g, 'player_1', 1) && !E.canClaim(g, 'player_1', 0), 'engine.canClaim agrees');

console.log('--- reveal ---');
n = apply(E.reveal, g, 'player_2', 'U2', now + 3000);
chk(gameWrite(g, n, 'U2', now + 3000) === 'reveal:not due', 'reveal with a free chair, everyone online, before 10 s: refused');
players.player_2.connected = false;
chk(gameWrite(g, n, 'U2', now + 3000) === 'envelope:actor', 'the offline player cannot be the actor');
n = apply(E.reveal, g, 'player_1', 'U1', now + 3000);
chk(gameWrite(g, n, 'U1', now + 3000) === 'reveal:not due', 'still not due — player_1 is online and unseated');
g = claim(g, 'player_1', 1);
n = apply(E.reveal, g, 'player_1', 'U1', now + 3500);
chk(gameWrite(g, n, 'U1', now + 3500) === true, 'all chairs taken → reveal accepted early');
chk(n.active.player_0 && n.active.player_1 && !n.active.player_2 && n.out.player_2 === 1 && n.status === 'playing' && n.phase === 'reveal', 'player_2 is out in round 1; two remain');
players.player_2.connected = true;
chk(gameWrite(g, { ...n, active: { ...n.active, player_2: true } }, 'U1', now + 3500) !== true, 'keeping the chairless player in is refused');
g = n; now = n.phaseAt + 3500;

console.log('--- settled-early reveal (offline player, chair free) ---');
let g2 = apply(E.nextRound, g, 'player_0', 'U0', now);
chk(gameWrite(g, g2, 'U0', now) === true && g2.round === 2 && E.chairCount(g2) === 1, 'next round: 2 players, 1 chair');
now += g2.musicMs; let g3 = apply(E.stopMusic, g2, 'player_0', 'U0', now);
chk(gameWrite(g2, g3, 'U0', now) === true, 'round 2 music stops');
players.player_1.connected = false;
g3 = claim(g3, 'player_0', 0);
let g4 = apply(E.reveal, g3, 'player_0', 'U0', now + 800);
chk(gameWrite(g3, g4, 'U0', now + 800) === true, 'everyone settled (host seated, other offline) → reveal at once');
chk(g4.status === 'finished' && g4.winnerKey === 'player_0' && g4.out.player_1 === 2, 'player_0 wins; player_1 out in round 2');
chk(E.nextRound(g4, 'player_0', 'U0', now + 5000) === null, 'no next round after a finish');
players.player_1.connected = true;

console.log('--- nobody claimed → round replays ---');
let h = E.createGame(['player_0', 'player_1', 'player_2'], 'U0', now); h.phaseAt = now; now += h.musicMs;
h = apply(E.stopMusic, h, 'player_0', 'U0', now); now += 10000;
let h2 = apply(E.reveal, h, 'player_0', 'U0', now);
chk(gameWrite(h, h2, 'U0', now) === true && Object.keys(h2.active).length === 3 && !h2.out, 'deadline with zero claims: nobody eliminated, reveal accepted');
now += 3500; let h3 = apply(E.nextRound, h2, 'player_2', 'U2', now);
chk(gameWrite(h2, h3, 'U2', now) === true && h3.round === 2, 'round replays as round 2');
chk(gameWrite(h2, apply(E.nextRound, h2, 'player_2', 'U2', now - 3000), 'U2', now - 3000) === 'next', 'next before the reveal has been shown is refused');

console.log('--- standings ---');
const st = E.standings(g4);
chk(st[0].key === 'player_0' && st[0].winner && st[1].key === 'player_1' && st[2].key === 'player_2', `standings: ${st.map((s) => `${s.key}(${s.survived})`).join(' > ')}`);
console.log(`\n${fails ? `${fails} FAILED` : 'MUSICAL CHAIRS ENGINE + RULE MIRROR VERIFIED'}`);
process.exit(fails ? 1 : 0);
