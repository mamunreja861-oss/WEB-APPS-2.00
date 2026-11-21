import { LanguageCode, RoleName, ThemeMode } from '../modules/types';

import { FirebaseApp, getApps, initializeApp } from 'firebase/app';
import {
  Analytics,
  getAnalytics,
  isSupported as isAnalyticsSupported,
} from 'firebase/analytics';
import {
  Auth,
  EmailAuthProvider,
  GoogleAuthProvider,
  User,
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  reauthenticateWithCredential,
  setPersistence,
  signInWithPopup,
  signOut,
  updatePassword,
  updateProfile,
} from 'firebase/auth';
import {
  Firestore,
  collection,
  deleteDoc,
  doc,
  getDocFromServer,
  getDocs,
  getFirestore,
} from 'firebase/firestore';
import { FirebaseStorage, getStorage } from 'firebase/storage';
import firebaseAppletConfig from '../../firebase-applet-config.json';

function nonEmptyEnv(val: string | undefined, fallback?: string): string {
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : (fallback || '').trim();
}

export const resolvedFirebaseConfig = {
  apiKey: nonEmptyEnv(import.meta.env.VITE_FIREBASE_API_KEY, firebaseAppletConfig.apiKey),
  authDomain: nonEmptyEnv(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN, firebaseAppletConfig.authDomain),
  projectId: nonEmptyEnv(import.meta.env.VITE_FIREBASE_PROJECT_ID, firebaseAppletConfig.projectId),
  storageBucket: nonEmptyEnv(
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    firebaseAppletConfig.storageBucket
  ),
  messagingSenderId: nonEmptyEnv(
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    firebaseAppletConfig.messagingSenderId
  ),
  appId: nonEmptyEnv(import.meta.env.VITE_FIREBASE_APP_ID, firebaseAppletConfig.appId),
  measurementId: nonEmptyEnv(
    import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
    firebaseAppletConfig.measurementId
  ),
  firestoreDatabaseId: nonEmptyEnv(
    import.meta.env.VITE_FIREBASE_DATABASE_ID,
    firebaseAppletConfig.firestoreDatabaseId
  ),
};

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let dbInstance: Firestore | null = null;
let storageInstance: FirebaseStorage | null = null;
let analyticsInstance: Analytics | null = null;
let initErrorMsg: string | null = null;

try {
  if (resolvedFirebaseConfig.apiKey && resolvedFirebaseConfig.projectId) {
    app =
      getApps().length > 0
        ? getApps()[0]
        : initializeApp({
            apiKey: resolvedFirebaseConfig.apiKey,
            authDomain: resolvedFirebaseConfig.authDomain,
            projectId: resolvedFirebaseConfig.projectId,
            storageBucket: resolvedFirebaseConfig.storageBucket || undefined,
            messagingSenderId: resolvedFirebaseConfig.messagingSenderId || undefined,
            appId: resolvedFirebaseConfig.appId || undefined,
            measurementId: resolvedFirebaseConfig.measurementId || undefined,
          });
    authInstance = getAuth(app);
    if (typeof window !== 'undefined') {
      void setPersistence(authInstance, browserLocalPersistence).catch((persistErr) => {
        console.warn('Firebase Auth persistence setup fallback:', persistErr);
      });
      if (resolvedFirebaseConfig.measurementId) {
        const initializedApp = app;
        void isAnalyticsSupported()
          .then((supported) => {
            if (supported) {
              analyticsInstance = getAnalytics(initializedApp);
            }
          })
          .catch(() => {
            analyticsInstance = null;
          });
      }
    }
    dbInstance = resolvedFirebaseConfig.firestoreDatabaseId
      ? getFirestore(app, resolvedFirebaseConfig.firestoreDatabaseId)
      : getFirestore(app);
    try {
      const normalizedBucket = resolvedFirebaseConfig.storageBucket.replace(/^gs:\/\//i, '').trim();
      storageInstance = normalizedBucket
        ? getStorage(app, `gs://${normalizedBucket}`)
        : getStorage(app);
    } catch (storageErr) {
      console.warn('Firebase Storage initialization warning:', storageErr);
      storageInstance = null;
    }
  }
} catch (err) {
  initErrorMsg = err instanceof Error ? err.message : 'Firebase SDK initialization failed.';
}

export const firebaseApp = app;
export const auth = authInstance;
export const db = dbInstance;
export const storage = storageInstance;
export const firebaseInitError: string | null = initErrorMsg;

export function getFirebaseAnalytics(): Analytics | null {
  return analyticsInstance;
}

export function isFirebaseConfigured(): boolean {
  return Boolean(dbInstance && authInstance && !initErrorMsg);
}

export function isFirebaseStorageConfigured(): boolean {
  return Boolean(storageInstance && resolvedFirebaseConfig.storageBucket && !initErrorMsg);
}

export function formatFirebaseAuthError(err: unknown): string {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: string }).code || '')
      : '';
  const msg = err instanceof Error ? err.message : String(err || '');
  switch (code) {
    case 'auth/weak-password':
      return 'New password is too weak. Use at least 12 characters with uppercase, lowercase, number, and symbol.';
    case 'auth/requires-recent-login':
      return 'Re-authentication is required before changing your cloud password. Please verify your current password or sign in again.';
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'Current password does not match your cloud authentication credentials.';
    case 'auth/network-request-failed':
      return 'Network error while updating cloud credentials. Check your internet connection and retry.';
    case 'auth/too-many-requests':
      return 'Too many password attempts. Wait a moment before retrying.';
    default:
      return msg || 'Unable to update cloud authentication credentials.';
  }
}

