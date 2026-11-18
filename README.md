# ForgeOffice

Self-hosted, subscription-free productivity suite. This repository contains **Phase 1: Foundation, Identity & Unified Shell**: the monorepo, shared packages, database schema, OIDC identity provider, Docker volume layout, web portal and admin center. Mail, Drive and Team (phases 2–4) plug into this foundation.

## Quick start (Docker)

```bash
cp .env.example .env          # set FORGE_PUBLIC_URL and POSTGRES_PASSWORD
docker compose up -d --build
docker compose logs api | grep -A3 "setup token"
```

Open `FORGE_PUBLIC_URL`, enter the setup token, and complete the wizard (organisation, domain, branding, policies, first administrator). The token is single-use; it is also stored in the `forge_certs` volume as `setup-token` until setup completes.

For HTTPS with automatic Let's Encrypt certificates, set `FORGE_DOMAIN` and `FORGE_PUBLIC_URL=https://<domain>` and run `docker compose --profile tls up -d`.

## Development

Requires Node.js 24+ and pnpm (`corepack enable`).

```bash
pnpm install
pnpm dev            # API on :8080 + Vite on :5173 — open http://localhost:5173
```

No database server is needed for development: the API defaults to embedded PostgreSQL ([PGlite](https://pglite.dev)) and stores everything under `./.data`. Redis is optional; without it, queues, backups and the worker are disabled and the admin console says so. For the full stack:

```bash
docker compose up -d db redis
export DATABASE_URL=postgres://forge:<password>@localhost:5432/forge REDIS_URL=redis://localhost:6379
pnpm dev            # and in another terminal:
pnpm dev:worker
```

In development the browser only talks to Vite, which proxies `/api`, `/oidc`, `/interaction` and `/socket.io` to the API, so the OIDC issuer is `http://localhost:5173/oidc`.

| Command | |
|---|---|
| `pnpm typecheck` | Type-check every package |
| `pnpm test` | API end-to-end tests (real HTTP + OIDC flow on PGlite) and worker backup test |
| `pnpm build` | Build web, API and worker bundles |
| `pnpm db:generate` | Generate a SQL migration after editing `packages/db/src/schema.ts` |

## Layout

```
apps/
  api/      Fastify API + oidc-provider + Socket.IO; serves the built web client
  worker/   BullMQ worker: backups and scheduled maintenance
  web/      React + Vite + Tailwind SPA: portal, sign-in, setup wizard, admin center
packages/
  db/       Drizzle schema, migrations, Postgres/PGlite connection
  auth/     RBAC permissions & roles, argon2id, TOTP + recovery codes, JWT verification
  storage/  Content-addressable SHA-256 blob store on node:fs streams, volume statfs
  events/   Typed BullMQ queues, Redis pub/sub event bus, service heartbeats
  ui/       Shared React components (buttons, dialogs, tables, app launcher, theming)
docker/     Dockerfile and Caddyfile
```

## Architecture

**Identity.** The API hosts an OpenID Connect provider (`oidc-provider`) at `/oidc`. The web client signs in with authorization code + PKCE and receives:

- an ES256-signed JWT access token with audience `<public url>/api` (15 minutes)
- a rotating refresh token (14 days)
- an ID token carrying profile, `org_id`, `roles` and `amr`

Signing keys are generated on first boot into `forge_certs/oidc/jwks.json`. ForgeOffice apps are first-party clients and skip the consent screen. Other applications can be registered with `FORGE_OIDC_CLIENTS` and then see a consent page.

**Sign-in steps.** Sign-in proceeds in this order:

1. Password, hashed with argon2id (OWASP parameters, transparent rehash). Five failures lock the account for 15 minutes.
2. TOTP code or a single-use recovery code. TOTP replay is blocked.
3. Forced TOTP enrolment, when the organisation or the user requires MFA.
4. Forced password change, when an administrator issued a temporary password.

Each step is persisted on the provider's interaction, so nothing is held in API memory.

**Authorisation.** Every API request re-loads the user, so suspension or a role change takes effect immediately. Permissions are coarse `resource:action` strings bundled into roles. Five roles are built in: global admin, user admin, helpdesk, auditor and system operator. Custom roles are also supported.

Privilege escalation is blocked in three ways:

- You can only grant permissions you hold.
- You can only manage users whose permissions you fully hold.
- The last active global administrator cannot be removed, suspended or deleted.

**Audit.** Sign-ins (successful and failed), lockouts, MFA changes, every administrative mutation and every permission denial are written to `audit_log`. New entries stream to the admin console over Socket.IO, and the log can be filtered and exported as CSV.

**Storage.** All binary data lives on the POSIX filesystem in Docker named volumes; there is no object storage. `@forge/storage` streams writes to a temp file while hashing, fsyncs, then atomically renames to `<root>/ab/cd/<sha256>`, so identical content is stored once. Reference counts live in the `blobs` table. Phase 1 uses it for organisation logos.

**Admin center.** The admin center includes:

- Live health of the API, database, Redis and worker (heartbeats), pushed every 5 s.
- Per-volume filesystem usage (`statfs`) and scanned content size.
- BullMQ queue counts and jobs, with retry, remove, pause, resume and clean.
- Optional Docker container status, using the read-only Engine API socket.
- One-click backups.

**Backups.** The worker writes `pg_dump` (custom format) plus a `tar.gz` per data volume and a `manifest.json` with SHA-256 checksums into `forge_backups/forge-<timestamp>.partial/`. It renames the directory only once complete. Backups run nightly (`FORGE_BACKUP_SCHEDULE`) and the last `FORGE_BACKUP_RETENTION` are kept.

Scheduled maintenance purges soft-deleted users after 30 days and removes expired OIDC artefacts. It also applies audit-log retention and rescans volume usage every 15 minutes.

### Docker volumes

| Volume | Mounted at | Contents |
|---|---|---|
| `forge_db_data` | postgres | Database files |
| `forge_redis_data` | redis | AOF persistence, BullMQ state |
| `forge_mail_data` | `/data/mail` | Mail (phase 2) |
| `forge_drive_data` | `/data/drive` | Blobs: logos now, Drive files in phase 3 |
| `forge_team_media` | `/data/team` | Team media (phase 4) |
| `forge_certs` | `/data/certs` | OIDC signing keys, master secret, setup token, TLS certificates |
| `forge_backups` | `/data/backups` | Backup snapshots |

`forge_certs` holds the master secret that encrypts TOTP secrets. Back it up together with the database: one without the other cannot restore MFA.

## API

OpenAPI documentation is served at `/api/docs`. Main route groups:

- `/api/v1/setup`, `/api/v1/branding`: first-run setup and public branding
- `/api/v1/me`: profile, password, TOTP enrolment, recovery codes
- `/api/v1/directory`: people and group search for all signed-in users (powers global search)
- `/api/v1/admin/{users,groups,domains,roles,org,audit,system}`: admin center

## Not yet implemented

- External IdP federation (signing in to ForgeOffice with another OIDC/SAML provider)
- Self-service password reset by email (needs ForgeMail)
- A restore command for backups (planned for `forge-cli` in phase 5)
- Group nesting and group-based role assignment
