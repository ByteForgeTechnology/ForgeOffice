import type { EventEmitter } from 'node:events';
import type { Database, DatabaseHandle } from '@forge/db';
import type { TokenVerifier } from '@forge/auth';
import type { EventBus, QueueName, Redis, TypedQueue } from '@forge/events';
import type { ObjectStore } from '@forge/storage';
import type { MailContext } from '@forge/mail';
import type { DriveContext } from '@forge/drive';
import type { MediaClient, PresenceStore } from '@forge/team';
import type { AppConfig } from './config';
import type { DerivedKeys } from './secrets';
import type { SigningKeys } from './oidc/keys';
import type { AuditService } from './services/audit';

export type Queues = { [Q in QueueName]: TypedQueue<Q> };

export interface AppContext {
  config: AppConfig;
  dbHandle: DatabaseHandle;
  db: Database;
  keys: DerivedKeys;
  signing: SigningKeys;
  /** Required to run the setup wizard; null once setup has completed. */
  setupToken: string | null;
  /** Blob store for org assets (logos, avatars) inside forge_drive_data. */
  /** Organisation pictures (logo, signature images, avatars): the Drive blob store. */
  assets: ObjectStore;
  redis: Redis | null;
  bus: EventBus | null;
  queues: Queues | null;
  /** In-process event fan-out (always available; mirrors bus events). */
  events: EventEmitter;
  audit: AuditService;
  verifyAccessToken: TokenVerifier;
  /** Mail engine (stores, delivery, scheduling). */
  mail: MailContext;
  /** ForgeDrive engine (libraries, files, versions on forge_drive_data). */
  drive: DriveContext;
  team: TeamServices;
  /** How files are stored: this machine's volumes, or the storage nodes. */
  storage: import('@forge/storage').StorageSetup;
}

/** Live updates for ForgeTeam: the team service's Socket.IO server plugs in here when it starts. */
export interface TeamHub {
  toUsers(userIds: string[], event: string, payload: unknown): void;
  toRoom(room: string, event: string, payload: unknown): void;
}

export interface TeamServices {
  presence: PresenceStore;
  /** Meetings: signalling to the media node hosting each one (this process, or media servers). */
  media: MediaClient;
  /** Meeting recordings (team storage namespace). */
  recordings: import('@forge/storage').ObjectStore;
  hub: TeamHub;
}
