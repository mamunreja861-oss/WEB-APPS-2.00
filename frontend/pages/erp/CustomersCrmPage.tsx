import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Cloud,
  FilePlus2,
  GitMerge,
  Pencil,
  Plus,
  Printer,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  UserCheck,
} from 'lucide-react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { ErpApplicationItem, ErpCustomerItem, ErpPaymentItem, UserProfile } from '../../modules/types';
import { erpApi } from '../../services/erpApi';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { MobileNumberInput } from '../../components/MobileNumberInput';
import { DataTable, TableColumn } from '../../components/DataTable';
import { formatCurrency, paginateArray } from '../../services/apiClient';
import { formatDateIST } from '../../services/formatters';
import {
  auth,
  extractFriendlyErrorMessage,
  isFirebaseConfigured,
  signInWithGoogleForFirestore,
} from '../../services/firebase';
import {
  deleteCustomerFromFirestore,
  saveCustomerToFirestore,
  saveCustomersBatchToFirestore,
  saveNewCustomerToFirestore,
  subscribeCustomersFromFirestore,
} from '../../services/customerFirestore';
import { connectCloudDatabaseInteractive, useCloudSync } from '../../services/cloudSync';
import { subscribeApplicationsFromFirestore, subscribePaymentsFromFirestore } from '../../services/erpFirestore';

interface CustomersCrmPageProps {
  currentUser: UserProfile;
  onStartApplicationForCustomer: (customerId: string) => void;
  onShowToast: (type: 'success' | 'error' | 'info', title: string, description?: string) => void;
}

const CONSENT_LABELS: Array<{ key: string; label: string }> = [
  { key: 'SMS_CONSENT', label: 'SMS Message Consent' },
  { key: 'WHATSAPP_CONSENT', label: 'WhatsApp Message Consent' },
  { key: 'STATUS_UPDATE_CONSENT', label: 'Application Status Update Consent' },
  { key: 'PAYMENT_REMINDER_CONSENT', label: 'Payment Reminder Consent' },
  { key: 'SERVICE_NOTIFICATION_CONSENT', label: 'Service Notification Consent' },
  { key: 'PROMOTIONAL_CONSENT', label: 'Promotional / Offer Consent' },
  { key: 'DATA_PRIVACY_CONSENT', label: 'Data Processing & Privacy Consent' },
];

