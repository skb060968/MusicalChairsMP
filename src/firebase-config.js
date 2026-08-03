import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);

/**
 * Resolves once anonymous auth has completed.
 * Resolves with the signed-in user, or with `null` if sign-in failed.
 * Firebase security rules match `auth.uid` against `meta/hostUid` and
 * `players/player_N/uid`, so always await this before reading a uid.
 */
export const authReady = new Promise((resolve) => {
  const unsubscribe = onAuthStateChanged(
    auth,
    (user) => {
      if (user) {
        unsubscribe();
        resolve(user);
      }
    },
    (err) => {
      console.error('Auth error:', err);
      unsubscribe();
      resolve(null);
    }
  );

  signInAnonymously(auth).catch((err) => {
    console.error('Auth error:', err);
    // Only settles if onAuthStateChanged never produced a user.
    unsubscribe();
    resolve(auth.currentUser || null);
  });
});
