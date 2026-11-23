import { useEffect, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { PageSpinner } from '@forge/ui';
import { useAuth } from '../lib/auth';
import { useApplyBranding } from '../lib/hooks';

const PUBLIC_PATHS = ['/setup', '/interaction/', '/auth/callback', '/signed-out', '/drive/s/', '/team/meet/'];

/** Applies branding and sends a fresh installation to the setup wizard. */
export function Root() {
  const branding = useApplyBranding();
  const { pathname } = useLocation();
  if (!branding) return <PageSpinner />;
  if (branding.needsSetup && !PUBLIC_PATHS.some((p) => pathname.startsWith(p))) return <Navigate to="/setup" replace />;
  return <Outlet />;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready, signingOut, signIn } = useAuth();
  const location = useLocation();
  useEffect(() => {
    if (ready && !user && !signingOut) void signIn(location.pathname + location.search);
  }, [ready, user, signingOut, signIn, location.pathname, location.search]);
  if (!ready || !user) return <PageSpinner />;
  return <>{children}</>;
}
