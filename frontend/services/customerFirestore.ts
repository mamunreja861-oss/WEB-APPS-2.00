import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  Unsubscribe,
} from 'firebase/firestore';
import { User } from 'firebase/auth';
import { ErpCustomerItem } from './erpApi';
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

const CUSTOMERS_COLLECTION = 'customers';

function boundStr(value: unknown, maxLen: number): string {
  return String(value ?? '').trim().slice(0, maxLen);
}

function sanitizeArrayOfMaps<T extends object>(arr: unknown, maxItems: number): T[] {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, maxItems).map((item) => {
    const clean: Record<string, unknown> = {};
    if (item && typeof item === 'object') {
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
        if (v !== undefined) clean[k] = v;
      }
    }
    return clean as T;
  });
}

function buildCustomerFirestorePayload(
  customer: ErpCustomerItem,
  authUser: User,
  isCreate: boolean,
  existingData?: Record<string, unknown>
): Record<string, unknown> {
  const cleanMobile = boundStr(customer.mobile, 24);
  const cleanVillage = boundStr(customer.village || 'Local Area', 120) || 'Local Area';
  const cleanFullName = boundStr(customer.fullName, 120);
  const validGender =
    customer.gender === 'Male' || customer.gender === 'Female' || customer.gender === 'Other'
      ? customer.gender
      : 'Male';
  const validSegment =
    customer.segment === 'Individual' ||
    customer.segment === 'Corporate' ||
    customer.segment === 'Government'
      ? customer.segment
      : 'Individual';
  const validStatus =
    customer.status === 'Active' ||
    customer.status === 'Inactive' ||
    customer.status === 'Blocked'
      ? customer.status
      : 'Active';

  const payload: Record<string, unknown> = {
    customerId: boundStr(existingData?.customerId || customer.customerId, 64),
    fullName: cleanFullName.length >= 2 ? cleanFullName : `${cleanFullName} Customer`,
    fatherOrHusbandName: boundStr(customer.fatherOrHusbandName, 120),
    dob: boundStr(customer.dob, 32),
    gender: validGender,
    mobile: cleanMobile.length >= 8 ? cleanMobile : cleanMobile.padEnd(10, '0'),
    whatsapp: boundStr(customer.whatsapp || cleanMobile, 24),
    email: boundStr(customer.email, 160),
    aadhaarMasked: boundStr(customer.aadhaarMasked, 24),
    panNumber: boundStr(customer.panNumber, 20),
    voterId: boundStr(customer.voterId, 32),
    village: cleanVillage,
    postOffice: boundStr(customer.postOffice, 120),
    policeStation: boundStr(customer.policeStation, 120),
    district: boundStr(customer.district, 120),
    pinCode: boundStr(customer.pinCode, 16),
    presentAddress: boundStr(customer.presentAddress, 300),
    permanentAddress: boundStr(customer.permanentAddress, 300),
    sameAsPresent: customer.sameAsPresent !== false,
    segment: validSegment,
    crmTag: boundStr(customer.crmTag || 'New', 64),
    status: validStatus,
    verificationStatus: boundStr(customer.verificationStatus || 'Unverified', 64),
    mobileOtpVerifiedAt: customer.mobileOtpVerifiedAt
      ? boundStr(customer.mobileOtpVerifiedAt, 64)
      : null,
    consents: sanitizeArrayOfMaps(customer.consents, 15),
    consentHistory: sanitizeArrayOfMaps(customer.consentHistory, 100),
    contactHistory: sanitizeArrayOfMaps(customer.contactHistory, 50),
    notesAndFollowUps: sanitizeArrayOfMaps(customer.notesAndFollowUps, 100),
    deletedAt: customer.deletedAt ? boundStr(customer.deletedAt, 64) : null,
    isArchived: Boolean(customer.isArchived || customer.deletedAt),
    updatedAt: serverTimestamp(),
  };

  if (typeof customer.id === 'number' && Number.isFinite(customer.id)) {
    payload.id = customer.id;
  }

  const hasValidUid =
    typeof existingData?.createdByUid === 'string' && existingData.createdByUid.length > 0;
  payload.createdByUid = hasValidUid ? existingData.createdByUid : authUser.uid;
  payload.createdBy =
    (typeof existingData?.createdBy === 'string' && existingData.createdBy.length > 0
      ? existingData.createdBy
      : boundStr(customer.createdBy || authUser.email || authUser.uid, 64)) || 'SYSTEM';

  if (isCreate || !existingData?.createdAt) {
    payload.createdAt = serverTimestamp();
  } else {
    payload.createdAt = existingData.createdAt;
  }

  return payload;
}

