import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generate } from 'selfsigned';

export interface TlsCredentials {
  key: string;
  cert: string;
  selfSigned: boolean;
}

/**
 * TLS key/certificate for SMTP and IMAP. Uses FORGE_TLS_CERT/FORGE_TLS_KEY or
 * `<certs>/tls/{fullchain,privkey}.pem`; otherwise creates a self-signed pair
 * (clients will warn until a real certificate is installed).
 */
export async function loadTlsCredentials(certsDir: string, hostname: string, env: NodeJS.ProcessEnv = process.env): Promise<TlsCredentials> {
  const certPath = env.FORGE_TLS_CERT ?? join(certsDir, 'tls', 'fullchain.pem');
  const keyPath = env.FORGE_TLS_KEY ?? join(certsDir, 'tls', 'privkey.pem');
  try {
    return { cert: await readFile(certPath, 'utf8'), key: await readFile(keyPath, 'utf8'), selfSigned: false };
  } catch {
    /* fall through to self-signed */
  }
  const selfDir = join(certsDir, 'tls', 'self-signed');
  try {
    return { cert: await readFile(join(selfDir, 'cert.pem'), 'utf8'), key: await readFile(join(selfDir, 'key.pem'), 'utf8'), selfSigned: true };
  } catch {
    const pems = await generate([{ name: 'commonName', value: hostname }], {
      keySize: 2048,
      notAfterDate: new Date(Date.now() + 5 * 365 * 86400_000),
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] }],
    } as Parameters<typeof generate>[1]);
    await mkdir(selfDir, { recursive: true, mode: 0o700 });
    await writeFile(join(selfDir, 'cert.pem'), pems.cert, { mode: 0o644 });
    await writeFile(join(selfDir, 'key.pem'), pems.private, { mode: 0o600 });
    return { cert: pems.cert, key: pems.private, selfSigned: true };
  }
}
