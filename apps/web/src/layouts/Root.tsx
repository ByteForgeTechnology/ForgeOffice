import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { Alert, Button, PageSpinner } from '@forge/ui';
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
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (ready && !user && !signingOut) {
      signIn(location.pathname + location.search).catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)));
    }
  }, [ready, user, signingOut, signIn, location.pathname, location.search, attempt]);
  if (failed && !user) {
    // Instead of a spinner that never stops when the sign-in page can't be reached.
    return (
      <div className="mx-auto mt-24 max-w-md space-y-4 px-4">
        <Alert tone="danger">Sign-in could not start: {failed}</Alert>
        <Button
          variant="primary"
          className="w-full"
          onClick={() => {
            setFailed(null);
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (!ready || !user) return <PageSpinner />;
  return <>{children}</>;
}
