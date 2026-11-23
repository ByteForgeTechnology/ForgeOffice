import net from 'node:net';
import { featureEnabled } from '@forge/db';
import tls from 'node:tls';
import { mailboxes, messages, orm, type Mailbox, type Message, type User } from '@forge/db';
import type { MailContext } from '../context';
import { onMailChanged } from '../context';
import { bodyStructure, envelopeFromHeaders, istr } from '../imap-format';
import { findPart, headerBlock, parseHeaderBlock } from '../mime';
import { authenticateProtocol } from '../protocol-auth';
import {
  appendMessage,
  copyMessages,
  createMailbox,
  deleteMailbox,
  ensureMailboxes,
  expungeMessages,
  moveMessages,
  QuotaExceededError,
  readRaw,
  renameMailbox,
  setFlags,
} from '../store';
import { decodeMutf7, encodeMutf7 } from './mutf7';
import { accessibleMailboxes, canDelete, canManage, canWrite, folderScope, sharedFolderOwners, type MailAccess, type MailboxGrant } from '../shared';

const { and, asc, eq, inArray } = orm;

export interface ImapServerOptions {
  ctx: MailContext;
  tls: { key: string; cert: string };
  /** Allow LOGIN/AUTHENTICATE without TLS (development only). */
  allowInsecureAuth: boolean;
  idleTimeoutMs?: number;
}

const CAPABILITIES = 'IMAP4rev1 LITERAL+ SASL-IR ID IDLE NAMESPACE UIDPLUS MOVE UNSELECT SPECIAL-USE ENABLE CHILDREN LIST-EXTENDED';
const SYSTEM_FLAGS = ['\\Answered', '\\Flagged', '\\Deleted', '\\Seen', '\\Draft'];
const MAX_LINE = 64 * 1024;
const MAX_LITERAL = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Command tokenizer
// ---------------------------------------------------------------------------

type Token = { atom: string } | { string: Buffer } | Token[];

class ParseError extends Error {}

const isAtom = (t: Token | undefined): t is { atom: string } => !!t && !Array.isArray(t) && 'atom' in t;
const isString = (t: Token | undefined): t is { string: Buffer } => !!t && !Array.isArray(t) && 'string' in t;

function tokenText(t: Token | undefined): string {
  if (isAtom(t)) return t.atom;
  if (isString(t)) return t.string.toString('utf8');
  throw new ParseError('Expected string');
}

/** Tokenise a full command (line text with \0L<n>\0 literal placeholders). */
function tokenize(text: string, literals: Buffer[]): Token[] {
  let pos = 0;
  const parseItems = (close: boolean): Token[] => {
    const items: Token[] = [];
    for (;;) {
      while (text[pos] === ' ') pos++;
      if (pos >= text.length) {
        if (close) throw new ParseError('Unbalanced parentheses');
        return items;
      }
      const c = text[pos]!;
      if (c === ')') {
        if (!close) throw new ParseError('Unexpected )');
        pos++;
        return items;
      }
      if (c === '(') {
        pos++;
        items.push(parseItems(true));
      } else if (c === '"') {
        pos++;
        let s = '';
        while (pos < text.length && text[pos] !== '"') {
          if (text[pos] === '\\') pos++;
          s += text[pos++];
        }
        if (text[pos] !== '"') throw new ParseError('Unterminated string');
        pos++;
        items.push({ string: Buffer.from(s, 'utf8') });
      } else if (c === '\0') {
        const end = text.indexOf('\0', pos + 1);
        items.push({ string: literals[Number(text.slice(pos + 2, end))]! });
        pos = end + 1;
      } else {
        let depth = 0;
        const start = pos;
        while (pos < text.length) {
          const ch = text[pos]!;
          if (ch === '[') depth++;
          else if (ch === ']') depth--;
          else if (depth === 0 && (ch === ' ' || ch === '(' || ch === ')')) break;
          pos++;
        }
        items.push({ atom: text.slice(start, pos) });
      }
    }
  };
  return parseItems(false);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagList(m: Pick<Message, 'seen' | 'flagged' | 'answered' | 'draft' | 'deleted' | 'keywords'>): string[] {
  const f: string[] = [];
  if (m.answered) f.push('\\Answered');
  if (m.flagged) f.push('\\Flagged');
  if (m.deleted) f.push('\\Deleted');
  if (m.seen) f.push('\\Seen');
  if (m.draft) f.push('\\Draft');
  return [...f, ...m.keywords];
}

const flagKey = (m: Parameters<typeof flagList>[0]) => flagList(m).join(' ');

function imapDate(d: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

function parseImapDate(s: string): Date | null {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4}))?\s*$/.exec(s);
  if (!m) return null;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2]!.toLowerCase());
  if (month < 0) return null;
  if (!m[4]) return new Date(Date.UTC(Number(m[3]), month, Number(m[1])));
  const tz = m[7]!;
  const offset = (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3)));
  return new Date(Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - offset * 60_000);
}

/** Resolve an IMAP sequence set against an ordered list of numbers (seqs 1..n or uids). */
function resolveSet(set: string, max: number, values: number[]): number[] {
  const wanted = new Set<number>();
  for (const part of set.split(',')) {
    const [a, b] = part.split(':');
    const lo = a === '*' ? max : Number(a);
    const hi = b === undefined ? lo : b === '*' ? max : Number(b);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new ParseError('Invalid sequence set');
    const [from, to] = lo <= hi ? [lo, hi] : [hi, lo];
    for (const v of values) if (v >= from && v <= to) wanted.add(v);
  }
  return values.filter((v) => wanted.has(v));
}

function compressSet(nums: number[]): string {
  const sorted = [...nums].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]!;
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i]! + 1) i++;
    out.push(start === sorted[i] ? String(start) : `${start}:${sorted[i]}`);
  }
  return out.join(',');
}