export async function updateFirebaseUserPasswordAndProfile(params: {
  currentPassword: string;
  newPassword: string;
  displayName?: string;
}): Promise<{ updatedAuthPassword: boolean; updatedProfile: boolean }> {
  const fbUser = authInstance?.currentUser;
  if (!fbUser) {
    return { updatedAuthPassword: false, updatedProfile: false };
  }

  let updatedProfile = false;
  if (params.displayName && params.displayName.trim() && fbUser.displayName !== params.displayName.trim()) {
    try {
      await updateProfile(fbUser, { displayName: params.displayName.trim() });
      updatedProfile = true;
    } catch (err) {
      console.warn('Firebase displayName update skipped:', err);
    }
  }

  const usesPasswordProvider = fbUser.providerData.some((p) => p.providerId === 'password');
  if (!usesPasswordProvider) {
    return { updatedAuthPassword: false, updatedProfile };
  }

  try {
    await updatePassword(fbUser, params.newPassword);
    return { updatedAuthPassword: true, updatedProfile };
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: string }).code || '')
        : '';
    if (code === 'auth/requires-recent-login' && fbUser.email && params.currentPassword) {
      try {
        const cred = EmailAuthProvider.credential(fbUser.email, params.currentPassword);
        await reauthenticateWithCredential(fbUser, cred);
        await updatePassword(fbUser, params.newPassword);
        return { updatedAuthPassword: true, updatedProfile };
      } catch (reauthErr) {
        throw new Error(formatFirebaseAuthError(reauthErr));
      }
    }
    throw new Error(formatFirebaseAuthError(err));
  }
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const currentUser = authInstance?.currentUser;
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: currentUser?.uid,
      email: currentUser?.email,
      emailVerified: currentUser?.emailVerified,
      isAnonymous: currentUser?.isAnonymous,
      tenantId: currentUser?.tenantId,
      providerInfo:
        currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testConnection(): Promise<{ ok: boolean; error?: string }> {
  if (!dbInstance || typeof window === 'undefined') {
    return { ok: false, error: 'Firestore not initialized.' };
  }
  try {
    await getDocFromServer(doc(dbInstance, 'test', 'connection'));
    return { ok: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const lower = msg.toLowerCase();
    if (lower.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
      return { ok: false, error: 'Cloud database client is offline.' };
    }
    // Permission denied on test/connection when signed out still proves server reachability
    if (lower.includes('permission-denied') || lower.includes('missing or insufficient permissions')) {
      return { ok: true };
    }
    return { ok: false, error: msg };
  }
}

void testConnection();

export async function waitForFirebaseAuthReady(): Promise<User | null> {
  if (!authInstance) return null;
  if (authInstance.currentUser) return authInstance.currentUser;
  return new Promise<User | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        unsub();
        resolve(authInstance?.currentUser ?? null);
      }
    }, 1800);
    const unsub = onAuthStateChanged(authInstance!, (user) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        unsub();
        resolve(user);
      }
    });
  });
}

