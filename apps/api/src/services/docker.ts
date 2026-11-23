import { request } from 'node:http';

export interface ContainerInfo {
  id: string;
  name: string;
  service: string | null;
  image: string;
  state: string;
  status: string;
  health: 'healthy' | 'unhealthy' | 'starting' | null;
}

/**
 * Read-only query of the Docker Engine API over its unix socket, listing the
 * containers of this compose project. Only used when FORGE_DOCKER_SOCKET is
 * set (mount the socket read-only, ideally through a socket proxy).
 */
export function listComposeContainers(socketPath: string, project: string, timeoutMs = 2_000): Promise<ContainerInfo[]> {
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`] }));
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: `/containers/json?all=1&filters=${filters}`, method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Docker API responded ${res.statusCode}`));
        try {
          const raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            Id: string;
            Names: string[];
            Image: string;
            State: string;
            Status: string;
            Labels: Record<string, string>;
          }[];
          resolve(
            raw.map((c) => ({
              id: c.Id.slice(0, 12),
              name: c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12),
              service: c.Labels['com.docker.compose.service'] ?? null,
              image: c.Image,
              state: c.State,
              status: c.Status,
              health: /\(healthy\)/.test(c.Status) ? 'healthy' : /\(unhealthy\)/.test(c.Status) ? 'unhealthy' : /health: starting/.test(c.Status) ? 'starting' : null,
            })),
          );
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Docker API timed out')));
    req.on('error', reject);
    req.end();
  });
}
