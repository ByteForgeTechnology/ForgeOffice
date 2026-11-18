import type { Readable } from 'node:stream';
import { SMTPServer, type SMTPServerAddress, type SMTPServerAuthentication, type SMTPServerSession } from 'smtp-server';
import { orm, users } from '@forge/db';
import { normaliseAddress, parseAddressList, splitAddress } from '../addresses';
import type { MailContext } from '../context';
import { deliverInbound } from '../delivery';
import { headerValue, parseHeaderBlock } from '../mime';
import { submitMessage } from '../outbound';
import { authenticateProtocol } from '../protocol-auth';
import { isLocalDomain, resolveRecipient, sendableAddresses } from '../routing';
import { onBehalfAddresses } from '../shared';
import { TransportRejectedError } from '../transport';
import { userQuota } from '../store';

const { eq } = orm;

export interface SmtpServerOptions {
  ctx: MailContext;
  tls: { key: string; cert: string };
  allowInsecureAuth: boolean;
  maxMessageBytes: number;
}

class SmtpError extends Error {
  constructor(
    message: string,
    readonly responseCode: number,
  ) {
    super(message);
  }
}

function readStream(stream: Readable, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    stream.on('end', () => {
      if ((stream as Readable & { sizeExceeded?: boolean }).sizeExceeded || size > limit) reject(new SmtpError('Message exceeds the maximum size', 552));
      else resolve(Buffer.concat(chunks));
    });
    stream.on('error', reject);
  });
}

const common = (o: SmtpServerOptions) => ({
  name: o.ctx.config.hostname,
  banner: 'ForgeOffice ESMTP',
  key: o.tls.key,
  cert: o.tls.cert,
  size: o.maxMessageBytes,
  logger: false,
  disableReverseLookup: true,
  closeTimeout: 5_000,
});

/** Port 25: mail from the internet to local recipients only (no relaying). */
function inboundServer(o: SmtpServerOptions) {
  const { ctx } = o;
  return new SMTPServer({
    ...common(o),
    authOptional: true,
    disabledCommands: ['AUTH'],
    async onRcptTo(address: SMTPServerAddress, session: SMTPServerSession, cb: (err?: Error | null) => void) {
      try {
        const addr = normaliseAddress(address.address);
        if (!(await isLocalDomain(ctx, splitAddress(addr).domain))) return cb(new SmtpError('5.7.1 Relaying denied', 554));
        const route = await resolveRecipient(ctx, addr);
        if (!route) return cb(new SmtpError('5.1.1 No such user here', 550));
        if (route.kind === 'user') {
          const q = await userQuota(ctx, route.user.id);
          if (q.quota > 0 && q.used >= q.quota) return cb(new SmtpError('4.2.2 Mailbox full', 452));
        }
        if ((session.envelope.rcptTo?.length ?? 0) >= 100) return cb(new SmtpError('4.5.3 Too many recipients', 452));
        cb();
      } catch (err) {
        ctx.log.error({ err }, 'smtp rcpt check failed');
        cb(new SmtpError('4.3.0 Temporary failure', 451));
      }
    },
    async onData(stream: Readable, session: SMTPServerSession, cb: (err?: Error | null, message?: string) => void) {
      try {
        const raw = await readStream(stream, o.maxMessageBytes);
        const from = session.envelope.mailFrom ? session.envelope.mailFrom.address : '';
        const results = await deliverInbound(ctx, {
          raw,
          envelopeFrom: from,
          recipients: session.envelope.rcptTo.map((r) => r.address),
          remoteIp: session.remoteAddress,
          helo: session.hostNameAppearsAs,
        });
        if (results.every((r) => r.status === 'rejected')) return cb(new SmtpError(`5.1.1 ${results[0]?.reason ?? 'Rejected'}`, 550));
        cb(null, 'Message accepted');
      } catch (err) {
        if (err instanceof SmtpError) return cb(err);
        ctx.log.error({ err }, 'inbound delivery failed');
        cb(new SmtpError('4.3.0 Temporary failure, try again later', 451));
      }
    },
  });
}