export async function signInWithGoogleForFirestore(): Promise<User | null> {
  if (!authInstance) {
    throw new Error('Firebase Auth is not initialized.');
  }
  await setPersistence(authInstance, browserLocalPersistence).catch(() => {});
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const cred = await signInWithPopup(authInstance, provider);
  return cred.user;
}

export async function signOutFirebase(): Promise<void> {
  if (!authInstance) return;
  await signOut(authInstance);
}

const FIRESTORE_ADMIN_CLEANUP_COLLECTIONS = [
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
  'systemSecurity',
  'securityAlerts',
  'securityIncidents',
  'registeredDevices',
  'deletedRecords',
  'reportTemplates',
  'reportArchives',
  'reportSchedules',
  'qaTestCases',
  'qaBugs',
  'qaReleases',
  'sessions',
] as const;

export async function purgeDemoDataFromClientFirestore(): Promise<{
  connected: boolean;
  deletedDocs: number;
  skippedCollections: string[];
}> {
  const skippedCollections: string[] = [];
  let deletedDocs = 0;

  if (!dbInstance || !authInstance?.currentUser) {
    return {
      connected: false,
      deletedDocs: 0,
      skippedCollections: [...FIRESTORE_ADMIN_CLEANUP_COLLECTIONS],
    };
  }

  for (const colName of FIRESTORE_ADMIN_CLEANUP_COLLECTIONS) {
    try {
      const snap = await getDocs(collection(dbInstance, colName));
      for (const d of snap.docs) {
        await deleteDoc(d.ref);
        deletedDocs += 1;
      }
    } catch {
      skippedCollections.push(colName);
    }
  }

  return {
    connected: true,
    deletedDocs,
    skippedCollections,
  };
}

export function resolveFinancialYearCodeIST(date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: 'numeric',
    }).formatToParts(date);
    const year = Number(parts.find((p) => p.type === 'year')?.value || date.getFullYear());
    const month = Number(parts.find((p) => p.type === 'month')?.value || date.getMonth() + 1);
    const startYear = month >= 4 ? year : year - 1;
    const endYear = startYear + 1;
    return `${String(startYear).slice(-2)}${String(endYear).slice(-2)}`;
  } catch {
    const y = date.getFullYear();
    const m = date.getMonth() + 1;
    const startYear = m >= 4 ? y : y - 1;
    return `${String(startYear).slice(-2)}${String(startYear + 1).slice(-2)}`;
  }
}

export function getIstMonthCode(date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      month: '2-digit',
    }).formatToParts(date);
    return (
      parts.find((p) => p.type === 'month')?.value ||
      String(date.getMonth() + 1).padStart(2, '0')
    );
  } catch {
    return String(date.getMonth() + 1).padStart(2, '0');
  }
}

export function getCurrentUserIdPrefix(date = new Date()): string {
  return `MC${resolveFinancialYearCodeIST(date)}${getIstMonthCode(date)}`;
}

export function extractFriendlyErrorMessage(
  err: unknown,
  fallback = 'An unexpected error occurred. Please check your input and try again.'
): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const fieldErrors =
    err && typeof err === 'object' && 'errors' in err
      ? (err as { errors?: Record<string, string[] | string> }).errors
      : undefined;
  const fieldDetails = fieldErrors
    ? Object.values(fieldErrors)
        .flatMap((v) => (Array.isArray(v) ? v : [v]))
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter(Boolean)
    : [];

  if (!raw && fieldDetails.length === 0) return fallback;
  const msg = raw || fallback;
  try {
    const parsed = JSON.parse(raw) as {
      error?: string;
      message?: string;
      path?: string | null;
    };
    if (parsed && (parsed.error || parsed.message)) {
      const inner = parsed.error || parsed.message || '';
      return `${inner}${parsed.path ? ` (${parsed.path})` : ''}`;
    }
  } catch {
    // Plain string error message
  }
  const lower = msg.toLowerCase();
  if (lower.includes('missing or insufficient permissions') || lower.includes('permission-denied')) {
    return 'Access denied by server security policy. Ensure your session and permissions are active.';
  }
  if (fieldDetails.length > 0) {
    const joined = fieldDetails.join(' ');
    if (!msg.includes(joined)) {
      return `${msg.replace(/\.$/, '')}: ${joined}`;
    }
  }
  return msg;
}

