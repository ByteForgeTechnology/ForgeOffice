import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { JOIN_PREFIX, joinCode, joinInfo } from '../src/services/join';

const multi = {
  NODE_ENV: 'production',
  FORGE_PUBLIC_URL: 'https://office.example.com',
  FORGE_MAIL_HOSTNAME: 'mail.example.com',
  DATABASE_URL: 'postgres://forge:s3cret%2Fpass@10.0.0.10:5432/forge',
  FORGE_SECRET: 'a'.repeat(64),
  FORGE_STORE_NODES: 'http://10.0.0.31:8096,http://10.0.0.32:8096',
  FORGE_STORE_REPLICAS: '2',
  FORGE_IMAGE: 'forgeoffice/app:0.1.0-build-3',
};

const decode = (code: string) =>
  Object.fromEntries(
    gunzipSync(Buffer.from(code.slice(JOIN_PREFIX.length), 'base64'))
      .toString()
      .trim()
      .split('\n')
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );

describe('join code for another server', () => {
  it('holds what the installer needs, in its format', () => {
    const config = loadConfig(multi);
    expect(joinInfo(config)).toMatchObject({ available: true, databaseHost: '10.0.0.10', release: '0.1.0-build-3', replicas: 2 });
    const code = joinCode(config);
    expect(code).toMatch(/^FORGEJOIN1:[A-Za-z0-9+/=]+$/);
    expect(decode(code)).toEqual({
      FORGE_PUBLIC_URL: 'https://office.example.com',
      FORGE_MAIL_HOSTNAME: 'mail.example.com',
      POSTGRES_PASSWORD: 's3cret/pass',
      FORGE_SECRET: 'a'.repeat(64),
      FORGE_DB_HOST: '10.0.0.10',
      FORGE_STORE_NODES: 'http://10.0.0.31:8096,http://10.0.0.32:8096',
      FORGE_STORE_REPLICAS: '2',
      FORGE_IMAGE: 'forgeoffice/app:0.1.0-build-3',
    });
  });

  it('is not offered when the install lives on one server', () => {
    const express = loadConfig({ ...multi, DATABASE_URL: 'postgres://forge:x@db:5432/forge', FORGE_STORE_NODES: 'http://store:8096' });
    expect(joinInfo(express)).toMatchObject({ available: false, reason: expect.stringContaining('one server') });
    expect(() => joinCode(express)).toThrow();
    expect(joinInfo(loadConfig({ ...multi, FORGE_SECRET: '' })).reason).toContain('FORGE_SECRET');
    expect(joinInfo(loadConfig({ ...multi, FORGE_STORE_NODES: 'http://store:8096' })).available).toBe(false);
  });
});
