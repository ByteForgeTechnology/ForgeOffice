/**
 * ForgeOffice back-end services. Each runs in its own container from the same
 * image (FORGE_SERVICES=mail, …) and owns a set of routes; the gateway routes
 * requests to the right container. "all" runs everything in one process
 * (development, tests and small single-container installs).
 */
export const SERVICE_NAMES = ['directory', 'mail', 'calendar', 'contacts', 'tasks', 'drive', 'team', 'media'] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

/** Internal port of each service's container (also published on the host). */
export const SERVICE_PORTS: Record<ServiceName, number> = {
  directory: 8091,
  mail: 8092,
  calendar: 8093,
  contacts: 8094,
  tasks: 8095,
  drive: 8097,
  team: 8098,
  /** Meeting media server (SFU); no HTTP routes of its own besides health. */
  media: 8099,
};

export function parseServices(value: string | undefined): Set<ServiceName> {
  const names = (value ?? 'all').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!names.length || names.includes('all')) return new Set(SERVICE_NAMES);
  const unknown = names.filter((n) => !SERVICE_NAMES.includes(n as ServiceName));
  if (unknown.length) throw new Error(`Unknown FORGE_SERVICES value: ${unknown.join(', ')} (expected all or ${SERVICE_NAMES.join(', ')})`);
  return new Set(names as ServiceName[]);
}

export const runsAll = (s: Set<ServiceName>) => s.size === SERVICE_NAMES.length;
