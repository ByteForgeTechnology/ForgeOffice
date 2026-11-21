import { useEffect, useState } from 'react';
import type { FeatureFlags } from './types';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Branding, Me } from './types';

export function useBranding() {
  return useQuery({ queryKey: ['branding'], queryFn: () => api<Branding>('/api/v1/branding', { anonymous: true }), staleTime: 60_000 });
}

/** Apply organisation branding (accent colour, document title) to the page. */
export function useApplyBranding() {
  const { data } = useBranding();
  useEffect(() => {
    if (!data) return;
    document.documentElement.style.setProperty('--brand', data.brandColor);
    document.title = data.name === 'ForgeOffice' ? 'ForgeOffice' : `${data.name} · ForgeOffice`;
  }, [data]);
  return data;
}

export function useMe(enabled = true) {
  return useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/v1/me'), enabled, staleTime: 30_000 });
}

/** Which optional products are switched on (all on until /me has loaded). */
export function useFeatures(): FeatureFlags {
  const { data } = useMe();
  return { mail: true, calendar: true, contacts: true, tasks: true, ...data?.org?.features };
}

export function useCan(permission: string): boolean {
  const { data } = useMe();
  return !!data?.permissions.includes(permission);
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Read an image file into a data URL (used for logo uploads). */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