export function mapFirestoreCustomerDoc(
  docId: string,
  data: Record<string, unknown>
): ErpCustomerItem {
  const deletedAt = typeof data.deletedAt === 'string' && data.deletedAt.length > 0 ? data.deletedAt : null;
  const isArchived = typeof data.isArchived === 'boolean' ? data.isArchived : Boolean(deletedAt);
  return {
    id: typeof data.id === 'number' ? data.id : Math.abs(hashStringToPositiveInt(docId)),
    customerId: String(data.customerId || docId),
    fullName: String(data.fullName || ''),
    fatherOrHusbandName: String(data.fatherOrHusbandName || ''),
    dob: String(data.dob || ''),
    gender: (data.gender as 'Male' | 'Female' | 'Other') || 'Male',
    mobile: String(data.mobile || ''),
    whatsapp: String(data.whatsapp || data.mobile || ''),
    email: String(data.email || ''),
    aadhaarMasked: data.aadhaarMasked ? String(data.aadhaarMasked) : undefined,
    panNumber: data.panNumber ? String(data.panNumber) : undefined,
    voterId: data.voterId ? String(data.voterId) : undefined,
    village: String(data.village || ''),
    postOffice: String(data.postOffice || ''),
    policeStation: String(data.policeStation || ''),
    district: String(data.district || ''),
    pinCode: String(data.pinCode || ''),
    presentAddress: String(data.presentAddress || ''),
    permanentAddress: String(data.permanentAddress || ''),
    sameAsPresent: data.sameAsPresent !== false,
    segment: (data.segment as 'Individual' | 'Corporate' | 'Government') || 'Individual',
    crmTag: String(data.crmTag || 'New'),
    status: (data.status as 'Active' | 'Inactive' | 'Blocked') || 'Active',
    verificationStatus: String(data.verificationStatus || 'Unverified'),
    mobileOtpVerifiedAt:
      typeof data.mobileOtpVerifiedAt === 'string' ? data.mobileOtpVerifiedAt : null,
    consents: Array.isArray(data.consents) ? (data.consents as ErpCustomerItem['consents']) : [],
    consentHistory: Array.isArray(data.consentHistory)
      ? (data.consentHistory as ErpCustomerItem['consentHistory'])
      : [],
    contactHistory: Array.isArray(data.contactHistory) ? data.contactHistory : [],
    notesAndFollowUps: Array.isArray(data.notesAndFollowUps)
      ? (data.notesAndFollowUps as ErpCustomerItem['notesAndFollowUps'])
      : [],
    deletedAt,
    isArchived,
    createdBy: String(data.createdBy || ''),
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
  };
}

function hashStringToPositiveInt(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.max(1, Math.abs(hash));
}

