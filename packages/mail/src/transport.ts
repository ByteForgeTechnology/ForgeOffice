import libmime from 'libmime';
import { groupMembers, orm, transportRuleHits, transportRules, userAliases, users, type MimeNode, type RuleAction, type RuleCondition, type TransportRule } from '@forge/db';
import { normaliseAddress, splitAddress } from './addresses';
import type { MailContext } from './context';
import type { IndexedMessage } from './ingest';
import { decodeHeaderWords, decodePartBody, parseHeaderBlock, parseMimeTree, partFilename } from './mime';
import { isLocalDomain } from './routing';

const { asc, eq } = orm;

export type Direction = 'inbound' | 'outbound' | 'internal';

export class TransportRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportRejectedError';
  }
}

// ---------------------------------------------------------------------------
// Message editing
// ---------------------------------------------------------------------------

const CRLF = '\r\n';
const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,76}$/;

function encodeHeaderValue(value: string): string {
  return /[^\x20-\x7e]/.test(value) ? libmime.encodeWords(value, 'Q', 52) : value;
}

/** Prefix the Subject and/or set headers on the top-level message. */
export function editRootHeaders(raw: Buffer, edit: { prependSubject?: string; setHeaders?: [string, string][] }): Buffer {
  const tree = parseMimeTree(raw);
  const fields = parseHeaderBlock(raw.subarray(0, tree.bodyStart).toString('utf8'));
  let lines = fields.map((f) => ({ key: f.key, raw: f.raw }));
  if (edit.prependSubject) {
    const prefix = edit.prependSubject.trim();
    const subject = fields.find((f) => f.key === 'subject');
    const current = subject ? decodeHeaderWords(subject.value) : '';
    if (!current.trimStart().toLowerCase().startsWith(prefix.toLowerCase())) {
      const line = `Subject: ${encodeHeaderValue(prefix)} ${subject?.value ?? ''}`.trimEnd() + CRLF;
      if (subject) lines = lines.map((l) => (l.key === 'subject' ? { key: 'subject', raw: line } : l));
      else lines.push({ key: 'subject', raw: line });
    }
  }
  for (const [name, value] of edit.setHeaders ?? []) {
    if (!HEADER_NAME_RE.test(name)) continue;
    lines = lines.filter((l) => l.key !== name.toLowerCase());
    lines.push({ key: name.toLowerCase(), raw: `${name}: ${encodeHeaderValue(value.replace(/[\r\n]+/g, ' '))}${CRLF}` });
  }
  return Buffer.concat([Buffer.from(lines.map((l) => l.raw).join('') + CRLF), raw.subarray(tree.bodyStart)]);
}

/** The parts a reader sees as the body: all alternatives, but only the first part of mixed/related. */
function bodyParts(node: MimeNode): MimeNode[] {
  if (node.type === 'multipart') {
    if (node.subtype === 'alternative') return node.children.flatMap(bodyParts);
    return node.children[0] ? bodyParts(node.children[0]) : [];
  }
  const isText = node.type === 'text' && (node.subtype === 'plain' || node.subtype === 'html');
  return isText && node.disposition?.type !== 'attachment' && !partFilename(node) ? [node] : [];
}

