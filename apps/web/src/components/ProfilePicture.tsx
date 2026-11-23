import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Camera, ImageUp, Trash2 } from 'lucide-react';
import { Alert, Avatar, Button, Dialog, cn, useToast } from '@forge/ui';
import { api, errorMessage } from '../lib/api';

const MAX_BYTES = 15 * 1024 * 1024;

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error('That file couldn’t be read'));
    r.readAsDataURL(file);
  });

/**
 * Change a profile picture: your own (endpoint /api/v1/me/avatar) or, for
 * admins, someone else's (/api/v1/admin/users/<id>/avatar). The server crops
 * it to a square, turns it the right way up and removes location data.
 */
export function ProfilePictureDialog({ name, current, endpoint, onClose, onChanged }: { name: string; current: string | null | undefined; endpoint: string; onClose: () => void; onChanged: (url: string | null) => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const choose = (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (!f.type.startsWith('image/')) return setError('Choose a picture (JPEG, PNG, WebP, GIF or AVIF).');
    if (f.size > MAX_BYTES) return setError('Choose a picture smaller than 15 MB.');
    setFile(f);
  };
  const save = async () => {
    if (!file) return;
    setBusy('save');
    try {
      const r = await api<{ avatarUrl: string }>(endpoint, { method: 'PUT', body: { dataUrl: await readAsDataUrl(file) } });
      toast.success('Profile picture updated');
      onChanged(r.avatarUrl);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy('remove');
    try {
      await api(endpoint, { method: 'DELETE' });
      toast.success('Profile picture removed');
      onChanged(null);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Profile picture"
      description={`Shown with ${name}’s name across ForgeOffice.`}
      footer={
        <>
          {current && !file && (
            <Button variant="ghost" className="mr-auto text-red-600" icon={<Trash2 className="size-4" />} loading={busy === 'remove'} onClick={() => void remove()}>
              Remove
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!file} loading={busy === 'save'} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <div
        onDragOver={(e: DragEvent) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e: DragEvent) => {
          e.preventDefault();
          setOver(false);
          choose(e.dataTransfer.files[0]);
        }}
        className={cn('flex flex-col items-center gap-4 rounded-xl border-2 border-dashed p-6', over ? 'border-brand bg-brand/5' : 'border-zinc-200 dark:border-zinc-700')}
      >
        {preview ? <img src={preview} alt="New profile picture" className="size-32 rounded-full object-cover ring-4 ring-white shadow dark:ring-zinc-900" /> : <Avatar name={name} src={current} className="size-32 text-4xl" />}
        <div className="text-center">
          <Button icon={<ImageUp className="size-4" />} onClick={() => input.current?.click()}>
            {current || file ? 'Choose a different photo' : 'Choose a photo'}
          </Button>
          <p className="mt-2 text-xs text-zinc-500">Or drag one here. It’s cropped to a circle; JPEG, PNG, WebP, GIF or AVIF up to 15 MB.</p>
        </div>
        <input ref={input} type="file" accept="image/*" hidden onChange={(e) => (choose(e.target.files?.[0]), (e.target.value = ''))} />
      </div>
    </Dialog>
  );
}

/** A picture with a camera button on it that opens the editor. */
export function EditableAvatar({ name, src, endpoint, onChanged, size = 'xl' }: { name: string; src: string | null | undefined; endpoint: string; onChanged: (url: string | null) => void; size?: 'lg' | 'xl' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="group relative shrink-0 rounded-full" aria-label={`Change ${name}’s profile picture`}>
        <Avatar name={name} src={src} size={size} />
        <span className="absolute -right-0.5 -bottom-0.5 rounded-full bg-white p-1.5 text-zinc-700 shadow ring-1 ring-zinc-200 group-hover:text-brand dark:bg-zinc-800 dark:text-zinc-200 dark:ring-zinc-700">
          <Camera className="size-3.5" />
        </span>
      </button>
      {open && <ProfilePictureDialog name={name} current={src} endpoint={endpoint} onClose={() => setOpen(false)} onChanged={onChanged} />}
    </>
  );
}
