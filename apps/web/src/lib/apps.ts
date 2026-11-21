import { Calendar, FolderOpen, Newspaper, Home, ListTodo, Mail, MessagesSquare, Settings2, UserCircle2, Users } from 'lucide-react';
import type { LauncherApp } from '@forge/ui';
import type { Feature, FeatureFlags } from './types';

/** Launcher entries; apps whose product is switched off are left out. */
export function launcherApps(isAdmin: boolean, features: FeatureFlags = { mail: true, calendar: true, contacts: true, tasks: true, drive: true }): LauncherApp[] {
  const needs: Record<string, Feature> = { mail: 'mail', calendar: 'calendar', people: 'contacts', tasks: 'tasks', drive: 'drive', sites: 'drive' };
  return ([
    { id: 'home', name: 'Home', description: 'Your ForgeOffice portal', href: '/', icon: Home, color: 'bg-brand', available: true },
    { id: 'mail', name: 'Mail', description: 'Email with conversations and rules', href: '/mail', icon: Mail, color: 'bg-sky-600', available: true },
    { id: 'calendar', name: 'Calendar', description: 'Meetings, rooms and schedules', href: '/calendar', icon: Calendar, color: 'bg-indigo-600', available: true },
    { id: 'tasks', name: 'Tasks', description: 'To-dos and flagged email', href: '/tasks', icon: ListTodo, color: 'bg-blue-600', available: true },
    { id: 'people', name: 'People', description: 'Contacts and the organisation directory', href: '/contacts', icon: Users, color: 'bg-teal-600', available: true },
    { id: 'drive', name: 'Drive', description: 'Files, folders and shared libraries', href: '/drive', icon: FolderOpen, color: 'bg-emerald-600', available: true },
    { id: 'sites', name: 'Sites', description: 'Intranet sites, wikis and news', href: '/sites', icon: Newspaper, color: 'bg-cyan-700', available: true },
    { id: 'team', name: 'Team', description: 'Chat, channels and meetings', href: '/apps/team', icon: MessagesSquare, color: 'bg-violet-600', available: false },
    { id: 'account', name: 'Account', description: 'Profile and security', href: '/account', icon: UserCircle2, color: 'bg-zinc-600', available: true },
    ...(isAdmin ? [{ id: 'admin', name: 'Admin', description: 'Admin center', href: '/admin', icon: Settings2, color: 'bg-amber-600', available: true }] : []),
  ] as LauncherApp[]).filter((a) => !needs[a.id] || features[needs[a.id]!]);
}

export const UPCOMING_APPS: Record<string, { name: string; phase: number; summary: string; features: string[] }> = {
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
