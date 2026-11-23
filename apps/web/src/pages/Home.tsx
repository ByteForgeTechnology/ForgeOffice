import { Link } from 'react-router';
import { ArrowRight, ShieldAlert } from 'lucide-react';
import { Alert, Badge, Card, CardBody, CardHeader, PageSpinner, ProgressBar, cn, formatBytes } from '@forge/ui';
import { launcherApps } from '../lib/apps';
import { useBranding, useMe } from '../lib/hooks';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function HomePage() {
  const { data: me, isLoading } = useMe();
  const { data: branding } = useBranding();
  if (isLoading || !me) return <PageSpinner />;
  const apps = launcherApps(me.permissions.length > 0, { mail: true, calendar: true, contacts: true, tasks: true, drive: true, team: true, ...me.org?.features }).filter((a) => a.id !== 'home');
  const quota = me.storage.quotaBytes ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {greeting()}, {me.user.givenName ?? me.user.displayName.split(' ')[0]}
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Welcome to {branding?.name ?? 'ForgeOffice'}.</p>
      </div>

      {!me.user.mfaEnabled && (
        <Alert tone={me.mfaRequired ? 'warning' : 'info'} title="Protect your account with two-step verification">
          Add an authenticator app so a stolen password alone cannot be used to sign in.{' '}
          <Link to="/account#security" className="font-medium underline">
            Set it up
          </Link>
        </Alert>
      )}

      <section aria-labelledby="apps-heading">
        <h2 id="apps-heading" className="mb-3 text-sm font-semibold text-zinc-500 dark:text-zinc-400">
          Apps
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {apps.map((app) => (
            <Link
              key={app.id}
              to={app.href}
              className="group flex items-start gap-4 rounded-xl border border-zinc-200 bg-white p-4 transition hover:border-brand/50 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
            >
              <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl text-white', app.color, !app.available && 'opacity-60')}>
                <app.icon className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 font-medium">
                  {app.name}
                  {!app.available && <Badge>Coming soon</Badge>}
                </span>
                <span className="mt-0.5 block text-sm text-zinc-500 dark:text-zinc-400">{app.description}</span>
              </span>
              <ArrowRight className="mt-1 size-4 shrink-0 text-zinc-300 transition group-hover:translate-x-0.5 group-hover:text-brand" />
            </Link>
          ))}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader title="Storage" description="Shared across Mail, Drive and Team" />
          <CardBody className="space-y-2">
            <ProgressBar value={quota ? (me.storage.usedBytes / quota) * 100 : 0} />
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {formatBytes(me.storage.usedBytes)} of {quota ? formatBytes(quota) : 'unlimited'} used
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Your groups" />
          <CardBody>
            {me.groups.length ? (
              <ul className="flex flex-wrap gap-2">
                {me.groups.map((g) => (
                  <li key={g.id}>
                    <Badge tone={g.type === 'security' ? 'neutral' : 'info'}>{g.name}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-zinc-500">You are not a member of any groups yet.</p>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Security" />
          <CardBody className="space-y-2 text-sm">
            <p className="flex items-center justify-between">
              Two-step verification
              <Badge tone={me.user.mfaEnabled ? 'success' : 'warning'}>{me.user.mfaEnabled ? 'On' : 'Off'}</Badge>
            </p>
            <p className="flex items-center justify-between">
              Roles
              <span className="text-zinc-500">{me.user.roles?.length ? me.user.roles.join(', ') : 'Member'}</span>
            </p>
            {me.user.recoveryCodesRemaining > 0 && me.user.recoveryCodesRemaining < 3 && (
              <p className="flex items-center gap-1.5 text-amber-600">
                <ShieldAlert className="size-4" /> Only {me.user.recoveryCodesRemaining} recovery codes left
              </p>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
