import { createTransport } from 'nodemailer';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { messages, orm, quarantine, transportRuleHits, transportRules, type RuleAction, type RuleCondition } from '@forge/db';
import { appendDisclaimer, ensureMailboxes, releaseFromQuarantine } from '../src';
import { startHarness, type Harness } from './harness';

const { eq } = orm;

let h: Harness;
let alice: Awaited<ReturnType<Harness['createUser']>>;

const external = () => createTransport({ host: '127.0.0.1', port: h.ports.smtp, secure: false, ignoreTLS: true } as never);
const submit = () => createTransport({ host: '127.0.0.1', port: h.ports.submission, secure: false, ignoreTLS: true, auth: { user: 'alice@acme.test', pass: 'alice password 123' } } as never);

async function rule(name: string, r: { appliesTo?: 'all' | 'inbound' | 'outbound' | 'internal'; conditions?: RuleCondition[]; exceptions?: RuleCondition[]; actions: RuleAction[]; mode?: 'enforce' | 'test'; priority?: number; stopProcessing?: boolean }) {
  const [row] = await h.handle.db
    .insert(transportRules)
    .values({ orgId: h.orgId, name, appliesTo: r.appliesTo ?? 'all', conditions: r.conditions ?? [], exceptions: r.exceptions ?? [], actions: r.actions, mode: r.mode ?? 'enforce', priority: r.priority ?? 0, stopProcessing: r.stopProcessing ?? false })
    .returning();
  return row!;
}

async function inboxSubjects() {
  const inbox = (await ensureMailboxes(h.ctx, alice.id)).find((b) => b.specialUse === '\\Inbox')!;
  return (await h.handle.db.select().from(messages).where(eq(messages.mailboxId, inbox.id))).map((m) => m.subject);
}

beforeAll(async () => {
  h = await startHarness();
  alice = await h.createUser('alice', 'alice password 123');
}, 60_000);

beforeEach(async () => {
  await h.handle.db.delete(transportRules);
});

afterAll(async () => {
  await h?.close();
});

describe('inbound rules', () => {
  it('tag mail from outside, with exceptions', async () => {
    await rule('External tag', {
      appliesTo: 'inbound',
      conditions: [{ type: 'senderScope', scope: 'external' }],
      exceptions: [{ type: 'senderAddress', values: ['trusted.example'] }],
      actions: [{ type: 'prependSubject', text: '[EXTERNAL]' }, { type: 'setHeader', header: 'X-Forge-Origin', text: 'external' }],
    });
    await external().sendMail({ from: 'stranger@example.org', to: 'alice@acme.test', subject: 'Hello', text: 'hi' });
    await external().sendMail({ from: 'friend@mail.trusted.example', to: 'alice@acme.test', subject: 'Trusted', text: 'hi' });
    expect(await inboxSubjects()).toEqual(expect.arrayContaining(['[EXTERNAL] Hello', 'Trusted']));
  });

  it('quarantine matching mail until an admin releases it', async () => {
    await rule('Invoice fraud', { appliesTo: 'inbound', conditions: [{ type: 'subjectContains', values: ['urgent payment'] }], actions: [{ type: 'quarantine' }] });
    await external().sendMail({ from: 'ceo@lookalike.example', to: 'alice@acme.test', subject: 'URGENT payment needed', text: 'wire it' });
    expect(await inboxSubjects()).not.toContain('URGENT payment needed');
    const [held] = await h.handle.db.select().from(quarantine).where(eq(quarantine.subject, 'URGENT payment needed'));
    expect(held!.reason).toContain('Invoice fraud');
    await releaseFromQuarantine(h.ctx, held!.id, alice.id);
    expect(await inboxSubjects()).toContain('URGENT payment needed');
  });

  it('reject with a custom message, or BCC an outside archive', async () => {
    await rule('Block exe', { appliesTo: 'inbound', conditions: [{ type: 'attachmentExtension', values: ['.exe'] }], actions: [{ type: 'reject', text: 'Executables are not accepted' }] });
    await expect(
      external().sendMail({ from: 'x@example.org', to: 'alice@acme.test', subject: 'tool', text: 'x', attachments: [{ filename: 'setup.exe', content: 'MZ' }] }),
    ).rejects.toThrow(/Executables are not accepted/);
    await rule('Archive', { appliesTo: 'inbound', actions: [{ type: 'bcc', addresses: ['archive@vault.example'] }] });
    await external().sendMail({ from: 'x@example.org', to: 'alice@acme.test', subject: 'Keep a copy', text: 'x' });
    await h.waitFor(async () => h.relay.received.find((r) => r.to.includes('archive@vault.example')));
    expect(await inboxSubjects()).toContain('Keep a copy');
  });
});

