import { Link } from 'react-router';
import { Compass } from 'lucide-react';
import { Button, EmptyState } from '@forge/ui';

export function NotFoundPage() {
  return (
    <EmptyState
      icon={<Compass />}
      title="Page not found"
      description="The page you were looking for does not exist."
      action={
        <Link to="/">
          <Button>Go home</Button>
        </Link>
      }
    />
  );
}
