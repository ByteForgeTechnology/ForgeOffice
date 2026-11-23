import { Link } from 'react-router';
import { PowerOff } from 'lucide-react';
import { Button, EmptyState } from '@forge/ui';
import { useCan } from '../lib/hooks';
import { FEATURE_NAMES, type Feature } from '../lib/types';

/** Shown in place of an app whose product an administrator has switched off. */
export function FeatureOff({ feature }: { feature: Feature }) {
  const canManage = useCan('org:manage');
  return (
    <div className="py-12">
      <EmptyState
        icon={<PowerOff />}
        title={`${FEATURE_NAMES[feature]} is turned off`}
        description={canManage ? 'It has been switched off for your organisation. Nothing has been deleted; switch it back on in the admin center.' : 'Your administrator has switched it off for your organisation.'}
        action={
          canManage ? (
            <Link to="/admin/organisation/features">
              <Button>Manage features</Button>
            </Link>
          ) : (
            <Link to="/">
              <Button>Go home</Button>
            </Link>
          )
        }
      />
    </div>
  );
}
