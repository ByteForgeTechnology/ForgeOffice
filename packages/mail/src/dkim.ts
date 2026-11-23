import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dkimSign } from 'mailauth';
import { domains, orm, type Domain } from '@forge/db';
import type { MailContext } from './context';

const { eq } = orm;

const keyPath = (certsDir: string, domain: string, selector: string) => join(certsDir, 'dkim', `${domain}.${selector}.key`);

/** Create an RSA-2048 DKIM key for a domain if it does not have one yet. */
export async function ensureDkimKey(ctx: Pick<MailContext, 'db' | 'config'>, domain: Domain): Promise<string> {
  const path = keyPath(ctx.config.certsDir, domain.name, domain.dkimSelector);
  try {
    await readFile(path);
    if (domain.dkimPublicKey) return domain.dkimPublicKey;
  } catch {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await mkdir(join(ctx.config.certsDir, 'dkim'), { recursive: true, mode: 0o700 });
    await writeFile(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    await ctx.db.update(domains).set({ dkimPublicKey: pub }).where(eq(domains.id, domain.id));
    return pub;
  }
  // Key exists on disk but the DB lost the public half: derive it again.
  const { createPublicKey } = await import('node:crypto');
  const pub = createPublicKey(await readFile(path)).export({ type: 'spki', format: 'der' }).toString('base64');
  await ctx.db.update(domains).set({ dkimPublicKey: pub }).where(eq(domains.id, domain.id));
  return pub;
}

/** Prepend a DKIM-Signature for the From domain when we hold its key. */
export async function signMessage(ctx: Pick<MailContext, 'db' | 'config' | 'log'>, raw: Buffer, fromDomain: string): Promise<Buffer> {
  const [domain] = await ctx.db.select().from(domains).where(eq(domains.name, fromDomain.toLowerCase())).limit(1);
  if (!domain) return raw;
  let privateKey: Buffer;
  try {
    privateKey = await readFile(keyPath(ctx.config.certsDir, domain.name, domain.dkimSelector));
  } catch {
    return raw;
  }
  const result = await dkimSign(raw, { canonicalization: 'relaxed/relaxed', signatureData: [{ signingDomain: domain.name, selector: domain.dkimSelector, privateKey }] });
  if (result.errors?.length) ctx.log.warn({ errors: result.errors.map((e: { err?: Error }) => e.err?.message) }, 'DKIM signing failed');
  return result.signatures ? Buffer.concat([Buffer.from(result.signatures), raw]) : raw;
}

export function dkimDnsRecord(domain: Pick<Domain, 'name' | 'dkimSelector' | 'dkimPublicKey'>) {
  return { type: 'TXT', host: `${domain.dkimSelector}._domainkey.${domain.name}`, value: `v=DKIM1; k=rsa; p=${domain.dkimPublicKey ?? ''}` };
}
