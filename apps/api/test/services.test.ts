import { afterAll, describe, expect, it } from 'vitest';
import { startServer } from './harness';

const servers: Awaited<ReturnType<typeof startServer>>[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
});

async function only(service: string) {
  // Its own database here; in production every service shares PostgreSQL and the directory service migrates it.
  const s = await startServer({ FORGE_SERVICES: service, FORGE_MIGRATE: 'true', FORGE_MAIL_EMBED: 'false' });
  servers.push(s);
  return s;
}

describe('one service per container', () => {
  it('the mail service serves mail routes only', async () => {
    const s = await only('mail');
    const services = new Set(s.app.routeOwners.values());
    expect([...services]).toEqual(['mail']);
    expect((await fetch(`${s.baseUrl}/api/v1/mail/mailboxes`)).status).toBe(401);
    expect((await fetch(`${s.baseUrl}/api/v1/admin/users`)).status).toBe(404);
    expect((await fetch(`${s.baseUrl}/oidc/.well-known/openid-configuration`)).status).toBe(404);
    expect((await fetch(`${s.baseUrl}/readyz`)).status).toBe(200);
    // No web pages outside the directory service.
    expect((await fetch(`${s.baseUrl}/interaction/x`, { headers: { accept: 'text/html' } })).status).toBe(404);
  }, 120_000);

  it('the calendar service also serves CalDAV; contacts serves CardDAV; tasks only tasks', async () => {
    const cal = await only('calendar');
    expect(new Set(cal.app.routeOwners.values())).toEqual(new Set(['calendar']));
    expect((await fetch(`${cal.baseUrl}/dav/`, { method: 'PROPFIND' })).status).toBe(401);
    const contacts = await only('contacts');
    expect((await fetch(`${contacts.baseUrl}/api/v1/contacts`)).status).toBe(401);
    expect((await fetch(`${contacts.baseUrl}/dav/addressbooks/`, { method: 'PROPFIND' })).status).toBe(401);
    expect((await fetch(`${contacts.baseUrl}/api/v1/calendar/calendars`)).status).toBe(404);
    const tasks = await only('tasks');
    expect([...new Set(tasks.app.routeOwners.values())]).toEqual(['tasks']);
  }, 120_000);

  it('the directory service hosts sign-in', async () => {
    const d = await only('directory');
    expect((await fetch(`${d.baseUrl}/oidc/.well-known/openid-configuration`)).status).toBe(200);
    expect((await fetch(`${d.baseUrl}/api/v1/mail/mailboxes`)).status).toBe(404);
  }, 120_000);

  it('rejects unknown service names', async () => {
    await expect(startServer({ FORGE_SERVICES: 'mail,nonsense' })).rejects.toThrow(/Unknown FORGE_SERVICES/);
  });
});
