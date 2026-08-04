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
 * Resolves once one stable anonymous identity is ready for RTDB authorization.
 * A persisted user is reused; anonymous sign-in starts only after Auth reports
 * no current user. This avoids replacing the identity while a room payload is
 * being prepared with ownership fields tied to `auth.uid`.
 */
export const authReady = new Promise((resolve) => {
  let settled = false;
  let signInStarted = false;
  let unsubscribe = () => {};

  const finish = async (user) => {
    if (settled) return;
    settled = true;
    unsubscribe();

    if (user && typeof user.getIdToken === 'function') {
      try {
        await user.getIdToken();
      } catch (err) {
        console.error('Auth token error:', err);
        resolve(null);
        return;
      }
    }
    resolve(user || null);
  };

  unsubscribe = onAuthStateChanged(
    auth,
    (user) => {
      if (user) {
        finish(user);
        return;
      }
      if (signInStarted) return;

      signInStarted = true;
      signInAnonymously(auth)
        .then((credential) => finish(credential.user))
        .catch((err) => {
          console.error('Auth error:', err);
          finish(null);
        });
    },
    (err) => {
      console.error('Auth error:', err);
      finish(null);
    },
  );
});
