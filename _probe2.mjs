/**
 * Round 2. We know: normal write passes, every onDisconnect write is denied.
 *
 * Two candidate blockers on the meta paths:
 *   (i)  the sentinel: serverTimestamp() may not be a number at ESTABLISH time,
 *        and onDisconnect rules are evaluated when established, not when fired.
 *   (ii) the clause `newData.val() === now` on meta/hostDisconnectedAt — exact
 *        equality, which a client clock can never hit.
 *
 * meta/lastActivity is the perfect control: same auth, same onDisconnect
 * mechanism, but its rule uses a WINDOW (>= now-300000 && <= now+60000) instead
 * of exact equality, and it has no coupling with players/player_0/connected.
 *
 *   E (onDisconnect, lastActivity, sentinel) PASS -> sentinels are fine in
 *       onDisconnect; the `=== now` equality is the sole blocker -> RULES fix.
 *   E fail + F (same, client number) PASS      -> the sentinel is the blocker
 *       -> CLIENT fix (send a number) + relax the equality.
 *   both fail                                  -> onDisconnect cannot write meta
 *       at all under these rules.
 */
import fs from 'node:fs';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import {
  getDatabase, ref, get, remove, onDisconnect, serverTimestamp, runTransaction,
} from 'firebase/database';

const base = 'c:/Users/sunil/OneDrive/Desktop/my games';
const env = new Map(
  fs.readFileSync(`${base}/skb-games/.env`, 'utf8').split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const app = initializeApp({
  apiKey: env.get('VITE_FIREBASE_API_KEY'),
  authDomain: env.get('VITE_FIREBASE_AUTH_DOMAIN'),
  databaseURL: env.get('VITE_FIREBASE_DATABASE_URL'),
  projectId: env.get('VITE_FIREBASE_PROJECT_ID'),
  storageBucket: env.get('VITE_FIREBASE_STORAGE_BUCKET'),
  messagingSenderId: env.get('VITE_FIREBASE_MESSAGING_SENDER_ID'),
  appId: env.get('VITE_FIREBASE_APP_ID'),
});
const db = getDatabase(app);
const auth = getAuth(app);

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const code = Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
const roomPath = `musical-chairs-rooms/${code}`;

const attempt = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); return true; }
  catch (e) { console.log(`  DENY  ${label} :: ${String(e.message || e).slice(0, 90)}`); return false; }
};

let created = false;
try {
  const { user } = await signInAnonymously(auth);
  console.log(`uid=${user.uid.slice(0, 8)}…  test room ${code}\n`);
  const res = await runTransaction(ref(db, roomPath), (cur) => (cur === null ? {
    meta: {
      schemaVersion: 2, hostUid: user.uid, hostName: 'ProbeHost', status: 'lobby',
      createdAt: serverTimestamp(), lastActivity: serverTimestamp(),
    },
    players: { player_0: { name: 'ProbeHost', uid: user.uid, connected: true, eliminated: false, emoji: '🥷' } },
  } : undefined), { applyLocally: false });
  if (!res.committed) throw new Error('create failed');
  created = true;

  console.log('--- control: meta/lastActivity via onDisconnect (WINDOW rule, no coupling) ---');
  const okE = await attempt('E  sentinel', async () => {
    const reg = onDisconnect(ref(db, `${roomPath}/meta/lastActivity`));
    await reg.set(serverTimestamp());
    await reg.cancel();
  });
  const okF = await attempt('F  client number', async () => {
    const reg = onDisconnect(ref(db, `${roomPath}/meta/lastActivity`));
    await reg.set(Date.now());
    await reg.cancel();
  });

  console.log('\n--- control: a path with NO now/sentinel at all ---');
  const okG = await attempt('G  players/player_0/eliminated=false via onDisconnect', async () => {
    const reg = onDisconnect(ref(db, `${roomPath}/players/player_0/eliminated`));
    await reg.set(false);
    await reg.cancel();
  });

  console.log('\n================ VERDICT ================');
  if (okE) {
    console.log('Sentinels ARE fine inside onDisconnect (E passed).');
    console.log("=> the blocker is the exact-equality clause `newData.val() === now`");
    console.log('   on meta/hostDisconnectedAt. FIX = rules (relax to a window).');
  } else if (okF) {
    console.log('Sentinel denied but a client number accepted (E fail, F pass).');
    console.log('=> serverTimestamp() cannot be validated at establish time.');
    console.log('   FIX = client sends Date.now(), AND rules relax the equality.');
  } else if (okG) {
    console.log('Plain values work via onDisconnect, but nothing time-based does.');
    console.log('=> every `now`-based clause is unsatisfiable for onDisconnect.');
    console.log('   FIX = rules must not compare against `now` for onDisconnect paths.');
  } else {
    console.log('Even a constant write via onDisconnect is denied.');
    console.log('=> the block is broader than the timestamp rules — inspect players rules.');
  }
  console.log(`E(sentinel)=${okE}  F(number)=${okF}  G(constant)=${okG}`);
} catch (e) {
  console.log(`SETUP FAILED: ${e.message}`);
} finally {
  if (created) {
    try {
      await remove(ref(db, roomPath));
      console.log(`\ncleanup: room ${code} deleted = ${!(await get(ref(db, roomPath))).exists()}`);
    } catch (e) { console.log(`\nCLEANUP FAILED for ${code}: ${e.message}`); }
  }
  process.exit(0);
}