function patternToRegex(pattern: string): RegExp {
  const re = pattern
    .split('')
    .map((ch) => (ch === '*' ? '.*' : ch === '%' ? '[^/]*' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${re}$`, 'i');
}

interface FetchItem {
  name: string;
  section?: string;
  partial?: { start: number; length: number };
  peek?: boolean;
}

function parseFetchItems(tokens: Token[]): FetchItem[] {
  const raw: string[] = [];
  const first = tokens[0];
  if (Array.isArray(first)) for (const t of first) raw.push(tokenText(t));
  else raw.push(tokenText(first));
  const items: FetchItem[] = [];
  for (const r of raw) {
    const up = r.toUpperCase();
    if (up === 'ALL') items.push({ name: 'FLAGS' }, { name: 'INTERNALDATE' }, { name: 'RFC822.SIZE' }, { name: 'ENVELOPE' });
    else if (up === 'FAST') items.push({ name: 'FLAGS' }, { name: 'INTERNALDATE' }, { name: 'RFC822.SIZE' });
    else if (up === 'FULL') items.push({ name: 'FLAGS' }, { name: 'INTERNALDATE' }, { name: 'RFC822.SIZE' }, { name: 'ENVELOPE' }, { name: 'BODY' });
    else {
      const m = /^(BODY(?:\.PEEK)?|BINARY(?:\.PEEK)?)\[([^\]]*)\](?:<(\d+)(?:\.(\d+))?>)?$/i.exec(r);
      if (m) {
        items.push({
          name: 'BODY[]',
          section: m[2]!,
          peek: /\.PEEK/i.test(m[1]!),
          partial: m[3] !== undefined ? { start: Number(m[3]), length: m[4] !== undefined ? Number(m[4]) : Infinity } : undefined,
        });
      } else items.push({ name: up });
    }
  }
  return items;
}

/** Extract a section of a message per RFC 3501 §6.4.5. */
function extractSection(raw: Buffer, tree: Message['mimeTree'], section: string): Buffer {
  const m = /^((?:\d+\.)*\d+)?\.?(.*)$/.exec(section.trim())!;
  const parts = m[1] ? m[1].split('.').map(Number) : [];
  const spec = (m[2] ?? '').trim();
  const specUp = spec.toUpperCase();
  let node = parts.length ? findPart(tree, parts) : tree;
  if (!node) return Buffer.alloc(0);
  if (parts.length && specUp === 'MIME') return raw.subarray(node.headerStart, node.bodyStart);
  if (parts.length && !specUp) return raw.subarray(node.bodyStart, node.bodyEnd);
  if (parts.length && specUp) {
    // HEADER/TEXT of an embedded message part.
    if (!(node.type === 'message' && node.subtype === 'rfc822' && node.message)) return Buffer.alloc(0);
    node = node.message;
  }
  if (!specUp) return raw.subarray(node.headerStart, node.bodyEnd);
  if (specUp === 'TEXT') return raw.subarray(node.bodyStart, node.bodyEnd);
  if (specUp === 'HEADER') return raw.subarray(node.headerStart, node.bodyStart);
  const fm = /^HEADER\.FIELDS(\.NOT)?\s*\((.*)\)$/i.exec(spec);
  if (fm) {
    const names = fm[2]!
      .split(/\s+/)
      .filter(Boolean)
      .map((n) => n.replace(/^"|"$/g, '').toLowerCase());
    const fields = parseHeaderBlock(raw.subarray(node.headerStart, node.bodyStart).toString('utf8'));
    const keep = fields.filter((f) => (fm[1] ? !names.includes(f.key) : names.includes(f.key)));
    return Buffer.from(keep.map((f) => f.raw).join('') + '\r\n');
  }
  return Buffer.alloc(0);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** A mailbox folder resolved to its owner and the session user's rights on it. */
type Resolved = Mailbox & { ownerId: string; access: MailAccess; prefix: string };

const SHARED_ROOT = 'Shared';

interface Selected {
  mailbox: Resolved;
  ownerId: string;
  readOnly: boolean;
  uids: number[];
  flags: Map<number, string>;
  modseq: number;
}

type MessageRow = Omit<Message, 'mimeTree' | 'bodyText' | 'searchVector'>;

class ImapSession {
  private socket: net.Socket | tls.TLSSocket;
  private buffer: Buffer = Buffer.alloc(0);
  private segments: string[] = [];
  private literals: Buffer[] = [];
  private literalRemaining = 0;
  private literalChunks: Buffer[] = [];
  private queue: Promise<void> = Promise.resolve();
  private user: User | null = null;
  private selected: Selected | null = null;
  private grants: MailboxGrant[] = [];
  private continuation: ((line: string) => Promise<void>) | null = null;
  private idleTag: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    socket: net.Socket | tls.TLSSocket,
    private readonly opts: ImapServerOptions,
    private secure: boolean,
  ) {
    this.socket = socket;
    this.attach(socket);
    this.send(`* OK [CAPABILITY ${this.capabilities()}] ForgeOffice IMAP ready`);
    this.touch();
  }

  private get ctx() {
    return this.opts.ctx;
  }

  private attach(socket: net.Socket | tls.TLSSocket) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
  }

  private capabilities() {
    const caps = [CAPABILITIES];
    if (!this.secure) caps.push('STARTTLS');
    if (!this.secure && !this.opts.allowInsecureAuth) caps.push('LOGINDISABLED');
    else caps.push('AUTH=PLAIN');
    return caps.join(' ');
  }

  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.send('* BYE Autologout; idle for too long');
      this.socket.end();
    }, this.opts.idleTimeoutMs ?? 30 * 60_000);
    this.idleTimer.unref();
  }

  send(line: string | Buffer[]) {
    if (this.closed) return;
    if (typeof line === 'string') this.socket.write(line + '\r\n');
    else {
      this.socket.write(Buffer.concat([...line, Buffer.from('\r\n')]));
    }
  }

  private close() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.socket.destroy();
  }

  private onData(chunk: Buffer) {
    this.touch();
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (!this.closed) {
      if (this.literalRemaining > 0) {
        const take = Math.min(this.literalRemaining, this.buffer.length);
        if (!take) return;
        this.literalChunks.push(this.buffer.subarray(0, take));
        this.buffer = this.buffer.subarray(take);
        this.literalRemaining -= take;
        if (this.literalRemaining > 0) return;
        this.literals.push(Buffer.concat(this.literalChunks));
        this.literalChunks = [];
        this.segments.push(`\0L${this.literals.length - 1}\0`);
        continue;
      }
      const idx = this.buffer.indexOf('\r\n');
      if (idx < 0) {
        if (this.buffer.length > MAX_LINE) {
          this.send('* BAD Line too long');
          this.close();
        }
        return;
      }
      const line = this.buffer.subarray(0, idx).toString('utf8');
      this.buffer = this.buffer.subarray(idx + 2);
      const lit = /\{(\d+)(\+)?\}$/.exec(line);
      if (lit && !this.continuation && this.idleTag === null) {
        const size = Number(lit[1]);
        if (size > MAX_LITERAL) {
          this.send('* BAD Literal too large');
          this.close();
          return;
        }
        this.segments.push(line.slice(0, lit.index));
        this.literalRemaining = size;
        if (!lit[2]) this.send('+ Ready for literal data');
        if (size === 0) {
          this.literals.push(Buffer.alloc(0));
          this.segments.push(`\0L${this.literals.length - 1}\0`);
        }
        continue;
      }
      this.segments.push(line);
      const text = this.segments.join('');
      const literals = this.literals;
      this.segments = [];
      this.literals = [];
      this.enqueue(text, literals);
    }
  }

  private enqueue(text: string, literals: Buffer[]) {
    // IDLE termination and SASL continuations bypass the command queue.
    if (this.idleTag !== null) {
      if (text.trim().toUpperCase() === 'DONE') {
        const tag = this.idleTag;
        this.idleTag = null;
        this.queue = this.queue.then(async () => {
          this.unsubscribe?.();
          this.unsubscribe = null;
          this.send(`${tag} OK IDLE terminated`);
        });
      } else this.send('* BAD Expected DONE');
      return;
    }
    if (this.continuation) {
      const handler = this.continuation;
      this.continuation = null;
      this.queue = this.queue.then(() => handler(text)).catch(() => {});
      return;
    }
    this.queue = this.queue.then(() => this.handle(text, literals)).catch((err) => {
      this.ctx.log.error({ err }, 'imap command failed');
    });
  }

  private async handle(text: string, literals: Buffer[]) {
    let tokens: Token[];
    try {
      tokens = tokenize(text, literals);
    } catch {
      this.send('* BAD Could not parse command');
      return;
    }
    const tag = isAtom(tokens[0]) ? tokens[0].atom : '*';
    const cmdTok = tokens[1];
    if (!isAtom(cmdTok)) {
      this.send(`${tag} BAD Missing command`);
      return;
    }
    let cmd = cmdTok.atom.toUpperCase();
    let args = tokens.slice(2);
    let uid = false;
    if (cmd === 'UID') {
      uid = true;
      cmd = tokenText(args[0]).toUpperCase();
      args = args.slice(1);
    }
    try {
      await this.dispatch(tag, cmd, args, uid);
    } catch (err) {
      if (err instanceof ParseError) this.send(`${tag} BAD ${err.message}`);
      else if (err instanceof QuotaExceededError) this.send(`${tag} NO [OVERQUOTA] Mailbox is full`);
      else {
        this.ctx.log.error({ err, cmd }, 'imap command error');
        this.send(`${tag} NO Server error`);
      }
    }
  }

  private requireAuth(tag: string): boolean {
    if (!this.user) {
      this.send(`${tag} NO Not authenticated`);
      return false;
    }
    return true;
  }

  private requireSelected(tag: string): boolean {
    if (!this.requireAuth(tag)) return false;
    if (!this.selected) {
      this.send(`${tag} BAD No mailbox selected`);
      return false;
    }
    return true;
  }

  private async dispatch(tag: string, cmd: string, args: Token[], uid: boolean) {
    switch (cmd) {
      case 'CAPABILITY':
        this.send(`* CAPABILITY ${this.capabilities()}`);
        return this.send(`${tag} OK CAPABILITY completed`);
      case 'NOOP':
      case 'CHECK':
        if (this.selected) await this.sync(true);
        return this.send(`${tag} OK ${cmd} completed`);
      case 'LOGOUT':
        this.send('* BYE ForgeOffice IMAP logging out');
        this.send(`${tag} OK LOGOUT completed`);
        this.socket.end();
        return;
      case 'ID':
        this.send('* ID ("name" "ForgeOffice" "vendor" "ForgeOffice")');
        return this.send(`${tag} OK ID completed`);
      case 'STARTTLS':
        return this.startTls(tag);
      case 'LOGIN':
        return this.login(tag, tokenText(args[0]), tokenText(args[1]));
      case 'AUTHENTICATE':
        return this.authenticate(tag, args);
      case 'ENABLE':
        if (!this.requireAuth(tag)) return;
        this.send('* ENABLED');
        return this.send(`${tag} OK ENABLE completed`);
      case 'NAMESPACE':
        if (!this.requireAuth(tag)) return;
        this.send(`* NAMESPACE (("" "/")) NIL (("${SHARED_ROOT}/" "/"))`);
        return this.send(`${tag} OK NAMESPACE completed`);
      case 'LIST':
      case 'LSUB':
        if (!this.requireAuth(tag)) return;
        return this.list(tag, cmd, args);
      case 'SELECT':
      case 'EXAMINE':
        if (!this.requireAuth(tag)) return;
        return this.select(tag, decodeMutf7(tokenText(args[0])), cmd === 'EXAMINE');
      case 'CREATE':
        if (!this.requireAuth(tag)) return;
        {
          const target = await this.resolveParent(decodeMutf7(tokenText(args[0])));
          if (!target) return this.send(`${tag} NO [NOPERM] You cannot create folders there`);
          await createMailbox(this.ctx, target.ownerId, target.path).catch((e: Error) => {
            throw new ParseError(e.message.includes('duplicate') || e.message.includes('unique') ? 'Mailbox already exists' : e.message);
          });
        }
        return this.send(`${tag} OK CREATE completed`);
      case 'DELETE': {
        if (!this.requireAuth(tag)) return;
        const box = await this.findMailbox(decodeMutf7(tokenText(args[0])));
        if (!box) return this.send(`${tag} NO [NONEXISTENT] No such mailbox`);
        if (!canManage(box.access)) return this.send(`${tag} NO [NOPERM] You cannot delete this folder`);
        try {
          await deleteMailbox(this.ctx, box.ownerId, box.id);
        } catch (e) {
          return this.send(`${tag} NO ${(e as Error).message}`);
        }
        return this.send(`${tag} OK DELETE completed`);
      }
      case 'RENAME': {
        if (!this.requireAuth(tag)) return;
        const box = await this.findMailbox(decodeMutf7(tokenText(args[0])));
        if (!box) return this.send(`${tag} NO [NONEXISTENT] No such mailbox`);
        const newName = decodeMutf7(tokenText(args[1]));
        if (!canManage(box.access) || (box.prefix && !newName.startsWith(box.prefix)) || (!box.prefix && newName.startsWith(`${SHARED_ROOT}/`))) {
          return this.send(`${tag} NO [NOPERM] Folders can only be renamed within the same mailbox`);
        }
        try {
          await renameMailbox(this.ctx, box.ownerId, box.id, newName.slice(box.prefix.length));
        } catch (e) {
          return this.send(`${tag} NO ${(e as Error).message}`);
        }
        return this.send(`${tag} OK RENAME completed`);
      }
      case 'SUBSCRIBE':
      case 'UNSUBSCRIBE': {
        if (!this.requireAuth(tag)) return;
        const box = await this.findMailbox(decodeMutf7(tokenText(args[0])));
        if (box && box.access === 'owner') await this.ctx.db.update(mailboxes).set({ subscribed: cmd === 'SUBSCRIBE' }).where(eq(mailboxes.id, box.id));
        return this.send(`${tag} OK ${cmd} completed`);
      }
      case 'STATUS':
        if (!this.requireAuth(tag)) return;
        return this.status(tag, args);
      case 'APPEND':
        if (!this.requireAuth(tag)) return;
        return this.append(tag, args);
      case 'IDLE':
        if (!this.requireAuth(tag)) return;
        return this.idle(tag);
      case 'CLOSE':
      case 'UNSELECT':
        if (!this.requireSelected(tag)) return;
        if (cmd === 'CLOSE' && !this.selected!.readOnly && canDelete(this.selected!.mailbox.access)) {
          const doomed = await this.ctx.db
            .select({ id: messages.id })
            .from(messages)
            .where(and(eq(messages.mailboxId, this.selected!.mailbox.id), eq(messages.deleted, true)));
          await expungeMessages(this.ctx, this.selected!.ownerId, doomed.map((d) => d.id));
        }
        this.selected = null;
        return this.send(`${tag} OK ${cmd} completed`);
      case 'EXPUNGE':
        if (!this.requireSelected(tag)) return;
        return this.expunge(tag, uid ? tokenText(args[0]) : null);
      case 'FETCH':
        if (!this.requireSelected(tag)) return;
        return this.fetch(tag, tokenText(args[0]), args.slice(1), uid);
      case 'STORE':
        if (!this.requireSelected(tag)) return;
        return this.store(tag, tokenText(args[0]), tokenText(args[1]), args.slice(2), uid);
      case 'SEARCH':
        if (!this.requireSelected(tag)) return;
        return this.search(tag, args, uid);
      case 'COPY':
      case 'MOVE':
        if (!this.requireSelected(tag)) return;
        return this.copyMove(tag, cmd, tokenText(args[0]), decodeMutf7(tokenText(args[1])), uid);
      default:
        return this.send(`${tag} BAD Unknown command ${cmd}`);
    }
  }

  // --- authentication -------------------------------------------------------

  private startTls(tag: string) {
    if (this.secure) return this.send(`${tag} BAD Already using TLS`);
    this.send(`${tag} OK Begin TLS negotiation now`);
    const plain = this.socket;
    plain.removeAllListeners('data');
    const secureSocket = new tls.TLSSocket(plain, { isServer: true, secureContext: tls.createSecureContext(this.opts.tls) });
    this.socket = secureSocket;
    this.secure = true;
    this.buffer = Buffer.alloc(0);
    this.attach(secureSocket);
  }

  private async login(tag: string, username: string, password: string) {
    if (!this.secure && !this.opts.allowInsecureAuth) return this.send(`${tag} NO [PRIVACYREQUIRED] Use STARTTLS first`);
    const user = await authenticateProtocol(this.ctx, username, password, { protocol: 'imap', ip: this.socket.remoteAddress });
    if (!user) {
      await new Promise((r) => setTimeout(r, 1000));
      return this.send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials. If two-step verification is on, use an app password.`);
    }
    if (!(await featureEnabled(this.ctx.db, 'mail'))) return this.send(`${tag} NO [UNAVAILABLE] ForgeMail is turned off for your organisation`);
    this.user = user;
    await ensureMailboxes(this.ctx, user.id);
    this.grants = await accessibleMailboxes(this.ctx, user.id);
    this.send(`${tag} OK [CAPABILITY ${this.capabilities()}] Logged in`);
  }

  private async authenticate(tag: string, args: Token[]) {
    const mech = tokenText(args[0]).toUpperCase();
    if (mech !== 'PLAIN') return this.send(`${tag} NO Unsupported mechanism`);
    const finish = async (b64: string) => {
      if (b64.trim() === '*') return this.send(`${tag} BAD Authentication cancelled`);
      const [, user = '', pass = ''] = Buffer.from(b64.trim(), 'base64').toString('utf8').split('\0');
      await this.login(tag, user, pass);
    };
    if (args[1]) return finish(tokenText(args[1]));
    this.continuation = finish;
    this.send('+ ');
  }

  // --- mailboxes ------------------------------------------------------------

  /** Resolve an IMAP name: own folders, or "Shared/<address>/<path>" for delegated mailboxes. */
  private async findMailbox(name: string): Promise<Resolved | null> {
    const shared = new RegExp(`^${SHARED_ROOT}/([^/]+)/(.+)$`, 'i').exec(name);
    if (shared) {
      const owner = (await this.otherAccounts()).find((o) => o.address === shared[1]!.toLowerCase());
      if (!owner) return null;
      const scope = await folderScope(this.ctx, this.user!.id, owner.ownerId);
      const boxes = await ensureMailboxes(this.ctx, owner.ownerId);
      const path = shared[2]!;
      const box = path.toUpperCase() === 'INBOX' ? boxes.find((b) => b.specialUse === '\\Inbox') : boxes.find((b) => b.path === path);
      const access = box ? scope.folders.get(box.id) : undefined;
      return box && access ? { ...box, ownerId: owner.ownerId, access, prefix: `${SHARED_ROOT}/${owner.address}/` } : null;
    }
    const boxes = await ensureMailboxes(this.ctx, this.user!.id);
    const box = name.toUpperCase() === 'INBOX' ? boxes.find((b) => b.specialUse === '\\Inbox') : boxes.find((b) => b.path === name);
    return box ? { ...box, ownerId: this.user!.id, access: 'owner', prefix: '' } : null;
  }

  /** Mailboxes shared with this user as a whole, plus accounts that shared single folders. */
  private async otherAccounts(): Promise<{ ownerId: string; address: string }[]> {
    this.grants = await accessibleMailboxes(this.ctx, this.user!.id);
    const out = new Map(this.grants.filter((g) => g.access !== 'none').map((g) => [g.ownerId, { ownerId: g.ownerId, address: g.address }]));
    for (const f of await sharedFolderOwners(this.ctx, this.user!.id)) if (!out.has(f.ownerId)) out.set(f.ownerId, { ownerId: f.ownerId, address: f.address });
    return [...out.values()];
  }

  /** Where a new folder named `name` would be created (and whether it is allowed). */
  private async resolveParent(name: string): Promise<{ ownerId: string; path: string } | null> {
    const shared = new RegExp(`^${SHARED_ROOT}/([^/]+)/(.+)$`, 'i').exec(name);
    if (!shared) return name.toLowerCase().startsWith(`${SHARED_ROOT.toLowerCase()}/`) ? null : { ownerId: this.user!.id, path: name };
    this.grants = await accessibleMailboxes(this.ctx, this.user!.id);
    const grant = this.grants.find((g) => g.address === shared[1]!.toLowerCase());
    return grant && canManage(grant.access) ? { ownerId: grant.ownerId, path: shared[2]! } : null;
  }

  private imapName(box: Mailbox & { prefix?: string }) {
    return encodeMutf7((box.prefix ?? '') + (box.specialUse === '\\Inbox' ? 'INBOX' : box.path));
  }

  private async list(tag: string, cmd: string, args: Token[]) {
    // LIST-EXTENDED: optional selection options before the reference.
    if (Array.isArray(args[0])) args = args.slice(1);
    const reference = decodeMutf7(tokenText(args[0]));
    const patternTok = args[1];
    const patterns = Array.isArray(patternTok) ? patternTok.map((p) => decodeMutf7(tokenText(p))) : [decodeMutf7(tokenText(patternTok))];
    if (patterns.length === 1 && patterns[0] === '') {
      this.send(`* ${cmd} (\\Noselect) "/" ""`);
      return this.send(`${tag} OK ${cmd} completed`);
    }
    const regexes = patterns.map((p) => patternToRegex(reference + p));
    const matches = (name: string) => regexes.some((r) => r.test(name));
    const emit = (boxes: Mailbox[], prefix: string, owned: boolean, visible?: Map<string, MailAccess>) => {
      const listed = new Set<string>();
      for (const box of boxes) {
        if (visible && !visible.has(box.id)) {
          // A parent of a shared folder: listed as a non-selectable container.
          const name = prefix + box.path;
          if (boxes.some((b) => visible.has(b.id) && b.path.startsWith(box.path + '/')) && matches(name) && !listed.has(name)) {
            listed.add(name);
            this.send(`* ${cmd} (\\Noselect \\HasChildren) "/" ${istr(encodeMutf7(name))}`);
          }
          continue;
        }
        const name = prefix + (box.specialUse === '\\Inbox' ? 'INBOX' : box.path);
        if (!matches(name)) continue;
        if (cmd === 'LSUB' && owned && !box.subscribed) continue;
        const hasChildren = boxes.some((b) => b.path.startsWith(box.path + '/'));
        const attrs = [hasChildren ? '\\HasChildren' : '\\HasNoChildren'];
        // Special-use attributes only for the user's own folders, so clients keep using their own Sent/Trash.
        if (owned && box.specialUse && box.specialUse !== '\\Inbox') attrs.push(box.specialUse);
        if ((box.subscribed || !owned) && cmd === 'LIST') attrs.push('\\Subscribed');
        this.send(`* ${cmd} (${attrs.join(' ')}) "/" ${istr(encodeMutf7(name))}`);
      }
    };
    emit(await ensureMailboxes(this.ctx, this.user!.id), '', true);
    const others = await this.otherAccounts();
    if (others.length) {
      if (matches(SHARED_ROOT)) this.send(`* ${cmd} (\\Noselect \\HasChildren) "/" ${istr(SHARED_ROOT)}`);
      for (const o of others) {
        const root = `${SHARED_ROOT}/${o.address}`;
        if (matches(root)) this.send(`* ${cmd} (\\Noselect \\HasChildren) "/" ${istr(encodeMutf7(root))}`);
        const scope = await folderScope(this.ctx, this.user!.id, o.ownerId);
        emit(await ensureMailboxes(this.ctx, o.ownerId), `${root}/`, false, scope.folders);
      }
    }
    this.send(`${tag} OK ${cmd} completed`);
  }

  private async loadState(mailboxId: string) {
    return this.ctx.db
      .select({ uid: messages.uid, seen: messages.seen, flagged: messages.flagged, answered: messages.answered, draft: messages.draft, deleted: messages.deleted, keywords: messages.keywords })
      .from(messages)
      .where(eq(messages.mailboxId, mailboxId))
      .orderBy(asc(messages.uid));
  }

  private async select(tag: string, name: string, readOnly: boolean) {
    this.selected = null;
    const box = await this.findMailbox(name);
    if (!box) return this.send(`${tag} NO [NONEXISTENT] No such mailbox`);
    readOnly = readOnly || !canWrite(box.access);
    const rows = await this.loadState(box.id);
    this.selected = { mailbox: box, ownerId: box.ownerId, readOnly, uids: rows.map((r) => r.uid), flags: new Map(rows.map((r) => [r.uid, flagKey(r)])), modseq: box.modseq };
    const keywords = [...new Set(rows.flatMap((r) => r.keywords))];
    this.send(`* FLAGS (${[...SYSTEM_FLAGS, ...keywords].join(' ')})`);
    this.send(`* OK [PERMANENTFLAGS (${readOnly ? '' : [...SYSTEM_FLAGS, '\\*'].join(' ')})] Flags permitted`);
    this.send(`* ${rows.length} EXISTS`);
    this.send('* 0 RECENT');
    const firstUnseen = rows.findIndex((r) => !r.seen);
    if (firstUnseen >= 0) this.send(`* OK [UNSEEN ${firstUnseen + 1}] First unseen`);
    this.send(`* OK [UIDVALIDITY ${box.uidValidity}] UIDs valid`);
    this.send(`* OK [UIDNEXT ${box.uidNext}] Predicted next UID`);
    this.send(`${tag} OK [${readOnly ? 'READ-ONLY' : 'READ-WRITE'}] ${readOnly ? 'EXAMINE' : 'SELECT'} completed`);
  }

  /** Report changes made elsewhere (other sessions, webmail, delivery). */
  private async sync(allowExpunge: boolean) {
    const sel = this.selected;
    if (!sel) return;
    const [box] = await this.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, sel.mailbox.id)).limit(1);
    if (!box) {
      this.send('* BYE Selected mailbox was deleted');
      this.socket.end();
      return;
    }
    if (box.modseq === sel.modseq) return;
    const rows = await this.loadState(box.id);
    const current = new Map(rows.map((r) => [r.uid, r]));
    if (allowExpunge) {
      for (let i = sel.uids.length - 1; i >= 0; i--) {
        const u = sel.uids[i]!;
        if (!current.has(u)) {
          this.send(`* ${i + 1} EXPUNGE`);
          sel.uids.splice(i, 1);
          sel.flags.delete(u);
        }
      }
    }
    const known = new Set(sel.uids);
    const added = rows.filter((r) => !known.has(r.uid) && r.uid > (sel.uids.at(-1) ?? 0));
    for (const r of added) {
      sel.uids.push(r.uid);
      sel.flags.set(r.uid, flagKey(r));
    }
    if (added.length) {
      this.send(`* ${sel.uids.length} EXISTS`);
      this.send('* 0 RECENT');
    }
    sel.uids.forEach((u, i) => {
      const r = current.get(u);
      if (!r) return;
      const key = flagKey(r);
      if (sel.flags.get(u) !== key) {
        sel.flags.set(u, key);
        this.send(`* ${i + 1} FETCH (UID ${u} FLAGS (${key}))`);
      }
    });
    sel.mailbox = { ...sel.mailbox, ...box };
    sel.modseq = allowExpunge || rows.length === sel.uids.length ? box.modseq : sel.modseq;
  }

  private async status(tag: string, args: Token[]) {
    const box = await this.findMailbox(decodeMutf7(tokenText(args[0])));
    if (!box) return this.send(`${tag} NO [NONEXISTENT] No such mailbox`);
    const items = (Array.isArray(args[1]) ? args[1] : []).map((t) => tokenText(t).toUpperCase());
    const rows = await this.ctx.db.select({ seen: messages.seen }).from(messages).where(eq(messages.mailboxId, box.id));
    const out: string[] = [];
    for (const item of items) {
      if (item === 'MESSAGES') out.push(`MESSAGES ${rows.length}`);
      else if (item === 'RECENT') out.push('RECENT 0');
      else if (item === 'UIDNEXT') out.push(`UIDNEXT ${box.uidNext}`);
      else if (item === 'UIDVALIDITY') out.push(`UIDVALIDITY ${box.uidValidity}`);
      else if (item === 'UNSEEN') out.push(`UNSEEN ${rows.filter((r) => !r.seen).length}`);
    }
    this.send(`* STATUS ${istr(this.imapName(box))} (${out.join(' ')})`);
    this.send(`${tag} OK STATUS completed`);
  }

  private async append(tag: string, args: Token[]) {
    const box = await this.findMailbox(decodeMutf7(tokenText(args[0])));
    if (!box) return this.send(`${tag} NO [TRYCREATE] No such mailbox`);
    if (!canWrite(box.access)) return this.send(`${tag} NO [NOPERM] Read-only access`);
    let i = 1;
    let flags: string[] = [];
    let date: Date | undefined;
    if (Array.isArray(args[i])) flags = (args[i++] as Token[]).map((t) => tokenText(t));
    if (isString(args[i]) && args[i + 1] !== undefined) date = parseImapDate(tokenText(args[i++])) ?? undefined;
    const data = args[i];
    if (!isString(data)) throw new ParseError('Missing message literal');
    const lower = flags.map((f) => f.toLowerCase());
    const msg = await appendMessage(this.ctx, {
      userId: box.ownerId,
      mailboxId: box.id,
      raw: data.string,
      internalDate: date,
      seen: lower.includes('\\seen'),
      flagged: lower.includes('\\flagged'),
      answered: lower.includes('\\answered'),
      draft: lower.includes('\\draft'),
      keywords: flags.filter((f) => !f.startsWith('\\')),
    });
    if (this.selected?.mailbox.id === box.id) await this.sync(false);
    this.send(`${tag} OK [APPENDUID ${box.uidValidity} ${msg.uid}] APPEND completed`);
  }

  private async idle(tag: string) {
    this.idleTag = tag;
    this.send('+ idling');
    const userId = this.user!.id;
    let pending = false;
    const push = async () => {
      if (pending || this.idleTag === null) return;
      pending = true;
      try {
        await this.sync(true);
      } finally {
        pending = false;
      }
    };
    this.unsubscribe = await onMailChanged(this.ctx, (e) => {
      if (e.userId === (this.selected?.ownerId ?? userId) && (!e.mailboxId || e.mailboxId === this.selected?.mailbox.id)) void push();
    });
    const poll = setInterval(() => void push(), 60_000);
    poll.unref();
    const prev = this.unsubscribe;
    this.unsubscribe = () => {
      prev();
      clearInterval(poll);
    };
  }

  // --- messages -------------------------------------------------------------

  /** Map a set to uids of the selected mailbox. */
  private targetUids(set: string, uid: boolean): number[] {
    const sel = this.selected!;
    if (uid) return resolveSet(set, sel.uids.at(-1) ?? 0, sel.uids);
    const seqs = resolveSet(set, sel.uids.length, sel.uids.map((_, i) => i + 1));
    return seqs.map((s) => sel.uids[s - 1]!);
  }

  private seqOf(uid: number) {
    return this.selected!.uids.indexOf(uid) + 1;
  }

  private async rowsFor(uids: number[], full = false): Promise<Message[]> {
    if (!uids.length) return [];
    const out: Message[] = [];
    for (let i = 0; i < uids.length; i += 500) {
      const chunk = uids.slice(i, i + 500);
      const rows = full
        ? await this.ctx.db.select().from(messages).where(and(eq(messages.mailboxId, this.selected!.mailbox.id), inArray(messages.uid, chunk)))
        : ((await this.ctx.db
            .select({
              id: messages.id,
              uid: messages.uid,
              size: messages.size,
              internalDate: messages.internalDate,
              seen: messages.seen,
              flagged: messages.flagged,
              answered: messages.answered,
              draft: messages.draft,
              deleted: messages.deleted,
              keywords: messages.keywords,
              blobSha: messages.blobSha,
              mimeTree: messages.mimeTree,
            })
            .from(messages)
            .where(and(eq(messages.mailboxId, this.selected!.mailbox.id), inArray(messages.uid, chunk)))) as unknown as Message[]);
      out.push(...rows);
    }
    return out.sort((a, b) => a.uid - b.uid);
  }

  private async fetch(tag: string, set: string, args: Token[], uid: boolean) {
    const items = parseFetchItems(args);
    if (uid && !items.some((i) => i.name === 'UID')) items.unshift({ name: 'UID' });
    const rows = await this.rowsFor(this.targetUids(set, uid));
    const needsRaw = items.some((i) => ['BODY[]', 'RFC822', 'RFC822.HEADER', 'RFC822.TEXT', 'ENVELOPE'].includes(i.name)) || items.some((i) => i.name === 'BODYSTRUCTURE' || i.name === 'BODY');
    const markSeen: string[] = [];
    for (const row of rows) {
      const raw = needsRaw ? await readRaw(this.ctx, row) : null;
      // Each FETCH item is one or more buffers (a literal is header + payload).
      const parts: Buffer[][] = [];
      const push = (s: string) => parts.push([Buffer.from(s)]);
      const pushLiteral = (name: string, data: Buffer) => {
        parts.push([Buffer.from(`${name} {${data.length}}\r\n`), data]);
      };
      let flagsDirty = false;
      for (const item of items) {
        switch (item.name) {
          case 'UID':
            push(`UID ${row.uid}`);
            break;
          case 'FLAGS':
            push(`FLAGS (${flagList(row).join(' ')})`);
            break;
          case 'INTERNALDATE':
            push(`INTERNALDATE "${imapDate(row.internalDate)}"`);
            break;
          case 'RFC822.SIZE':
            push(`RFC822.SIZE ${row.size}`);
            break;
          case 'ENVELOPE':
            push(`ENVELOPE ${envelopeFromHeaders(headerBlock(raw!, row.mimeTree))}`);
            break;
          case 'BODYSTRUCTURE':
            push(`BODYSTRUCTURE ${bodyStructure(row.mimeTree, raw, true)}`);
            break;
          case 'BODY':
            push(`BODY ${bodyStructure(row.mimeTree, raw, false)}`);
            break;
          case 'RFC822':
            pushLiteral('RFC822', raw!);
            flagsDirty = !row.seen;
            break;
          case 'RFC822.HEADER':
            pushLiteral('RFC822.HEADER', raw!.subarray(0, row.mimeTree.bodyStart));
            break;
          case 'RFC822.TEXT':
            pushLiteral('RFC822.TEXT', raw!.subarray(row.mimeTree.bodyStart));
            flagsDirty = !row.seen;
            break;
          case 'BODY[]': {
            let data = extractSection(raw!, row.mimeTree, item.section ?? '');
            let name = `BODY[${item.section ?? ''}]`;
            if (item.partial) {
              data = data.subarray(item.partial.start, item.partial.start + item.partial.length);
              name += `<${item.partial.start}>`;
            }
            pushLiteral(name, data);
            if (!item.peek && !row.seen) flagsDirty = true;
            break;
          }
          default:
            throw new ParseError(`Unsupported FETCH item ${item.name}`);
        }
      }
      if (flagsDirty && !this.selected!.readOnly) {
        markSeen.push(row.id);
        row.seen = true;
        if (!items.some((i) => i.name === 'FLAGS')) push(`FLAGS (${flagList(row).join(' ')})`);
      }
      const joined: Buffer[] = [Buffer.from(`* ${this.seqOf(row.uid)} FETCH (`)];
      parts.forEach((p, idx) => {
        if (idx > 0) joined.push(Buffer.from(' '));
        joined.push(...p);
      });
      joined.push(Buffer.from(')'));
      this.send(joined);
    }
    if (markSeen.length) {
      const updated = await setFlags(this.ctx, this.selected!.ownerId, markSeen, { seen: true });
      for (const u of updated) this.selected!.flags.set(u.uid, flagKey(u));
      this.selected!.modseq = Math.max(this.selected!.modseq, ...updated.map((u) => u.modseq));
    }
    if (uid) await this.sync(true);
    else await this.sync(false);
    this.send(`${tag} OK ${uid ? 'UID ' : ''}FETCH completed`);
  }

  private async store(tag: string, set: string, op: string, args: Token[], uid: boolean) {
    if (this.selected!.readOnly) return this.send(`${tag} NO Mailbox is read-only`);
    const m = /^([+-]?)FLAGS(\.SILENT)?$/i.exec(op);
    if (!m) throw new ParseError('Invalid STORE operation');
    const flagTokens = Array.isArray(args[0]) ? args[0] : args;
    const flags = flagTokens.map((t) => tokenText(t));
    const lower = new Set(flags.map((f) => f.toLowerCase()));
    const keywords = flags.filter((f) => !f.startsWith('\\'));
    const mode = m[1] === '+' ? 'add' : m[1] === '-' ? 'remove' : 'replace';
    const rows = await this.rowsFor(this.targetUids(set, uid));
    const sys = { seen: lower.has('\\seen'), flagged: lower.has('\\flagged'), answered: lower.has('\\answered'), draft: lower.has('\\draft'), deleted: lower.has('\\deleted') };
    // Marking for deletion needs delete rights ("write" may flag and file, not delete).
    if (sys.deleted && mode !== 'remove' && !canDelete(this.selected!.mailbox.access)) return this.send(`${tag} NO [NOPERM] You cannot delete messages in this folder`);
    const change =
      mode === 'replace'
        ? { ...sys, keywords }
        : Object.fromEntries([
            ...Object.entries(sys)
              .filter(([, v]) => v)
              .map(([k]) => [k, mode === 'add']),
            [mode === 'add' ? 'addKeywords' : 'removeKeywords', keywords],
          ]);
    const updated = await setFlags(this.ctx, this.selected!.ownerId, rows.map((r) => r.id), change);
    for (const u of updated.sort((a, b) => a.uid - b.uid)) {
      this.selected!.flags.set(u.uid, flagKey(u));
      if (!m[2]) this.send(`* ${this.seqOf(u.uid)} FETCH (${uid ? `UID ${u.uid} ` : ''}FLAGS (${flagList(u).join(' ')}))`);
    }
    if (updated.length) this.selected!.modseq = Math.max(this.selected!.modseq, ...updated.map((u) => u.modseq));
    await this.sync(uid);
    this.send(`${tag} OK ${uid ? 'UID ' : ''}STORE completed`);
  }

  private async expunge(tag: string, uidSet: string | null) {
    if (this.selected!.readOnly || !canDelete(this.selected!.mailbox.access)) return this.send(`${tag} NO [NOPERM] You cannot delete messages in this folder`);
    let doomed = await this.ctx.db
      .select({ id: messages.id, uid: messages.uid })
      .from(messages)
      .where(and(eq(messages.mailboxId, this.selected!.mailbox.id), eq(messages.deleted, true)));
    if (uidSet) {
      const allowed = new Set(resolveSet(uidSet, this.selected!.uids.at(-1) ?? 0, this.selected!.uids));
      doomed = doomed.filter((d) => allowed.has(d.uid));
    }
    await expungeMessages(this.ctx, this.selected!.ownerId, doomed.map((d) => d.id));
    await this.sync(true);
    this.send(`${tag} OK EXPUNGE completed`);
  }

  private async copyMove(tag: string, cmd: string, set: string, target: string, uid: boolean) {
    const box = await this.findMailbox(target);
    if (!box) return this.send(`${tag} NO [TRYCREATE] No such mailbox`);
    if (!canWrite(box.access)) return this.send(`${tag} NO [NOPERM] Read-only access to the target mailbox`);
    if (cmd === 'MOVE' && this.selected!.readOnly) return this.send(`${tag} NO Mailbox is read-only`);
    const source = this.selected!.ownerId;
    const rows = await this.rowsFor(this.targetUids(set, uid));
    if (!rows.length) return this.send(`${tag} OK ${cmd} completed`);

    if (box.ownerId !== source) {
      // Between two accounts (e.g. personal ↔ shared): store a new copy for the target owner.
      const pairs: { fromUid: number; toUid: number }[] = [];
      for (const r of rows) {
        const copy = await appendMessage(this.ctx, {
          userId: box.ownerId,
          mailboxId: box.id,
          raw: await readRaw(this.ctx, r),
          internalDate: r.internalDate,
          seen: r.seen,
          flagged: r.flagged,
          answered: r.answered,
          draft: r.draft,
          keywords: r.keywords,
        });
        pairs.push({ fromUid: r.uid, toUid: copy.uid });
      }
      const code = `[COPYUID ${box.uidValidity} ${compressSet(pairs.map((p) => p.fromUid))} ${compressSet(pairs.map((p) => p.toUid))}]`;
      if (cmd === 'MOVE') {
        this.send(`* OK ${code} Moved`);
        await expungeMessages(this.ctx, source, rows.map((r) => r.id));
        await this.sync(true);
        return this.send(`${tag} OK MOVE completed`);
      }
      return this.send(`${tag} OK ${code} COPY completed`);
    }

    if (cmd === 'MOVE') {
      const moved = await moveMessages(this.ctx, source, rows.map((r) => r.id), box.id);
      if (moved.length) this.send(`* OK [COPYUID ${box.uidValidity} ${compressSet(moved.map((m) => m.fromUid))} ${compressSet(moved.map((m) => m.toUid))}] Moved`);
      await this.sync(true);
      return this.send(`${tag} OK MOVE completed`);
    }
    const copied = await copyMessages(this.ctx, source, rows.map((r) => r.id), box.id);
    if (this.selected!.mailbox.id === box.id) await this.sync(uid);
    this.send(`${tag} OK [COPYUID ${box.uidValidity} ${compressSet(copied.map((c) => c.fromUid))} ${compressSet(copied.map((c) => c.toUid))}] COPY completed`);
  }

  // --- search ---------------------------------------------------------------

  private async search(tag: string, args: Token[], uid: boolean) {
    let tokens = args;
    if (isAtom(tokens[0]) && tokens[0].atom.toUpperCase() === 'CHARSET') tokens = tokens.slice(2);
    const sel = this.selected!;
    const rows = await this.ctx.db
      .select()
      .from(messages)
      .where(eq(messages.mailboxId, sel.mailbox.id))
      .orderBy(asc(messages.uid));
    const known = new Map(rows.filter((r) => sel.uids.includes(r.uid)).map((r) => [r.uid, r]));
    const predicate = this.compileSearch(tokens);
    const hits: number[] = [];
    for (let i = 0; i < sel.uids.length; i++) {
      const row = known.get(sel.uids[i]!);
      if (row && (await predicate(row, i + 1))) hits.push(uid ? row.uid : i + 1);
    }
    this.send(`* SEARCH${hits.length ? ' ' + hits.join(' ') : ''}`);
    await this.sync(uid);
    this.send(`${tag} OK ${uid ? 'UID ' : ''}SEARCH completed`);
  }

  private compileSearch(tokens: Token[]): (m: Message, seq: number) => Promise<boolean> {
    let pos = 0;
    const sel = this.selected!;
    const next = () => tokens[pos++];
    const text = () => tokenText(next()).toLowerCase();
    const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const parseOne = (): ((m: Message, seq: number) => Promise<boolean> | boolean) => {
      const t = next();
      if (Array.isArray(t)) {
        const inner = this.compileSearch(t);
        return inner;
      }
      const key = tokenText(t).toUpperCase();
      const has = (s: string | null | undefined, needle: string) => (s ?? '').toLowerCase().includes(needle);
      const addrs = (list: { name: string; address: string }[]) => list.map((a) => `${a.name} <${a.address}>`).join(', ');
      switch (key) {
        case 'ALL':
          return () => true;
        case 'ANSWERED':
          return (m) => m.answered;
        case 'UNANSWERED':
          return (m) => !m.answered;
        case 'DELETED':
          return (m) => m.deleted;
        case 'UNDELETED':
          return (m) => !m.deleted;
        case 'FLAGGED':
          return (m) => m.flagged;
        case 'UNFLAGGED':
          return (m) => !m.flagged;
        case 'SEEN':
          return (m) => m.seen;
        case 'UNSEEN':
          return (m) => !m.seen;
        case 'DRAFT':
          return (m) => m.draft;
        case 'UNDRAFT':
          return (m) => !m.draft;
        case 'NEW':
        case 'RECENT':
          return () => false;
        case 'OLD':
          return () => true;
        case 'KEYWORD': {
          const k = tokenText(next());
          return (m) => m.keywords.includes(k);
        }
        case 'UNKEYWORD': {
          const k = tokenText(next());
          return (m) => !m.keywords.includes(k);
        }
        case 'FROM': {
          const v = text();
          return (m) => has(m.fromAddr ? addrs([m.fromAddr]) : '', v);
        }
        case 'TO': {
          const v = text();
          return (m) => has(addrs(m.toAddrs), v);
        }
        case 'CC': {
          const v = text();
          return (m) => has(addrs(m.ccAddrs), v);
        }
        case 'BCC': {
          const v = text();
          return (m) => has(addrs(m.bccAddrs), v);
        }
        case 'SUBJECT': {
          const v = text();
          return (m) => has(m.subject, v);
        }
        case 'BODY': {
          const v = text();
          return (m) => has(m.bodyText, v);
        }
        case 'TEXT': {
          const v = text();
          return (m) => has(m.subject, v) || has(m.bodyText, v) || has(m.searchAddresses, v);
        }
        case 'HEADER': {
          const field = text();
          const v = text();
          return async (m) => {
            const raw = await readRaw(this.ctx, m);
            const fields = parseHeaderBlock(headerBlock(raw, m.mimeTree));
            return fields.some((f) => f.key === field && (v === '' || f.value.toLowerCase().includes(v)));
          };
        }
        case 'SINCE':
        case 'BEFORE':
        case 'ON':
        case 'SENTSINCE':
        case 'SENTBEFORE':
        case 'SENTON': {
          const d = parseImapDate(tokenText(next()));
          if (!d) throw new ParseError('Invalid date');
          const target = day(d);
          const sent = key.startsWith('SENT');
          const op = key.replace('SENT', '');
          return (m) => {
            const v = sent ? m.sentAt : m.internalDate;
            if (!v) return false;
            const dd = day(v);
            return op === 'SINCE' ? dd >= target : op === 'BEFORE' ? dd < target : dd === target;
          };
        }
        case 'LARGER': {
          const n = Number(tokenText(next()));
          return (m) => m.size > n;
        }
        case 'SMALLER': {
          const n = Number(tokenText(next()));
          return (m) => m.size < n;
        }
        case 'UID': {
          const set = new Set(resolveSet(tokenText(next()), sel.uids.at(-1) ?? 0, sel.uids));
          return (m) => set.has(m.uid);
        }
        case 'NOT': {
          const inner = parseOne();
          return async (m, s) => !(await inner(m, s));
        }
        case 'OR': {
          const a = parseOne();
          const b = parseOne();
          return async (m, s) => (await a(m, s)) || (await b(m, s));
        }
        default: {
          if (/^[\d*:,]+$/.test(key)) {
            const set = new Set(resolveSet(key, sel.uids.length, sel.uids.map((_, i) => i + 1)));
            return (_m, seq) => set.has(seq);
          }
          throw new ParseError(`Unsupported search key ${key}`);
        }
      }
    };
    const preds: ((m: Message, seq: number) => Promise<boolean> | boolean)[] = [];
    while (pos < tokens.length) preds.push(parseOne());
    return async (m, seq) => {
      for (const p of preds) if (!(await p(m, seq))) return false;
      return true;
    };
  }
}