/** Ports 587/465: authenticated submission from mail clients. */
function submissionServer(o: SmtpServerOptions, secure: boolean) {
  const { ctx } = o;
  return new SMTPServer({
    ...common(o),
    secure,
    authOptional: false,
    authMethods: ['PLAIN', 'LOGIN'],
    allowInsecureAuth: o.allowInsecureAuth,
    async onAuth(auth: SMTPServerAuthentication, session: SMTPServerSession, cb: (err: Error | null | undefined, response?: { user?: unknown }) => void) {
      const user = await authenticateProtocol(ctx, auth.username ?? '', auth.password ?? '', { protocol: 'smtp', ip: session.remoteAddress }).catch(() => null);
      if (!user) return cb(new SmtpError('5.7.8 Authentication failed. If two-step verification is on, use an app password.', 535));
      cb(null, { user: user.id });
    },
    async onMailFrom(address: SMTPServerAddress, session: SMTPServerSession, cb: (err?: Error | null) => void) {
      const userId = String(session.user);
      const allowed = [...(await sendableAddresses(ctx, userId)), ...(await onBehalfAddresses(ctx, userId))];
      if (!allowed.includes(normaliseAddress(address.address))) return cb(new SmtpError('5.7.1 You are not allowed to send as this address', 553));
      cb();
    },
    async onData(stream: Readable, session: SMTPServerSession, cb: (err?: Error | null, message?: string) => void) {
      try {
        const raw = await readStream(stream, o.maxMessageBytes);
        const userId = String(session.user);
        const end = raw.indexOf('\r\n\r\n');
        const fields = parseHeaderBlock(raw.subarray(0, end < 0 ? raw.length : end).toString('utf8'));
        const fromAddrs = parseAddressList(headerValue(fields, 'from'));
        const allowed = await sendableAddresses(ctx, userId);
        const onBehalf = await onBehalfAddresses(ctx, userId);
        // "Send on behalf" requires a Sender: header naming one of the user's own addresses.
        const senderAddr = parseAddressList(headerValue(fields, 'sender'))[0]?.address;
        const senderOk = !!senderAddr && allowed.includes(normaliseAddress(senderAddr)) && !onBehalf.includes(normaliseAddress(senderAddr));
        const permitted = (a: string) => allowed.includes(a) || (onBehalf.includes(a) && senderOk);
        if (!fromAddrs.length || fromAddrs.some((a) => !permitted(normaliseAddress(a.address)))) {
          return cb(new SmtpError('5.7.1 The From address must be one of your own addresses', 550));
        }
        const [user] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
        if (!user) return cb(new SmtpError('5.7.1 Account no longer active', 550));
        // Mail clients store their own copy in Sent via IMAP APPEND.
        const out = await submitMessage(ctx, {
          userId,
          raw,
          envelopeFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          recipients: session.envelope.rcptTo.map((r) => r.address),
          source: 'smtp',
        });
        cb(null, `Queued as ${out.id}`);
      } catch (err) {
        if (err instanceof SmtpError) return cb(err);
        if (err instanceof TransportRejectedError) return cb(new SmtpError(`5.7.1 ${err.message}`, 550));
        ctx.log.error({ err }, 'submission failed');
        cb(new SmtpError('4.3.0 Temporary failure, try again later', 451));
      }
    },
  });
}

export interface SmtpPorts {
  smtp?: number;
  submission?: number;
  submissions?: number;
  host?: string;
}

export async function startSmtpServers(o: SmtpServerOptions, ports: SmtpPorts) {
  const servers: SMTPServer[] = [];
  const bound: Record<string, number> = {};
  const listen = (server: SMTPServer, port: number, name: string) =>
    new Promise<void>((resolve, reject) => {
      server.on('error', (err: Error) => o.ctx.log.warn({ err: err.message, server: name }, 'smtp server error'));
      server.server.once('error', reject);
      server.listen(port, ports.host ?? '0.0.0.0', () => {
        bound[name] = (server.server.address() as { port: number }).port;
        resolve();
      });
    });
  if (ports.smtp !== undefined) {
    const s = inboundServer(o);
    await listen(s, ports.smtp, 'smtp');
    servers.push(s);
  }
  if (ports.submission !== undefined) {
    const s = submissionServer(o, false);
    await listen(s, ports.submission, 'submission');
    servers.push(s);
  }
  if (ports.submissions !== undefined) {
    const s = submissionServer(o, true);
    await listen(s, ports.submissions, 'submissions');
    servers.push(s);
  }
  return {
    ports: bound,
    close: () => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))).then(() => undefined),
  };
}
