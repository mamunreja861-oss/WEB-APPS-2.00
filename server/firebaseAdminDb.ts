import fs from 'node:fs';
import path from 'node:path';
import { cert, getApps, initializeApp, type ServiceAccount } from 'firebase-admin/app';
import { getDatabase, type Database } from 'firebase-admin/database';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { AuthChallenge, SecurityLogRecord, ServerSession, ServerUser } from './types.js';

function resolveFirestoreDatabaseId(): string | undefined {
  const envDb = (process.env.FIREBASE_DATABASE_ID || '').trim();
  if (envDb) return envDb;
  try {
    const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
        firestoreDatabaseId?: string;
      };
      if (parsed.firestoreDatabaseId && parsed.firestoreDatabaseId.trim()) {
        return parsed.firestoreDatabaseId.trim();
      }
    }
  } catch {
    // fallback to default Firestore database
  }
  return undefined;
}

let initialized = false;
let initAttempted = false;
let rtdbInstance: Database | null = null;
let firestoreInstance: Firestore | null = null;

function parseServiceAccount(): ServiceAccount | null {
  const rawJson = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as ServiceAccount & {
        project_id?: string;
        client_email?: string;
        private_key?: string;
      };
      if (parsed.private_key && typeof parsed.private_key === 'string') {
        parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
      }
      return parsed;
    } catch {
      console.warn('Invalid FIREBASE_SERVICE_ACCOUNT_JSON format; skipping Firebase Admin SDK.');
      return null;
    }
  }

  const projectId = (process.env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = (process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  if (projectId && clientEmail && privateKey) {
    return {
      projectId,
      clientEmail,
      privateKey,
    };
  }
  return null;
}

export function ensureFirebaseAdminInitialized(): {
  enabled: boolean;
  rtdb: Database | null;
  firestore: Firestore | null;
} {
  if (initAttempted) {
    return { enabled: initialized, rtdb: rtdbInstance, firestore: firestoreInstance };
  }
  initAttempted = true;

  const serviceAccount = parseServiceAccount();
  if (!serviceAccount) {
    return { enabled: false, rtdb: null, firestore: null };
  }

  const databaseURL = (process.env.FIREBASE_DATABASE_URL || '').trim() || undefined;
  try {
    const existingApps = getApps();
    const app =
      existingApps.length > 0
        ? existingApps[0]!
        : initializeApp({
            credential: cert(serviceAccount),
            ...(databaseURL ? { databaseURL } : {}),
          });

    if (databaseURL) {
      rtdbInstance = getDatabase(app);
    }
    const firestoreDbId = resolveFirestoreDatabaseId();
    firestoreInstance = firestoreDbId ? getFirestore(app, firestoreDbId) : getFirestore(app);
    initialized = true;
  } catch (err) {
    console.warn(
      'Firebase Admin initialization warning:',
      err instanceof Error ? err.message : String(err)
    );
    initialized = false;
  }

  return { enabled: initialized, rtdb: rtdbInstance, firestore: firestoreInstance };
}

export function isFirebaseAdminActive(): boolean {
  return ensureFirebaseAdminInitialized().enabled;
}

function sanitizeKey(raw: string): string {
  return raw.replace(/[.#$/[\]]/g, '_');
}

export async function syncUserRecordToFirebase(user: ServerUser): Promise<void> {
  const { enabled, rtdb, firestore } = ensureFirebaseAdminInitialized();
  if (!enabled) return;

  const safeId = sanitizeKey(user.userId);
  const record: Record<string, unknown> = {
    id: user.id,
    userId: user.userId,
    isMasterAdmin: Boolean(user.isMasterAdmin),
    fullName: user.fullName,
    role: user.role,
    mobile: user.mobile,
    email: user.email || '',
    address: user.address,
    designation: user.designation || '',
    departmentCode: user.departmentCode || 'DEPT-CSC',
    joiningDate: user.joiningDate || '',
    branch: user.branch,
    status: user.status,
    mobileVerified: Boolean(user.mobileVerified),
    emailVerified: Boolean(user.emailVerified),
    passwordHash: user.passwordHash,
    passwordAlgo: user.passwordAlgo || 'bcrypt-12',
    mustChangePassword: Boolean(user.mustChangePassword),
    passwordMigrationRequired: Boolean(user.passwordMigrationRequired),
    isFirstLogin:
      typeof user.isFirstLogin === 'boolean'
        ? user.isFirstLogin
        : Boolean(user.mustChangePassword || user.passwordMigrationRequired),
    passwordChanged:
      typeof user.passwordChanged === 'boolean'
        ? user.passwordChanged
        : !(user.mustChangePassword || user.passwordMigrationRequired),
    totpEnabled: Boolean(user.totpEnabled),
    totpSecretEncrypted: user.totpSecretEncrypted || '',
    totpEnrolledAt: user.totpEnrolledAt || '',
    lastTotpStepUsed: user.lastTotpStepUsed ?? null,
    recoveryCodeHashes: user.recoveryCodeHashes ?? [],
    failedLoginAttempts: user.failedLoginAttempts,
    lockedUntil: user.lockedUntil ?? null,
    createdBy: user.createdBy ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    passwordChangedAt: user.passwordChangedAt,
    customPermissions: user.customPermissions || {},
    customRoleCode: user.customRoleCode || '',
    firebaseUid: user.firebaseUid || '',
  };

  await Promise.allSettled([
    rtdb ? rtdb.ref(`auth_users/${safeId}`).set(record) : Promise.resolve(),
    firestore
      ? firestore.collection('auth_users').doc(safeId).set(record, { merge: true })
      : Promise.resolve(),
  ]);
}

export async function syncSessionRecordToFirebase(session: ServerSession): Promise<void> {
  const { enabled, rtdb, firestore } = ensureFirebaseAdminInitialized();
  if (!enabled) return;

  const safeKey = sanitizeKey(session.tokenHash);
  const payload = {
    id: session.id,
    tokenHash: session.tokenHash,
    userId: session.userId,
    role: session.role,
    ipAddress: session.ipAddress,
    deviceInfo: session.deviceInfo,
    deviceId: session.deviceId || '',
    lastActiveAt: session.lastActiveAt || session.createdAt,
    rotatedFromSessionId: session.rotatedFromSessionId || '',
    rememberMe: session.rememberMe,
    status: session.status,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    maxAllowedExpiresAt: session.maxAllowedExpiresAt,
    reauthenticatedUntil: session.reauthenticatedUntil ?? null,
  };

  await Promise.allSettled([
    rtdb ? rtdb.ref(`auth_sessions/${safeKey}`).set(payload) : Promise.resolve(),
    firestore
      ? firestore.collection('auth_sessions').doc(safeKey).set(payload, { merge: true })
      : Promise.resolve(),
  ]);
}

export async function syncAuthChallengeToFirebase(challenge: AuthChallenge): Promise<void> {
  const { enabled, rtdb, firestore } = ensureFirebaseAdminInitialized();
  if (!enabled) return;

  const safeId = sanitizeKey(challenge.id);
  const payload = { ...challenge };
  await Promise.allSettled([
    rtdb ? rtdb.ref(`auth_challenges/${safeId}`).set(payload) : Promise.resolve(),
    firestore
      ? firestore.collection('auth_challenges').doc(safeId).set(payload, { merge: true })
      : Promise.resolve(),
  ]);
}

export async function removeAuthChallengeFromFirebase(challengeId: string): Promise<void> {
  const { enabled, rtdb, firestore } = ensureFirebaseAdminInitialized();
  if (!enabled) return;
  const safeId = sanitizeKey(challengeId);
  await Promise.allSettled([
    rtdb ? rtdb.ref(`auth_challenges/${safeId}`).remove() : Promise.resolve(),
    firestore ? firestore.collection('auth_challenges').doc(safeId).delete() : Promise.resolve(),
  ]);
}

export async function syncSecurityLogToFirebase(log: SecurityLogRecord): Promise<void> {
  const { enabled, rtdb, firestore } = ensureFirebaseAdminInitialized();
  if (!enabled) return;
  const key = `log_${String(log.id).padStart(8, '0')}_${Date.now().toString(36)}`;
  await Promise.allSettled([
    rtdb ? rtdb.ref(`auth_audit_logs/${key}`).set(log) : Promise.resolve(),
    firestore ? firestore.collection('auth_audit_logs').doc(key).set(log) : Promise.resolve(),
  ]);
}

let hydrationPromise: Promise<void> | null = null;

export async function hydrateAuthStateFromFirebase(target: {
  users: ServerUser[];
  sessions: Map<string, ServerSession>;
  authChallenges: Map<string, AuthChallenge>;
}): Promise<void> {
  if (hydrationPromise) return hydrationPromise;
  const { enabled, rtdb, firestore } = ensureFirebaseAdminInitialized();
  if (!enabled) return;

  hydrationPromise = (async () => {
    try {
      let rawUsers: Record<string, Partial<ServerUser>> | null = null;
      let rawSessions: Record<string, ServerSession> | null = null;
      let rawChallenges: Record<string, AuthChallenge> | null = null;

      if (rtdb) {
        const [uSnap, sSnap, cSnap] = await Promise.all([
          rtdb.ref('auth_users').get(),
          rtdb.ref('auth_sessions').get(),
          rtdb.ref('auth_challenges').get(),
        ]);
        rawUsers = (uSnap.val() as Record<string, Partial<ServerUser>> | null) ?? null;
        rawSessions = (sSnap.val() as Record<string, ServerSession> | null) ?? null;
        rawChallenges = (cSnap.val() as Record<string, AuthChallenge> | null) ?? null;
      } else if (firestore) {
        const [uSnap, sSnap, cSnap] = await Promise.all([
          firestore.collection('auth_users').get(),
          firestore.collection('auth_sessions').where('status', '==', 'ACTIVE').get(),
          firestore.collection('auth_challenges').get(),
        ]);
        if (!uSnap.empty) {
          rawUsers = {};
          uSnap.forEach((d) => {
            rawUsers![d.id] = d.data() as Partial<ServerUser>;
          });
        }
        if (!sSnap.empty) {
          rawSessions = {};
          sSnap.forEach((d) => {
            rawSessions![d.id] = d.data() as ServerSession;
          });
        }
        if (!cSnap.empty) {
          rawChallenges = {};
          cSnap.forEach((d) => {
            rawChallenges![d.id] = d.data() as AuthChallenge;
          });
        }
      }

      if (rawUsers) {
        for (const rec of Object.values(rawUsers)) {
          if (!rec.userId) continue;
          const upperId = rec.userId.toUpperCase();
          if (
            (upperId === 'MC2627110003' ||
              upperId === 'MC2627110004' ||
              upperId === 'MC2627110005') &&
            (rec.createdBy === 'SYSTEM' || !rec.createdBy)
          ) {
            continue;
          }
          const existing = target.users.find(
            (u) => u.userId.toUpperCase() === upperId
          );
          if (existing) {
            const recPwdTime = Date.parse(String(rec.passwordChangedAt || ''));
            const curPwdTime = Date.parse(String(existing.passwordChangedAt || ''));
            const canOverwritePassword =
              !Number.isFinite(curPwdTime) ||
              (Number.isFinite(recPwdTime) && recPwdTime >= curPwdTime);

            if (canOverwritePassword) {
              if (rec.passwordHash) existing.passwordHash = rec.passwordHash;
              if (rec.passwordAlgo) existing.passwordAlgo = rec.passwordAlgo;
              if (rec.passwordChangedAt) existing.passwordChangedAt = rec.passwordChangedAt;
              if (typeof rec.mustChangePassword === 'boolean') {
                existing.mustChangePassword = rec.mustChangePassword;
              }
              if (typeof rec.passwordMigrationRequired === 'boolean') {
                existing.passwordMigrationRequired = rec.passwordMigrationRequired;
              }
              if (typeof rec.isFirstLogin === 'boolean') {
                existing.isFirstLogin = rec.isFirstLogin;
              }
              if (typeof rec.passwordChanged === 'boolean') {
                existing.passwordChanged = rec.passwordChanged;
              }
            }
            if (typeof rec.totpEnabled === 'boolean') existing.totpEnabled = rec.totpEnabled;
            if (rec.totpSecretEncrypted) existing.totpSecretEncrypted = rec.totpSecretEncrypted;
            if (rec.totpEnrolledAt) existing.totpEnrolledAt = rec.totpEnrolledAt;
            if (typeof rec.lastTotpStepUsed === 'number') {
              existing.lastTotpStepUsed = rec.lastTotpStepUsed;
            }
            if (Array.isArray(rec.recoveryCodeHashes)) {
              existing.recoveryCodeHashes = rec.recoveryCodeHashes;
            }
            if (rec.status) existing.status = rec.status;
          } else if (rec.passwordHash && rec.role && rec.fullName) {
            target.users.push({
              id: Number(rec.id || target.users.length + 1),
              userId: rec.userId,
              isMasterAdmin: Boolean(rec.isMasterAdmin),
              fullName: rec.fullName,
              role: rec.role,
              mobile: rec.mobile || '',
              email: rec.email || '',
              address: rec.address || '',
              designation: rec.designation || '',
              departmentCode: rec.departmentCode || 'DEPT-CSC',
              joiningDate: rec.joiningDate || '',
              branch: rec.branch || 'Main Service Center',
              status: rec.status || 'ACTIVE',
              mobileVerified: Boolean(rec.mobileVerified),
              emailVerified: Boolean(rec.emailVerified),
              passwordHash: rec.passwordHash,
              passwordAlgo: rec.passwordAlgo || 'bcrypt-12',
              mustChangePassword: Boolean(rec.mustChangePassword),
              passwordMigrationRequired: Boolean(rec.passwordMigrationRequired),
              failedLoginAttempts: Number(rec.failedLoginAttempts || 0),
              lockedUntil: rec.lockedUntil ?? null,
              createdBy: rec.createdBy ?? null,
              createdAt: rec.createdAt || new Date().toISOString(),
              updatedAt: rec.updatedAt || new Date().toISOString(),
              passwordChangedAt: rec.passwordChangedAt || new Date().toISOString(),
              customPermissions: rec.customPermissions || {},
              customRoleCode: rec.customRoleCode || undefined,
              totpEnabled: Boolean(rec.totpEnabled),
              totpSecretEncrypted: rec.totpSecretEncrypted || undefined,
              totpEnrolledAt: rec.totpEnrolledAt || undefined,
              lastTotpStepUsed: rec.lastTotpStepUsed ?? undefined,
              recoveryCodeHashes: Array.isArray(rec.recoveryCodeHashes)
                ? rec.recoveryCodeHashes
                : undefined,
            });
          }
        }
      }

      const now = Date.now();
      if (rawSessions) {
        for (const sess of Object.values(rawSessions)) {
          if (sess?.tokenHash && sess.status === 'ACTIVE' && sess.expiresAt > now) {
            target.sessions.set(sess.tokenHash, sess);
          }
        }
      }

      if (rawChallenges) {
        for (const ch of Object.values(rawChallenges)) {
          if (ch?.id && ch.expiresAt > now) {
            target.authChallenges.set(ch.id, ch);
          }
        }
      }
    } catch (err) {
      console.error(
        'Firebase Auth state hydration error:',
        err instanceof Error ? err.message : String(err)
      );
      hydrationPromise = null;
    }
  })();

  return hydrationPromise;
}

export async function purgeDemoDataFromFirebaseAdmin(): Promise<{
  executed: boolean;
  deletedDocs: number;
  reason?: string;
}> {
  const { enabled, rtdb, firestore } = ensureFirebaseAdminInitialized();
  if (!enabled) {
    return {
      executed: false,
      deletedDocs: 0,
      reason: 'Firebase Admin service account credentials are not configured on this server.',
    };
  }
  let deletedDocs = 0;

  if (rtdb) {
    const usersSnap = await rtdb.ref('auth_users').get();
    const raw = (usersSnap.val() as Record<string, Partial<ServerUser>> | null) ?? {};
    for (const [key, val] of Object.entries(raw)) {
      if (val?.userId !== 'MC2627110001' && val?.userId !== 'MC2627110002') {
        await rtdb.ref(`auth_users/${key}`).remove();
        deletedDocs += 1;
      }
    }
    await rtdb.ref('auth_challenges').remove();
    await rtdb.ref('auth_audit_logs').remove();
  }

  if (firestore) {
    const collectionsToClear = [
      'customers',
      'applications',
      'payments',
      'expenses',
      'refunds',
      'dailyCashClosings',
      'cscOrders',
      'pvcOrders',
      'cscGrievances',
      'cscDocuments',
      'wholesaleShops',
      'managerServiceAssignments',
      'staffServiceRequests',
      'staffServicePermissions',
      'serviceApprovalLogs',
      'securityLogs',
      'auditLogs',
      'notifications',
      'auth_challenges',
      'auth_audit_logs',
    ];
    for (const colName of collectionsToClear) {
      const snap = await firestore.collection(colName).get();
      if (!snap.empty) {
        for (const d of snap.docs) {
          await d.ref.delete();
          deletedDocs += 1;
        }
      }
    }
    const authUsersSnap = await firestore.collection('auth_users').get();
    for (const d of authUsersSnap.docs) {
      if (d.id !== 'MC2627110001' && d.id !== 'MC2627110002') {
        await d.ref.delete();
        deletedDocs += 1;
      }
    }
  }

  return { executed: true, deletedDocs };
}
