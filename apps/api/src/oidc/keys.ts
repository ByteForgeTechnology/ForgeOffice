import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from 'jose';

export interface SigningKeys {
  /** Private JWKS handed to oidc-provider. */
  privateJwks: { keys: JWK[] };
  /** Public JWKS for local access-token verification. */
  publicJwks: { keys: JWK[] };
}

async function generate(alg: 'ES256' | 'RS256'): Promise<JWK> {
  const { privateKey } = await generateKeyPair(alg, { extractable: true, ...(alg === 'RS256' ? { modulusLength: 3072 } : {}) });
  const jwk = await exportJWK(privateKey);
  jwk.alg = alg;
  jwk.use = 'sig';
  jwk.kid = await calculateJwkThumbprint(jwk);
  return jwk;
}

function toPublic(jwk: JWK): JWK {
  const { d, p, q, dp, dq, qi, ...pub } = jwk;
  void d, p, q, dp, dq, qi;
  return pub;
}

/**
 * Load the OIDC signing keys from `<certs>/oidc/jwks.json`, generating an
 * ES256 (default) and RS256 (compatibility) key on first boot. Keeping keys
 * in forge_certs means tokens survive restarts and are covered by backups.
 */
export async function loadSigningKeys(certsDir: string): Promise<SigningKeys> {
  const dir = join(certsDir, 'oidc');
  const file = join(dir, 'jwks.json');
  let keys: JWK[];
  try {
    keys = (JSON.parse(await readFile(file, 'utf8')) as { keys: JWK[] }).keys;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    keys = [await generate('ES256'), await generate('RS256')];
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await writeFile(file, JSON.stringify({ keys }, null, 2), { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      keys = (JSON.parse(await readFile(file, 'utf8')) as { keys: JWK[] }).keys;
    }
  }
  return { privateJwks: { keys }, publicJwks: { keys: keys.map(toPublic) } };
}
