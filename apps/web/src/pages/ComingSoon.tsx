import { Link, useParams } from 'react-router';
import { Check } from 'lucide-react';
import { Badge, Button, Card, CardBody } from '@forge/ui';
import { UPCOMING_APPS } from '../lib/apps';
import { NotFoundPage } from './NotFound';

export function ComingSoonPage() {
  const { app = '' } = useParams();
  const info = UPCOMING_APPS[app];
  if (!info) return <NotFoundPage />;
  return (
    <div className="mx-auto max-w-2xl py-8">
      <Card>
        <CardBody className="space-y-4 p-8">
          <Badge tone="brand">Phase {info.phase}</Badge>
          <h1 className="text-2xl font-semibold tracking-tight">{info.name} is on its way</h1>
          <p className="text-zinc-600 dark:text-zinc-400">{info.summary}</p>
          <ul className="space-y-2">
            {info.features.map((f) => (
              <li key={f} className="flex items-start gap-2 text-sm">
                <Check className="mt-0.5 size-4 shrink-0 text-brand" /> {f}
              </li>
            ))}
          </ul>
          <p className="text-sm text-zinc-500">Your account, groups and distribution lists are already set up and will be used by {info.name} automatically.</p>
          <Link to="/">
            <Button>Back to home</Button>
          </Link>
        </CardBody>
      </Card>
    </div>
  );
}
