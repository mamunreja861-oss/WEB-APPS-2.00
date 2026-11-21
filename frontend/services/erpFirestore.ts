import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  Unsubscribe,
} from 'firebase/firestore';
import { User } from 'firebase/auth';
import {
  DailyCashClosingRecord,
  ErpApplicationItem,
  ErpCustomerItem,
  ErpExpenseItem,
  ErpPaymentItem,
  ErpRefundItem,
  ErpServiceItem,
  LanguageCode,
  MasterSettingsOverview,
  ThemeMode,
} from '../modules/types';
import {
  auth,
  db,
  extractFriendlyErrorMessage,
  handleFirestoreError,
  OperationType,
  timestampToIso,
} from './firebase';
import {
  recordCloudSyncError,
  recordCloudSyncSuccess,
  runCloudWrite,
} from './cloudSync';
import { saveCustomerToFirestore } from './customerFirestore';
import { saveServiceToFirestore } from './servicesFirestore';

export interface FeedbackRecord {
  id: string;
  feedbackNo: string;
  customerName: string;
  mobile: string;
  whatsapp: string;
  serviceName: string;
  invoiceNo?: string;
  rating: number;
  comments: string;
  testimonialConsent: boolean;
  reviewed: boolean;
  internalRemarks?: string;
  createdAt: string;
}

export interface ProductInventoryDoc {
  sku: string;
  productCode?: string;
  name: string;
  category: string;
  hsnSac: string;
  gstRatePct: number;
  valuationMethod: string;
  sellingPrice: number;
  qtyOnHand: number;
  avgUnitCost: number;
  stockValue: number;
  stockStatus: string;
  status?: string;
  movements?: any[];
  createdAt?: string;
  updatedAt?: string;
}

export interface EmployeePayrollDoc {
  id?: number;
  empId: string;
  userId?: string;
  fullName: string;
  designation: string;
  department: string;
  mobile: string;
  basicSalary: number;
  hra: number;
  allowances: number;
  pfDeduction: number;
  tdsDeduction: number;
  netSalary?: number;
  joiningDate?: string;
  status: 'Active' | 'Inactive' | 'Terminated';
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PayrollRunDoc {
  id?: number;
  runId: string;
  monthCode: string;
  voucherNo: string;
  employeeCount: number;
  grossTotal: number;
  totalDeductions: number;
  netPayableTotal: number;
  totalGross?: number;
  totalPf?: number;
  totalTds?: number;
  totalNet?: number;
  slips: any[];
  status: 'POSTED' | 'DRAFT' | 'REVERSED';
  postedBy?: string;
  createdAt?: string;
}

function boundStr(val: unknown, maxLen: number): string {
  return String(val ?? '').trim().slice(0, maxLen);
}

function sanitizeValidId(val: unknown, fallbackPrefix = 'DOC'): string {
  const cleaned = String(val ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 128);
  return cleaned.length >= 1 ? cleaned : `${fallbackPrefix}_${Date.now()}`;
}

function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = stripUndefinedDeep(v);
    }
    return out as T;
  }
  return value;
}

function sanitizeArrayOfMaps<T extends object>(arr: unknown, maxItems: number): T[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .slice(0, maxItems)
    .map((item) => stripUndefinedDeep(item && typeof item === 'object' ? item : {}) as T);
}

function hashId(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.max(1, Math.abs(hash));
}