function decodeText(bytes: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Append a disclaimer to the text and HTML bodies, re-encoding each edited
 * part as UTF-8/base64. Attachments and other parts are untouched.
 */
export function appendDisclaimer(raw: Buffer, text: string, html?: string): Buffer {
  const tree = parseMimeTree(raw);
  const targets = bodyParts(tree).sort((a, b) => b.headerStart - a.headerStart);
  const htmlBlock = `<div style="margin-top:16px;padding-top:8px;border-top:1px solid #d4d4d8;color:#52525b;font-size:12px">${html ?? escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
  let out = raw;
  for (const part of targets) {
    const body = decodeText(decodePartBody(raw.subarray(part.bodyStart, part.bodyEnd), part.encoding), part.params.charset);
    let next: string;
    if (part.subtype === 'html') {
      const idx = body.toLowerCase().lastIndexOf('</body>');
      next = idx >= 0 ? body.slice(0, idx) + htmlBlock + body.slice(idx) : body + htmlBlock;
    } else {
      next = body.replace(/\s+$/, '') + `${CRLF}${CRLF}${text.replace(/\r?\n/g, CRLF)}${CRLF}`;
    }
    const encoded = (Buffer.from(next, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join(CRLF);
    const header = parseHeaderBlock(raw.subarray(part.headerStart, part.bodyStart).toString('utf8'))
      .filter((f) => f.key !== 'content-type' && f.key !== 'content-transfer-encoding')
      .map((f) => f.raw)
      .join('');
    const newHeader = `${header}Content-Type: text/${part.subtype}; charset=utf-8${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}`;
    const tail = part.path === '' ? CRLF : '';
    out = Buffer.concat([out.subarray(0, part.headerStart), Buffer.from(newHeader + encoded + tail), out.subarray(part.bodyEnd)]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface RuleInput {
  direction: Direction;
  envelopeFrom: string;
  recipients: string[];
  raw: Buffer;
  idx: IndexedMessage;
  spamScore?: number;
}

export interface RuleMatch {
  ruleId: string;
  name: string;
  mode: 'enforce' | 'test';
  actions: string[];
}

export interface RuleOutcome {
  raw: Buffer;
  recipients: string[];
  changed: boolean;
  reject?: string;
  quarantine?: string;
  drop?: boolean;
  junk?: boolean;
  matched: RuleMatch[];
}

/** "example.com", "@example.com", "*@example.com" match a domain (and its subdomains); otherwise exact address. */
export function addressMatches(address: string, patterns: string[]): boolean {
  const addr = normaliseAddress(address);
  const { domain } = splitAddress(addr);
  return patterns.some((p) => {
    const pat = p.trim().toLowerCase();
    if (!pat) return false;
    if (pat.includes('@') && !pat.startsWith('@') && !pat.startsWith('*@')) return addr === pat;
    const d = pat.replace(/^\*?@/, '');
    return domain === d || domain.endsWith(`.${d}`);
  });
}

class Facts {
  private local = new Map<string, boolean>();
  private groups = new Map<string, string[]>();
  constructor(private readonly ctx: Pick<MailContext, 'db'>) {}

  async isInternal(address: string): Promise<boolean> {
    const { domain } = splitAddress(address);
    if (!this.local.has(domain)) this.local.set(domain, await isLocalDomain(this.ctx, domain));
    return this.local.get(domain)!;
  }

  async groupsOf(address: string): Promise<string[]> {
    const addr = normaliseAddress(address);
    if (!this.groups.has(addr)) {
      const [direct] = await this.ctx.db.select({ id: users.id }).from(users).where(eq(users.email, addr)).limit(1);
      const [alias] = direct ? [] : await this.ctx.db.select({ id: userAliases.userId }).from(userAliases).where(eq(userAliases.address, addr)).limit(1);
      const userId = direct?.id ?? alias?.id;
      const ids = userId ? (await this.ctx.db.select({ id: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.userId, userId))).map((g) => g.id) : [];
      this.groups.set(addr, ids);
    }
    return this.groups.get(addr)!;
  }
}

async function conditionMatches(c: RuleCondition, input: RuleInput, facts: Facts): Promise<boolean> {
  const values = (c.values ?? []).map((v) => v.trim()).filter(Boolean);
  const lower = values.map((v) => v.toLowerCase());
  const senders = [input.idx.from?.address, input.envelopeFrom].filter((a): a is string => !!a);
  const anyRecipient = async (fn: (r: string) => Promise<boolean> | boolean) => {
    for (const r of input.recipients) if (await fn(r)) return true;
    return false;
  };
  switch (c.type) {
    case 'senderAddress':
      return senders.some((s) => addressMatches(s, values));
    case 'senderScope':
      return senders.length > 0 && (await facts.isInternal(senders[0]!)) === (c.scope === 'internal');
    case 'senderMemberOf':
      return senders.length > 0 && (await facts.groupsOf(senders[0]!)).some((g) => values.includes(g));
    case 'recipientAddress':
      return anyRecipient((r) => addressMatches(r, values));
    case 'recipientScope':
      return anyRecipient(async (r) => (await facts.isInternal(r)) === (c.scope === 'internal'));
    case 'recipientMemberOf':
      return anyRecipient(async (r) => (await facts.groupsOf(r)).some((g) => values.includes(g)));
    case 'subjectContains':
      return lower.some((w) => input.idx.subject.toLowerCase().includes(w));
    case 'subjectOrBodyContains': {
      const hay = `${input.idx.subject}\n${input.idx.bodyText}`.toLowerCase();
      return lower.some((w) => hay.includes(w));
    }
    case 'headerContains': {
      const got = (input.idx.headers.get((c.header ?? '').toLowerCase()) ?? []).map((v) => decodeHeaderWords(v).toLowerCase());
      return got.length > 0 && (lower.length === 0 || got.some((g) => lower.some((w) => g.includes(w))));
    }
    case 'hasAttachment':
      return input.idx.attachments.some((a) => !a.inline);
    case 'attachmentExtension': {
      const exts = lower.map((e) => e.replace(/^\*?\./, ''));
      return input.idx.attachments.some((a) => !a.inline && exts.includes(a.filename.toLowerCase().split('.').pop() ?? ''));
    }
    case 'attachmentNameContains':
      return input.idx.attachments.some((a) => !a.inline && lower.some((w) => a.filename.toLowerCase().includes(w)));
    case 'sizeOver':
      return input.raw.length > (c.number ?? Infinity);
    case 'spamScoreAbove':
      return (input.spamScore ?? 0) > (c.number ?? Infinity);
    default:
      return false;
  }
}

async function ruleMatches(rule: Pick<TransportRule, 'conditions' | 'exceptions' | 'appliesTo'>, input: RuleInput, facts: Facts): Promise<boolean> {
  if (rule.appliesTo !== 'all' && rule.appliesTo !== input.direction) return false;
  for (const c of rule.conditions) if (!(await conditionMatches(c, input, facts))) return false;
  for (const c of rule.exceptions) if (await conditionMatches(c, input, facts)) return false;
  return true;
}

const describe = (a: RuleAction) =>
  a.type === 'prependSubject'
    ? `prefix subject “${a.text}”`
    : a.type === 'setHeader'
      ? `set ${a.header}`
      : a.type === 'appendDisclaimer'
        ? 'append disclaimer'
        : a.type === 'bcc' || a.type === 'addRecipients'
          ? `bcc ${(a.addresses ?? []).join(', ')}`
          : a.type === 'redirect'
            ? `redirect to ${(a.addresses ?? []).join(', ')}`
            : a.type;

/**
 * Evaluate enabled rules in priority order and apply the enforced ones.
 * Test-mode rules are only recorded. With `dryRun`, nothing is recorded.
 */
export async function applyTransportRules(ctx: Pick<MailContext, 'db' | 'log'>, input: RuleInput, opts: { dryRun?: boolean; rules?: TransportRule[] } = {}): Promise<RuleOutcome> {
  const rules = opts.rules ?? (await ctx.db.select().from(transportRules).where(eq(transportRules.enabled, true)).orderBy(asc(transportRules.priority), asc(transportRules.createdAt)));
  const outcome: RuleOutcome = { raw: input.raw, recipients: [...input.recipients], changed: false, matched: [] };
  if (!rules.length) return outcome;
  const facts = new Facts(ctx);
  const enforced: RuleAction[] = [];
  for (const rule of rules) {
    if (!(await ruleMatches(rule, input, facts))) continue;
    outcome.matched.push({ ruleId: rule.id, name: rule.name, mode: rule.mode, actions: rule.actions.map(describe) });
    if (rule.mode === 'enforce') enforced.push(...rule.actions.map((a) => ({ ...a, _rule: rule.name }) as RuleAction & { _rule: string }));
    if (rule.stopProcessing && rule.mode === 'enforce') break;
  }

  if (!opts.dryRun && outcome.matched.length) {
    await ctx.db
      .insert(transportRuleHits)
      .values(
        outcome.matched.map((m) => ({
          ruleId: m.ruleId,
          direction: input.direction,
          sender: input.idx.from?.address ?? input.envelopeFrom ?? '',
          recipients: input.recipients.slice(0, 50),
          subject: input.idx.subject.slice(0, 300),
          messageId: input.idx.messageId,
          mode: m.mode,
          actions: m.actions,
        })),
      )
      .catch((err) => ctx.log.warn({ err }, 'could not record transport rule hit'));
  }

  // Terminal actions: the first one wins.
  for (const a of enforced as (RuleAction & { _rule: string })[]) {
    if (a.type === 'reject') return { ...outcome, reject: a.text?.trim() || 'Delivery not authorized, message refused by policy' };
    if (a.type === 'delete') return { ...outcome, drop: true };
    if (a.type === 'quarantine') return { ...outcome, quarantine: `Transport rule: ${a._rule}` };
  }

  let raw = input.raw;
  let prefix: string | undefined;
  const headers: [string, string][] = [];
  const disclaimers: RuleAction[] = [];
  for (const a of enforced) {
    switch (a.type) {
      case 'junk':
        if (input.direction === 'inbound') outcome.junk = true;
        break;
      case 'redirect':
        if (a.addresses?.length) outcome.recipients = a.addresses.map(normaliseAddress);
        break;
      case 'bcc':
      case 'addRecipients':
        outcome.recipients.push(...(a.addresses ?? []).map(normaliseAddress));
        break;
      case 'prependSubject':
        if (a.text?.trim()) prefix = a.text;
        break;
      case 'setHeader':
        if (a.header) headers.push([a.header, a.text ?? '']);
        break;
      case 'appendDisclaimer':
        if (a.text?.trim() || a.html?.trim()) disclaimers.push(a);
        break;
    }
  }
  outcome.recipients = [...new Set(outcome.recipients)];

  if (prefix || headers.length) raw = editRootHeaders(raw, { prependSubject: prefix, setHeaders: headers });
  for (const d of disclaimers) {
    // Skip if this exact disclaimer is already in the thread being replied to.
    if (input.idx.bodyText.includes((d.text ?? '').trim().slice(0, 80))) continue;
    raw = appendDisclaimer(raw, d.text ?? '', d.html);
  }
  outcome.changed = raw !== input.raw || outcome.recipients.join() !== input.recipients.join();
  outcome.raw = raw;
  return outcome;
}

