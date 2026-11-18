import { Mail, FolderOpen, MessagesSquare, Settings2, UserCircle2, Home } from 'lucide-react';
import type { LauncherApp } from '@forge/ui';

export function launcherApps(isAdmin: boolean): LauncherApp[] {
  return [
    { id: 'home', name: 'Home', description: 'Your ForgeOffice portal', href: '/', icon: Home, color: 'bg-brand', available: true },
    { id: 'mail', name: 'Mail', description: 'Email, calendar and contacts', href: '/apps/mail', icon: Mail, color: 'bg-sky-600', available: false },
    { id: 'drive', name: 'Drive', description: 'Files, libraries and intranet sites', href: '/apps/drive', icon: FolderOpen, color: 'bg-emerald-600', available: false },
    { id: 'team', name: 'Team', description: 'Chat, channels and meetings', href: '/apps/team', icon: MessagesSquare, color: 'bg-violet-600', available: false },
    { id: 'account', name: 'Account', description: 'Profile and security', href: '/account', icon: UserCircle2, color: 'bg-zinc-600', available: true },
    ...(isAdmin ? [{ id: 'admin', name: 'Admin', description: 'Admin center', href: '/admin', icon: Settings2, color: 'bg-amber-600', available: true }] : []),
  ];
}

export const UPCOMING_APPS: Record<string, { name: string; phase: number; summary: string; features: string[] }> = {
  mail: {
    name: 'ForgeMail',
    phase: 2,
    summary: 'Email, calendars and contacts served from your own server.',
    features: ['SMTP & IMAP with DKIM, SPF and DMARC', 'Three-pane webmail with threading', 'CalDAV / CardDAV calendars and contacts', 'Global address list from your directory'],
  },
  drive: {
    name: 'ForgeDrive',
    phase: 3,
    summary: 'Files, document libraries and intranet sites on local storage.',
    features: ['Content-addressed storage with version history', 'Fine-grained sharing and external links', 'Intranet and wiki sites', 'Previews and in-browser Office editing'],
  },
  team: {
    name: 'ForgeTeam',
    phase: 4,
    summary: 'Chat, channels, presence and video meetings.',
    features: ['Teams, channels and direct messages', 'Audio, video and screen sharing', 'Presence synced with your calendar', 'Files stored in the team’s Drive library'],
  },
};
