/**
 * Pinpoints which write in MusicalChairs' host onDisconnect is denied.
 *
 * The app arms, as player_0:
 *   players/player_0/connected = false
 *   meta/hostDisconnectedAt    = serverTimestamp()
 *   meta/lastActivity          = serverTimestamp()
 * ...and gets PERMISSION_DENIED.
 *
 * Suspect clause on meta/hostDisconnectedAt:
 *     (!data.exists() && newData.isNumber() && newData.val() === now)
 * Exact equality with `now` plus a server sentinel is a fragile combination.
 *
 * The probes are chosen to DISCRIMINATE, not just reproduce:
 *   D (normal update, serverTimestamp) vs A (onDisconnect, serverTimestamp)
 *     D passes, A fails  -> onDisconnect-specific sentinel handling
 *     both fail          -> the rule clause itself is unsatisfiable
 *   B (onDisconnect, client Date.now()) isolates the `=== now` equality.
 *
 * Creates one room and deletes it in a finally block.
 */
import fs from 'node:fs';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import {
  getDatabase, ref, get, update, remove, onDisconnect, serverTimestamp, runTransaction,
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
const P0 = `${roomPath}/players/player_0`;

const attempt = async (label, fn) => {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
    return true;
  } catch (e) {
    console.log(`  DENY  ${label}\n          ${String(e.message || e).slice(0, 150)}`);
    return false;
  }
};

let created = false;
try {
  const { user } = await signInAnonymously(auth);
  console.log(`signed in anonymously, uid=${user.uid.slice(0, 8)}…`);
  console.log(`test room: ${code}\n`);

  /* ---- create the room exactly as the app does ---- */
  const roomData = {
    meta: {
      schemaVersion: 2,
      hostUid: user.uid,
      hostName: 'ProbeHost',
      status: 'lobby',
      createdAt: serverTimestamp(),
      lastActivity: serverTimestamp(),
    },
    players: {
      player_0: {
        name: 'ProbeHost', uid: user.uid, connected: true, eliminated: false, emoji: '🥷',
      },
    },
  };
  const res = await runTransaction(ref(db, roomPath), (cur) => (cur === null ? roomData : undefined), { applyLocally: false });
  if (!res.committed) throw new Error('room create not committed');
  created = true;
  console.log('room created OK (so create rules + emoji whitelist are fine)\n');

  console.log('--- A: onDisconnect root update, serverTimestamp (what the app does) ---');
  const okA = await attempt('A', async () => {
    const reg = onDisconnect(ref(db));
    const t = serverTimestamp();
    await reg.update({
      [`${P0}/connected`]: false,
      [`${roomPath}/meta/hostDisconnectedAt`]: t,
      [`${roomPath}/meta/lastActivity`]: t,
    });
    await reg.cancel();
  });

  console.log('\n--- B: same, but a client-computed number instead of the sentinel ---');
  const okB = await attempt('B', async () => {
    const reg = onDisconnect(ref(db));
    const t = Date.now();
    await reg.update({
      [`${P0}/connected`]: false,
      [`${roomPath}/meta/hostDisconnectedAt`]: t,
      [`${roomPath}/meta/lastActivity`]: t,
    });
    await reg.cancel();
  });

  console.log('\n--- C: onDisconnect on hostDisconnectedAt alone (coupling should reject) ---');
  const okC = await attempt('C', async () => {
    const reg = onDisconnect(ref(db, `${roomPath}/meta/hostDisconnectedAt`));
    await reg.set(serverTimestamp());
    await reg.cancel();
  });

  console.log('\n--- D: the SAME payload as an ordinary update (not onDisconnect) ---');
  const okD = await attempt('D', async () => {
    const t = serverTimestamp();
    await update(ref(db), {
      [`${P0}/connected`]: false,
      [`${roomPath}/meta/hostDisconnectedAt`]: t,
      [`${roomPath}/meta/lastActivity`]: t,
    });
  });

  if (okD) {
    const snap = await get(ref(db, `${roomPath}/meta`));
    const meta = snap.val() || {};
    console.log(`        wrote hostDisconnectedAt=${meta.hostDisconnectedAt} (server resolved the sentinel)`);
    // put it back so the room is consistent before delete
    await update(ref(db), {
      [`${P0}/connected`]: true,
      [`${roomPath}/meta/hostDisconnectedAt`]: null,
    }).catch(() => {});
  }

  console.log('\n================ VERDICT ================');
  if (okD && !okA) {
    console.log('The rule is satisfiable by a normal write but NOT via onDisconnect.');
    console.log('=> onDisconnect rule evaluation is the problem, not the payload.');
  } else if (!okD && !okA) {
    console.log('Even an ordinary write with the identical payload is denied.');
    console.log("=> the hostDisconnectedAt rule clause itself is unsatisfiable; fix the rule.");
  } else if (okA) {
    console.log('A passed here — the live failure is environment-specific, not the rule.');
  }
  console.log(`A(onDisc+sentinel)=${okA}  B(onDisc+number)=${okB}  C(marker alone)=${okC}  D(normal+sentinel)=${okD}`);
} catch (e) {
  console.log(`\nSETUP FAILED: ${e.message}`);
} finally {
  if (created) {
    try {
      await remove(ref(db, roomPath));
      const gone = !(await get(ref(db, roomPath))).exists();
      console.log(`\ncleanup: test room ${code} deleted = ${gone}`);
    } catch (e) {
      console.log(`\nCLEANUP FAILED — delete musical-chairs-rooms/${code} manually: ${e.message}`);
    }
  }
  process.exit(0);
}