describe('outbound rules', () => {
  it('append disclaimers before DKIM signing', async () => {
    await rule('Disclaimer', {
      appliesTo: 'outbound',
      actions: [{ type: 'appendDisclaimer', text: 'Confidential: intended only for the addressee.', html: '<p><em>Confidential</em>: intended only for the addressee.</p>' }],
    });
    await submit().sendMail({ from: 'alice@acme.test', to: 'bob@partner.example', subject: 'Contract', text: 'See attached terms.', html: '<html><body><p>See attached terms.</p></body></html>' });
    const out = await h.waitFor(async () => h.relay.received.find((r) => r.to.includes('bob@partner.example')));
    const raw = out.raw.toString();
    expect(raw).toMatch(/^DKIM-Signature:/m);
    const decoded = [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g)].map((m) => Buffer.from(m[1]!.replace(/\s/g, ''), 'base64').toString());
    expect(decoded.find((d) => d.startsWith('See attached terms.'))).toContain('Confidential: intended only for the addressee.');
    expect(decoded.find((d) => d.includes('<p>See attached terms.</p>'))).toMatch(/<em>Confidential<\/em>.*<\/body>/s);
  });

  it('reject submissions with the rule’s message, and record test-mode matches only', async () => {
    await rule('No secrets out', { appliesTo: 'outbound', conditions: [{ type: 'subjectOrBodyContains', values: ['project falcon'] }], actions: [{ type: 'reject', text: 'Project Falcon must not leave the company' }] });
    const watch = await rule('Watch large mail', { appliesTo: 'outbound', mode: 'test', conditions: [{ type: 'sizeOver', number: 10 }], actions: [{ type: 'delete' }] });
    await expect(submit().sendMail({ from: 'alice@acme.test', to: 'x@partner.example', subject: 'Status', text: 'Project Falcon is on track' })).rejects.toThrow(/Project Falcon must not leave/);
    await submit().sendMail({ from: 'alice@acme.test', to: 'y@partner.example', subject: 'Lunch', text: 'Noon?' });
    await h.waitFor(async () => h.relay.received.find((r) => r.to.includes('y@partner.example')));
    const hits = await h.handle.db.select().from(transportRuleHits).where(eq(transportRuleHits.ruleId, watch.id));
    expect(hits.map((x) => x.subject)).toContain('Lunch');
  });
});

describe('disclaimer insertion', () => {
  it('keeps other parts intact and handles legacy charsets', () => {
    const raw = Buffer.from(
      [
        'From: a@acme.test',
        'Subject: x',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/plain; charset=iso-8859-1',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'Gr=FC=DFe',
        '--b1',
        'Content-Type: text/plain; name="notes.txt"',
        'Content-Disposition: attachment; filename="notes.txt"',
        '',
        'attachment body',
        '--b1--',
        '',
      ].join('\r\n'),
      'latin1',
    );
    const out = appendDisclaimer(raw, 'Footer').toString();
    const body = /charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([^\r]+)/.exec(out)![1]!;
    expect(Buffer.from(body, 'base64').toString()).toBe('Grüße\r\n\r\nFooter\r\n');
    expect(out).toContain('attachment body');
    expect(out).toContain('--b1--');
  });
});
