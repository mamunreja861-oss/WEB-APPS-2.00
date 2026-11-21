import { useSyncExternalStore } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { UserProfile } from '../modules/types';
import {
  auth,
  db,
  extractFriendlyErrorMessage,
  firebaseInitError,
  isFirebaseConfigured,
  signInWithGoogleForFirestore,
  testConnection,
  waitForFirebaseAuthReady,
} from './firebase';

export type CloudSyncStatus =
  | 'disabled'
  | 'connecting'
  | 'syncing'
  | 'connected'
  | 'auth_required'
  | 'offline'
  | 'error';

export interface CloudSyncSnapshot {
  configured: boolean;
  status: CloudSyncStatus;
  user: User | null;
  userUid: string | null;
  userEmail: string | null;
  lastSyncedAt: string | null;
  errorMessage: string | null;
  online: boolean;
  activeWrites: number;
}

const BOOTSTRAPPED_ADMIN_EMAILS = new Set([
  'muncomputer2019@gmail.com',
  'mamunreja335@gmail.com',
  'maishamart514@gmail.com',
  'mamunreja05@gmail.com',
  'mamunreja861@gmail.com',
]);

let snapshot: CloudSyncSnapshot = {
  configured: isFirebaseConfigured(),
  status: !isFirebaseConfigured()
    ? 'disabled'
    : typeof navigator !== 'undefined' && navigator.onLine === false
      ? 'offline'
      : 'connecting',
  user: auth?.currentUser ?? null,
  userUid: auth?.currentUser?.uid ?? null,
  userEmail: auth?.currentUser?.email ?? null,
  lastSyncedAt: null,
  errorMessage: firebaseInitError,
  online: typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
  activeWrites: 0,
};

const listeners = new Set<() => void>();
let monitorStarted = false;
let currentAppUser: UserProfile | null = null;
let authUnSub: (() => void) | null = null;
let profileEnsuredForUid: string | null = null;
let pendingSignInPromise: Promise<User> | null = null;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function updateSnapshot(patch: Partial<CloudSyncSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  notify();
}

export function getCloudSyncSnapshot(): CloudSyncSnapshot {
  return snapshot;
}

export function subscribeCloudSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCloudSync(): CloudSyncSnapshot {
  return useSyncExternalStore(subscribeCloudSync, getCloudSyncSnapshot, getCloudSyncSnapshot);
}

export function markCloudSyncActivity(active: boolean): void {
  const nextCount = Math.max(0, snapshot.activeWrites + (active ? 1 : -1));
  const nextStatus: CloudSyncStatus =
    nextCount > 0
      ? 'syncing'
      : !snapshot.online
        ? 'offline'
        : !snapshot.configured
          ? 'disabled'
          : snapshot.user
            ? 'connected'
            : 'auth_required';
  updateSnapshot({ activeWrites: nextCount, status: nextStatus });
}

export function recordCloudSyncSuccess(): void {
  updateSnapshot({
    status: snapshot.online ? 'connected' : 'offline',
    lastSyncedAt: new Date().toISOString(),
    errorMessage: null,
  });
}

export function recordCloudSyncError(message: string): void {
  const clean = message.trim() || 'Cloud database synchronization error.';
  updateSnapshot({
    status: snapshot.online ? 'error' : 'offline',
    errorMessage: clean,
  });
}

