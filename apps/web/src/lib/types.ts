export type UserStatus = 'active' | 'suspended' | 'deleted';

export interface User {
  id: string;
  username: string;
  email: string;
  domainId: string;
  displayName: string;
  givenName: string | null;
  familyName: string | null;
  jobTitle: string | null;
  department: string | null;
  timezone: string | null;
  status: UserStatus;
  mustChangePassword: boolean;
  mfaRequired: boolean;
  mfaEnabled: boolean;
  recoveryCodesRemaining: number;
  quotaBytes: number | null;
  usedBytes: number;
  locked: boolean;
  lastLoginAt: string | null;
  passwordChangedAt: string | null;
  suspendedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  roles?: string[];
}

export interface Org {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  locale: string;
  defaultQuotaBytes: number;
  requireMfa: boolean;
  brandColor: string;
  hasLogo: boolean;
  setupCompletedAt: string | null;
}

export interface Me {
  user: User;
  org: Org | null;
  permissions: string[];
  groups: { id: string; name: string; type: GroupType }[];
  storage: { usedBytes: number; quotaBytes: number | null };
  mfaRequired: boolean;
}

export interface Branding {
  needsSetup: boolean;
  name: string;
  brandColor: string;
  logoUrl: string | null;
  timezone: string;
}

export type GroupType = 'security' | 'distribution';

export interface Group {
  id: string;
  name: string;
  description: string;
  type: GroupType;
  email: string | null;
  allowExternalSenders: boolean;
  createdAt: string;
  memberCount?: number;
}

export interface DirectoryCard {
  id: string;
  email: string;
  displayName: string;
  jobTitle: string | null;
  department: string | null;
}

export interface Domain {
  id: string;
  name: string;
  isPrimary: boolean;
  verified: boolean;
  verifiedAt: string | null;
  verificationRecord: { type: 'TXT'; host: string; value: string };
  createdAt: string;
  userCount?: number;
}

export interface Role {
  id: string;
  key: string;
  name: string;
  description: string;
  permissions: string[];
  builtin: boolean;
  userCount: number;
}

export interface AuditEntry {
  id: number;
  orgId: string | null;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  outcome: 'success' | 'failure';
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type ServiceState = 'up' | 'down' | 'degraded' | 'disabled';

export interface SystemOverview {
  generatedAt: string;
  version: string;
  startedAt: string;
  host: { loadavg: number[]; totalMemBytes: number; freeMemBytes: number };
  services: { key: string; name: string; state: ServiceState; latencyMs?: number; detail?: string; instances?: { instance: string; lastSeen: string }[] }[];
  volumes: {
    scannedAt: string | null;
    volumes: {
      key: string;
      volume: string;
      description: string;
      path: string;
      mounted: boolean;
      error?: string;
      disk: { totalBytes: number; freeBytes: number; availableBytes: number; usedBytes: number } | null;
      scanned: { bytes: number; files: number } | null;
    }[];
  };
  queues: QueueSummary[];
  containers: { enabled: boolean; error?: string; items: { id: string; name: string; service: string | null; image: string; state: string; status: string; health: string | null }[] };
}

export interface QueueSummary {
  name: string;
  label: string;
  phase: number;
  description: string;
  available: boolean;
  paused: boolean;
  error?: string;
  counts: Record<'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'prioritized', number> | null;
}

export interface QueueJob {
  id: string;
  name: string;
  data: unknown;
  attemptsMade: number;
  failedReason: string | null;
  stacktrace: string[];
  progress: unknown;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
  returnvalue: unknown;
}

export interface Backup {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  trigger: 'manual' | 'scheduled';
  requestedBy: string | null;
  name: string | null;
  sizeBytes: number | null;
  manifest: { artifacts: { name: string; kind: string; source: string; bytes: number; sha256: string }[] } | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface Enrollment {
  secret: string;
  uri: string;
  qr: string;
}
