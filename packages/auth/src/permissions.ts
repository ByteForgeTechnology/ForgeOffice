/**
 * Permission catalogue. Permissions are coarse `resource:action` strings so
 * they can be stored on roles and checked cheaply on every request.
 */
export const PERMISSIONS = {
  'org:read': 'View organisation settings',
  'org:manage': 'Change organisation settings and branding',
  'domains:manage': 'Add, verify and remove domains',
  'users:read': 'View users',
  'users:manage': 'Create, edit, suspend and delete users',
  'users:credentials': 'Reset passwords and MFA for users',
  'groups:read': 'View groups and distribution lists',
  'groups:manage': 'Create, edit and delete groups and memberships',
  'roles:manage': 'Create roles and assign roles to users',
  'audit:read': 'View the audit log',
  'system:read': 'View service health, volumes and queues',
  'system:manage': 'Manage queues and trigger backups',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(PERMISSIONS, value);
}

export interface BuiltinRole {
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
}

export const GLOBAL_ADMIN = 'global_admin';

/** Roles seeded into every organisation. Built-in roles cannot be edited. */
export const BUILTIN_ROLES: BuiltinRole[] = [
  {
    key: GLOBAL_ADMIN,
    name: 'Global administrator',
    description: 'Full access to every administrative feature.',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'user_admin',
    name: 'User administrator',
    description: 'Manages users, groups and distribution lists.',
    permissions: ['org:read', 'users:read', 'users:manage', 'users:credentials', 'groups:read', 'groups:manage', 'audit:read'],
  },
  {
    key: 'helpdesk',
    name: 'Helpdesk',
    description: 'Resets passwords and MFA for non-administrators.',
    permissions: ['users:read', 'users:credentials', 'groups:read'],
  },
  {
    key: 'auditor',
    name: 'Auditor',
    description: 'Read-only access to settings, directory, audit log and system status.',
    permissions: ['org:read', 'users:read', 'groups:read', 'audit:read', 'system:read'],
  },
  {
    key: 'system_operator',
    name: 'System operator',
    description: 'Monitors services, manages queues and runs backups.',
    permissions: ['system:read', 'system:manage', 'audit:read'],
  },
];

/** Any permission that grants administrative capability (used to gate the admin UI). */
export function isAdministrator(perms: Iterable<string>): boolean {
  return [...perms].length > 0;
}

export function hasPermission(granted: ReadonlySet<string>, required: Permission | Permission[]): boolean {
  const list = Array.isArray(required) ? required : [required];
  return list.every((p) => granted.has(p));
}

/** Union the permission arrays of a set of roles. Unknown strings are dropped. */
export function resolvePermissions(roles: { permissions: string[] }[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const role of roles) for (const p of role.permissions) if (isPermission(p)) out.add(p);
  return out;
}

/**
 * Privilege-escalation guard: an actor may only grant a set of permissions it
 * already holds itself.
 */
export function canGrant(actor: ReadonlySet<string>, permissions: Iterable<string>): boolean {
  for (const p of permissions) if (!actor.has(p)) return false;
  return true;
}