export function timestampToIso(value: unknown, fallback = new Date().toISOString()): string {
  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate: () => Date }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return fallback;
}

const UI_PREFS_CACHE_KEY = 'mun_ui_prefs_v1';

export function getCachedUiPrefs(): { theme?: ThemeMode; language?: LanguageCode } {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(UI_PREFS_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { theme?: string; language?: string };
    return {
      theme: parsed.theme === 'dark' ? 'dark' : parsed.theme === 'light' ? 'light' : undefined,
      language:
        parsed.language === 'bn' || parsed.language === 'hi' || parsed.language === 'en'
          ? parsed.language
          : undefined,
    };
  } catch {
    return {};
  }
}

export function cacheUiPrefs(prefs: { theme?: ThemeMode; language?: LanguageCode }): void {
  if (typeof window === 'undefined') return;
  try {
    const current = getCachedUiPrefs();
    window.localStorage.setItem(UI_PREFS_CACHE_KEY, JSON.stringify({ ...current, ...prefs }));
  } catch {
    // Ignore storage failure
  }
}

const ROLE_PERMISSIONS: Record<RoleName, Record<string, string[]>> = {
  ADMIN: {
    dashboard: ['VIEW', 'EXPORT', 'PRINT', 'MANAGE'],
    customers: ['VIEW', 'ADD', 'EDIT', 'DELETE', 'PRINT', 'EXPORT', 'MANAGE'],
    services: ['VIEW', 'ADD', 'EDIT', 'DELETE', 'APPROVE', 'REJECT', 'ASSIGN', 'EXECUTE', 'FINANCIAL', 'MANAGE'],
    applications: ['VIEW', 'ADD', 'EDIT', 'DELETE', 'PRINT', 'EXPORT', 'APPROVE', 'REJECT', 'ASSIGN', 'EXECUTE', 'MANAGE'],
    transactions: ['VIEW', 'ADD', 'EDIT', 'DELETE', 'PRINT', 'EXPORT', 'FINANCIAL', 'MANAGE'],
    receipts: ['VIEW', 'ADD', 'EDIT', 'DELETE', 'PRINT', 'EXPORT', 'FINANCIAL'],
    invoices: ['VIEW', 'ADD', 'EDIT', 'DELETE', 'PRINT', 'EXPORT', 'FINANCIAL'],
    expenses: ['VIEW', 'ADD', 'EDIT', 'DELETE', 'PRINT', 'EXPORT', 'APPROVE', 'REJECT', 'FINANCIAL'],
    daily_cash: ['VIEW', 'ADD', 'EDIT', 'DELETE', 'PRINT', 'EXPORT', 'APPROVE', 'REJECT', 'FINANCIAL'],
    finance_engine: ['VIEW', 'ADD', 'EDIT', 'DELETE', 'PRINT', 'EXPORT', 'APPROVE', 'REJECT', 'FINANCIAL', 'MANAGE'],
    employees: ['VIEW', 'ADD', 'EDIT', 'DELETE', 'PRINT', 'EXPORT', 'APPROVE', 'REJECT', 'FINANCIAL', 'MANAGE'],
    products: ['VIEW', 'ADD', 'EDIT', 'DELETE', 'PRINT', 'EXPORT', 'FINANCIAL'],
    inventory: ['VIEW', 'ADD', 'EDIT', 'DELETE', 'PRINT', 'EXPORT', 'FINANCIAL'],
    documents: ['VIEW', 'ADD', 'EDIT', 'DELETE', 'PRINT', 'EXPORT', 'APPROVE', 'REJECT'],
    notifications: ['VIEW', 'ADD', 'EDIT', 'DELETE', 'MANAGE'],
    reports: ['VIEW', 'PRINT', 'EXPORT', 'FINANCIAL', 'MANAGE'],
    users: ['VIEW', 'ADD', 'EDIT', 'DELETE', 'APPROVE', 'REJECT', 'MANAGE'],
    roles: ['VIEW', 'EDIT', 'ASSIGN', 'MANAGE'],
    permissions: ['VIEW', 'EDIT', 'APPROVE', 'REJECT', 'ASSIGN', 'MANAGE'],
    approvals: ['VIEW', 'APPROVE', 'REJECT', 'MANAGE'],
    approval_history: ['VIEW', 'EXPORT'],
    security_logs: ['VIEW', 'EXPORT', 'MANAGE'],
    settings: ['VIEW', 'EDIT', 'MANAGE'],
    settings_proposal: ['VIEW', 'ADD', 'APPROVE', 'REJECT'],
    service_rate_proposals: ['VIEW', 'ADD', 'APPROVE', 'REJECT'],
    csc_portal: ['VIEW', 'MANAGE'],
  },
  MANAGER: {
    dashboard: ['VIEW', 'PRINT'],
    customers: ['VIEW', 'ADD', 'EDIT', 'PRINT', 'EXPORT'],
    services: ['VIEW', 'ASSIGN', 'EXECUTE'],
    applications: ['VIEW', 'ADD', 'EDIT', 'PRINT', 'APPROVE', 'REJECT', 'ASSIGN', 'EXECUTE'],
    transactions: ['VIEW', 'PRINT'],
    receipts: ['VIEW', 'ADD', 'PRINT'],
    invoices: ['VIEW', 'ADD', 'PRINT'],
    expenses: ['VIEW', 'ADD', 'PRINT'],
    daily_cash: ['VIEW', 'ADD', 'PRINT'],
    finance_engine: ['VIEW', 'ADD', 'PRINT', 'EXPORT'],
    employees: ['VIEW', 'PRINT'],
    products: ['VIEW', 'ADD', 'EDIT'],
    inventory: ['VIEW', 'ADD', 'EDIT'],
    documents: ['VIEW', 'ADD', 'PRINT', 'APPROVE', 'REJECT'],
    notifications: ['VIEW'],
    reports: ['VIEW', 'PRINT', 'EXPORT'],
    users: ['VIEW', 'ADD', 'EDIT'],
    roles: ['VIEW'],
    permissions: ['VIEW', 'ASSIGN'],
    approvals: ['VIEW', 'APPROVE'],
    approval_history: ['VIEW'],
    security_logs: ['VIEW'],
    settings: [],
    settings_proposal: ['VIEW', 'ADD'],
    service_rate_proposals: ['VIEW', 'ADD'],
    csc_portal: [],
  },
  STAFF: {
    dashboard: ['VIEW'],
    customers: ['VIEW', 'ADD'],
    services: ['VIEW', 'EXECUTE'],
    applications: ['VIEW', 'ADD', 'EDIT', 'EXECUTE'],
    transactions: [],
    receipts: ['VIEW', 'ADD', 'PRINT'],
    invoices: ['VIEW', 'PRINT'],
    expenses: [],
    daily_cash: ['VIEW', 'ADD'],
    finance_engine: ['VIEW'],
    employees: [],
    products: ['VIEW'],
    inventory: ['VIEW'],
    documents: ['VIEW', 'ADD'],
    notifications: ['VIEW'],
    reports: [],
    users: [],
    roles: [],
    permissions: [],
    approvals: [],
    approval_history: [],
    security_logs: [],
    settings: [],
    settings_proposal: [],
    service_rate_proposals: [],
    csc_portal: [],
  },
  EMPLOYEE: {
    dashboard: ['VIEW'],
    customers: ['VIEW'],
    services: ['VIEW'],
    applications: ['VIEW', 'EXECUTE'],
    transactions: [],
    receipts: ['VIEW'],
    invoices: ['VIEW'],
    expenses: [],
    daily_cash: [],
    finance_engine: [],
    employees: [],
    products: ['VIEW'],
    inventory: ['VIEW'],
    documents: ['VIEW'],
    notifications: ['VIEW'],
    reports: [],
    users: [],
    roles: [],
    permissions: [],
    approvals: [],
    approval_history: [],
    security_logs: [],
    settings: [],
    settings_proposal: [],
    service_rate_proposals: [],
    csc_portal: [],
  },
  AUDITOR: {
    dashboard: ['VIEW', 'PRINT'],
    customers: ['VIEW'],
    services: ['VIEW'],
    applications: ['VIEW'],
    transactions: ['VIEW', 'PRINT', 'EXPORT'],
    receipts: ['VIEW', 'PRINT'],
    invoices: ['VIEW', 'PRINT'],
    expenses: ['VIEW', 'PRINT'],
    daily_cash: ['VIEW', 'PRINT'],
    finance_engine: ['VIEW', 'PRINT', 'EXPORT'],
    employees: ['VIEW'],
    products: ['VIEW'],
    inventory: ['VIEW'],
    documents: ['VIEW'],
    notifications: ['VIEW'],
    reports: ['VIEW', 'PRINT', 'EXPORT'],
    users: ['VIEW'],
    roles: ['VIEW'],
    permissions: ['VIEW'],
    approvals: ['VIEW'],
    approval_history: ['VIEW', 'EXPORT'],
    security_logs: ['VIEW', 'EXPORT'],
    settings: ['VIEW'],
    settings_proposal: ['VIEW'],
    service_rate_proposals: ['VIEW'],
    csc_portal: [],
  },
  CUSTOMER: {
    dashboard: ['VIEW'],
    customers: [],
    services: ['VIEW'],
    applications: [],
    transactions: [],
    receipts: [],
    invoices: [],
    expenses: [],
    daily_cash: [],
    finance_engine: [],
    employees: [],
    products: [],
    inventory: [],
    documents: [],
    notifications: ['VIEW'],
    reports: [],
    users: [],
    roles: [],
    permissions: [],
    approvals: [],
    approval_history: [],
    security_logs: [],
    settings: [],
    settings_proposal: [],
    service_rate_proposals: [],
    csc_portal: ['VIEW'],
  },
};