function makeUniqueCollisionSafeCustomerId(baseId: string): string {
  const suffix = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`.toUpperCase();
  const cleanBase = baseId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50) || 'MCC';
  return `${cleanBase}_${suffix}`.slice(0, 64);
}

export async function saveNewCustomerToFirestore(
  customer: ErpCustomerItem
): Promise<ErpCustomerItem> {
  return runCloudWrite(async (authUser) => {
    if (!db) {
      throw new Error('Cloud database (Firestore) is not initialized.');
    }
    let targetCustomer = { ...customer };
    let ref = doc(db, CUSTOMERS_COLLECTION, targetCustomer.customerId);
    try {
      const existing = await getDoc(ref);
      if (existing.exists()) {
        const existingData = existing.data() as Record<string, unknown>;
        const samePerson =
          String(existingData.mobile || '').trim() === String(customer.mobile || '').trim() &&
          String(existingData.fullName || '').trim().toLowerCase() ===
            String(customer.fullName || '').trim().toLowerCase();
        if (!samePerson) {
          // Express memory restarted after cold-start and reissued an existing sequence ID.
          // Generate a non-colliding ID so existing customer data is preserved intact.
          const newId = makeUniqueCollisionSafeCustomerId(customer.customerId);
          targetCustomer = { ...customer, customerId: newId };
          ref = doc(db, CUSTOMERS_COLLECTION, newId);
          const createPayload = buildCustomerFirestorePayload(targetCustomer, authUser, true);
          await setDoc(ref, createPayload);
        } else {
          const updatePayload = buildCustomerFirestorePayload(
            targetCustomer,
            authUser,
            false,
            existingData
          );
          await updateDoc(ref, updatePayload);
        }
      } else {
        const createPayload = buildCustomerFirestorePayload(targetCustomer, authUser, true);
        await setDoc(ref, createPayload);
      }
      return targetCustomer;
    } catch (err) {
      handleFirestoreError(
        err,
        OperationType.WRITE,
        `${CUSTOMERS_COLLECTION}/${targetCustomer.customerId}`
      );
    }
  });
}

export async function saveCustomerToFirestore(customer: ErpCustomerItem): Promise<boolean> {
  await runCloudWrite(async (authUser) => {
    if (!db) {
      throw new Error('Cloud database (Firestore) is not initialized.');
    }
    const ref = doc(db, CUSTOMERS_COLLECTION, customer.customerId);
    try {
      const existing = await getDoc(ref);
      if (existing.exists()) {
        const updatePayload = buildCustomerFirestorePayload(
          customer,
          authUser,
          false,
          existing.data() as Record<string, unknown>
        );
        await updateDoc(ref, updatePayload);
      } else {
        const createPayload = buildCustomerFirestorePayload(customer, authUser, true);
        await setDoc(ref, createPayload);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `${CUSTOMERS_COLLECTION}/${customer.customerId}`);
    }
  });
  return true;
}

export async function saveCustomersBatchToFirestore(
  customers: ErpCustomerItem[]
): Promise<ErpCustomerItem[]> {
  const saved: ErpCustomerItem[] = [];
  for (const cust of customers) {
    const res = await saveNewCustomerToFirestore(cust);
    saved.push(res);
  }
  return saved;
}

export async function deleteCustomerFromFirestore(customerId: string): Promise<boolean> {
  await runCloudWrite(async () => {
    if (!db) {
      throw new Error('Cloud database (Firestore) is not initialized.');
    }
    const path = `${CUSTOMERS_COLLECTION}/${customerId}`;
    try {
      await deleteDoc(doc(db, CUSTOMERS_COLLECTION, customerId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  });
  return true;
}

export async function fetchCustomersFromFirestore(): Promise<ErpCustomerItem[]> {
  if (!db || !auth?.currentUser) return [];
  try {
    const snap = await getDocs(collection(db, CUSTOMERS_COLLECTION));
    recordCloudSyncSuccess();
    return snap.docs
      .map((d) => mapFirestoreCustomerDoc(d.id, d.data() as Record<string, unknown>))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (err) {
    recordCloudSyncError(extractFriendlyErrorMessage(err));
    handleFirestoreError(err, OperationType.LIST, CUSTOMERS_COLLECTION);
  }
}

export function subscribeCustomersFromFirestore(
  onData: (customers: ErpCustomerItem[]) => void,
  onError?: (err: unknown) => void
): Unsubscribe {
  if (!db || !auth?.currentUser) {
    return () => {};
  }
  return onSnapshot(
    collection(db, CUSTOMERS_COLLECTION),
    (snapshot) => {
      recordCloudSyncSuccess();
      const list = snapshot.docs
        .map((d) => mapFirestoreCustomerDoc(d.id, d.data() as Record<string, unknown>))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      onData(list);
    },
    (error) => {
      recordCloudSyncError(extractFriendlyErrorMessage(error));
      if (onError) {
        onError(error);
      } else {
        handleFirestoreError(error, OperationType.LIST, CUSTOMERS_COLLECTION);
      }
    }
  );
}
