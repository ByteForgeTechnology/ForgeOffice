import { ApiError, api } from '../../lib/api';
import { getAccessToken } from '../../lib/auth';

export type DriveRole = 'owner' | 'editor' | 'commenter' | 'viewer';

export interface DriveItem {
  id: string;
  libraryId: string;
  parentId: string | null;
  kind: 'folder' | 'file';
  name: string;
  size: number;
  mime: string | null;
  scanStatus: 'pending' | 'clean' | 'infected' | 'error' | 'skipped' | null;
  scanDetail: string | null;
  thumbnailUrl: string | null;
  inheritPermissions: boolean;
  checkedOutBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  deletedAt: string | null;
  deletedBy?: string | null;
  role?: DriveRole;
  library?: { id: string; name: string; kind?: string };
  libraryName?: string | null;
}

export interface Library {
  id: string;
  kind: 'personal' | 'group' | 'site';
  name: string;
  description: string;
  role: DriveRole;
  usedBytes: number;
  mine: boolean;
}

export const ROLE_RANK: Record<DriveRole, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 };
export const can = (role: DriveRole | undefined, need: DriveRole) => !!role && ROLE_RANK[role] >= ROLE_RANK[need];

export const ROLE_LEVELS = [
  { value: 'viewer', label: 'Viewer', description: 'Open and download' },
  { value: 'commenter', label: 'Commenter', description: 'Also comment' },
  { value: 'editor', label: 'Editor', description: 'Also upload, edit, move and delete' },
  { value: 'owner', label: 'Owner', description: 'Also share and manage permissions' },
];

/** A short-lived URL for a file's content (images, video, PDFs, downloads). */
export async function contentUrl(id: string, opts: { download?: boolean; versionId?: string } = {}) {
  const q = new URLSearchParams();
  if (opts.download) q.set('download', 'true');
  if (opts.versionId) q.set('versionId', opts.versionId);
  return (await api<{ url: string }>(`/api/v1/drive/items/${id}/url?${q}`)).url;
}

export async function download(id: string, versionId?: string) {
  const url = await contentUrl(id, { download: true, versionId });
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------------------------
// Resumable uploads: 8 MB chunks; after a dropped connection, ask the server
// how much arrived and carry on from there.
// ---------------------------------------------------------------------------

export interface UploadJob {
  id: string;
  name: string;
  size: number;
  sent: number;
  state: 'queued' | 'uploading' | 'done' | 'error' | 'cancelled';
  error?: string;
}

export async function uploadFile(
  file: File,
  target: { libraryId: string; parentId: string | null; itemId?: string },
  onProgress: (sent: number) => void,
  opts: { conflict?: 'fail' | 'rename' | 'replace'; signal?: AbortSignal } = {},
): Promise<DriveItem> {
  const start = await api<{ upload: { id: string; chunkSize: number } }>('/api/v1/drive/uploads', {
    body: { libraryId: target.libraryId, parentId: target.parentId, itemId: target.itemId, name: file.name, size: file.size, mime: file.type || undefined },
  });
  const { id, chunkSize } = start.upload;
  let offset = 0;
  let failures = 0;
  for (;;) {
    if (opts.signal?.aborted) {
      await api(`/api/v1/drive/uploads/${id}`, { method: 'DELETE' }).catch(() => {});
      throw new DOMException('Upload cancelled', 'AbortError');
    }
    const chunk = file.slice(offset, offset + chunkSize);
    try {
      const token = await getAccessToken();
      const res = await fetch(`/api/v1/drive/uploads/${id}?conflict=${opts.conflict ?? 'rename'}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/offset+octet-stream', 'upload-offset': String(offset) },
        body: chunk,
        signal: opts.signal,
      });
      const data = (await res.json().catch(() => ({}))) as { received?: number; item?: DriveItem | null; message?: string; error?: string };
      if (res.status === 409 && data.error === 'offset_mismatch') {
        offset = (await api<{ upload: { received: number } }>(`/api/v1/drive/uploads/${id}`)).upload.received;
        continue;
      }
      if (!res.ok) throw new ApiError(res.status, data.message ?? 'Upload failed');
      offset = data.received ?? offset + chunk.size;
      onProgress(offset);
      failures = 0;
      if (data.item) return data.item;
    } catch (err) {
      if ((err as Error).name === 'AbortError' || (err instanceof ApiError && err.status < 500)) throw err;
      // Network trouble: wait, find out what arrived, resume.
      if (++failures > 5) throw err;
      await new Promise((r) => setTimeout(r, 1000 * failures));
      offset = (await api<{ upload: { received: number } }>(`/api/v1/drive/uploads/${id}`)).upload.received;
    }
  }
}

export const isImage = (m: string | null) => !!m && /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(m);
export const isVideo = (m: string | null) => !!m && m.startsWith('video/');
export const isAudio = (m: string | null) => !!m && m.startsWith('audio/');
export const isPdf = (m: string | null) => m === 'application/pdf';
export const isText = (m: string | null) => !!m && /^(text\/|application\/json$)/.test(m);
export const isOffice = (name: string) => /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv)$/i.test(name);
