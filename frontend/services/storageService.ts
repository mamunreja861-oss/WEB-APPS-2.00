import { getDownloadURL, ref, uploadBytes, uploadString } from 'firebase/storage';
import {
  markCloudSyncActivity,
  recordCloudSyncError,
  recordCloudSyncSuccess,
  ensureCloudAuthForSave,
} from './cloudSync';
import { extractFriendlyErrorMessage, isFirebaseStorageConfigured, storage } from './firebase';

export interface UploadedCloudAttachment {
  storagePath: string;
  downloadUrl: string;
  fileSizeBytes: number;
  mimeType: string;
}

function sanitizeSegment(raw: string, fallback = 'item'): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

function formatStorageError(err: unknown): string {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: string }).code || '')
      : '';
  switch (code) {
    case 'storage/unauthorized':
      return 'Cloud Storage permission denied. Ensure your Firebase account is signed in and Storage rules allow uploads.';
    case 'storage/quota-exceeded':
      return 'Cloud Storage quota exceeded.';
    case 'storage/canceled':
      return 'File upload was cancelled.';
    case 'storage/retry-limit-exceeded':
      return 'Upload timed out due to network instability. Please try again.';
    case 'storage/unauthenticated':
      return 'Please authenticate your Cloud DB session before uploading files.';
    default:
      return extractFriendlyErrorMessage(err, 'Failed to upload file attachment to Firebase Storage.');
  }
}

export async function uploadAttachmentToFirebaseStorage(params: {
  file?: File | null;
  base64?: string;
  folder: string;
  fileName: string;
  contentType?: string;
}): Promise<UploadedCloudAttachment> {
  if (!isFirebaseStorageConfigured() || !storage) {
    throw new Error('Firebase Storage is not configured. Check VITE_FIREBASE_STORAGE_BUCKET.');
  }
  await ensureCloudAuthForSave();

  const safeFolder = params.folder
    .split('/')
    .filter(Boolean)
    .map((seg) => sanitizeSegment(seg))
    .join('/');
  const safeName = sanitizeSegment(params.fileName, 'document');
  const storagePath = `${safeFolder || 'attachments'}/${Date.now()}_${safeName}`;
  const fileRef = ref(storage, storagePath);

  markCloudSyncActivity(true);
  try {
    let resolvedMime = params.contentType || params.file?.type || 'application/octet-stream';
    let resolvedSize = params.file?.size || 0;

    if (params.file) {
      const snap = await uploadBytes(fileRef, params.file, {
        contentType: resolvedMime,
      });
      resolvedSize = snap.metadata.size || params.file.size;
      resolvedMime = snap.metadata.contentType || resolvedMime;
    } else if (params.base64) {
      const dataUrlMatch = /^data:([^;]+);base64,(.*)$/s.exec(params.base64.trim());
      const cleanBase64 = dataUrlMatch ? dataUrlMatch[2] : params.base64.trim();
      resolvedMime = dataUrlMatch?.[1] || resolvedMime;
      const snap = await uploadString(fileRef, cleanBase64, 'base64', {
        contentType: resolvedMime,
      });
      resolvedSize = snap.metadata.size || Math.round((cleanBase64.length * 3) / 4);
      resolvedMime = snap.metadata.contentType || resolvedMime;
    } else {
      throw new Error('Select a file attachment to upload.');
    }

    const downloadUrl = await getDownloadURL(fileRef);
    recordCloudSyncSuccess();
    return {
      storagePath,
      downloadUrl,
      fileSizeBytes: resolvedSize,
      mimeType: resolvedMime,
    };
  } catch (err) {
    const friendly = formatStorageError(err);
    recordCloudSyncError(friendly);
    throw new Error(friendly);
  } finally {
    markCloudSyncActivity(false);
  }
}

export async function resolveStorageDownloadUrl(
  storagePath?: string | null,
  fallbackUrl?: string | null
): Promise<string | null> {
  if (fallbackUrl && /^https?:\/\//i.test(fallbackUrl)) {
    return fallbackUrl;
  }
  if (storage && storagePath) {
    try {
      return await getDownloadURL(ref(storage, storagePath));
    } catch {
      return fallbackUrl || null;
    }
  }
  return fallbackUrl || null;
}

export async function downloadCloudAttachment(params: {
  storageUrl?: string | null;
  storagePath?: string | null;
  fileName: string;
  fallbackBase64?: string | null;
  fallbackMimeType?: string;
}): Promise<boolean> {
  const url = await resolveStorageDownloadUrl(params.storagePath, params.storageUrl);
  if (url) {
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const blob = await resp.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = params.fileName || 'document';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
        return true;
      }
    } catch {
      // Fallback to direct anchor download when CORS restricts fetch
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = params.fileName || 'document';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  }

  if (params.fallbackBase64) {
    const raw = params.fallbackBase64.includes(',')
      ? params.fallbackBase64.split(',')[1]
      : params.fallbackBase64;
    const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: params.fallbackMimeType || 'application/pdf' });
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = params.fileName || 'document';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
    return true;
  }

  return false;
}