export interface ImapServers {
  close(): Promise<void>;
}

/** Start IMAP listeners: STARTTLS port (143) and implicit TLS port (993). */
export async function startImapServers(opts: ImapServerOptions, ports: { imap?: number; imaps?: number; host?: string }): Promise<ImapServers & { ports: { imap?: number; imaps?: number } }> {
  const servers: net.Server[] = [];
  const sockets = new Set<net.Socket>();
  const track = (sock: net.Socket) => {
    sockets.add(sock);
    sock.once('close', () => sockets.delete(sock));
  };
  const bound: { imap?: number; imaps?: number } = {};
  const listen = (server: net.Server, port: number) =>
    new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, ports.host ?? '0.0.0.0', () => resolve((server.address() as net.AddressInfo).port));
    });
  if (ports.imap !== undefined) {
    const s = net.createServer((sock) => {
      track(sock);
      new ImapSession(sock, opts, false);
    });
    bound.imap = await listen(s, ports.imap);
    servers.push(s);
  }
  if (ports.imaps !== undefined) {
    const s = tls.createServer({ key: opts.tls.key, cert: opts.tls.cert }, (sock) => {
      track(sock);
      new ImapSession(sock, opts, true);
    });
    bound.imaps = await listen(s, ports.imaps);
    servers.push(s);
  }
  return {
    ports: bound,
    async close() {
      const closing = Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      for (const sock of sockets) {
        sock.end('* BYE Server shutting down\r\n');
        setTimeout(() => sock.destroy(), 1000).unref();
      }
      await closing;
    },
  };
}

export const _internal = { tokenize, resolveSet, extractSection, parseFetchItems };
