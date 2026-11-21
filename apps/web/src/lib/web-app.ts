/**
 * Which web app this bundle is. Production builds one bundle per app, each
 * served by its own container ("mail", "calendar", …, "portal" for home,
 * account and sign-in pages); development and all-in-one installs use "all".
 * Replaced at build time (vite.config.ts), so unused apps are left out of the bundle.
 */
declare const __FORGE_APP__: string;
export const WEB_APP: string = __FORGE_APP__;

export type WebAppName = 'portal' | 'mail' | 'calendar' | 'contacts' | 'tasks' | 'admin' | 'drive' | 'sites';

/** The app that owns a path. */
export function appForPath(path: string): WebAppName {
  const first = path.split(/[?#]/)[0]!.split('/')[1] ?? '';
  return (['mail', 'calendar', 'contacts', 'tasks', 'admin', 'drive', 'sites'] as const).find((a) => a === first) ?? 'portal';
}

/** Does this bundle contain the page at `path`? */
export const servesPath = (path: string) => WEB_APP === 'all' || appForPath(path) === WEB_APP;

/** Go to a path, loading another app's bundle (a full page load through the gateway) when needed. */
export function goTo(path: string, navigate: (to: string, opts?: { replace?: boolean }) => void, opts: { replace?: boolean } = {}) {
  if (servesPath(path)) return navigate(path, opts);
  if (opts.replace) window.location.replace(path);
  else window.location.assign(path);
}
