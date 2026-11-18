import { expect, it } from 'vitest';
import { Client, signIn, startServer } from './harness';

it('RP-initiated logout ends the provider session', async () => {
  const server = await startServer();
  try {
    const c = new Client(server.baseUrl);
    await c.post('/api/v1/setup', {
      setupToken: 'test-setup-token',
      organization: { name: 'Acme', timezone: 'UTC', defaultQuotaBytes: 1, requireMfa: false },
      domain: 'acme.example',
      admin: { username: 'admin', displayName: 'Admin', password: 'correct horse battery staple' },
    });
    const login = async ({ uid, client }: any) => client.post(`/interaction/${uid}/login`, { email: 'admin', password: 'correct horse battery staple' });
    const { tokens } = await signIn(c, login);

    const q = new URLSearchParams({ id_token_hint: tokens.id_token, post_logout_redirect_uri: `${server.baseUrl}/signed-out`, client_id: 'forge-web' });
    const page = await c.get(`/oidc/session/end?${q}`);
    expect(page.status).toBe(200);
    const nonce = /nonce="([^"]+)"/.exec(page.text)![1]!;
    expect(page.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`);
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(page.text)![1]!;
    const confirm = await c.request('POST', '/oidc/session/end/confirm', { form: { xsrf, logout: 'yes' } });
    expect(confirm.headers.get('location')).toBe(`${server.baseUrl}/signed-out`);

    // The next authorization must ask for credentials again.
    const { stepResponses } = await signIn(c, login);
    expect(stepResponses).toHaveLength(1);
  } finally {
    await server.close();
  }
});