function makeUniqueSuffixId(base: string, maxLen = 64): string {
  const suffix = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`.toUpperCase();
  const clean = sanitizeValidId(base).slice(0, maxLen - suffix.length - 1);
  return `${clean}_${suffix}`.slice(0, maxLen);
}

// ============================================================================
// 1. Applications (applications/{applicationNo})
// ============================================================================
const VALID_APP_STATUSES = new Set([
  'Draft',
  'Submitted',
  'Under Review',
  'Processing',
  'Pending Customer',
  'Pending Office',
  'Approved',
  'Rejected',
  'Completed',
  'Cancelled',
  'On Hold',
  'Reopened',
]);

async function ensureCustomerAndServiceForApp(
  app: ErpApplicationItem,
  customerFallback?: ErpCustomerItem,
  serviceFallback?: ErpServiceItem
): Promise<void> {
  if (!db) return;
  const custRef = doc(db, 'customers', app.customerId);
  const custSnap = await getDoc(custRef);
  if (!custSnap.exists()) {
    const custData: ErpCustomerItem = customerFallback ?? {
      id: hashId(app.customerId),
      customerId: app.customerId,
      fullName: app.customerSnapshot?.fullName || 'Registered Customer',
      fatherOrHusbandName: app.customerSnapshot?.fatherOrHusbandName || '',
      dob: app.customerSnapshot?.dob || '',
      gender:
        app.customerSnapshot?.gender === 'Female' || app.customerSnapshot?.gender === 'Other'
          ? app.customerSnapshot.gender
          : 'Male',
      mobile: app.customerSnapshot?.mobile || '9999999999',
      whatsapp: app.customerSnapshot?.whatsapp || app.customerSnapshot?.mobile || '9999999999',
      email: '',
      village: app.customerSnapshot?.village || 'Local Area',
      postOffice: '',
      policeStation: '',
      district: '',
      pinCode: '',
      presentAddress: app.customerSnapshot?.presentAddress || '',
      permanentAddress: app.customerSnapshot?.presentAddress || '',
      sameAsPresent: true,
      segment: 'Individual',
      crmTag: 'New',
      status: 'Active',
      verificationStatus: 'Unverified',
      mobileOtpVerifiedAt: null,
      consents: [],
      consentHistory: [],
      contactHistory: [],
      notesAndFollowUps: [],
      deletedAt: null,
      createdBy: app.createdBy || 'SYSTEM',
      createdAt: app.createdAt || new Date().toISOString(),
    };
    await saveCustomerToFirestore(custData);
  }

  const svcRef = doc(db, 'services', app.serviceId);
  const svcSnap = await getDoc(svcRef);
  if (!svcSnap.exists()) {
    const svcData: ErpServiceItem = serviceFallback ?? {
      id: hashId(app.serviceId),
      serviceId: app.serviceId,
      serviceCode: app.serviceSnapshot?.serviceCode || app.serviceId,
      name: app.serviceSnapshot?.name || 'CSC Service',
      categoryId: 1,
      categoryName: app.serviceSnapshot?.categoryName || 'General',
      description: '',
      serviceCharge: app.serviceSnapshot?.customerChargeSnapshot ?? 0,
      serviceCost: app.serviceSnapshot?.serviceCostSnapshot ?? 0,
      govtFee: 0,
      additionalCharges: 0,
      totalCustomerCharge: app.serviceSnapshot?.customerChargeSnapshot ?? 0,
      customerCharge: app.serviceSnapshot?.customerChargeSnapshot ?? 0,
      profitAmount: app.serviceSnapshot?.profitSnapshot ?? 0,
      status: 'Active',
      availability: 'Available',
      termsAndConditions: app.serviceSnapshot?.termsSnapshot || '',
      sla: {
        processingMode: 'FIXED',
        expectedDays: 3,
        minDays: 1,
        maxDays: 5,
        dayType: 'WORKING',
        excludeHolidays: true,
        startEvent: 'ON_SUBMIT',
        pauseOnStatuses: ['Pending Customer', 'Pending Office', 'On Hold'],
        warningThresholdPct: 75,
        breachThresholdHours: 72,
      },
      requiredDocuments: app.serviceSnapshot?.requiredDocsSnapshot || [],
      currentFormVersion: app.serviceSnapshot?.appliedFormVersion || 1,
      formVersions: [],
      automationRules: [],
      deletedAt: null,
    };
    await saveServiceToFirestore(svcData);
  }
}

function buildApplicationPayload(
  app: ErpApplicationItem,
  authUser: User,
  isCreate: boolean,
  existingData?: Record<string, unknown>
): Record<string, unknown> {
  const status = VALID_APP_STATUSES.has(app.status) ? app.status : 'Submitted';
  const payload: Record<string, unknown> = {
    applicationNo: sanitizeValidId(existingData?.applicationNo || app.applicationNo, 'MCA'),
    financialYear:
      typeof existingData?.financialYear === 'string'
        ? existingData.financialYear
        : boundStr(app.financialYear || '2026-27', 20),
    customerId: sanitizeValidId(existingData?.customerId || app.customerId, 'MCC'),
    customerSnapshot: existingData?.customerSnapshot ?? stripUndefinedDeep(app.customerSnapshot ?? {}),
    serviceId: sanitizeValidId(existingData?.serviceId || app.serviceId, 'SRV'),
    serviceSnapshot: existingData?.serviceSnapshot ?? stripUndefinedDeep(app.serviceSnapshot ?? {}),
    formData: stripUndefinedDeep(app.formData ?? {}),
    status,
    assignedStaffId: app.assignedStaffId ?? null,
    assignedCounterCode: app.assignedCounterCode ?? null,
    submissionDate: app.submissionDate ?? null,
    expectedCompletionDate: boundStr(app.expectedCompletionDate, 64),
    actualCompletionDate: app.actualCompletionDate ?? null,
    references: sanitizeArrayOfMaps(app.references, 30),
    statusHistory: sanitizeArrayOfMaps(app.statusHistory, 50),
    assignmentHistory: sanitizeArrayOfMaps(app.assignmentHistory, 50),
    checklistSummary: stripUndefinedDeep(app.checklistSummary ?? {}),
    documents: sanitizeArrayOfMaps(
      Array.isArray(app.documents)
        ? app.documents.map((docItem) => {
            if (!docItem || typeof docItem !== 'object') return {};
            const copy = { ...(docItem as unknown as Record<string, unknown>) };
            delete copy.contentBase64;
            return copy;
          })
        : [],
      30
    ),
    financialSummary: stripUndefinedDeep(app.financialSummary ?? {}),
    payments: sanitizeArrayOfMaps(app.payments, 50),
    followUps: sanitizeArrayOfMaps(app.followUps, 50),
    notes: sanitizeArrayOfMaps(app.notes, 100),
    delivery: app.delivery ? stripUndefinedDeep(app.delivery) : null,
    cancellations: sanitizeArrayOfMaps(app.cancellations, 10),
    reassignments: sanitizeArrayOfMaps(app.reassignments, 20),
    notifications: sanitizeArrayOfMaps(app.notifications, 50),
    activities: sanitizeArrayOfMaps(app.activities, 100),
    createdByUid:
      typeof existingData?.createdByUid === 'string' && existingData.createdByUid
        ? existingData.createdByUid
        : authUser.uid,
    createdBy:
      typeof existingData?.createdBy === 'string' && existingData.createdBy
        ? existingData.createdBy
        : boundStr(app.createdBy || authUser.email || authUser.uid, 64) || 'SYSTEM',
    updatedAt: serverTimestamp(),
  };

  if (existingData) {
    if (existingData.id !== undefined) payload.id = existingData.id;
    if (existingData.mandatoryDocExceptionReason !== undefined) {
      payload.mandatoryDocExceptionReason = existingData.mandatoryDocExceptionReason;
    }
    if (existingData.duplicateOverrideReason !== undefined) {
      payload.duplicateOverrideReason = existingData.duplicateOverrideReason;
    }
    if (existingData.slaStatus !== undefined) payload.slaStatus = existingData.slaStatus;
    if (existingData.refunds !== undefined) payload.refunds = existingData.refunds;
    if (existingData.archivedAt !== undefined) payload.archivedAt = existingData.archivedAt;
    payload.createdAt = existingData.createdAt ?? serverTimestamp();
  } else {
    if (typeof app.id === 'number' && Number.isFinite(app.id)) payload.id = app.id;
    if (app.mandatoryDocExceptionReason !== undefined) {
      payload.mandatoryDocExceptionReason = app.mandatoryDocExceptionReason ?? null;
    }
    if (app.duplicateOverrideReason !== undefined) {
      payload.duplicateOverrideReason = app.duplicateOverrideReason ?? null;
    }
    payload.slaStatus = stripUndefinedDeep(app.slaStatus ?? { label: 'On Track', badge: 'success' });
    payload.refunds = sanitizeArrayOfMaps(app.refunds, 20);
    payload.archivedAt = app.archivedAt ?? null;
    payload.createdAt = serverTimestamp();
  }

  return payload;
}

export function mapFirestoreApplicationDoc(
  docId: string,
  data: Record<string, unknown>
): ErpApplicationItem {
  const applicationNo = String(data.applicationNo || docId);
  return {
    id: typeof data.id === 'number' ? data.id : hashId(applicationNo),
    applicationNo,
    financialYear: String(data.financialYear || '2026-27'),
    customerId: String(data.customerId || ''),
    customerSnapshot: (data.customerSnapshot as ErpApplicationItem['customerSnapshot']) || {
      customerId: String(data.customerId || ''),
      fullName: 'Customer',
      fatherOrHusbandName: '',
      dob: '',
      gender: 'Male',
      mobile: '',
      whatsapp: '',
      village: '',
      presentAddress: '',
    },
    serviceId: String(data.serviceId || ''),
    serviceSnapshot: (data.serviceSnapshot as ErpApplicationItem['serviceSnapshot']) || {
      serviceId: String(data.serviceId || ''),
      serviceCode: String(data.serviceId || ''),
      name: 'Service',
      categoryName: 'General',
      appliedFormVersion: 1,
      formFieldsSnapshot: [],
      requiredDocsSnapshot: [],
      customerChargeSnapshot: 0,
      serviceCostSnapshot: 0,
      profitSnapshot: 0,
      termsSnapshot: '',
    },
    formData: (data.formData as Record<string, unknown>) || {},
    status: (data.status as ErpApplicationItem['status']) || 'Submitted',
    assignedStaffId: typeof data.assignedStaffId === 'string' ? data.assignedStaffId : null,
    assignedCounterCode:
      typeof data.assignedCounterCode === 'string' ? data.assignedCounterCode : null,
    submissionDate: typeof data.submissionDate === 'string' ? data.submissionDate : null,
    expectedCompletionDate: String(data.expectedCompletionDate || ''),
    actualCompletionDate:
      typeof data.actualCompletionDate === 'string' ? data.actualCompletionDate : null,
    mandatoryDocExceptionReason:
      typeof data.mandatoryDocExceptionReason === 'string'
        ? data.mandatoryDocExceptionReason
        : null,
    duplicateOverrideReason:
      typeof data.duplicateOverrideReason === 'string' ? data.duplicateOverrideReason : null,
    references: Array.isArray(data.references) ? (data.references as ErpApplicationItem['references']) : [],
    statusHistory: Array.isArray(data.statusHistory)
      ? (data.statusHistory as ErpApplicationItem['statusHistory'])
      : [],
    assignmentHistory: Array.isArray(data.assignmentHistory)
      ? (data.assignmentHistory as ErpApplicationItem['assignmentHistory'])
      : [],
    checklistSummary: (data.checklistSummary as ErpApplicationItem['checklistSummary']) || {
      requiredDocuments: 0,
      optionalDocuments: 0,
      uploadedDocuments: 0,
      uploadedMandatoryCount: 0,
      verifiedDocuments: 0,
      pendingVerification: 0,
      rejectedDocuments: 0,
      missingCount: 0,
      missingRequiredLabels: [],
      isSubmissionReady: true,
    },
    slaStatus: (data.slaStatus as ErpApplicationItem['slaStatus']) || {
      label: 'On Track',
      badge: 'success',
    },
    documents: Array.isArray(data.documents)
      ? (data.documents as ErpApplicationItem['documents'])
      : [],
    financialSummary: (data.financialSummary as ErpApplicationItem['financialSummary']) || {
      serviceCharge: 0,
      serviceCost: 0,
      profitAmount: 0,
      totalPaid: 0,
      totalRefunded: 0,
      netCollected: 0,
      balanceDue: 0,
      paymentStatus: 'Unpaid',
    },
    payments: Array.isArray(data.payments) ? (data.payments as ErpPaymentItem[]) : [],
    refunds: Array.isArray(data.refunds) ? (data.refunds as ErpRefundItem[]) : [],
    followUps: Array.isArray(data.followUps)
      ? (data.followUps as ErpApplicationItem['followUps'])
      : [],
    notes: Array.isArray(data.notes) ? (data.notes as ErpApplicationItem['notes']) : [],
    delivery: (data.delivery as ErpApplicationItem['delivery']) || null,
    cancellations: Array.isArray(data.cancellations)
      ? (data.cancellations as ErpApplicationItem['cancellations'])
      : [],
    reassignments: Array.isArray(data.reassignments)
      ? (data.reassignments as ErpApplicationItem['reassignments'])
      : [],
    notifications: Array.isArray(data.notifications)
      ? (data.notifications as ErpApplicationItem['notifications'])
      : [],
    activities: Array.isArray(data.activities)
      ? (data.activities as ErpApplicationItem['activities'])
      : [],
    archivedAt: typeof data.archivedAt === 'string' && data.archivedAt ? data.archivedAt : null,
    createdBy: String(data.createdBy || ''),
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

export async function saveApplicationToFirestore(
  app: ErpApplicationItem,
  opts?: {
    customerFallback?: ErpCustomerItem;
    serviceFallback?: ErpServiceItem;
    isExplicitCreate?: boolean;
  }
): Promise<ErpApplicationItem> {
  return runCloudWrite(async (authUser) => {
    if (!db) throw new Error('Cloud database (Firestore) is not initialized.');
    await ensureCustomerAndServiceForApp(app, opts?.customerFallback, opts?.serviceFallback);
    let targetApp = { ...app };
    let ref = doc(db, 'applications', targetApp.applicationNo);
    try {
      const existing = await getDoc(ref);
      if (existing.exists()) {
        const existingData = existing.data() as Record<string, unknown>;
        const sameRecord =
          String(existingData.customerId || '') === targetApp.customerId &&
          String(existingData.serviceId || '') === targetApp.serviceId;
        if (opts?.isExplicitCreate && !sameRecord) {
          const nextNo = makeUniqueSuffixId(targetApp.applicationNo, 64);
          targetApp = { ...targetApp, applicationNo: nextNo };
          ref = doc(db, 'applications', nextNo);
          await setDoc(ref, buildApplicationPayload(targetApp, authUser, true));
        } else {
          await updateDoc(ref, buildApplicationPayload(targetApp, authUser, false, existingData));
        }
      } else {
        await setDoc(ref, buildApplicationPayload(targetApp, authUser, true));
      }
      return targetApp;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `applications/${targetApp.applicationNo}`);
    }
  });
}

export async function deleteApplicationFromFirestore(applicationNo: string): Promise<void> {
  await runCloudWrite(async () => {
    if (!db) throw new Error('Cloud database (Firestore) is not initialized.');
    try {
      await deleteDoc(doc(db, 'applications', applicationNo));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `applications/${applicationNo}`);
    }
  });
}

export async function getApplicationFromFirestore(
  applicationNo: string
): Promise<ErpApplicationItem | null> {
  if (!db || !auth?.currentUser) return null;
  try {
    const snap = await getDoc(doc(db, 'applications', applicationNo));
    if (!snap.exists()) return null;
    recordCloudSyncSuccess();
    return mapFirestoreApplicationDoc(snap.id, snap.data() as Record<string, unknown>);
  } catch (err) {
    recordCloudSyncError(extractFriendlyErrorMessage(err));
    return null;
  }
}

export function subscribeApplicationsFromFirestore(
  onData: (apps: ErpApplicationItem[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  return onSnapshot(
    collection(db, 'applications'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => mapFirestoreApplicationDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      if (onError) onError(error);
    }
  );
}

// ============================================================================
// 2. Payments, Expenses, Refunds & Daily Cash Closings
// ============================================================================
const VALID_PAYMENT_METHODS = new Set(['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other']);
const VALID_PAYMENT_VERIFICATIONS = new Set(['Confirmed', 'Pending Verification', 'Rejected']);

export function mapFirestorePaymentDoc(
  docId: string,
  data: Record<string, unknown>
): ErpPaymentItem {
  const transactionId = String(data.transactionId || docId);
  return {
    id: typeof data.id === 'number' ? data.id : hashId(transactionId),
    transactionId,
    receiptNo: String(data.receiptNo || transactionId),
    invoiceNo: typeof data.invoiceNo === 'string' && data.invoiceNo ? data.invoiceNo : undefined,
    applicationNo: String(data.applicationNo || ''),
    customerId: String(data.customerId || ''),
    customerName: String(data.customerName || ''),
    serviceId: String(data.serviceId || ''),
    serviceName: String(data.serviceName || ''),
    counterCode: String(data.counterCode || 'CTR-01'),
    collectedBy: String(data.collectedBy || ''),
    paymentType: (data.paymentType as ErpPaymentItem['paymentType']) || 'Full',
    paymentMethod: (data.paymentMethod as ErpPaymentItem['paymentMethod']) || 'Cash',
    upiReference: typeof data.upiReference === 'string' ? data.upiReference : undefined,
    amount: Number(data.amount ?? 0),
    verificationStatus:
      (data.verificationStatus as ErpPaymentItem['verificationStatus']) || 'Confirmed',
    verifiedBy: typeof data.verifiedBy === 'string' ? data.verifiedBy : null,
    recordedAt: String(data.recordedAt || timestampToIso(data.createdAt)),
    notes: boundStr(data.notes, 400),
  };
}

export async function savePaymentToFirestore(
  payment: ErpPaymentItem,
  appFallback?: ErpApplicationItem
): Promise<ErpPaymentItem> {
  return runCloudWrite(async (authUser) => {
    if (!db) throw new Error('Cloud database (Firestore) is not initialized.');
    if (appFallback) {
      const appRef = doc(db, 'applications', payment.applicationNo);
      const appSnap = await getDoc(appRef);
      if (!appSnap.exists()) {
        await saveApplicationToFirestore(appFallback);
      }
    }

    let target = { ...payment };
    let ref = doc(db, 'payments', target.transactionId);
    try {
      const existing = await getDoc(ref);
      const existingData = existing.exists()
        ? (existing.data() as Record<string, unknown>)
        : undefined;
      if (
        existingData &&
        String(existingData.applicationNo || '') !== target.applicationNo
      ) {
        target = { ...target, transactionId: makeUniqueSuffixId(target.transactionId, 64) };
        ref = doc(db, 'payments', target.transactionId);
      }

      const payload: Record<string, unknown> = {
        id: typeof target.id === 'number' ? target.id : hashId(target.transactionId),
        transactionId: sanitizeValidId(target.transactionId, 'TXN'),
        receiptNo: boundStr(target.receiptNo || target.transactionId, 64),
        invoiceNo: target.invoiceNo ? boundStr(target.invoiceNo, 64) : '',
        applicationNo: sanitizeValidId(
          existingData?.applicationNo || target.applicationNo,
          'MCA'
        ),
        customerId: sanitizeValidId(target.customerId, 'MCC'),
        customerName: boundStr(target.customerName, 120),
        serviceId: sanitizeValidId(target.serviceId || 'SRV', 'SRV'),
        serviceName: boundStr(target.serviceName, 160),
        counterCode: boundStr(target.counterCode || 'CTR-01', 40),
        collectedBy: boundStr(target.collectedBy || authUser.email || authUser.uid, 64),
        paymentType: target.paymentType || 'Full',
        paymentMethod: VALID_PAYMENT_METHODS.has(target.paymentMethod)
          ? target.paymentMethod
          : 'Cash',
        upiReference: boundStr(target.upiReference, 80),
        amount: Math.max(0.01, Number(target.amount || 0)),
        verificationStatus: VALID_PAYMENT_VERIFICATIONS.has(target.verificationStatus)
          ? target.verificationStatus
          : 'Confirmed',
        verifiedBy: target.verifiedBy ?? null,
        recordedAt: target.recordedAt || new Date().toISOString(),
        notes: boundStr(target.notes, 400),
        createdByUid:
          typeof existingData?.createdByUid === 'string' && existingData.createdByUid
            ? existingData.createdByUid
            : authUser.uid,
        createdAt: existingData?.createdAt ?? serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      if (existingData && !makeCollisionCheck(existingData, target.applicationNo)) {
        await updateDoc(ref, payload);
      } else {
        await setDoc(ref, payload);
      }
      return target;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `payments/${target.transactionId}`);
    }
  });
}

function makeCollisionCheck(existingData: Record<string, unknown>, appNo: string): boolean {
  return String(existingData.applicationNo || '') !== appNo;
}

export function subscribePaymentsFromFirestore(
  onData: (payments: ErpPaymentItem[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  return onSnapshot(
    collection(db, 'payments'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => mapFirestorePaymentDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      if (onError) onError(error);
    }
  );
}

export function mapFirestoreExpenseDoc(
  docId: string,
  data: Record<string, unknown>
): ErpExpenseItem {
  const voucherNo = String(data.voucherNo || docId);
  return {
    id: typeof data.id === 'number' ? data.id : hashId(voucherNo),
    voucherNo,
    category: String(data.category || 'General'),
    description: String(data.description || ''),
    counterCode: String(data.counterCode || 'CTR-01'),
    amount: Number(data.amount ?? 0),
    expenseDate: String(data.expenseDate || timestampToIso(data.createdAt).slice(0, 10)),
    recordedBy: String(data.recordedBy || ''),
    status: data.status === 'Pending' ? 'Pending' : 'Approved',
    createdAt: timestampToIso(data.createdAt),
  };
}

export async function saveExpenseToFirestore(expense: ErpExpenseItem): Promise<ErpExpenseItem> {
  return runCloudWrite(async (authUser) => {
    if (!db) throw new Error('Cloud database (Firestore) is not initialized.');
    let target = { ...expense };
    let ref = doc(db, 'expenses', target.voucherNo);
    try {
      const existing = await getDoc(ref);
      const existingData = existing.exists()
        ? (existing.data() as Record<string, unknown>)
        : undefined;
      if (
        existingData &&
        String(existingData.description || '') !== String(target.description || '')
      ) {
        target = { ...target, voucherNo: makeUniqueSuffixId(target.voucherNo, 64) };
        ref = doc(db, 'expenses', target.voucherNo);
      }
      const cleanCategory = boundStr(target.category, 80);
      const payload: Record<string, unknown> = {
        id: typeof target.id === 'number' ? target.id : hashId(target.voucherNo),
        voucherNo: sanitizeValidId(target.voucherNo, 'EXP'),
        category: cleanCategory.length >= 2 ? cleanCategory : `${cleanCategory} Expense`,
        description: boundStr(target.description, 300),
        counterCode: boundStr(target.counterCode || 'CTR-01', 40),
        amount: Math.max(0.01, Number(target.amount || 0)),
        expenseDate: boundStr(target.expenseDate || new Date().toISOString().slice(0, 10), 32),
        recordedBy: boundStr(target.recordedBy || authUser.email || authUser.uid, 64),
        status: target.status === 'Pending' ? 'Pending' : 'Approved',
        createdByUid:
          typeof existingData?.createdByUid === 'string' && existingData.createdByUid
            ? existingData.createdByUid
            : authUser.uid,
        createdAt: existingData?.createdAt ?? serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (existing.exists() && ref.id === existing.id) {
        await updateDoc(ref, payload);
      } else {
        await setDoc(ref, payload);
      }
      return target;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `expenses/${target.voucherNo}`);
    }
  });
}

export function subscribeExpensesFromFirestore(
  onData: (expenses: ErpExpenseItem[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  return onSnapshot(
    collection(db, 'expenses'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => mapFirestoreExpenseDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      if (onError) onError(error);
    }
  );
}

export function mapFirestoreRefundDoc(
  docId: string,
  data: Record<string, unknown>
): ErpRefundItem {
  const refundId = String(data.refundId || docId);
  return {
    id: typeof data.id === 'number' ? data.id : hashId(refundId),
    refundId,
    applicationNo: String(data.applicationNo || ''),
    customerId: String(data.customerId || ''),
    originalTransactionId: String(data.originalTransactionId || ''),
    refundType: (data.refundType as ErpRefundItem['refundType']) || 'Full',
    refundAmount: Number(data.refundAmount ?? 0),
    refundMethod: (data.refundMethod as ErpRefundItem['refundMethod']) || 'Cash',
    refundReason: boundStr(data.refundReason, 300),
    status: (data.status as ErpRefundItem['status']) || 'Pending',
    requestedBy: String(data.requestedBy || ''),
    approvedBy: typeof data.approvedBy === 'string' ? data.approvedBy : null,
    processedBy: typeof data.processedBy === 'string' ? data.processedBy : null,
    createdAt: timestampToIso(data.createdAt),
    processedAt: typeof data.processedAt === 'string' ? data.processedAt : null,
  };
}

export async function saveRefundToFirestore(
  refund: ErpRefundItem,
  appFallback?: ErpApplicationItem
): Promise<ErpRefundItem> {
  return runCloudWrite(async (authUser) => {
    if (!db) throw new Error('Cloud database (Firestore) is not initialized.');
    if (appFallback) {
      const appRef = doc(db, 'applications', refund.applicationNo);
      const appSnap = await getDoc(appRef);
      if (!appSnap.exists()) {
        await saveApplicationToFirestore(appFallback);
      }
    }

    const ref = doc(db, 'refunds', refund.refundId);
    try {
      const existing = await getDoc(ref);
      const existingData = existing.exists()
        ? (existing.data() as Record<string, unknown>)
        : undefined;
      const payload: Record<string, unknown> = {
        id: typeof refund.id === 'number' ? refund.id : hashId(refund.refundId),
        refundId: sanitizeValidId(existingData?.refundId || refund.refundId, 'MCRF'),
        applicationNo: sanitizeValidId(existingData?.applicationNo || refund.applicationNo, 'MCA'),
        customerId: sanitizeValidId(refund.customerId || 'MCC', 'MCC'),
        originalTransactionId: boundStr(refund.originalTransactionId, 64),
        refundType: refund.refundType || 'Full',
        refundAmount: Math.max(0, Number(refund.refundAmount || 0)),
        refundMethod: refund.refundMethod || 'Cash',
        refundReason: boundStr(refund.refundReason, 300),
        status: ['Pending', 'Approved', 'Rejected', 'Processed'].includes(refund.status)
          ? refund.status
          : 'Pending',
        requestedBy: boundStr(refund.requestedBy || authUser.email || authUser.uid, 64),
        approvedBy: refund.approvedBy ?? null,
        processedBy: refund.processedBy ?? null,
        processedAt: refund.processedAt ?? null,
        createdByUid:
          typeof existingData?.createdByUid === 'string' && existingData.createdByUid
            ? existingData.createdByUid
            : authUser.uid,
        createdAt: existingData?.createdAt ?? serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (existing.exists()) {
        await updateDoc(ref, payload);
      } else {
        await setDoc(ref, payload);
      }
      return refund;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `refunds/${refund.refundId}`);
    }
  });
}

export function subscribeRefundsFromFirestore(
  onData: (refunds: ErpRefundItem[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  return onSnapshot(
    collection(db, 'refunds'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => mapFirestoreRefundDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      if (onError) onError(error);
    }
  );
}

export function mapFirestoreDailyCashDoc(
  docId: string,
  data: Record<string, unknown>
): DailyCashClosingRecord {
  const closingCode = String(data.closingCode || docId);
  return {
    id: typeof data.id === 'number' ? data.id : hashId(closingCode),
    closingCode,
    branchId: Number(data.branchId ?? 1),
    counterCode: String(data.counterCode || 'CTR-01'),
    closingDate: String(data.closingDate || ''),
    openingCash: Number(data.openingCash ?? 0),
    cashReceived: Number(data.cashReceived ?? 0),
    cashExpenses: Number(data.cashExpenses ?? 0),
    expectedCash: Number(data.expectedCash ?? 0),
    actualCashCount: Number(data.actualCashCount ?? 0),
    cashDifference: Number(data.cashDifference ?? 0),
    differenceReason: String(data.differenceReason || ''),
    submittedBy: String(data.submittedBy || ''),
    approvedBy: typeof data.approvedBy === 'string' ? data.approvedBy : null,
    approvalStatus:
      (data.approvalStatus as DailyCashClosingRecord['approvalStatus']) || 'Pending Admin Approval',
    createdAt: timestampToIso(data.createdAt),
    correctionAudit: Array.isArray(data.correctionAudit)
      ? (data.correctionAudit as DailyCashClosingRecord['correctionAudit'])
      : [],
  };
}

export async function saveDailyCashToFirestore(
  closing: DailyCashClosingRecord
): Promise<DailyCashClosingRecord> {
  return runCloudWrite(async (authUser) => {
    if (!db) throw new Error('Cloud database (Firestore) is not initialized.');
    const ref = doc(db, 'dailyCashClosings', closing.closingCode);
    try {
      const existing = await getDoc(ref);
      const existingData = existing.exists()
        ? (existing.data() as Record<string, unknown>)
        : undefined;
      const payload: Record<string, unknown> = {
        id: typeof closing.id === 'number' ? closing.id : hashId(closing.closingCode),
        closingCode: sanitizeValidId(existingData?.closingCode || closing.closingCode, 'DCC'),
        branchId: Number(closing.branchId ?? 1),
        counterCode: boundStr(closing.counterCode || 'CTR-01', 40),
        closingDate: boundStr(closing.closingDate || new Date().toISOString().slice(0, 10), 32),
        openingCash: Number(closing.openingCash ?? 0),
        cashReceived: Number(closing.cashReceived ?? 0),
        cashExpenses: Number(closing.cashExpenses ?? 0),
        expectedCash: Number(closing.expectedCash ?? 0),
        actualCashCount: Number(closing.actualCashCount ?? 0),
        cashDifference: Number(closing.cashDifference ?? 0),
        differenceReason: boundStr(closing.differenceReason, 300),
        submittedBy: boundStr(closing.submittedBy || authUser.email || authUser.uid, 64),
        approvedBy: closing.approvedBy ?? null,
        approvalStatus: ['Approved', 'Pending Admin Approval', 'Rejected'].includes(
          closing.approvalStatus
        )
          ? closing.approvalStatus
          : 'Pending Admin Approval',
        correctionAudit: sanitizeArrayOfMaps(closing.correctionAudit, 50),
        createdByUid:
          typeof existingData?.createdByUid === 'string' && existingData.createdByUid
            ? existingData.createdByUid
            : authUser.uid,
        createdAt: existingData?.createdAt ?? serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (existing.exists()) {
        await updateDoc(ref, payload);
      } else {
        await setDoc(ref, payload);
      }
      return closing;
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `dailyCashClosings/${closing.closingCode}`);
    }
  });
}

export function subscribeDailyCashFromFirestore(
  onData: (closings: DailyCashClosingRecord[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  return onSnapshot(
    collection(db, 'dailyCashClosings'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => mapFirestoreDailyCashDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      if (onError) onError(error);
    }
  );
}

// ============================================================================
// 3. Products & Inventory (products/{productId})
// ============================================================================
export function mapFirestoreProductDoc(
  docId: string,
  data: Record<string, unknown>
): ProductInventoryDoc {
  const sku = String(data.sku || data.productCode || docId);
  return {
    sku,
    productCode: String(data.productCode || sku),
    name: String(data.name || ''),
    category: String(data.category || 'Hardware'),
    hsnSac: String(data.hsnSac || ''),
    gstRatePct: Number(data.gstRatePct ?? 18),
    valuationMethod: String(data.valuationMethod || 'FIFO'),
    sellingPrice: Number(data.sellingPrice ?? 0),
    qtyOnHand: Number(data.qtyOnHand ?? 0),
    avgUnitCost: Number(data.avgUnitCost ?? 0),
    stockValue: Number(data.stockValue ?? 0),
    stockStatus: String(data.stockStatus || data.status || 'in_stock'),
    status: String(data.status || data.stockStatus || 'in_stock'),
    movements: Array.isArray(data.movements) ? data.movements : [],
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

export async function saveProductToFirestore(
  product: ProductInventoryDoc
): Promise<ProductInventoryDoc> {
  return runCloudWrite(async (authUser) => {
    if (!db) throw new Error('Cloud database (Firestore) is not initialized.');
    const productCode = sanitizeValidId(product.sku || product.productCode, 'SKU');
    const ref = doc(db, 'products', productCode);
    try {
      const existing = await getDoc(ref);
      const existingData = existing.exists()
        ? (existing.data() as Record<string, unknown>)
        : undefined;
      const payload = stripUndefinedDeep({
        productCode: String(existingData?.productCode || productCode),
        sku: productCode,
        name: boundStr(product.name || productCode, 160),
        category: boundStr(product.category || 'Hardware', 80),
        hsnSac: boundStr(product.hsnSac || '8471', 24),
        gstRatePct: Number(product.gstRatePct ?? 18),
        valuationMethod: boundStr(product.valuationMethod || 'FIFO', 16),
        sellingPrice: Number(product.sellingPrice ?? 0),
        qtyOnHand: Number(product.qtyOnHand ?? 0),
        avgUnitCost: Number(product.avgUnitCost ?? 0),
        stockValue: Number(product.stockValue ?? 0),
        stockStatus: boundStr(product.stockStatus || 'in_stock', 40),
        status: boundStr(product.stockStatus || product.status || 'in_stock', 40),
        movements: sanitizeArrayOfMaps(product.movements ?? existingData?.movements ?? [], 100),
        createdByUid:
          typeof existingData?.createdByUid === 'string' && existingData.createdByUid
            ? existingData.createdByUid
            : authUser.uid,
        createdAt: existingData?.createdAt ?? serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      if (existing.exists()) {
        await updateDoc(ref, payload);
      } else {
        await setDoc(ref, payload);
      }
      return { ...product, sku: productCode, productCode };
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `products/${productCode}`);
    }
  });
}

export function subscribeProductsFromFirestore(
  onData: (products: ProductInventoryDoc[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  return onSnapshot(
    collection(db, 'products'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => mapFirestoreProductDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => a.sku.localeCompare(b.sku));
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      if (onError) onError(error);
    }
  );
}

// ============================================================================
// 4. Employees & Payroll Runs (employees/{empId}, payrollRuns/{runId})
// ============================================================================
export function mapFirestoreEmployeeDoc(
  docId: string,
  data: Record<string, unknown>
): EmployeePayrollDoc {
  const empId = String(data.empId || docId);
  return {
    id: typeof data.id === 'number' ? data.id : hashId(empId),
    empId,
    fullName: String(data.fullName || ''),
    designation: String(data.designation || 'Operator'),
    department: String(data.department || 'Operations'),
    mobile: String(data.mobile || ''),
    basicSalary: Number(data.basicSalary ?? 0),
    hra: Number(data.hra ?? 0),
    allowances: Number(data.allowances ?? 0),
    pfDeduction: Number(data.pfDeduction ?? 0),
    tdsDeduction: Number(data.tdsDeduction ?? 0),
    netSalary: Number(data.netSalary ?? 0),
    joiningDate: typeof data.joiningDate === 'string' ? data.joiningDate : '',
    status: (data.status as EmployeePayrollDoc['status']) || 'Active',
    createdBy: String(data.createdBy || ''),
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

export async function saveEmployeeToFirestore(
  emp: EmployeePayrollDoc
): Promise<EmployeePayrollDoc> {
  return runCloudWrite(async (authUser) => {
    if (!db) throw new Error('Cloud database (Firestore) is not initialized.');
    let target = { ...emp };
    let empId = sanitizeValidId(target.empId, 'EMP');
    let ref = doc(db, 'employees', empId);
    try {
      const existing = await getDoc(ref);
      const existingData = existing.exists()
        ? (existing.data() as Record<string, unknown>)
        : undefined;
      if (
        existingData &&
        String(existingData.mobile || '') !== String(target.mobile || '') &&
        String(existingData.fullName || '') !== String(target.fullName || '')
      ) {
        empId = makeUniqueSuffixId(empId, 48);
        target = { ...target, empId };
        ref = doc(db, 'employees', empId);
      }

      const basic = Math.max(0, Number(target.basicSalary ?? 0));
      const hra = Math.max(0, Number(target.hra ?? 0));
      const allowances = Math.max(0, Number(target.allowances ?? 0));
      const pf = Math.max(0, Number(target.pfDeduction ?? 0));
      const tds = Math.max(0, Number(target.tdsDeduction ?? 0));
      const net = Math.max(0, basic + hra + allowances - pf - tds);
      const fullName = boundStr(target.fullName, 120);
      const mobile = boundStr(target.mobile, 24);

      const payload: Record<string, unknown> = {
        id: typeof target.id === 'number' ? target.id : hashId(empId),
        empId,
        fullName: fullName.length >= 2 ? fullName : `${fullName} Staff`,
        designation: boundStr(target.designation || 'Operator', 120),
        department: boundStr(target.department || 'Operations', 80),
        mobile: mobile.length >= 8 ? mobile : mobile.padEnd(10, '0'),
        basicSalary: basic,
        hra,
        allowances,
        pfDeduction: pf,
        tdsDeduction: tds,
        netSalary: net,
        joiningDate: boundStr(target.joiningDate || new Date().toISOString().slice(0, 10), 32),
        status: ['Active', 'Inactive', 'Terminated'].includes(target.status)
          ? target.status
          : 'Active',
        createdBy: boundStr(target.createdBy || authUser.email || authUser.uid, 64),
        createdByUid:
          typeof existingData?.createdByUid === 'string' && existingData.createdByUid
            ? existingData.createdByUid
            : authUser.uid,
        createdAt: existingData?.createdAt ?? serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (existing.exists() && ref.id === existing.id) {
        await updateDoc(ref, payload);
      } else {
        await setDoc(ref, payload);
      }
      return { ...target, empId };
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `employees/${empId}`);
    }
  });
}

export function subscribeEmployeesFromFirestore(
  onData: (employees: EmployeePayrollDoc[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  return onSnapshot(
    collection(db, 'employees'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => mapFirestoreEmployeeDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      if (onError) onError(error);
    }
  );
}

export function mapFirestorePayrollRunDoc(
  docId: string,
  data: Record<string, unknown>
): PayrollRunDoc {
  const runId = String(data.runId || docId);
  const totalGross = Number(data.totalGross ?? data.grossTotal ?? 0);
  const totalPf = Number(data.totalPf ?? 0);
  const totalTds = Number(data.totalTds ?? 0);
  const totalNet = Number(data.totalNet ?? data.netPayableTotal ?? 0);
  const totalDeductions =
    data.totalDeductions !== undefined
      ? Number(data.totalDeductions)
      : totalPf + totalTds || Math.max(0, totalGross - totalNet);
  return {
    id: typeof data.id === 'number' ? data.id : hashId(runId),
    runId,
    monthCode: String(data.monthCode || ''),
    voucherNo: String(data.voucherNo || ''),
    employeeCount: Number(data.employeeCount ?? 0),
    grossTotal: totalGross,
    totalDeductions,
    netPayableTotal: totalNet,
    totalGross,
    totalPf,
    totalTds,
    totalNet,
    slips: Array.isArray(data.slips) ? data.slips : [],
    status: (data.status as PayrollRunDoc['status']) || 'POSTED',
    postedBy: String(data.postedBy || ''),
    createdAt: timestampToIso(data.createdAt),
  };
}

export async function savePayrollRunToFirestore(run: PayrollRunDoc): Promise<PayrollRunDoc> {
  return runCloudWrite(async (authUser) => {
    if (!db) throw new Error('Cloud database (Firestore) is not initialized.');
    const runId = sanitizeValidId(run.runId, 'PAY');
    const ref = doc(db, 'payrollRuns', runId);
    try {
      const existing = await getDoc(ref);
      const existingData = existing.exists()
        ? (existing.data() as Record<string, unknown>)
        : undefined;
      const totalGross = Math.max(0, Number(run.totalGross ?? run.grossTotal ?? 0));
      const totalNet = Math.max(0, Number(run.totalNet ?? run.netPayableTotal ?? 0));
      const totalPf = Math.max(0, Number(run.totalPf ?? run.totalDeductions ?? 0));
      const totalTds = Math.max(0, Number(run.totalTds ?? 0));

      const payload: Record<string, unknown> = {
        id: typeof run.id === 'number' ? run.id : hashId(runId),
        runId,
        monthCode: boundStr(run.monthCode || new Date().toISOString().slice(0, 7), 16),
        voucherNo: boundStr(run.voucherNo, 64),
        employeeCount: Math.max(0, Number(run.employeeCount ?? 0)),
        totalGross,
        totalPf,
        totalTds,
        totalNet,
        slips: sanitizeArrayOfMaps(run.slips, 100),
        status: ['POSTED', 'DRAFT', 'REVERSED'].includes(run.status) ? run.status : 'POSTED',
        postedBy: boundStr(run.postedBy || authUser.email || authUser.uid, 64),
        createdByUid:
          typeof existingData?.createdByUid === 'string' && existingData.createdByUid
            ? existingData.createdByUid
            : authUser.uid,
        createdAt: existingData?.createdAt ?? serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (existing.exists()) {
        await updateDoc(ref, payload);
      } else {
        await setDoc(ref, payload);
      }
      return { ...run, runId };
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `payrollRuns/${runId}`);
    }
  });
}

export function subscribePayrollRunsFromFirestore(
  onData: (runs: PayrollRunDoc[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  return onSnapshot(
    collection(db, 'payrollRuns'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => mapFirestorePayrollRunDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      if (onError) onError(error);
    }
  );
}

// ============================================================================
// 5. Customer Feedback & Testimonials (feedbacks/{feedbackId})
// ============================================================================
export function mapFirestoreFeedbackDoc(
  docId: string,
  data: Record<string, unknown>
): FeedbackRecord {
  const feedbackNo = String(data.feedbackNo || docId);
  return {
    id: String(data.id || feedbackNo),
    feedbackNo,
    customerName: String(data.customerName || ''),
    mobile: String(data.mobile || ''),
    whatsapp: String(data.whatsapp || data.mobile || ''),
    serviceName: String(data.serviceName || 'General Service'),
    invoiceNo: typeof data.invoiceNo === 'string' && data.invoiceNo ? data.invoiceNo : undefined,
    rating: Number(data.rating ?? 10),
    comments: String(data.comments || ''),
    testimonialConsent: Boolean(data.testimonialConsent),
    reviewed: Boolean(data.reviewed),
    internalRemarks:
      typeof data.internalRemarks === 'string' ? data.internalRemarks : undefined,
    createdAt: timestampToIso(data.createdAt),
  };
}

export async function saveFeedbackToFirestore(feedback: FeedbackRecord): Promise<FeedbackRecord> {
  return runCloudWrite(async (authUser) => {
    if (!db) throw new Error('Cloud database (Firestore) is not initialized.');
    const feedbackNo = sanitizeValidId(feedback.feedbackNo || feedback.id, 'FB');
    const ref = doc(db, 'feedbacks', feedbackNo);
    try {
      const existing = await getDoc(ref);
      const existingData = existing.exists()
        ? (existing.data() as Record<string, unknown>)
        : undefined;
      const mobile = boundStr(feedback.mobile, 24);
      const payload: Record<string, unknown> = {
        id: feedbackNo,
        feedbackNo,
        customerName: boundStr(feedback.customerName || 'Customer', 120),
        mobile: mobile.length >= 8 ? mobile : mobile.padEnd(10, '0'),
        whatsapp: boundStr(feedback.whatsapp || mobile, 24),
        serviceName: boundStr(feedback.serviceName || 'General Service', 160),
        invoiceNo: feedback.invoiceNo ? boundStr(feedback.invoiceNo, 64) : '',
        rating: Math.min(10, Math.max(1, Number(feedback.rating || 10))),
        comments: boundStr(feedback.comments || 'Good service', 1000),
        testimonialConsent: Boolean(feedback.testimonialConsent),
        reviewed: Boolean(feedback.reviewed),
        internalRemarks: feedback.internalRemarks ? boundStr(feedback.internalRemarks, 500) : '',
        createdByUid:
          typeof existingData?.createdByUid === 'string' && existingData.createdByUid
            ? existingData.createdByUid
            : authUser.uid,
        createdAt: existingData?.createdAt ?? serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (existing.exists()) {
        await updateDoc(ref, payload);
      } else {
        await setDoc(ref, payload);
      }
      return { ...feedback, id: feedbackNo, feedbackNo };
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `feedbacks/${feedbackNo}`);
    }
  });
}

export function subscribeFeedbacksFromFirestore(
  onData: (feedbacks: FeedbackRecord[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  return onSnapshot(
    collection(db, 'feedbacks'),
    (snap) => {
      recordCloudSyncSuccess();
      const items = snap.docs
        .map((d) => mapFirestoreFeedbackDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      onData(items);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      if (onError) onError(error);
    }
  );
}

// ============================================================================
// 6. Master Settings & User UI Preferences (settings/*)
// ============================================================================
export async function saveMasterSettingsToFirestore(
  overview: Partial<MasterSettingsOverview>
): Promise<void> {
  await runCloudWrite(async (authUser) => {
    if (!db) throw new Error('Cloud database (Firestore) is not initialized.');
    const docRef = doc(db, 'settings', 'masterConfig');
    try {
      const existing = await getDoc(docRef);
      const existingData = existing.exists()
        ? (existing.data() as Record<string, unknown>)
        : undefined;
      const payload: Record<string, unknown> = stripUndefinedDeep({
        settingKey: 'masterConfig',
        companyProfile: overview.companyProfile ?? existingData?.companyProfile,
        globalConfig: overview.globalConfig ?? existingData?.globalConfig,
        userLanguage: overview.userLanguage ?? existingData?.userLanguage,
        appearanceTheme: overview.appearanceTheme ?? existingData?.appearanceTheme,
        securityPolicy: overview.securityPolicy ?? existingData?.securityPolicy,
        printSettings: overview.printSettings ?? existingData?.printSettings,
        paymentQrSettings: overview.paymentQrSettings ?? existingData?.paymentQrSettings,
        customerPrivacy: overview.customerPrivacy ?? existingData?.customerPrivacy,
        reportSettings: overview.reportSettings ?? existingData?.reportSettings,
        maintenanceSettings: overview.maintenanceSettings ?? existingData?.maintenanceSettings,
        documentTemplates: overview.documentTemplates ?? existingData?.documentTemplates,
        notificationTemplates: overview.notificationTemplates ?? existingData?.notificationTemplates,
        dashboardPreferences: overview.dashboardPreferences ?? existingData?.dashboardPreferences,
        updatedByUid: authUser.uid,
        createdAt: existingData?.createdAt ?? serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      if (existing.exists()) {
        await updateDoc(docRef, payload);
      } else {
        await setDoc(docRef, payload);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'settings/masterConfig');
    }
  });
}

export async function saveUserUiPrefsToFirestore(prefs: {
  userLanguage?: LanguageCode;
  appearanceTheme?: ThemeMode;
}): Promise<void> {
  await runCloudWrite(async (authUser) => {
    if (!db) throw new Error('Cloud database (Firestore) is not initialized.');
    const docId = `pref_${authUser.uid}`;
    const docRef = doc(db, 'settings', docId);
    try {
      const existing = await getDoc(docRef);
      if (existing.exists()) {
        const updateData: Record<string, unknown> = {
          updatedByUid: authUser.uid,
          updatedAt: serverTimestamp(),
        };
        if (prefs.userLanguage) updateData.userLanguage = prefs.userLanguage;
        if (prefs.appearanceTheme) updateData.appearanceTheme = prefs.appearanceTheme;
        await updateDoc(docRef, updateData);
      } else {
        await setDoc(docRef, {
          settingKey: docId,
          userLanguage: prefs.userLanguage || 'en',
          appearanceTheme: prefs.appearanceTheme || 'light',
          updatedByUid: authUser.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `settings/${docId}`);
    }
  });
}

export function subscribeMasterSettingsFromFirestore(
  onData: (overview: Partial<MasterSettingsOverview> | null) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) return () => {};
  return onSnapshot(
    doc(db, 'settings', 'masterConfig'),
    (snap) => {
      recordCloudSyncSuccess();
      if (!snap.exists()) {
        onData(null);
        return;
      }
      onData(snap.data() as Partial<MasterSettingsOverview>);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
    }
  );
}
