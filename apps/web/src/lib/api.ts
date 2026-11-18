import { getAccessToken, signInRedirect } from './auth';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  /** Flatten policy details (e.g. password rules) into one readable message. */
  get detailMessages(): string[] {
    const d = this.details as Record<string, string[]> | undefined;
    return d && typeof d === 'object' ? Object.values(d).flat().filter((x) => typeof x === 'string') : [];
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Do not attach a token (public endpoints). */
  anonymous?: boolean;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (!opts.anonymous) {
    const token = await getAccessToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
    credentials: 'same-origin',
  });
  if (res.status === 401 && !opts.anonymous) {
    void signInRedirect();
    throw new ApiError(401, 'Your session has expired. Signing you in again…');
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = (data ?? {}) as { message?: string; error?: string; details?: unknown };
    throw new ApiError(res.status, err.message ?? `Request failed (${res.status})`, err.error, err.details);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return [err.message, ...err.detailMessages].join(' ');
  return err instanceof Error ? err.message : 'Something went wrong';
}

/** Download an authenticated file (e.g. the audit CSV). */
export async function download(path: string, filename: string) {
  const token = await getAccessToken();
  const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, `Download failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
