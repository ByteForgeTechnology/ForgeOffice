import { createTransport } from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emailSignatures, groupMembers, groups } from '@forge/db';
import { renderSignature, signatureFor, signatureText } from '../src';
import { startHarness, type Harness } from './harness';

describe('renderSignature', () => {
  const values = { displayName: 'Ana <Ops> & Co', jobTitle: 'Engineer', workPhone: '+44 20 7946 0000', mobilePhone: '', website: 'acme.com', websiteUrl: 'https://acme.com', email: 'ana@acme.test' };

  it('fills variables, escaping HTML', () => {
    expect(renderSignature('<p><strong>{{displayName}}</strong><br>{{jobTitle}}</p>', values)).toBe('<p><strong>Ana &lt;Ops&gt; &amp; Co</strong><br>Engineer</p>');
  });

  it('drops lines and paragraphs whose variables are all empty', () => {
    expect(renderSignature('<p>Name: {{displayName}}<br>Mobile: {{mobilePhone}}</p><p>M: {{mobilePhone}}</p><p>Static</p>', values)).toBe('<p>Name: Ana &lt;Ops&gt; &amp; Co</p><p>Static</p>');
  });

  it('removes separators next to empty values', () => {
    expect(renderSignature('<p>{{workPhone}} | {{mobilePhone}}</p>', values)).toBe('<p>+44 20 7946 0000</p>');
    expect(renderSignature('<p>{{mobilePhone}} · {{workPhone}}</p>', values)).toBe('<p>+44 20 7946 0000</p>');
  });

  it('fills links: full URL for website, digits for tel:, and blocks script URLs', () => {
    expect(renderSignature('<p><a href="{{website}}">{{website}}</a></p>', values)).toBe('<p><a href="https://acme.com">acme.com</a></p>');
    expect(renderSignature('<p><a href="tel:{{workPhone}}">{{workPhone}}</a></p>', values)).toBe('<p><a href="tel:+442079460000">+44 20 7946 0000</a></p>');
    expect(renderSignature('<p><a href="{{jobTitle}}">x</a></p>', { jobTitle: 'javascript:alert(1)' })).toBe('<p><a href="#">x</a></p>');
    expect(renderSignature('<p><a href="mailto:{{email}}" title="{{displayName}}">mail</a></p>', values)).toContain('title="Ana &lt;Ops&gt; &amp; Co"');
  });

  it('has a plain-text form', () => {
    expect(signatureText('<p><strong>Ana</strong><br>Engineer</p><p><img src="https://x/logo.png"><a href="https://acme.com">acme.com</a></p>')).toBe('Ana\nEngineer\n\nacme.com [https://acme.com]');
  });
});

describe('signatures in use', () => {
  let h: Harness;
  let alice: Awaited<ReturnType<Harness['createUser']>>;
  let bob: Awaited<ReturnType<Harness['createUser']>>;

  beforeAll(async () => {
    h = await startHarness();
    alice = await h.createUser('alice', 'alice password 123', { jobTitle: 'Head of Sales', workPhone: '020 7946 0000' });
    bob = await h.createUser('bob', 'bob password 1234');
    const [sales] = await h.handle.db.insert(groups).values({ orgId: h.orgId, name: 'Sales', type: 'security' }).returning();
    await h.handle.db.insert(groupMembers).values({ groupId: sales!.id, userId: alice.id });
    await h.handle.db.insert(emailSignatures).values([
      { orgId: h.orgId, name: 'Sales', priority: 0, audience: 'groups', groupIds: [sales!.id], html: '<p><strong>{{displayName}}</strong><br>{{jobTitle}}<br>T: {{workPhone}}</p>', applyToApps: true },
      { orgId: h.orgId, name: 'Everyone', priority: 1, html: '<p>{{displayName}} · {{company}}</p>' },
    ]);
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it('picks the first signature whose audience includes the person', async () => {
    expect((await signatureFor(h.ctx, alice))?.name).toBe('Sales');
    expect((await signatureFor(h.ctx, bob))?.name).toBe('Everyone');
  });

  it('adds “apps” signatures to SMTP submissions, once', async () => {
    const submit = createTransport({ host: '127.0.0.1', port: h.ports.submission, secure: false, ignoreTLS: true, auth: { user: 'alice@acme.test', pass: 'alice password 123' } } as never);
    await submit.sendMail({ from: 'alice@acme.test', to: 'x@partner.example', subject: 'From Thunderbird', text: 'Hello', html: '<html><body><p>Hello</p></body></html>' });
    await submit.sendMail({ from: 'alice@acme.test', to: 'x@partner.example', subject: 'Already signed', text: 'Hi\n\n-- \nalice\nHead of Sales\nT: 020 7946 0000\n' });
    const decode = (raw: string) => [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g)].map((m) => Buffer.from(m[1]!.replace(/\s/g, ''), 'base64').toString()).join('\n');
    const first = await h.waitFor(async () => h.relay.received.find((r) => r.raw.toString().includes('Subject: From Thunderbird')));
    const body = decode(first.raw.toString());
    expect(body).toContain('-- \r\nalice\r\nHead of Sales\r\nT: 020 7946 0000');
    expect(body).toMatch(/<div class="forge-signature"[^>]*><p><strong>alice<\/strong><br>Head of Sales<br>T: 020 7946 0000<\/p><\/div><\/body>/);
    const second = await h.waitFor(async () => h.relay.received.find((r) => r.raw.toString().includes('Subject: Already signed')));
    expect(second.raw.toString()).not.toContain('Content-Transfer-Encoding: base64');
  });
});