export const CustomersCrmPage: React.FC<CustomersCrmPageProps> = ({
  currentUser,
  onStartApplicationForCustomer,
  onShowToast,
}) => {
  const [apiCustomers, setApiCustomers] = useState<ErpCustomerItem[]>([]);
  const [firestoreCustomers, setFirestoreCustomers] = useState<ErpCustomerItem[]>([]);
  const [firestoreApps, setFirestoreApps] = useState<ErpApplicationItem[]>([]);
  const [firestorePayments, setFirestorePayments] = useState<ErpPaymentItem[]>([]);
  const [deletedCustomerIds, setDeletedCustomerIds] = useState<string[]>([]);
  const cloudSync = useCloudSync();
  const [firebaseUser, setFirebaseUser] = useState<User | null>(() => auth?.currentUser ?? null);
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [segmentFilter, setSegmentFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [page, setPage] = useState(1);
  const fetchSeqRef = useRef(0);
  const [permanentDeleteTarget, setPermanentDeleteTarget] = useState<ErpCustomerItem | null>(null);
  const [deletingPermanent, setDeletingPermanent] = useState(false);

  // Registration modal
  const [createOpen, setCreateOpen] = useState(false);
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [dupOverridePrompt, setDupOverridePrompt] = useState<string | null>(null);
  const [form, setForm] = useState({
    fullName: '',
    fatherOrHusbandName: '',
    dob: '',
    gender: 'Male' as 'Male' | 'Female' | 'Other',
    mobile: '',
    whatsapp: '',
    email: '',
    aadhaarNumber: '',
    panNumber: '',
    voterId: '',
    village: '',
    postOffice: '',
    policeStation: '',
    district: 'Murshidabad',
    pinCode: '',
    presentAddress: '',
    sameAsPresent: true,
    sameAsMobile: true,
    permanentAddress: '',
    segment: 'Individual' as 'Individual' | 'Corporate' | 'Government',
    overrideDuplicateReason: '',
  });
  const [newConsents, setNewConsents] = useState<Record<string, boolean>>({
    SMS_CONSENT: true,
    WHATSAPP_CONSENT: true,
    STATUS_UPDATE_CONSENT: true,
    PAYMENT_REMINDER_CONSENT: true,
    SERVICE_NOTIFICATION_CONSENT: true,
    PROMOTIONAL_CONSENT: false,
    DATA_PRIVACY_CONSENT: true,
  });

  // Customer 360 Profile modal
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileData, setProfileData] = useState<{
    customer: ErpCustomerItem;
    applications: ErpApplicationItem[];
    payments: ErpPaymentItem[];
  } | null>(null);
  const [profileTab, setProfileTab] = useState<'overview' | 'consents' | 'apps' | 'notes' | 'idcard'>('overview');
  const [noteInput, setNoteInput] = useState('');
  const [noteType, setNoteType] = useState<'INTERNAL_NOTE' | 'FOLLOW_UP'>('INTERNAL_NOTE');
  const [followUpDate, setFollowUpDate] = useState('');
  const [otpChallenge, setOtpChallenge] = useState<{
    challengeId: string;
    sandboxOtpPreview?: string;
    newMobile: string;
    otpInput: string;
  } | null>(null);
  const [decryptedAadhaar, setDecryptedAadhaar] = useState<string | null>(null);

  // Bulk import & Admin merge
  const [bulkOpen, setBulkOpen] = useState(false);
  const [csvInput, setCsvInput] = useState(
    'fullName,mobile,village,district\nRabiul Sk,9830100991,Mamudpur,Murshidabad\nSultana Khatun,9830100992,Juginda,Murshidabad'
  );
  const [bulkPreview, setBulkPreview] = useState<Array<{
    rowNumber: number;
    fullName: string;
    mobile: string;
    village: string;
    valid: boolean;
    errors: string[];
  }> | null>(null);

  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergePrimary, setMergePrimary] = useState('');
  const [mergeDuplicate, setMergeDuplicate] = useState('');
  const [mergeReason, setMergeReason] = useState('');
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editForm, setEditForm] = useState({
    customerId: '',
    fullName: '',
    fatherOrHusbandName: '',
    email: '',
    village: '',
    district: 'Murshidabad',
    pinCode: '',
    presentAddress: '',
    segment: 'Individual' as 'Individual' | 'Corporate' | 'Government',
    status: 'Active' as 'Active' | 'Inactive' | 'Blocked',
  });

  const loadCustomers = useCallback(async () => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    try {
      const [res, tombRes] = await Promise.all([
        erpApi.listCustomers({ includeDeleted: true }),
        erpApi.getTombstones().catch(() => null),
      ]);
      if (seq === fetchSeqRef.current) {
        setApiCustomers(res.data);
        if (tombRes?.data?.deletedCustomerIds) {
          setDeletedCustomerIds((prev) =>
            Array.from(new Set([...prev, ...tombRes.data.deletedCustomerIds]))
          );
        }
      }
    } catch (err) {
      onShowToast('error', 'Failed to load Customers', extractFriendlyErrorMessage(err));
    } finally {
      if (seq === fetchSeqRef.current) {
        setLoading(false);
      }
    }
  }, [onShowToast]);

  useEffect(() => {
    loadCustomers();
  }, [loadCustomers]);

  useEffect(() => {
    if (!auth) return;
    const unsub = onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!cloudSync.userUid || !isFirebaseConfigured()) {
      setFirestoreCustomers([]);
      setFirestoreApps([]);
      setFirestorePayments([]);
      return;
    }
    const unsubCust = subscribeCustomersFromFirestore(
      (docs) => setFirestoreCustomers(docs),
      (err) => {
        onShowToast('error', 'Cloud Customer Sync Error', extractFriendlyErrorMessage(err));
      }
    );
    const unsubApps = subscribeApplicationsFromFirestore((docs) => setFirestoreApps(docs));
    const unsubPays = subscribePaymentsFromFirestore((docs) => setFirestorePayments(docs));
    return () => {
      unsubCust();
      unsubApps();
      unsubPays();
    };
  }, [cloudSync.userUid, onShowToast]);

  useEffect(() => {
    const handleCustomerCreated = (event: Event) => {
      const custom = event as CustomEvent<ErpCustomerItem>;
      const created = custom.detail;
      if (!created?.customerId) return;
      const normalized: ErpCustomerItem = {
        ...created,
        isArchived: Boolean(created.isArchived || created.deletedAt),
        deletedAt: created.deletedAt ?? null,
        status: created.status || 'Active',
        segment: created.segment || 'Individual',
        createdAt: created.createdAt || new Date().toISOString(),
      };
      setApiCustomers((prev) => [
        normalized,
        ...prev.filter((c) => c.customerId !== normalized.customerId),
      ]);
    };
    const handleCustomersChanged = () => {
      void loadCustomers();
    };
    window.addEventListener('mun:customer-created', handleCustomerCreated);
    window.addEventListener('mun:customers-changed', handleCustomersChanged);
    return () => {
      window.removeEventListener('mun:customer-created', handleCustomerCreated);
      window.removeEventListener('mun:customers-changed', handleCustomersChanged);
    };
  }, [loadCustomers]);

  const handleCloudSync = async () => {
    if (!isFirebaseConfigured()) {
      onShowToast('info', 'Cloud Sync Unavailable', 'Firebase SDK configuration is not active.');
      return;
    }
    setCloudSyncing(true);
    try {
      const user = await connectCloudDatabaseInteractive(currentUser);
      if (user) {
        setFirebaseUser(user);
        onShowToast('success', 'Cloud Sync Connected', `Signed in as ${user.email || user.uid}`);
      }
    } catch (err) {
      onShowToast('error', 'Cloud Sync Sign-In Failed', extractFriendlyErrorMessage(err));
    } finally {
      setCloudSyncing(false);
    }
  };

  const customers = useMemo(() => {
    const deletedSet = new Set(deletedCustomerIds);
    const byId = new Map<string, ErpCustomerItem>();

    for (const c of firestoreCustomers) {
      if (deletedSet.has(c.customerId)) continue;
      byId.set(c.customerId, {
        ...c,
        isArchived: Boolean(c.isArchived || c.deletedAt),
        status: c.status || 'Active',
      });
    }

    for (const c of apiCustomers) {
      if (deletedSet.has(c.customerId)) continue;
      const fsMatch = byId.get(c.customerId);
      if (!fsMatch) {
        byId.set(c.customerId, {
          ...c,
          isArchived: Boolean(c.isArchived || c.deletedAt),
          status: c.status || 'Active',
        });
        continue;
      }

      const fsUpdated = Date.parse(fsMatch.updatedAt || fsMatch.createdAt || '') || 0;
      const apiUpdated = Date.parse(c.updatedAt || c.createdAt || '') || 0;
      // Preserve Firestore only when strictly newer than backend API state so local edits/archival win immediately
      const preferFirestore = fsUpdated > apiUpdated && !(c.deletedAt && !fsMatch.deletedAt && apiUpdated >= fsUpdated);
      const primary = preferFirestore ? fsMatch : c;
      const secondary = preferFirestore ? c : fsMatch;

      byId.set(c.customerId, {
        ...secondary,
        ...primary,
        stats: c.stats ?? fsMatch.stats,
        isArchived: Boolean(primary.isArchived || primary.deletedAt),
        deletedAt: primary.deletedAt ?? null,
        status: primary.status || secondary.status || 'Active',
      });
    }

    const q = query.trim().toLowerCase();
    return Array.from(byId.values())
      .filter((c) => {
        const archived = Boolean(c.deletedAt || c.isArchived);
        if (!showArchived && archived) return false;
        if (statusFilter && c.status !== statusFilter) return false;
        if (segmentFilter && c.segment !== segmentFilter) return false;
        if (q) {
          const hay = [
            c.customerId,
            c.fullName,
            c.mobile,
            c.whatsapp,
            c.village,
            c.district,
            c.panNumber ?? '',
          ]
            .join(' ')
            .toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || b.id - a.id);
  }, [apiCustomers, firestoreCustomers, deletedCustomerIds, showArchived, statusFilter, segmentFilter, query]);

  const handlePermanentDeleteCustomer = async () => {
    if (!permanentDeleteTarget) return;
    setDeletingPermanent(true);
    const target = permanentDeleteTarget;
    try {
      await erpApi.deleteCustomer(target.customerId).catch((apiErr) => {
        const msg = extractFriendlyErrorMessage(apiErr).toLowerCase();
        if (!msg.includes('not found') && !msg.includes('404')) throw apiErr;
      });
      await deleteCustomerFromFirestore(target.customerId);
      setDeletedCustomerIds((prev) => Array.from(new Set([...prev, target.customerId])));
      setApiCustomers((prev) => prev.filter((c) => c.customerId !== target.customerId));
      setFirestoreCustomers((prev) => prev.filter((c) => c.customerId !== target.customerId));
      if (profileData?.customer.customerId === target.customerId) {
        setProfileData(null);
      }
      setPermanentDeleteTarget(null);
      window.dispatchEvent(new CustomEvent('mun:customers-changed'));
      onShowToast('success', 'Customer Permanently Deleted', `${target.fullName} (${target.customerId}) removed from cloud.`);
      await loadCustomers();
    } catch (err) {
      onShowToast('error', 'Permanent Delete Blocked', extractFriendlyErrorMessage(err));
    } finally {
      setDeletingPermanent(false);
    }
  };

  const openProfile = async (customerId: string) => {
    setProfileLoading(true);
    setDecryptedAadhaar(null);
    setProfileTab('overview');
    try {
      const res = await erpApi.getCustomerProfile(customerId);
      setProfileData({
        customer: res.data.customer,
        applications: res.data.applications,
        payments: res.data.payments,
      });
    } catch (err) {
      const fsCust =
        firestoreCustomers.find((c) => c.customerId === customerId) ||
        customers.find((c) => c.customerId === customerId);
      if (fsCust) {
        setProfileData({
          customer: fsCust,
          applications: firestoreApps.filter((a) => a.customerId === customerId),
          payments: firestorePayments.filter((p) => p.customerId === customerId),
        });
      } else {
        onShowToast('error', 'Failed to inspect Customer', extractFriendlyErrorMessage(err));
      }
    } finally {
      setProfileLoading(false);
    }
  };

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    const cleanName = form.fullName.trim();
    const cleanMobile = form.mobile.replace(/\D/g, '').slice(-10);
    const cleanWhatsapp = (form.sameAsMobile ? cleanMobile : form.whatsapp).replace(/\D/g, '').slice(-10);
    const cleanVillage = form.village.trim();
    const cleanAadhaar = form.aadhaarNumber.replace(/[\s-]/g, '');

    if (cleanName.length < 2) {
      setCreateError('Full name must be at least 2 characters.');
      return;
    }
    if (cleanMobile.length < 10) {
      setCreateError('Please enter a valid 10-digit mobile number.');
      return;
    }
    if (cleanVillage.length < 2) {
      setCreateError('Village / Locality is required (at least 2 characters).');
      return;
    }
    if (cleanAadhaar && !/^\d{12}$/.test(cleanAadhaar)) {
      setCreateError('Aadhaar number must be exactly 12 digits when provided.');
      return;
    }
    setSavingCustomer(true);
    try {
      const payload = {
        ...form,
        fullName: cleanName,
        mobile: cleanMobile,
        whatsapp: cleanWhatsapp || cleanMobile,
        village: cleanVillage,
        district: form.district.trim() || 'Murshidabad',
        aadhaarNumber: cleanAadhaar,
        consents: CONSENT_LABELS.map((c) => ({
          category: c.key,
          granted: Boolean(newConsents[c.key]),
          verificationMethod: 'Digital Signature',
        })),
      };
      const res = await erpApi.createCustomer(payload);
      const baseCustomer: ErpCustomerItem = {
        ...res.data,
        isArchived: false,
        deletedAt: res.data.deletedAt ?? null,
        status: res.data.status || 'Active',
        segment: res.data.segment || form.segment || 'Individual',
        createdAt: res.data.createdAt || new Date().toISOString(),
      };

      // Strictly await permanent Cloud Firestore write before confirming success or closing modal
      const savedCustomer = await saveNewCustomerToFirestore(baseCustomer);

      setApiCustomers((prev) => [
        savedCustomer,
        ...prev.filter((c) => c.customerId !== savedCustomer.customerId),
      ]);
      setQuery('');
      setStatusFilter('');
      setSegmentFilter('');
      setShowArchived(false);
      setPage(1);

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('mun:customer-created', { detail: savedCustomer }));
      }

      onShowToast('success', 'Customer Saved Permanently', `${savedCustomer.customerId} — ${savedCustomer.fullName}`);
      setCreateOpen(false);
      setDupOverridePrompt(null);
      setForm({
        fullName: '',
        fatherOrHusbandName: '',
        dob: '',
        gender: 'Male',
        mobile: '',
        whatsapp: '',
        email: '',
        aadhaarNumber: '',
        panNumber: '',
        voterId: '',
        village: '',
        postOffice: '',
        policeStation: '',
        district: 'Murshidabad',
        pinCode: '',
        presentAddress: '',
        sameAsPresent: true,
        sameAsMobile: true,
        permanentAddress: '',
        segment: 'Individual',
        overrideDuplicateReason: '',
      });
      void loadCustomers();
    } catch (err) {
      const msg = extractFriendlyErrorMessage(err, 'Unable to save customer to cloud database.');
      if (msg.toLowerCase().includes('duplicate')) {
        setDupOverridePrompt(msg);
      } else {
        setCreateError(msg);
      }
      onShowToast('error', 'Customer Registration Failed', msg);
    } finally {
      setSavingCustomer(false);
    }
  };

  const openEditProfile = (c: ErpCustomerItem) => {
    setEditForm({
      customerId: c.customerId,
      fullName: c.fullName || '',
      fatherOrHusbandName: c.fatherOrHusbandName || '',
      email: c.email || '',
      village: c.village || '',
      district: c.district || 'Murshidabad',
      pinCode: c.pinCode || '',
      presentAddress: c.presentAddress || '',
      segment: c.segment || 'Individual',
      status: c.status || 'Active',
    });
    setEditOpen(true);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editForm.fullName.trim() || editForm.fullName.trim().length < 2) {
      onShowToast('error', 'Invalid Name', 'Full name must be at least 2 characters.');
      return;
    }
    setSavingEdit(true);
    try {
      const updatePatch = {
        fullName: editForm.fullName.trim(),
        fatherOrHusbandName: editForm.fatherOrHusbandName.trim(),
        email: editForm.email.trim(),
        village: editForm.village.trim(),
        district: editForm.district.trim(),
        pinCode: editForm.pinCode.trim(),
        presentAddress: editForm.presentAddress.trim(),
        segment: editForm.segment,
        status: editForm.status,
      };
      let updatedCustomer: ErpCustomerItem;
      try {
        const res = await erpApi.updateCustomer(editForm.customerId, updatePatch);
        updatedCustomer = res.data;
      } catch (apiErr) {
        const msg = extractFriendlyErrorMessage(apiErr).toLowerCase();
        const existingLocal =
          firestoreCustomers.find((c) => c.customerId === editForm.customerId) ||
          customers.find((c) => c.customerId === editForm.customerId);
        if ((msg.includes('not found') || msg.includes('404')) && existingLocal) {
          updatedCustomer = {
            ...existingLocal,
            ...updatePatch,
            updatedAt: new Date().toISOString(),
          };
        } else {
          throw apiErr;
        }
      }

      await saveCustomerToFirestore(updatedCustomer);
      setApiCustomers((prev) =>
        prev.map((c) => (c.customerId === updatedCustomer.customerId ? { ...c, ...updatedCustomer } : c))
      );
      setProfileData((prev) =>
        prev && prev.customer.customerId === updatedCustomer.customerId
          ? { ...prev, customer: updatedCustomer }
          : prev
      );
      setEditOpen(false);
      onShowToast('success', 'Customer Updated in Cloud', `${updatedCustomer.customerId} saved permanently.`);
    } catch (err) {
      onShowToast('error', 'Update Failed', extractFriendlyErrorMessage(err));
    } finally {
      setSavingEdit(false);
    }
  };

  const handleBulkPreviewOrCommit = async (commit: boolean) => {
    try {
      const lines = csvInput
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const start = lines[0]?.toLowerCase().includes('fullname') ? 1 : 0;
      const rows = lines.slice(start).map((line) => {
        const [fullName = '', mobile = '', village = '', district = 'Murshidabad'] = line
          .split(',')
          .map((s) => s.trim());
        return { fullName, mobile, village, district };
      });
      const res = await erpApi.bulkImportCustomers(rows, commit);
      setBulkPreview(res.data.preview);
      if (commit) {
        if (res.data.createdIds.length > 0) {
          const allCustRes = await erpApi.listCustomers({ includeDeleted: true });
          const idSet = new Set(res.data.createdIds);
          const createdRecords = allCustRes.data.filter((c) => idSet.has(c.customerId));
          if (createdRecords.length > 0) {
            await saveCustomersBatchToFirestore(createdRecords);
          }
        }
        onShowToast('success', 'Bulk Import Saved to Cloud', res.message);
        setBulkOpen(false);
        setBulkPreview(null);
        await loadCustomers();
      }
    } catch (err) {
      onShowToast('error', 'Import Error', extractFriendlyErrorMessage(err));
    }
  };

  const handleToggleConsent = async (category: string, nextGranted: boolean) => {
    if (!profileData) return;
    try {
      let updatedCustomer: ErpCustomerItem;
      try {
        const res = await erpApi.updateCustomerConsents(profileData.customer.customerId, {
          updates: [{ category, granted: nextGranted }],
          verificationMethod: 'Digital Signature',
          notes: 'Updated via Customer 360° Profile',
        });
        updatedCustomer = res.data;
      } catch (apiErr) {
        const msg = extractFriendlyErrorMessage(apiErr).toLowerCase();
        if (!msg.includes('not found') && !msg.includes('404')) throw apiErr;
        const now = new Date().toISOString();
        updatedCustomer = {
          ...profileData.customer,
          consents: profileData.customer.consents.map((c) =>
            c.category === category ? { ...c, granted: nextGranted, recordedAt: now } : c
          ),
          updatedAt: now,
        };
      }
      await saveCustomerToFirestore(updatedCustomer);
      setProfileData((prev) => (prev ? { ...prev, customer: updatedCustomer } : prev));
      onShowToast('success', 'Consent Saved to Cloud', `${category} set to ${nextGranted ? 'Granted' : 'Revoked'}`);
    } catch (err) {
      onShowToast('error', 'Failed', extractFriendlyErrorMessage(err));
    }
  };

  const handleSendCustomerOtp = async () => {
    if (!profileData) return;
    const targetMob = otpChallenge?.newMobile || profileData.customer.mobile;
    try {
      const res = await erpApi.sendMobileOtp(targetMob);
      setOtpChallenge({
        challengeId: res.data.challengeId,
        sandboxOtpPreview: res.data.sandboxOtpPreview,
        newMobile: targetMob,
        otpInput: res.data.sandboxOtpPreview || '',
      });
      onShowToast(
        'info',
        'OTP Verification Challenge Issued',
        res.data.providerConfigured ? 'Dispatched via SMS gateway.' : `Sandbox preview OTP: ${res.data.sandboxOtpPreview}`
      );
    } catch (err) {
      onShowToast('error', 'OTP Error', extractFriendlyErrorMessage(err));
    }
  };

  const handleVerifyCustomerOtp = async () => {
    if (!profileData || !otpChallenge) return;
    try {
      const v = await erpApi.verifyMobileOtp(otpChallenge.challengeId, otpChallenge.otpInput);
      let updatedCustomer: ErpCustomerItem;
      try {
        const updated = await erpApi.verifyCustomerContact(profileData.customer.customerId, {
          newMobile: otpChallenge.newMobile,
          verificationToken: v.data.verificationToken,
        });
        updatedCustomer = updated.data;
      } catch (apiErr) {
        const msg = extractFriendlyErrorMessage(apiErr).toLowerCase();
        if (!msg.includes('not found') && !msg.includes('404')) throw apiErr;
        const now = new Date().toISOString();
        updatedCustomer = {
          ...profileData.customer,
          mobile: otpChallenge.newMobile,
          verificationStatus: 'OTP Verified',
          mobileOtpVerifiedAt: now,
          updatedAt: now,
        };
      }
      await saveCustomerToFirestore(updatedCustomer);
      setProfileData((prev) => (prev ? { ...prev, customer: updatedCustomer } : prev));
      setOtpChallenge(null);
      onShowToast('success', 'Mobile OTP Verified & Saved', `${updatedCustomer.customerId} marked ${updatedCustomer.verificationStatus}`);
      await loadCustomers();
    } catch (err) {
      onShowToast('error', 'Verification Failed', extractFriendlyErrorMessage(err));
    }
  };

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profileData || !noteInput.trim()) return;
    try {
      let updatedCustomer: ErpCustomerItem;
      try {
        const res = await erpApi.addCustomerNote(profileData.customer.customerId, {
          type: noteType,
          text: noteInput,
          followUpDate: noteType === 'FOLLOW_UP' ? followUpDate : undefined,
        });
        updatedCustomer = res.data;
      } catch (apiErr) {
        const msg = extractFriendlyErrorMessage(apiErr).toLowerCase();
        if (!msg.includes('not found') && !msg.includes('404')) throw apiErr;
        const now = new Date().toISOString();
        updatedCustomer = {
          ...profileData.customer,
          notesAndFollowUps: [
            {
              id: Date.now(),
              type: noteType,
              text: noteInput.trim(),
              followUpDate: noteType === 'FOLLOW_UP' ? followUpDate : undefined,
              authorUserId: currentUser.userId,
              createdAt: now,
            },
            ...profileData.customer.notesAndFollowUps,
          ],
          updatedAt: now,
        };
      }
      await saveCustomerToFirestore(updatedCustomer);
      setProfileData((prev) => (prev ? { ...prev, customer: updatedCustomer } : prev));
      setNoteInput('');
      onShowToast('success', 'CRM Note Saved to Cloud');
    } catch (err) {
      onShowToast('error', 'Failed', extractFriendlyErrorMessage(err));
    }
  };

  const handleMerge = async (e: React.FormEvent) => {
    e.preventDefault();
    setMergeError(null);
    setMerging(true);
    try {
      const res = await erpApi.mergeCustomers({
        primaryCustomerId: mergePrimary.trim(),
        duplicateCustomerId: mergeDuplicate.trim(),
        reason: mergeReason.trim(),
      });
      await saveCustomerToFirestore(res.data.primaryCustomer);
      const dupRec = customers.find((c) => c.customerId === res.data.mergedDuplicateId);
      if (dupRec) {
        await saveCustomerToFirestore({
          ...dupRec,
          status: 'Inactive',
          isArchived: true,
          deletedAt: new Date().toISOString(),
        });
      }
      onShowToast(
        'success',
        'Customers Merged & Synced',
        `Moved ${res.data.relinkedApplicationsCount} application(s) to ${mergePrimary}`
      );
      setMergeOpen(false);
      await loadCustomers();
    } catch (err) {
      const msg = extractFriendlyErrorMessage(err, 'Unable to merge customers.');
      setMergeError(msg);
      onShowToast('error', 'Merge Failed', msg);
    } finally {
      setMerging(false);
    }
  };

  const paginated = useMemo(() => paginateArray(customers, page, 8), [customers, page]);

  const columns: TableColumn<ErpCustomerItem>[] = [
    {
      key: 'customerId',
      header: 'Customer ID',
      render: (r) => (
        <div>
          <span className="font-mono text-xs font-semibold text-neutral-950 dark:text-white">
            {r.customerId}
          </span>
          {(r.deletedAt || r.isArchived) && (
            <span className="ml-2 text-[10px] font-mono uppercase text-red-600">Archived</span>
          )}
        </div>
      ),
    },
    {
      key: 'fullName',
      header: 'Customer & Address',
      render: (r) => (
        <div>
          <div className="font-medium text-neutral-950 dark:text-white">{r.fullName}</div>
          <div className="text-xs text-neutral-500 dark:text-neutral-400">
            {r.village} · {r.district} ({r.segment})
          </div>
        </div>
      ),
    },
    {
      key: 'mobile',
      header: 'Mobile / Verification',
      render: (r) => (
        <div>
          <div className="font-mono text-xs text-neutral-900 dark:text-neutral-200">{r.mobile}</div>
          <div className="text-[11px] text-neutral-500 dark:text-neutral-400">{r.verificationStatus}</div>
        </div>
      ),
    },
    {
      key: 'apps',
      header: 'Applications',
      render: (r) => (
        <span className="font-mono text-xs tabular-nums">
          {r.stats?.activeApplications ?? 0} active / {r.stats?.applicationCount ?? 0} total
        </span>
      ),
    },
    {
      key: 'balance',
      header: 'Paid / Due',
      align: 'right',
      render: (r) => (
        <div className="text-right font-mono text-xs tabular-nums">
          <div className="text-neutral-950 dark:text-white">{formatCurrency(r.stats?.totalPaid ?? 0)}</div>
          {(r.stats?.pendingBalance ?? 0) > 0 && (
            <div className="text-amber-600 dark:text-amber-400">Due {formatCurrency(r.stats!.pendingBalance)}</div>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Action',
      align: 'right',
      render: (r) => (
        <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="outline" onClick={() => openProfile(r.customerId)}>
            360° Profile
          </Button>
          {!(r.deletedAt || r.isArchived) ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onStartApplicationForCustomer(r.customerId)}
              icon={<FilePlus2 className="h-3 w-3" />}
            >
              New App
            </Button>
          ) : (
            currentUser.role === 'ADMIN' && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      let restoredData: ErpCustomerItem;
                      try {
                        const restored = await erpApi.restoreCustomer(r.customerId);
                        restoredData = restored.data;
                      } catch (apiErr) {
                        const msg = extractFriendlyErrorMessage(apiErr).toLowerCase();
                        if (!msg.includes('not found') && !msg.includes('404')) throw apiErr;
                        restoredData = {
                          ...r,
                          deletedAt: null,
                          isArchived: false,
                          status: 'Active',
                          updatedAt: new Date().toISOString(),
                        };
                      }
                      await saveCustomerToFirestore(restoredData);
                      setApiCustomers((prev) =>
                        prev.map((c) => (c.customerId === r.customerId ? restoredData : c))
                      );
                      window.dispatchEvent(new CustomEvent('mun:customers-changed'));
                      onShowToast('success', 'Customer Restored to Cloud', r.customerId);
                      loadCustomers();
                    } catch (err) {
                      onShowToast('error', 'Restore Failed', extractFriendlyErrorMessage(err));
                    }
                  }}
                  icon={<RotateCcw className="h-3 w-3" />}
                >
                  Restore
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => setPermanentDeleteTarget(r)}
                  icon={<Trash2 className="h-3 w-3" />}
                >
                  Delete
                </Button>
              </>
            )
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-neutral-950 dark:text-white">
            Customer Management &amp; CRM
          </h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            MCC sequential FY IDs, duplicate Mobile/Aadhaar guards, OTP contact verification, and 7-category consent ledger
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isFirebaseConfigured() && (
            <Button
              variant="outline"
              size="sm"
              loading={cloudSyncing}
              onClick={handleCloudSync}
              icon={<Cloud className="h-3.5 w-3.5" />}
            >
              {firebaseUser ? `Synced: ${firebaseUser.email?.split('@')[0] || 'Cloud'}` : 'Connect Cloud Sync'}
            </Button>
          )}
          {currentUser.role === 'ADMIN' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMergeOpen(true)}
              icon={<GitMerge className="h-3.5 w-3.5" />}
            >
              Merge Duplicates
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setBulkOpen(true)}
            icon={<Upload className="h-3.5 w-3.5" />}
          >
            Bulk CSV Import
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => {
              setCreateError(null);
              setDupOverridePrompt(null);
              setCreateOpen(true);
            }}
            icon={<Plus className="h-3.5 w-3.5" />}
          >
            Register Customer
          </Button>
        </div>
      </div>

      {/* Filters Bar */}
      <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="h-3.5 w-3.5 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Search ID, name, mobile, village, PAN..."
            className="w-full h-9 pl-8 pr-3 text-xs bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={segmentFilter}
            onChange={(e) => {
              setSegmentFilter(e.target.value);
              setPage(1);
            }}
            className="h-9 px-2.5 text-xs bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
          >
            <option value="">All Segments</option>
            <option value="Individual">Individual</option>
            <option value="Corporate">Corporate</option>
            <option value="Government">Government</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="h-9 px-2.5 text-xs bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
          >
            <option value="">All Status</option>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
            <option value="Blocked">Blocked</option>
          </select>
          <label className="inline-flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300 px-2">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => {
                setShowArchived(e.target.checked);
                setPage(1);
              }}
            />
            Show Archived
          </label>
        </div>
      </div>

      <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
        <DataTable
          columns={columns}
          data={paginated.items}
          rowKey={(r) => r.customerId}
          loading={loading}
          pagination={paginated.pagination}
          onPageChange={setPage}
          onRowClick={(r) => openProfile(r.customerId)}
        />
      </div>

      {/* Register Customer Modal */}
      <Modal
        isOpen={createOpen}
        onClose={() => {
          setCreateError(null);
          setCreateOpen(false);
        }}
        title="Register New Customer (CRM)"
        description="Generates sequential Customer ID (MCC-YYYY-YY-NNNNNN) with server duplicate detection."
        maxWidthClass="max-w-3xl"
      >
        <form onSubmit={handleCreateCustomer} className="space-y-4" noValidate>
          {createError && (
            <div role="alert" className="px-3 py-2 text-xs rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300">
              {createError}
            </div>
          )}
          {dupOverridePrompt && (
            <div className="p-3 border border-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded text-xs space-y-2">
              <div className="font-semibold text-amber-800 dark:text-amber-300">{dupOverridePrompt}</div>
              {(currentUser.role === 'ADMIN' || currentUser.role === 'MANAGER') && (
                <div>
                  <label className="block font-medium mb-1">Authorized Override Reason (Manager/Admin Only)</label>
                  <input
                    type="text"
                    value={form.overrideDuplicateReason}
                    onChange={(e) => setForm({ ...form, overrideDuplicateReason: e.target.value })}
                    placeholder="e.g., Family member sharing phone with valid consent"
                    className="w-full h-9 px-3 border border-amber-300 rounded bg-white dark:bg-neutral-950 text-xs"
                  />
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div>
              <label className="block font-medium mb-1">Full Name *</label>
              <input
                required
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Father / Husband Name</label>
              <input
                value={form.fatherOrHusbandName}
                onChange={(e) => setForm({ ...form, fatherOrHusbandName: e.target.value })}
                className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Mobile Number *</label>
              <div className="flex rounded-md border border-neutral-300 dark:border-neutral-700 overflow-hidden bg-white dark:bg-neutral-950">
                <span className="inline-flex items-center px-3 bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 text-xs font-mono font-medium border-r border-neutral-300 dark:border-neutral-700">
                  +91
                </span>
                <input
                  required
                  value={form.mobile}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, '');
                    const val = digits.length > 10 ? digits.slice(-10) : digits;
                    setForm({
                      ...form,
                      mobile: val,
                      whatsapp: form.sameAsMobile ? val : form.whatsapp,
                    });
                  }}
                  placeholder="9830000000"
                  className="w-full h-9 px-3 border-0 bg-transparent font-mono text-xs focus:outline-none"
                />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block font-medium">WhatsApp Number</label>
                <label className="inline-flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.sameAsMobile}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setForm({
                        ...form,
                        sameAsMobile: checked,
                        whatsapp: checked ? form.mobile : form.whatsapp,
                      });
                    }}
                    className="rounded border-neutral-300"
                  />
                  <span>Same as Mobile Number</span>
                </label>
              </div>
              <div className="flex rounded-md border border-neutral-300 dark:border-neutral-700 overflow-hidden bg-white dark:bg-neutral-950">
                <span className="inline-flex items-center px-3 bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 text-xs font-mono font-medium border-r border-neutral-300 dark:border-neutral-700">
                  +91
                </span>
                <input
                  value={form.whatsapp}
                  disabled={form.sameAsMobile}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, '');
                    setForm({ ...form, whatsapp: digits.length > 10 ? digits.slice(-10) : digits });
                  }}
                  placeholder="9830000000"
                  className="w-full h-9 px-3 border-0 bg-transparent font-mono text-xs focus:outline-none disabled:opacity-75"
                />
              </div>
            </div>
            <div>
              <label className="block font-medium mb-1">Aadhaar (12 digits, Encrypted &amp; Masked)</label>
              <input
                value={form.aadhaarNumber}
                onChange={(e) => setForm({ ...form, aadhaarNumber: e.target.value })}
                placeholder="Optional 12-digit number"
                className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950 font-mono"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">PAN Number</label>
              <input
                value={form.panNumber}
                onChange={(e) => setForm({ ...form, panNumber: e.target.value })}
                placeholder="ABCDE1234F"
                className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950 font-mono uppercase"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Village / Locality *</label>
              <input
                required
                value={form.village}
                onChange={(e) => setForm({ ...form, village: e.target.value })}
                className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">District &amp; PIN</label>
              <div className="flex gap-2">
                <input
                  value={form.district}
                  onChange={(e) => setForm({ ...form, district: e.target.value })}
                  className="flex-1 h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
                />
                <input
                  value={form.pinCode}
                  onChange={(e) => setForm({ ...form, pinCode: e.target.value })}
                  placeholder="PIN"
                  className="w-24 h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950 font-mono"
                />
              </div>
            </div>
          </div>

          <div className="border-t border-neutral-200 dark:border-neutral-800 pt-3">
            <div className="text-xs font-semibold mb-2">7-Category Customer Consents</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              {CONSENT_LABELS.map((c) => (
                <label key={c.key} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(newConsents[c.key])}
                    onChange={(e) =>
                      setNewConsents((prev) => ({ ...prev, [c.key]: e.target.checked }))
                    }
                  />
                  <span>{c.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={savingCustomer}>
              Register Customer
            </Button>
          </div>
        </form>
      </Modal>

      {/* Customer 360 Profile Drawer/Modal */}
      <Modal
        isOpen={Boolean(profileData) || profileLoading}
        onClose={() => setProfileData(null)}
        title={profileData ? `${profileData.customer.fullName} · ${profileData.customer.customerId}` : 'Loading Customer...'}
        description="Complete 12-section Customer CRM Profile, OTP Verification, Consent Proof, Applications & ID Card"
        maxWidthClass="max-w-5xl"
      >
        {profileData && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 dark:border-neutral-800 pb-3">
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ['overview', 'Personal & Addresses'],
                    ['consents', '7 Consents & OTP'],
                    ['apps', `Applications (${profileData.applications.length})`],
                    ['notes', 'Notes & Follow-ups'],
                    ['idcard', 'ID Card Print'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setProfileTab(id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded border cursor-pointer ${
                      profileTab === id
                        ? 'bg-neutral-950 text-white border-neutral-950 dark:bg-white dark:text-neutral-950'
                        : 'border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                {(currentUser.role === 'ADMIN' || currentUser.role === 'MANAGER') && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openEditProfile(profileData.customer)}
                    icon={<Pencil className="h-3.5 w-3.5" />}
                  >
                    Edit Profile
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    const id = profileData.customer.customerId;
                    setProfileData(null);
                    onStartApplicationForCustomer(id);
                  }}
                  icon={<FilePlus2 className="h-3.5 w-3.5" />}
                >
                  New Application (Pre-filled)
                </Button>
                {currentUser.role === 'ADMIN' && !(profileData.customer.deletedAt || profileData.customer.isArchived) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      try {
                        await erpApi.softDeleteCustomer(profileData.customer.customerId, 'Archived via CRM').catch((apiErr) => {
                          const msg = extractFriendlyErrorMessage(apiErr).toLowerCase();
                          if (!msg.includes('not found') && !msg.includes('404')) throw apiErr;
                        });
                        const archivedAt = new Date().toISOString();
                        const archivedRecord: ErpCustomerItem = {
                          ...profileData.customer,
                          deletedAt: archivedAt,
                          isArchived: true,
                          updatedAt: archivedAt,
                        };
                        await saveCustomerToFirestore(archivedRecord);
                        setApiCustomers((prev) =>
                          prev.map((c) =>
                            c.customerId === archivedRecord.customerId ? archivedRecord : c
                          )
                        );
                        setProfileData(null);
                        window.dispatchEvent(new CustomEvent('mun:customers-changed'));
                        loadCustomers();
                        onShowToast('info', 'Customer Archived in Cloud');
                      } catch (err) {
                        onShowToast('error', 'Archive Failed', extractFriendlyErrorMessage(err));
                      }
                    }}
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                  >
                    Archive
                  </Button>
                )}
                {currentUser.role === 'ADMIN' && (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => setPermanentDeleteTarget(profileData.customer)}
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                  >
                    Delete Permanently
                  </Button>
                )}
              </div>
            </div>

            {profileTab === 'overview' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-2">
                  <div className="font-semibold text-sm">Identity &amp; Contact</div>
                  <div>Father / Husband: <span className="font-medium">{profileData.customer.fatherOrHusbandName || '-'}</span></div>
                  <div>DOB / Gender: <span className="font-medium">{profileData.customer.dob || '-'} · {profileData.customer.gender}</span></div>
                  <div>Mobile: <span className="font-mono font-medium">{profileData.customer.mobile}</span> ({profileData.customer.verificationStatus})</div>
                  <div>WhatsApp: <span className="font-mono font-medium">{profileData.customer.whatsapp}</span></div>
                  <div>Email: <span className="font-medium">{profileData.customer.email || '-'}</span></div>
                  <div className="flex items-center justify-between pt-1">
                    <span>
                      Aadhaar: <span className="font-mono font-semibold">{decryptedAadhaar || profileData.customer.aadhaarMasked || 'Not Stored'}</span>
                    </span>
                    {currentUser.role === 'ADMIN' && profileData.customer.aadhaarMasked && !decryptedAadhaar && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          try {
                            const res = await erpApi.decryptCustomerAadhaar(profileData.customer.customerId);
                            setDecryptedAadhaar(res.data.aadhaarFormatted);
                          } catch (err) {
                            onShowToast('error', 'Decrypt Failed', extractFriendlyErrorMessage(err));
                          }
                        }}
                      >
                        Decrypt (Audit Logged)
                      </Button>
                    )}
                  </div>
                </div>

                <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-2">
                  <div className="font-semibold text-sm">Addresses &amp; Summary</div>
                  <div>Present Address: <span className="font-medium">{profileData.customer.presentAddress}</span></div>
                  <div>Permanent Address: <span className="font-medium">{profileData.customer.permanentAddress}</span></div>
                  <div>Village / PS / District: <span className="font-medium">{profileData.customer.village}, {profileData.customer.policeStation}, {profileData.customer.district} - {profileData.customer.pinCode}</span></div>
                  <div className="pt-2 border-t border-neutral-100 dark:border-neutral-800">
                    Payments Settled: <span className="font-mono font-bold">{formatCurrency(profileData.payments.filter((p) => p.verificationStatus === 'Confirmed').reduce((s, p) => s + p.amount, 0))}</span>
                  </div>
                </div>
              </div>
            )}

            {profileTab === 'consents' && (
              <div className="space-y-4 text-xs">
                <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="font-semibold text-sm flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-emerald-600" />
                      OTP Mobile / WhatsApp Verification
                    </div>
                    <Button size="sm" variant="outline" onClick={handleSendCustomerOtp}>
                      Send Verification OTP
                    </Button>
                  </div>
                  {otpChallenge && (
                    <div className="p-3 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded flex flex-wrap items-end gap-2">
                      <div>
                        <label className="block mb-1">Target Mobile</label>
                        <MobileNumberInput
                          value={otpChallenge.newMobile}
                          onChange={(val) => setOtpChallenge((prev) => (prev ? { ...prev, newMobile: val } : prev))}
                          heightClassName="h-8"
                          aria-label="Target OTP mobile number"
                        />
                      </div>
                      <div>
                        <label className="block mb-1">OTP Code {otpChallenge.sandboxOtpPreview ? `(Sandbox: ${otpChallenge.sandboxOtpPreview})` : ''}</label>
                        <input
                          value={otpChallenge.otpInput}
                          onChange={(e) => setOtpChallenge({ ...otpChallenge, otpInput: e.target.value })}
                          className="h-8 px-2 border rounded font-mono w-32"
                        />
                      </div>
                      <Button size="sm" variant="primary" onClick={handleVerifyCustomerOtp} icon={<UserCheck className="h-3.5 w-3.5" />}>
                        Confirm OTP
                      </Button>
                    </div>
                  )}
                </div>

                <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-2">
                  <div className="font-semibold text-sm mb-2">7 Separate Consent Categories (Privacy &amp; Notification Gate)</div>
                  <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                    {profileData.customer.consents.map((c) => (
                      <div key={c.category} className="py-2 flex items-center justify-between gap-4">
                        <div>
                          <div className="font-medium">{c.label}</div>
                          <div className="text-[11px] text-neutral-500">
                            Method: {c.verificationMethod} · {c.recordedAt ? formatDateIST(c.recordedAt.slice(0, 10)) : 'Pending'}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant={c.granted ? 'primary' : 'outline'}
                          onClick={() => handleToggleConsent(c.category, !c.granted)}
                        >
                          {c.granted ? 'Granted (Click to Revoke)' : 'Not Granted (Grant)'}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {profileTab === 'apps' && (
              <div className="space-y-2 text-xs">
                {profileData.applications.length === 0 ? (
                  <p className="text-neutral-500">No applications linked to this customer yet.</p>
                ) : (
                  profileData.applications.map((a) => (
                    <div key={a.applicationNo} className="border border-neutral-200 dark:border-neutral-800 rounded p-3 flex items-center justify-between">
                      <div>
                        <div className="font-mono font-semibold">{a.applicationNo} · {a.serviceSnapshot.name}</div>
                        <div className="text-neutral-500">Status: {a.status} · Due: {formatDateIST(a.expectedCompletionDate)}</div>
                      </div>
                      <div className="font-mono text-right">
                        <div>{formatCurrency(a.financialSummary.netCollected)} paid</div>
                        <div className="text-neutral-500">Fee {formatCurrency(a.financialSummary.serviceCharge)}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {profileTab === 'notes' && (
              <div className="space-y-3 text-xs">
                <form onSubmit={handleAddNote} className="flex flex-wrap gap-2">
                  <select
                    value={noteType}
                    onChange={(e) => setNoteType(e.target.value as 'INTERNAL_NOTE' | 'FOLLOW_UP')}
                    className="h-9 px-2 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
                  >
                    <option value="INTERNAL_NOTE">Internal Note</option>
                    <option value="FOLLOW_UP">CRM Follow-up</option>
                  </select>
                  {noteType === 'FOLLOW_UP' && (
                    <input
                      type="date"
                      value={followUpDate}
                      onChange={(e) => setFollowUpDate(e.target.value)}
                      className="h-9 px-2 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
                    />
                  )}
                  <input
                    value={noteInput}
                    onChange={(e) => setNoteInput(e.target.value)}
                    placeholder="Add CRM interaction note..."
                    className="flex-1 h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
                  />
                  <Button type="submit" size="sm" variant="primary">Save</Button>
                </form>
                <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {profileData.customer.notesAndFollowUps.map((n) => (
                    <div key={n.id} className="py-2">
                      <span className="font-mono font-semibold mr-2">[{n.type}]</span>
                      <span>{n.text}</span>
                      <span className="ml-2 text-neutral-400">by {n.authorUserId}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {profileTab === 'idcard' && (
              <div className="space-y-3">
                <div className="max-w-md mx-auto border-2 border-neutral-950 dark:border-white rounded-lg p-5 bg-white text-neutral-950 space-y-2">
                  <div className="flex items-center justify-between border-b border-neutral-300 pb-2">
                    <div>
                      <div className="font-bold text-sm tracking-tight">MUN COMPUTER</div>
                      <div className="text-[10px] text-neutral-600">CUSTOMER MEMBERSHIP &amp; SERVICE CARD</div>
                    </div>
                    <span className="font-mono text-xs font-bold">{profileData.customer.customerId}</span>
                  </div>
                  <div className="text-xs space-y-1">
                    <div className="font-bold text-sm">{profileData.customer.fullName}</div>
                    <div>Mobile: <span className="font-mono">{profileData.customer.mobile}</span></div>
                    <div>Address: {profileData.customer.village}, {profileData.customer.district}</div>
                    <div>Status: {profileData.customer.verificationStatus}</div>
                  </div>
                  <div className="pt-2 border-t border-neutral-200 flex items-center justify-between text-[10px] font-mono text-neutral-600">
                    <span>AUTH-QR: {profileData.customer.customerId}</span>
                    <span>ISSUED BY MUN COMPUTER</span>
                  </div>
                </div>
                <div className="flex justify-center no-print">
                  <Button size="sm" variant="primary" onClick={() => window.print()} icon={<Printer className="h-3.5 w-3.5" />}>
                    Print Customer ID Card
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Bulk CSV Import Modal */}
      <Modal
        isOpen={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title="Bulk Customer CSV Import"
        description="Validate rows before committing sequential MCC Customer IDs."
        maxWidthClass="max-w-2xl"
      >
        <div className="space-y-3 text-xs">
          <textarea
            rows={6}
            value={csvInput}
            onChange={(e) => setCsvInput(e.target.value)}
            className="w-full p-3 font-mono border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
          />
          {bulkPreview && (
            <div className="border border-neutral-200 dark:border-neutral-800 rounded p-3 max-h-48 overflow-y-auto space-y-1">
              {bulkPreview.map((r) => (
                <div key={r.rowNumber} className="flex justify-between">
                  <span>Row {r.rowNumber}: {r.fullName} ({r.mobile})</span>
                  <span className={r.valid ? 'text-emerald-600 font-semibold' : 'text-red-600'}>
                    {r.valid ? 'Valid' : r.errors.join(', ')}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => handleBulkPreviewOrCommit(false)}>
              Validate Preview
            </Button>
            <Button size="sm" variant="primary" onClick={() => handleBulkPreviewOrCommit(true)}>
              Commit Valid Customers
            </Button>
          </div>
        </div>
      </Modal>

      {/* Admin Customer Merge Modal */}
      <Modal
        isOpen={mergeOpen}
        onClose={() => {
          setMergeError(null);
          setMergeOpen(false);
        }}
        title="Merge Duplicate Customers (Admin Only)"
        description="Transfers all linked applications, documents, payments, deliveries, and refunds to the primary Customer ID."
      >
        <form onSubmit={handleMerge} className="space-y-3 text-xs" noValidate>
          {mergeError && (
            <div role="alert" className="px-3 py-2 rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300">
              {mergeError}
            </div>
          )}
          <div>
            <label className="block font-medium mb-1">Primary Customer ID (Retained)</label>
            <input
              required
              value={mergePrimary}
              onChange={(e) => setMergePrimary(e.target.value)}
              placeholder="MCC-2026-27-000001"
              className="w-full h-9 px-3 border rounded font-mono bg-white dark:bg-neutral-950"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">Duplicate Customer ID (Merged &amp; Archived)</label>
            <input
              required
              value={mergeDuplicate}
              onChange={(e) => setMergeDuplicate(e.target.value)}
              placeholder="MCC-2026-27-000004"
              className="w-full h-9 px-3 border rounded font-mono bg-white dark:bg-neutral-950"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">Merge Audit Reason</label>
            <input
              required
              value={mergeReason}
              onChange={(e) => setMergeReason(e.target.value)}
              placeholder="Same citizen registered twice under alternate mobile"
              className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-950"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setMergeError(null);
                setMergeOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="primary" loading={merging}>
              Execute Merge
            </Button>
          </div>
        </form>
      </Modal>
      {/* Edit Customer Profile Modal */}
      <Modal
        isOpen={editOpen}
        onClose={() => setEditOpen(false)}
        title={`Edit Customer · ${editForm.customerId}`}
        description="Updates profile fields and synchronizes with backend and Cloud Firestore."
        maxWidthClass="max-w-2xl"
      >
        <form onSubmit={handleSaveEdit} className="space-y-3 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-medium mb-1">Full Name *</label>
              <input
                required
                value={editForm.fullName}
                onChange={(e) => setEditForm((prev) => ({ ...prev, fullName: e.target.value }))}
                className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Father / Husband Name</label>
              <input
                value={editForm.fatherOrHusbandName}
                onChange={(e) => setEditForm((prev) => ({ ...prev, fatherOrHusbandName: e.target.value }))}
                className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Email</label>
              <input
                type="email"
                value={editForm.email}
                onChange={(e) => setEditForm((prev) => ({ ...prev, email: e.target.value }))}
                className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Village / Locality</label>
              <input
                value={editForm.village}
                onChange={(e) => setEditForm((prev) => ({ ...prev, village: e.target.value }))}
                className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">District</label>
              <input
                value={editForm.district}
                onChange={(e) => setEditForm((prev) => ({ ...prev, district: e.target.value }))}
                className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">PIN Code</label>
              <input
                value={editForm.pinCode}
                onChange={(e) => setEditForm((prev) => ({ ...prev, pinCode: e.target.value }))}
                className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950 font-mono"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Segment</label>
              <select
                value={editForm.segment}
                onChange={(e) =>
                  setEditForm((prev) => ({
                    ...prev,
                    segment: e.target.value as 'Individual' | 'Corporate' | 'Government',
                  }))
                }
                className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              >
                <option value="Individual">Individual</option>
                <option value="Corporate">Corporate</option>
                <option value="Government">Government</option>
              </select>
            </div>
            <div>
              <label className="block font-medium mb-1">Status</label>
              <select
                value={editForm.status}
                onChange={(e) =>
                  setEditForm((prev) => ({
                    ...prev,
                    status: e.target.value as 'Active' | 'Inactive' | 'Blocked',
                  }))
                }
                className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
              >
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
                <option value="Blocked">Blocked</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block font-medium mb-1">Present Address</label>
            <input
              value={editForm.presentAddress}
              onChange={(e) => setEditForm((prev) => ({ ...prev, presentAddress: e.target.value }))}
              className="w-full h-9 px-3 border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-950"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" variant="primary" loading={savingEdit}>
              Save Changes
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={Boolean(permanentDeleteTarget)}
        onClose={() => !deletingPermanent && setPermanentDeleteTarget(null)}
        title="Permanently Delete Customer?"
        description="This permanently removes the customer record from both backend storage and Firestore so it will never return."
        maxWidthClass="max-w-md"
      >
        {permanentDeleteTarget && (
          <div className="space-y-4 text-xs">
            <div className="p-3 rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200">
              <div className="font-semibold">{permanentDeleteTarget.fullName}</div>
              <div className="font-mono mt-0.5">
                {permanentDeleteTarget.customerId} · {permanentDeleteTarget.mobile}
              </div>
            </div>
            <p className="text-neutral-600 dark:text-neutral-400">
              Customers with active applications or confirmed financial payments are protected and must have those records archived/deleted first.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={deletingPermanent}
                onClick={() => setPermanentDeleteTarget(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                variant="danger"
                loading={deletingPermanent}
                onClick={handlePermanentDeleteCustomer}
                icon={<Trash2 className="h-3.5 w-3.5" />}
              >
                Permanently Delete
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};