export async function ensureFirestoreUserProfile(
  firebaseUser: User,
  appUser?: UserProfile | null
): Promise<void> {
  if (!db) return;
  if (profileEnsuredForUid === firebaseUser.uid) return;
  const userRef = doc(db, 'users', firebaseUser.uid);
  try {
    const existing = await getDoc(userRef);
    if (existing.exists()) {
      profileEnsuredForUid = firebaseUser.uid;
      return;
    }

    const email = (firebaseUser.email || '').trim().toLowerCase();
    const isBootstrapped =
      firebaseUser.uid === '1ftA1pw2Q5b1wxciGoSsNUqQPmF2' ||
      BOOTSTRAPPED_ADMIN_EMAILS.has(email);

    const mappedRole = isBootstrapped ? 'ADMIN' : 'STAFF';
    const needsPwdUpdate = Boolean(
      appUser?.mustChangePassword || appUser?.passwordMigrationRequired || appUser?.isFirstLogin
    );

    const payload = {
      uid: firebaseUser.uid,
      userId: String(appUser?.userId || `MC_${firebaseUser.uid.slice(0, 12)}`).slice(0, 40),
      fullName: String(
        appUser?.fullName || firebaseUser.displayName || email.split('@')[0] || 'MUN User'
      ).slice(0, 120),
      role: mappedRole,
      status: 'ACTIVE',
      branch: String(appUser?.branch || 'Main Branch').slice(0, 120),
      designation: String(appUser?.designation || (isBootstrapped ? 'Master Administrator' : 'Operator')).slice(0, 120),
      isMasterAdmin: isBootstrapped,
      isFirstLogin: typeof appUser?.isFirstLogin === 'boolean' ? appUser.isFirstLogin : needsPwdUpdate,
      passwordChanged:
        typeof appUser?.passwordChanged === 'boolean' ? appUser.passwordChanged : !needsPwdUpdate,
      mustChangePassword: Boolean(appUser?.mustChangePassword || appUser?.passwordMigrationRequired),
      passwordChangedAt: String(appUser?.passwordChangedAt || '').slice(0, 64),
      mobileVerified: Boolean(appUser?.mobileVerified),
      emailVerified: Boolean(firebaseUser.emailVerified),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    await setDoc(userRef, payload);
    profileEnsuredForUid = firebaseUser.uid;
  } catch (err) {
    // Non-fatal if user lacks /users creation privileges (e.g. non-bootstrapped pending member)
    console.warn('User profile sync skipped:', extractFriendlyErrorMessage(err));
  }
}

export async function markPasswordChangedInFirestore(
  firebaseUser: User | null | undefined,
  appUser?: UserProfile | null
): Promise<void> {
  if (!db || !firebaseUser) return;
  const userRef = doc(db, 'users', firebaseUser.uid);
  const nowIso = new Date().toISOString();
  const existing = await getDoc(userRef);

  if (!existing.exists()) {
    const email = (firebaseUser.email || '').trim().toLowerCase();
    const isBootstrapped =
      firebaseUser.uid === '1ftA1pw2Q5b1wxciGoSsNUqQPmF2' ||
      BOOTSTRAPPED_ADMIN_EMAILS.has(email);
    await setDoc(userRef, {
      uid: firebaseUser.uid,
      userId: String(appUser?.userId || `MC_${firebaseUser.uid.slice(0, 12)}`).slice(0, 40),
      fullName: String(
        appUser?.fullName || firebaseUser.displayName || email.split('@')[0] || 'MUN User'
      ).slice(0, 120),
      role: isBootstrapped ? 'ADMIN' : 'STAFF',
      status: 'ACTIVE',
      branch: String(appUser?.branch || 'Main Branch').slice(0, 120),
      designation: String(appUser?.designation || (isBootstrapped ? 'Master Administrator' : 'Operator')).slice(0, 120),
      isMasterAdmin: isBootstrapped,
      isFirstLogin: false,
      passwordChanged: true,
      mustChangePassword: false,
      passwordChangedAt: nowIso,
      mobileVerified: Boolean(appUser?.mobileVerified),
      emailVerified: Boolean(firebaseUser.emailVerified),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    profileEnsuredForUid = firebaseUser.uid;
    return;
  }

  await updateDoc(userRef, {
    isFirstLogin: false,
    passwordChanged: true,
    mustChangePassword: false,
    passwordChangedAt: nowIso,
    updatedAt: serverTimestamp(),
  });
  profileEnsuredForUid = firebaseUser.uid;
}

export function initCloudSyncMonitor(appUser?: UserProfile | null): () => void {
  if (appUser) {
    currentAppUser = appUser;
    if (snapshot.user) {
      void ensureFirestoreUserProfile(snapshot.user, appUser);
    }
  }

  if (monitorStarted) {
    return () => {};
  }
  monitorStarted = true;

  if (!isFirebaseConfigured() || !auth) {
    updateSnapshot({
      configured: false,
      status: 'disabled',
      errorMessage: firebaseInitError || 'Firebase configuration not found.',
    });
    return () => {};
  }

  const handleOnline = () => {
    updateSnapshot({
      online: true,
      status: snapshot.user ? 'connecting' : 'auth_required',
      errorMessage: null,
    });
    void testConnection().then((res) => {
      if (!res.ok) {
        updateSnapshot({ status: 'error', errorMessage: res.error || 'Unable to reach cloud database.' });
      } else if (auth?.currentUser) {
        updateSnapshot({
          status: 'connected',
          lastSyncedAt: snapshot.lastSyncedAt || new Date().toISOString(),
          errorMessage: null,
        });
      } else {
        updateSnapshot({ status: 'auth_required' });
      }
    });
  };

  const handleOffline = () => {
    updateSnapshot({
      online: false,
      status: 'offline',
      errorMessage: 'Internet connection offline. Reconnect to sync changes to cloud database.',
    });
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
  }

  authUnSub = onAuthStateChanged(auth, async (user) => {
    if (!user) {
      profileEnsuredForUid = null;
      updateSnapshot({
        user: null,
        userUid: null,
        userEmail: null,
        status: snapshot.online ? 'auth_required' : 'offline',
      });
      return;
    }

    updateSnapshot({
      user,
      userUid: user.uid,
      userEmail: user.email ?? null,
      status: snapshot.online ? 'connecting' : 'offline',
      errorMessage: null,
    });

    await ensureFirestoreUserProfile(user, currentAppUser);
    const conn = await testConnection();
    if (!conn.ok) {
      updateSnapshot({
        status: snapshot.online ? 'error' : 'offline',
        errorMessage: conn.error || 'Failed to connect to cloud database.',
      });
      return;
    }

    updateSnapshot({
      status: snapshot.online ? 'connected' : 'offline',
      lastSyncedAt: new Date().toISOString(),
      errorMessage: null,
    });
  });

  return () => {
    if (authUnSub) {
      authUnSub();
      authUnSub = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    }
    monitorStarted = false;
  };
}

export async function connectCloudDatabaseInteractive(appUser?: UserProfile | null): Promise<User> {
  if (appUser) currentAppUser = appUser;
  if (!isFirebaseConfigured()) {
    throw new Error(firebaseInitError || 'Cloud database (Firebase) is not configured.');
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    updateSnapshot({ online: false, status: 'offline' });
    throw new Error('Your device is offline. Reconnect to the internet and try again.');
  }

  const readyUser = await waitForFirebaseAuthReady();
  if (readyUser) {
    await ensureFirestoreUserProfile(readyUser, currentAppUser);
    updateSnapshot({
      user: readyUser,
      userUid: readyUser.uid,
      userEmail: readyUser.email ?? null,
      status: 'connected',
      lastSyncedAt: new Date().toISOString(),
      errorMessage: null,
    });
    return readyUser;
  }

  if (pendingSignInPromise) {
    return pendingSignInPromise;
  }

  pendingSignInPromise = (async () => {
    updateSnapshot({ status: 'connecting', errorMessage: null });
    try {
      const signedInUser = await signInWithGoogleForFirestore();
      if (!signedInUser) {
        throw new Error('Google Cloud DB sign-in was cancelled.');
      }
      await ensureFirestoreUserProfile(signedInUser, currentAppUser);
      updateSnapshot({
        user: signedInUser,
        userUid: signedInUser.uid,
        userEmail: signedInUser.email ?? null,
        status: 'connected',
        lastSyncedAt: new Date().toISOString(),
        errorMessage: null,
      });
      return signedInUser;
    } catch (err) {
      const msg = extractFriendlyErrorMessage(err, 'Cloud DB connection sign-in failed.');
      updateSnapshot({
        status: auth?.currentUser ? 'error' : 'auth_required',
        errorMessage: msg,
      });
      throw new Error(msg);
    } finally {
      pendingSignInPromise = null;
    }
  })();

  return pendingSignInPromise;
}

export async function ensureCloudAuthForSave(appUser?: UserProfile | null): Promise<User> {
  return connectCloudDatabaseInteractive(appUser);
}

export async function runCloudWrite<T>(
  operation: (user: User) => Promise<T>
): Promise<T> {
  const user = await ensureCloudAuthForSave();
  markCloudSyncActivity(true);
  try {
    const result = await operation(user);
    recordCloudSyncSuccess();
    return result;
  } catch (err) {
    recordCloudSyncError(extractFriendlyErrorMessage(err, 'Failed to write to cloud database.'));
    throw err;
  } finally {
    markCloudSyncActivity(false);
  }
}

if (typeof window !== 'undefined') {
  initCloudSyncMonitor();
}