export function buildPermissionsForRole(role: RoleName): Record<string, boolean> {
  const effective: Record<string, boolean> = {};
  const matrix = ROLE_PERMISSIONS[role];
  for (const [mod, perms] of Object.entries(matrix)) {
    for (const perm of [
      'VIEW',
      'ADD',
      'EDIT',
      'DELETE',
      'PRINT',
      'EXPORT',
      'APPROVE',
      'REJECT',
      'ASSIGN',
      'EXECUTE',
      'FINANCIAL',
      'MANAGE',
    ]) {
      effective[`${mod}.${perm}`] = perms.includes(perm);
    }
  }
  const canReport = role !== 'STAFF' && role !== 'CUSTOMER';
  const isAdmin = role === 'ADMIN';
  effective['report.view'] = canReport;
  effective['report.create'] = role === 'ADMIN' || role === 'MANAGER';
  effective['report.update'] = role === 'ADMIN' || role === 'MANAGER';
  effective['report.delete'] = isAdmin;
  effective['report.export.pdf'] = canReport;
  effective['report.export.excel'] = canReport;
  effective['report.print'] = canReport;
  effective['report.schedule'] = isAdmin;
  effective['report.archive.view'] = canReport;
  effective['report.audit.view'] = role === 'ADMIN' || role === 'AUDITOR';

  const isOperator = role === 'ADMIN' || role === 'MANAGER' || role === 'STAFF';
  effective['csc.customerReg'] = isOperator;
  effective['csc.orderCreate'] = isOperator;
  effective['csc.appEntry'] = isOperator;
  effective['csc.docUpload'] = isOperator;
  effective['csc.paymentEntry'] = isOperator;
  effective['csc.receiptPrint'] = isOperator;
  effective['csc.statusUpdate'] = isOperator;
  effective['csc.pvcOrderEntry'] = isOperator;
  effective['csc.customerSearch'] = isOperator;
  effective['csc.reportView'] = isAdmin || role === 'MANAGER';
  effective['csc.rateEdit'] = isAdmin;
  return effective;
}
