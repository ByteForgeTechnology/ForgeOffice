import type { EventEmitter } from 'node:events';
import type { Database, DatabaseHandle } from '@forge/db';
import type { TokenVerifier } from '@forge/auth';
import type { EventBus, QueueName, Redis, TypedQueue } from '@forge/events';
import type { BlobStore } from '@forge/storage';
import type { MailContext } from '@forge/mail';
import type { DriveContext } from '@forge/drive';
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
  assets: BlobStore;
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
}
