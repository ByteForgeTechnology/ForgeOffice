import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTransport } from 'nodemailer';
import { decryptString, deriveKey } from '@forge/auth';
import { orm, organizations, type Organization } from '@forge/db';
import type { MailContext } from './context';

const { asc } = orm;

export type RelaySecurity = 'starttls' | 'tls' | 'none';

export interface RelaySettings {
  host: string;
  port: number;
  security: RelaySecurity;
  username: string | null;
  password: string | null;
}

/** Key for the stored relay password: derived from the master secret, so every service can read it. */
export const smarthostKey = (masterSecret: string) => deriveKey(masterSecret, 'smtp-relay-password');

let cachedSecret: Promise<string | null> | null = null;
/** The master secret: FORGE_SECRET, or the file the API creates in the certs volume. */
async function masterSecret(ctx: Pick<MailContext, 'config'>): Promise<string | null> {
  if (ctx.config.masterSecret) return ctx.config.masterSecret;
  cachedSecret ??= (async () => {
    if (process.env.FORGE_SECRET) return process.env.FORGE_SECRET;
    try {
      return (await readFile(join(ctx.config.certsDir, 'forge-secret'), 'utf8')).trim();
    } catch {
      return null;
    }
  })();
  return cachedSecret;
}

/** Nodemailer options for a smarthost. Certificates are always verified. */
export function relayTransportOptions(s: RelaySettings, hostname: string) {
  return {
    host: s.host,
    port: s.port,
    name: hostname,
    secure: s.security === 'tls',
    requireTLS: s.security === 'starttls',
    ignoreTLS: s.security === 'none',
    ...(s.username ? { auth: { user: s.username, pass: s.password ?? '' } } : {}),
    tls: { servername: s.host, minVersion: 'TLSv1.2' as const },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 120_000,
  };
}

const domainMatches = (domain: string, list: string[]) => list.some((d) => domain === d || domain.endsWith(`.${d}`));

/** The organisation's smarthost, if it is switched on (password decrypted). */
export async function configuredRelay(ctx: Pick<MailContext, 'db' | 'config'>, org?: Organization): Promise<(RelaySettings & { domains: string[] }) | null> {
  const o = org ?? (await ctx.db.select().from(organizations).orderBy(asc(organizations.createdAt)).limit(1))[0];
  if (!o?.smtpRelayEnabled || !o.smtpRelayHost) return null;
  let password: string | null = null;
  if (o.smtpRelayPasswordEnc) {
    const secret = await masterSecret(ctx);
    if (!secret) throw new Error('Cannot read the master secret to decrypt the smarthost password');
    password = decryptString(smarthostKey(secret), o.smtpRelayPasswordEnc);
  }
  return { host: o.smtpRelayHost, port: o.smtpRelayPort, security: o.smtpRelaySecurity, username: o.smtpRelayUsername, password, domains: o.smtpRelayDomains };
}

/**
 * How to reach a recipient domain: the admin-configured smarthost (when on
 * and the domain is in scope), else the FORGE_SMTP_RELAY environment relay,
 * else null for direct MX delivery.
 */
export async function relayFor(ctx: Pick<MailContext, 'db' | 'config'>, domain: string): Promise<{ via: 'smarthost'; options: ReturnType<typeof relayTransportOptions>; host: string } | { via: 'env'; url: string } | null> {
  const relay = await configuredRelay(ctx);
  if (relay && (!relay.domains.length || domainMatches(domain.toLowerCase(), relay.domains))) return { via: 'smarthost', options: relayTransportOptions(relay, ctx.config.hostname), host: relay.host };
  if (ctx.config.relayUrl) return { via: 'env', url: ctx.config.relayUrl };
  return null;
}

/**
 * Check a smarthost: connect, start TLS, log in, and optionally send a test
 * message. Returns a human-readable outcome either way.
 */
export async function testRelay(s: RelaySettings, hostname: string, test?: { from: string; to: string }): Promise<{ ok: boolean; message: string }> {
  const transport = createTransport(relayTransportOptions(s, hostname));
  try {
    await transport.verify();
    if (!test) return { ok: true, message: `Connected to ${s.host}:${s.port}${s.username ? ` and signed in as ${s.username}` : ''}.` };
    const info = (await transport.sendMail({
      from: test.from,
      to: test.to,
      subject: 'ForgeOffice smarthost test',
      text: `This message was sent through ${s.host}:${s.port} to check the outgoing relay configured in ForgeOffice.`,
    })) as { response: string };
    return { ok: true, message: `Test message accepted by ${s.host}: ${info.response}` };
  } catch (err) {
    const e = err as { code?: string; response?: string; message: string };
    const hint =
      e.code === 'EAUTH' ? 'The relay rejected the username or password.'
      : e.code === 'ESOCKET' || e.code === 'ECONNECTION' || e.code === 'ETIMEDOUT' ? 'Could not connect. Check the host, port and security setting, and that outbound connections are allowed.'
      : e.message?.includes('certificate') ? "The relay's TLS certificate could not be verified."
      : '';
    return { ok: false, message: [hint, e.response ?? e.message].filter(Boolean).join(' ') };
  } finally {
    transport.close();
  }
}

