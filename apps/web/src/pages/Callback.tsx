import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Button, PageSpinner } from '@forge/ui';
import { signInRedirect, userManager } from '../lib/auth';
import { AuthCard } from '../components/AuthCard';

export function CallbackPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    userManager
      .signinCallback()
      .then((user) => {
        const returnTo = (user?.state as { returnTo?: string } | undefined)?.returnTo;
        navigate(returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/', { replace: true });
      })
      .catch((err: Error) => setError(err.message));
  }, [navigate]);

  if (!error) return <PageSpinner />;
  return (
    <AuthCard title="Sign-in could not be completed">
      <Alert tone="danger">{error}</Alert>
      <Button variant="primary" className="mt-4 w-full" onClick={() => void signInRedirect('/')}>
        Try again
      </Button>
    </AuthCard>
  );
}
