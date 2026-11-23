import { Button } from '@forge/ui';
import { signInRedirect } from '../lib/auth';
import { AuthCard } from '../components/AuthCard';

export function SignedOutPage() {
  return (
    <AuthCard title="You have signed out" subtitle="Close this window or sign in again to continue.">
      <Button variant="primary" className="w-full" onClick={() => void signInRedirect('/')}>
        Sign in
      </Button>
    </AuthCard>
  );
}
