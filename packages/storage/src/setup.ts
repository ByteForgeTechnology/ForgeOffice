import { join } from 'node:path';
import { BlobStore } from './blob-store';
import { ClusterKeyedStore, ClusterStore, ClusterUploadStore, combinedRegistry, redisRegistry, staticRegistry, type NodeRegistry, type RegistryRedis, type ReplicaIndex } from './cluster';
import { LocalKeyedStore, LocalUploadStore, type KeyedStore, type ObjectStore, type UploadStore } from './object-store';
import type { ForgeVolume, VolumeKey } from './volumes';

/**
 * How a service stores mail, Drive files and recordings:
 *   - FORGE_STORE_NODES set (one or more storage nodes, plus any that announce
 *     themselves in Redis): everything goes to the storage cluster;
 *   - only FORGE_MAIL_STORE_URL set (earlier single-store installs): mail goes
 *     to that store, Drive and recordings stay on this machine's volumes;
 *   - neither (development, tests, all-in-one): local volumes.
 */
export interface StorageSetup {
  mode: 'local' | 'cluster' | 'mail-store';
  mail: ObjectStore;
  drive: { blobs: ObjectStore; previews: KeyedStore; uploads: UploadStore };
  team: ObjectStore;
  /** The storage nodes (cluster modes). */
  registry: NodeRegistry | null;
  /** Per-namespace cluster stores (for repair, listing and backups). */
  cluster: Record<'mail' | 'drive' | 'team', ClusterStore> | null;
}

export interface StorageSetupOptions {
  env: NodeJS.ProcessEnv;
  volumes: Record<VolumeKey, ForgeVolume>;
  /** Service token for storage nodes (derived from the master secret). */
  token: string | null;
  redis?: RegistryRedis | null;
  index?: ReplicaIndex | null;
  log?: { warn: (o: unknown, m?: string) => void };
}

export const storageNodeUrls = (env: NodeJS.ProcessEnv) =>
  (env.FORGE_STORE_NODES ?? '')
    .split(/[\s,]+/)
    .map((u) => u.trim().replace(/\/+$/, ''))
    .filter(Boolean);

export async function setupStorage(o: StorageSetupOptions): Promise<StorageSetup> {
  const local = async (key: VolumeKey) => {
    const s = new BlobStore(join(o.volumes[key].path, 'blobs'));
    await s.init().catch(() => {});
    return s;
  };
  const urls = storageNodeUrls(o.env);
  const replicas = Number(o.env.FORGE_STORE_REPLICAS ?? 2);
  const registryFor = (list: string[]) => {
    if (!o.token) throw new Error('Storage nodes are configured but the master secret (FORGE_SECRET or forge_certs) is not available');
    return o.redis ? combinedRegistry(staticRegistry(list, o.token), redisRegistry(o.redis)) : staticRegistry(list, o.token);
  };

  if (urls.length || (o.env.FORGE_STORE_CLUSTER === 'true' && o.redis)) {
    const registry = registryFor(urls);
    const opts = { registry, token: o.token!, replicas, index: o.index ?? null, log: o.log };
    const cluster = { mail: new ClusterStore('mail', opts), drive: new ClusterStore('drive', opts), team: new ClusterStore('team', opts) };
    return {
      mode: 'cluster',
      mail: cluster.mail,
      drive: { blobs: cluster.drive, previews: new ClusterKeyedStore('drive', opts), uploads: new ClusterUploadStore('drive', cluster.drive, opts) },
      team: cluster.team,
      registry,
      cluster,
    };
  }

  const driveBlobs = await local('drive');
  const drive = { blobs: driveBlobs, previews: new LocalKeyedStore(join(o.volumes.drive.path, '.previews'), '.webp'), uploads: new LocalUploadStore(join(o.volumes.drive.path, '.uploads'), driveBlobs) };
  const team = await local('team');
  const mailUrl = o.env.FORGE_MAIL_STORE_URL?.replace(/\/+$/, '');
  if (mailUrl) {
    // One mail-store (earlier installs): a cluster of one, so mail still works through it.
    const registry = registryFor([mailUrl]);
    const mail = new ClusterStore('mail', { registry, token: o.token!, replicas: 1, index: o.index ?? null, log: o.log });
    return { mode: 'mail-store', mail, drive, team, registry, cluster: null };
  }
  return { mode: 'local', mail: await local('mail'), drive, team, registry: null, cluster: null };
}
