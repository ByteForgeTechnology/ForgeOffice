![Logo](images/Logo.jpeg)   
# ForgeOffice

Self-hosted, subscription-free productivity suite.

## Introduction

I have been very inspired by the work of [Artcraft](https://github.com/storytold). I think the work they are doing is amazing and I wanted to do the same but instead of the desktop apps, I am taking on the managed services. Here is my first shot!

> [!WARNING]
> This project is very much pre-alpha, please be careful using this in production!

## What I have done so far

- **Phase 1 – Foundation, Identity & Unified Shell:** monorepo, OIDC identity provider, users/groups/RBAC, audit log, web portal and admin center.
- **Phase 2 – ForgeMail:** SMTP and IMAP servers written in Node.js, webmail, server-side rules, auto-replies, quarantine, calendars and contacts with CalDAV/CardDAV, meeting rooms and free/busy.
- **Phase 3 – ForgeDrive & ForgeSites:** file libraries with resumable uploads, de-duplicated storage, versions, a recycle bin, inherited permissions, sharing links, check-out, previews, full-text search, optional virus scanning (ClamAV) and Office editing (Euro-Office); intranet sites with pages, news and widgets.
- **Phase 4 – ForgeTeam:** teams and channels (public and private), one-to-one and group chats, threads, reactions, mentions, markdown, files kept in Drive, presence synced with calls and the calendar, and audio/video meetings with screen sharing, guests (via a lobby) and recording, on a mediasoup SFU.
- **Several machines and installers:** run any part of ForgeOffice on several servers (plain Docker or Docker Swarm), with replicated storage nodes and several meeting servers; a release package with a menu-driven installer offering an express install (everything on one server) or a custom one (choose the parts; start a new ForgeOffice or join an existing one).

## Still left todo
- **ForgeManage:** A mobile device manager component that will allow you to control, patch, policy and deploy software. (Similar to Intune)
- **Desktop client:** Build a desktop client that will sign in the user on a desktop and all the apps. It should include notifications from ForgeTeam.

## Installing on a server

Build a release (on a machine with Docker and this source):

```bash
build/build.sh          # → dist/forgeoffice-<version>-build-<n>-<arch>.zip
```

The zip holds the image, the compose files, `install.sh`, `uninstall.sh` and `INSTALL.txt`. GitHub Actions ([.github/workflows/build.yml](.github/workflows/build.yml)) builds one on every push to `main`. It commits the build number it used back to `main` (`Build <n> [skip ci]`). It then publishes a GitHub release tagged `v<version>-build-<n>`, holding the zip and its SHA-256 checksum, with install instructions and the changes since the last release. Copy it to the server, then:

```bash
unzip forgeoffice-*.zip && cd forgeoffice-*/
sudo ./install.sh
```

The installer installs Docker if needed and asks how ForgeOffice should run:

- **Express:** everything on this server. It asks:
  - how people reach it: your own domain with HTTPS (a Let's Encrypt certificate, renewed automatically), or a port such as `http://<server IP>:8080`;
  - the mail server's host name and the mail ports;
  - the address browsers send meeting audio and video to;
  - whether to add virus scanning (ClamAV) and Office editing (Euro-Office, which gets its own `docs.` domain over HTTPS).
- **Custom:** the parts you tick, for spreading ForgeOffice over several servers (see [Several machines](#several-machines)).
  - **A new ForgeOffice:** this server keeps the database and writes a join code to `/opt/forgeoffice/join-code.txt`.
  - **Join:** paste the join code, or give the path of a copy of `join-code.txt`. The installer checks it can reach the database and that both servers run the same release.
  - **The gateway's server** also asks which other servers run the web apps, the Directory and the app back ends, and balances requests between them.

It generates the passwords, master secret and setup token, writes them to `/opt/forgeoffice/.env` (readable by root only), checks the ports it needs are free, loads the image, and starts the containers. When they answer, it shows the address and setup token. Everything it does is logged to `/var/log/forgeoffice-install.log`.

**Adding a server later.** Admins with the *system:manage* permission can show the join code in the admin center: **Organisation → Servers & storage → Add a server**. Each time it's shown, that's recorded in the audit log. The code holds the database password and the master secret, so keep it secret. Express installs can't be joined, because their database is only reachable inside the one server; the card says so.

**Running `install.sh` again** on an installed server offers to:
- upgrade to the newer release, keeping the data (on several servers, upgrade every one, starting with the server that runs the Directory);
- show the join code;
- change the other servers the gateway uses (when this server runs the gateway).

**Removing.** `uninstall.sh` removes ForgeOffice and keeps its data, or deletes everything after you type `DELETE`. It warns when the server holds the database other servers use, or is a storage node that should be retired first. Docker itself is left alone.

**Building for other servers.** `build/build.sh --platform linux/arm64` builds for ARM servers; the installer refuses a release made for another kind of server. Each run bumps `build/BUILD_NUMBER` (`--same-build` skips that).

> [!NOTE]
> Installs use the Docker Compose project name `forgeoffice`, the same as this repository's `docker-compose.yml`. On a machine that already runs a development copy, the installer finds its data and offers to delete it. Its default is to stop and change nothing. Try the installer on a separate server or VM.

**Plain HTTP works for trying ForgeOffice out**, including on a LAN address. Browsers withhold some security features from plain-HTTP pages, so the web apps bring their own fallbacks for sign-in. Cameras and microphones are a different matter: browsers only allow them over HTTPS, or on the server itself, so use HTTPS for meetings.

## Quick start (Docker)

```bash
cp .env.example .env          # set FORGE_PUBLIC_URL and POSTGRES_PASSWORD
docker compose up -d --build
docker compose logs directory | grep -A3 "setup token"
```

ForgeOffice runs as one container per component, all from one image. Browsers, phones and desktop apps use the **gateway** (`FORGE_PUBLIC_URL`, port 8080), which sends each request to the container that serves it:

| Container | Port | What it does |
|---|---|---|
| `gateway` | 8080 | One address for everything (Caddy; config generated from the code) |
| `portal-web` | 8081 | Web: home, account, sign-in and setup pages |
| `mail-web` | 8082 | Web: webmail |
| `calendar-web` | 8083 | Web: calendar |
| `contacts-web` | 8084 | Web: contacts |
| `tasks-web` | 8085 | Web: tasks |
| `admin-web` | 8086 | Web: admin center |
| `drive-web` | 8087 | Web: ForgeDrive, and the pages behind sharing links |
| `sites-web` | 8088 | Web: ForgeSites |
| `team-web` | 8089 | Web: ForgeTeam (chat, channels, meetings) |
| `directory` | 8091 | ForgeDirectory: sign-in (OpenID Connect), users, groups, roles, organisation, audit, real-time updates; applies database migrations |
| `mail-api` | 8092 | ForgeMail back end: webmail API, mail admin (transport rules, signatures, smarthost…) |
| `calendar-api` | 8093 | Calendars, scheduling, CalDAV |
| `contacts-api` | 8094 | Contacts, CardDAV |
| `tasks-api` | 8095 | Tasks |
| `store` | 8096 | Storage node: mail, Drive files (with previews and uploads in progress) and meeting recordings. The only container that writes `forge_mail_data`, `forge_drive_data` and `forge_team_media` |
| `team-api` | 8098 | ForgeTeam back end: messages, presence and meeting signalling (Socket.IO at `/team-socket`) |
| `media` | 8099, 40000–40099 UDP/TCP | Meeting server (mediasoup SFU, recording). Browsers connect to it directly on the media ports |
| `drive-api` | 8097 | ForgeDrive and ForgeSites back end: files, versions, permissions, links, search, WOPI for Office editing |
| `smtp` | 25, 587, 465 | Receiving mail and submission from mail apps |
| `imap` | 143, 993 | Mail apps (IMAP) |
| `worker` | – | Outgoing delivery queue, virus scans and previews of Drive files, backups, maintenance |
| `clamav` *(profile `av`)* | – | Optional virus scanning of Drive uploads |
| `office` *(profile `office`)* | 9980 | Optional Euro-Office Document Server, for editing Office documents in the browser |
| `db`, `redis` | – | PostgreSQL (shared by the services) and Redis (queues, events, heartbeats) |

The web, back-end and storage ports are published on `127.0.0.1` only. Set `FORGE_SERVICE_BIND=0.0.0.0` to expose them, but browsers should always go through the gateway: it keeps sign-in and the apps on one origin. SMTP and IMAP are published on all interfaces from their own containers. SMTP, IMAP, the webmail back end and the worker store and read messages through the `store` container (still reachable as `mail-store`), using a service token derived from the master secret. The worker also mounts the mailbox volume read-only, for backups and usage scans.

`docker/gateway/Caddyfile` is generated from the routes each service registers, and a test fails if it is out of date. Regenerate it with `UPDATE_GATEWAY=1 pnpm --filter @forge/api test gateway`. The same image still runs everything in one process (`FORGE_SERVICES=all`, the default), which is used in development and tests.

Open `FORGE_PUBLIC_URL`, enter the setup token, and complete the wizard (organisation, domain, branding, policies, first administrator). The token is single-use; it is also stored in the `forge_certs` volume as `setup-token` until setup completes.

**Optional Drive extras.** For virus scanning, set `FORGE_CLAMAV=clamav:3310` in `.env` and start with `docker compose --profile av up -d` (ClamAV needs about 1.5 GB of memory). For Office editing, set `FORGE_OFFICE_URL` to an address browsers can reach (`http://localhost:9980` on one machine) and start with `--profile office`. Also set `FORGE_OFFICE_JWT_SECRET` (`openssl rand -hex 32`), which the document server and drive-api share to sign the editor config and save callbacks. Euro-Office fetches and saves files by calling `drive-api` directly (`FORGE_WOPI_URL`, default `http://drive-api:8097`), and drive-api reaches it at `http://office` (`FORGE_OFFICE_INTERNAL_URL`). It needs 2–4 GB of memory. Collabora Online works too, over WOPI (`FORGE_OFFICE_PROTOCOL=wopi`). Admin → ForgeDrive → Settings shows whether each is working.

**Meetings.** Browsers send audio and video straight to the `media` container on ports 40000–40099 (UDP, with TCP as a fallback), which are published on every interface. Cameras and microphones need HTTPS, except in a browser on the server itself. Set `FORGE_RTC_ANNOUNCED_IP` in `.env` to the server's address as other computers reach it: its LAN IP on an office network, or its public IP with those ports forwarded. Without it, only browsers on the server itself can join. Admin → ForgeTeam → Meetings & policies shows the setting.

For HTTPS with automatic Let's Encrypt certificates, set `FORGE_DOMAIN` and `FORGE_PUBLIC_URL=https://<domain>` and run `docker compose --profile tls up -d`. Caddy terminates TLS in front of the gateway. Also set `FORGE_HTTP_BIND=127.0.0.1`, so the gateway's own port is only reachable through Caddy. More HTTPS sites (for example the Office editor on its own domain) go in `docker/sites/*.caddy`.

**Ports.** `FORGE_HTTP_PORT` moves the gateway (default 8080). `FORGE_SMTP_HOST_PORT`, `FORGE_SUBMISSION_HOST_PORT`, `FORGE_SUBMISSIONS_HOST_PORT`, `FORGE_IMAP_HOST_PORT` and `FORGE_IMAPS_HOST_PORT` move the mail ports, for example when another mail server already uses them. Other mail servers only deliver to port 25.

## Several machines

ForgeOffice can spread over several machines, and run several copies of any service for load balancing:

- **Stateless services** run any number of copies behind the gateway: `directory`, `mail-api`, `calendar-api`, `contacts-api`, `tasks-api`, `drive-api`, `team-api`, the web apps, `smtp`/`imap` and `worker`. They share Postgres and Redis. Real-time events fan out through Redis, and files are on the storage nodes. Migrations take a database lock, so several `directory` copies can start together.
- **Storage nodes** (`store`) keep mail, Drive files, previews and recordings on their own disks. Run one on every machine that should hold data. Each file is kept on `FORGE_STORE_REPLICAS` nodes (default 2), and reads fall back to another copy if a node is down.
  - Nodes announce themselves in Redis, so a new node is used straight away.
  - Every 10 minutes the worker's `storage-repair` job checks copies:
    - it records files a node already holds (for example data from before the cluster);
    - it makes missing copies (after adding a node, or after losing one);
    - it empties nodes you retire.
  - Admin → Organisation → **Servers & storage** shows each node's space and files. It's also where you retire a node, or forget one that's gone for good.
  - Backups ask each node for an archive of its share.
- **Media servers** (`media`) each host whole meetings. A new meeting goes to the least busy live server. `team-api` passes each meeting's signalling to its server through Redis, and browsers send audio and video straight to the server's address.
  - `FORGE_RTC_PORT=40000` runs every call on one UDP and TCP port, which is easier to open in a firewall.
  - `FORGE_RTC_ANNOUNCED_IP`, or `FORGE_RTC_ANNOUNCED_MAP` with `FORGE_NODE_HOSTNAME`, says where browsers reach each server.
- **Keys and certificates** are kept in the database, encrypted with the master secret. That covers the sign-in signing keys, DKIM keys, the SMTP/IMAP TLS certificate and the setup token. Every machine copies them into its own `forge_certs`, so the volume needn't be shared. **Every machine must have the same `FORGE_SECRET`**; a machine with a different one refuses to start and says so.
- **The gateway** sends each service's requests to `{$FORGE_UPSTREAM_<SERVICE>:<container>}`. List several addresses (`FORGE_UPSTREAM_MAIL_API="10.0.0.21:8092 10.0.0.22:8092"`) and it balances between them (least busy first, health-checked at `/healthz`).
- **Postgres and Redis** run once. Use your own replicated Postgres and Redis (and point `DATABASE_URL` and `REDIS_URL` at them) if you need those to survive a machine failing.

Two ways to deploy:

**Docker Swarm** (`docker-stack.yml`, the same machines managed as one): label the machines (`forge.db`, `forge.store`, `forge.media`, `forge.mail`), push the image to a registry, then `set -a; . ./.env; set +a; docker stack deploy -c docker-stack.yml forge`. Each service has a `replicas` setting (`FORGE_MAIL_API_REPLICAS`, …), or use `docker service scale forge_mail-api=3`. Storage nodes, media servers and SMTP/IMAP run one per labelled machine.

**The installer** (Custom) sets up plain Docker on each server for you, as described in [Installing on a server](#installing-on-a-server).

**Plain Docker by hand** (`deploy/multi-host/`): every machine runs the same compose file with its own `.env`, see `env.example`. `COMPOSE_PROFILES` chooses what each machine runs: `data`, `gateway`, `web`, `directory`, `apps`, `mail`, `store`, `media` or `worker`. Add `tls` on the gateway's machine for HTTPS, with `FORGE_DOMAIN` and `FORGE_HTTP_BIND=127.0.0.1`. For more copies, run a role on more machines and list them in the gateway machine's `FORGE_UPSTREAM_*`.

A single machine needs none of this: `docker compose up -d` runs one of everything, with one storage node and one media server.

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

In development the API also runs the mail listeners in-process, on unprivileged ports without TLS:

| Service | Port |
|---|---|
| SMTP inbound | 2525 |
| SMTP submission | 2587 |
| IMAP | 2143 |

Point Thunderbird at `localhost` to try them. Without Redis, outgoing mail is delivered in-process (not durable across restarts).

In development the browser only talks to Vite, which proxies `/api`, `/oidc`, `/interaction` and `/socket.io` to the API, so the OIDC issuer is `http://localhost:5173/oidc`.

| Command | |
|---|---|
| `pnpm typecheck` | Type-check every package |
| `pnpm test` | Real-HTTP API tests (OIDC, admin, webmail, calendar, CalDAV/CardDAV), real IMAP/SMTP client tests, worker backup test — all on PGlite |
| `pnpm build` | Build the web apps (one bundle per app, plus `all`), the API, worker, mail server and mail-store |
| `pnpm --filter @forge/mail test:remote-store` | Run the mail tests through a real mail-store service |
| `pnpm db:generate` | Generate a SQL migration after editing `packages/db/src/schema.ts` |

## Layout

```
apps/
  api/        Fastify back-end services (FORGE_SERVICES=directory|mail|calendar|contacts|tasks|drive|team|media|all), oidc-provider, Socket.IO, CalDAV/CardDAV; gateway generator
  worker/     BullMQ worker: outbound mail delivery, virus scans, thumbnails, backups, scheduled maintenance
  mailserver/ SMTP (25/587/465) and IMAP (143/993) listeners (FORGE_MAIL_ROLE=smtp|imap)
  mailstore/  Storage node ("store"): mail, Drive and recordings over authenticated HTTP; any number of nodes
  web/        React + Vite + Tailwind web apps (portal, mail, calendar, contacts, tasks, drive, sites, team, admin), built one bundle per app; serve.mjs serves one app per container
packages/
  db/       Drizzle schema, migrations, Postgres/PGlite connection
  auth/     RBAC permissions & roles, argon2id, TOTP + recovery codes, JWT verification
  storage/  Content-addressable SHA-256 blob store, storage nodes and the replicated cluster client, volume statfs
  events/   Typed BullMQ queues, Redis pub/sub event bus, service heartbeats
  mail/     Mail engine: MIME parsing, mailbox store, delivery, rules, spam, DKIM, IMAP & SMTP servers
  calendar/ iCalendar/vCard handling, calendar & contact storage, iTIP scheduling, free/busy
  drive/    Drive engine: libraries, items, versions, ACL, uploads, locks, tokens, ClamAV, previews and PDF text
  ui/       Shared React components (buttons, dialogs, tables, app launcher, theming)
  team/     ForgeTeam engine: teams, channels, messages, presence, mediasoup SFU, recording, media cluster
build/      Release builder (build.sh), installer (install.sh), uninstaller (uninstall.sh) and INSTALL.txt
deploy/     multi-host/: one compose file for plain Docker on several machines, with env.example
docker/     Dockerfile, gateway/Caddyfile (generated), the optional TLS Caddyfile and its extra sites (sites/*.caddy)
docker-stack.yml  Docker Swarm deployment
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

**Admin center.** The sidebar is grouped by product:

| Section | Pages |
|---|---|
| Overview | System health, storage, queues, backups |
| ForgeDirectory | Users, Groups, Roles, Sign-in & security |
| ForgeMail | Shared mailboxes, Mail flow, Transport rules, Blocked & allowed, Signatures, Mail settings |
| ForgeCalendar | Rooms & resources |
| Organisation | Settings (name, branding, storage), Domains, Audit log |

ForgeDrive and ForgeTeam are listed as coming in phases 3 and 4. Each person only sees the pages their roles allow. Old admin addresses (such as `/admin/users/<id>`) redirect to their new place.

The Overview includes:

- Live health of the API, database, Redis and worker (heartbeats), pushed every 5 s.
- Per-volume filesystem usage (`statfs`) and scanned content size.
- BullMQ queue counts and jobs, with retry, remove, pause, resume and clean.
- Optional Docker container status, using the read-only Engine API socket.
- One-click backups.

**Backups.** The worker writes `pg_dump` (custom format) plus a `tar.gz` per data volume and a `manifest.json` with SHA-256 checksums into `forge_backups/forge-<timestamp>.partial/`. It renames the directory only once complete. Backups run nightly (`FORGE_BACKUP_SCHEDULE`) and the last `FORGE_BACKUP_RETENTION` are kept.

Scheduled maintenance purges soft-deleted users after 30 days and removes expired OIDC artefacts. It also applies audit-log retention and rescans volume usage every 15 minutes.

### ForgeMail

**Storage.** Raw messages are stored once as content-addressed blobs in `forge_mail_data`. Postgres holds per-message metadata:

- flags, UID and modseq for IMAP
- a byte-offset MIME tree, so IMAP section fetches are served as file slices without re-parsing
- a weighted `tsvector` for full-text search
- the thread ID, derived from `References` and `In-Reply-To`

**Inbound (port 25).** Recipients are checked at RCPT: users, aliases, sub-addressing (`user+tag@`), distribution lists, rooms and per-domain catch-alls. Open relaying is refused.

Messages are checked with SPF, DKIM and DMARC (`mailauth`) and scored by a small rule set:

- **Spam** goes to Junk.
- **DMARC failures under `p=reject`** are held in an admin quarantine.

After that, each recipient's server-side rules run (move, mark read, flag, delete, forward). Out-of-office replies follow RFC 3834: one per sender per four days, never to lists or robots, sent from the null sender.

**Submission (587/465) and webmail.** Senders must authenticate and may only use their own addresses: primary, aliases, or lists they own.

Each outgoing message is processed as follows:

1. It is DKIM-signed with a per-domain key generated automatically into `forge_certs/dkim`.
2. It is queued on BullMQ. Webmail sends are held for the undo window or until the scheduled time.
3. The worker delivers it directly to the recipient's MX with opportunistic TLS, or through a smarthost (see below).
4. Failures are retried with exponential backoff (8 attempts).
5. If delivery finally fails, a non-delivery report goes to the sender's inbox.

**IMAP.** IMAP4rev1 with LITERAL+, IDLE (push via Redis pub/sub), UIDPLUS, MOVE, SPECIAL-USE, NAMESPACE, STARTTLS and AUTH=PLAIN. It works with Thunderbird, Apple Mail, iOS, Android and Outlook.

**Shared mailboxes.** Admin → ForgeMail → Shared mailboxes creates team addresses such as `sales@`. They have their own folders, storage, rules and auto-reply, but no one can sign in to them. Admins grant people or security groups:

- **Full access:** read, file, flag, delete, manage folders.
- **Read only.**
- **Send as:** From is the shared address.
- **Send on behalf:** From is the shared address and Sender is the person.

Members can open a shared mailbox in two places:

- **Webmail:** pick it in the mailbox switcher; replies and new mail default to its address.
- **IMAP apps:** it appears under `Shared/<address>/`. Read-only grants are enforced as `READ-ONLY`, and messages can be moved between your own and shared folders.

Mail sent from a shared address is saved in that mailbox's Sent folder. The same grants cover the mailbox's **calendar and contacts**: full access edits them, read-only views them, in the web apps and over CalDAV/CardDAV. In a shared calendar, members act as the mailbox: invitations go out from its address (with `SENT-BY` when the member only has "on behalf" rights), replies come back to it, and members can answer invitations sent to it. Permission changes take effect immediately and are audited.

**Sharing single folders.** Any mail folder, calendar or address book can be shared with specific people or security groups, without sharing the whole mailbox. You can share your own, and those of a shared mailbox you have full access to.

| What | Levels |
|---|---|
| Mail folders | Read (view), Write (also flag, mark read, file messages in/out), Full (also delete) |
| Calendars | Free/busy, Read, Write |
| Address books | Read, Write |

Shared folders appear in the webmail mailbox switcher as "(shared folders)" and in IMAP apps under `Shared/<owner>/…`. Deleting and expunging need Full. Every share change is audited.

**Free/busy** shows event titles and locations to anyone who can read the calendar (directly, or through a shared-mailbox grant), and plain busy blocks to everyone else.

**Reminders** are a per-person setting on each calendar: on by default for your own calendars, off for shared and team ones. Phones and desktop apps only receive alarms (VALARM) for calendars where the setting is on. Edits made from a device that can't see the alarms keep everyone else's reminders intact.

**Transport rules.** Admin → ForgeMail → Transport rules sets organisation-wide policies for mail in transit. Each rule has conditions (all must match), exceptions (any one skips the rule) and actions:

- **Conditions:** sender, recipient, location (inside or outside the organisation), group membership, subject or body words, headers, attachments, size and spam score.
- **Actions:** prefix the subject, set an `X-` header, append a disclaimer, Bcc, redirect, deliver to Junk, quarantine, reject with a message, or silently delete.

Rules run in the listed order and apply to incoming, outgoing, internal or all mail. A rule can stop later rules from running. Outgoing disclaimers are added before DKIM signing. When a user's message is rejected, they see the rule's explanation, both in webmail and in SMTP apps (as a `550 5.7.1` response).

**Test mode** records matches without changing mail, and *Test a message* is a dry run that shows which rules would match and the result. Matches are kept for 30 days. Every rule change is audited.

**Blocked and allowed senders.** Lists of addresses or domains (a domain includes its subdomains). An address overrides its domain, so you can block `example.com` but allow `boss@example.com`.

| Level | Where | Blocked | Allowed |
|---|---|---|---|
| Organisation | Admin → ForgeMail → Blocked & allowed | Refused at SMTP with a bounce | Skips spam filtering (transport rules still apply) |
| Mailbox | Mail settings, or *Block sender* / *Always allow* on a message | Delivered to Junk | Never sent to Junk |

The organisation lists apply to mail from outside. A person's block list overrides the organisation's allow list for their mailbox. Allow entries are ignored for mail that fails DMARC, so forged mail can't use them to get past the spam filter. Your own domains can't be on the organisation's allow list. Organisation changes are audited.

**Email signatures.** Admin → ForgeMail → Signatures has a visual editor for organisation-wide signatures. It supports fonts, sizes, colours, alignment, links, hosted logo images, and tables for laying out a logo beside text.

- **Variables:** `{{displayName}}`, `{{jobTitle}}`, `{{workPhone}}`, `{{website}}` and others are filled from each person's contact details (Admin → ForgeDirectory → Users → Contact details).
- **Empty details:** a line whose variables are all empty for someone is left out, as is a separator such as `|` next to an empty value.
- **Who gets which signature:** each signature applies to everyone or to chosen groups, and the first match in the list wins.
- **Where it's added:** each signature can be inserted in new messages, in replies and forwards, or both, in webmail. It can also be appended by the server to mail sent from desktop and phone apps (skipped when the message already contains it).
- **Preview:** shows the result with sample details or for any person.

**Contact details.** Each person can have a company, office, work and mobile phone, website, postal address and pronouns, set by admins. These details appear in the directory, in the organisation address book on phones and desktop apps (as vCard TEL, ORG, URL and ADR), and in signatures.

**Sign in with ForgeOffice (OAuth 2.0 / OpenID Connect).** Admin → ForgeDirectory → *App registrations* lets other applications (wikis, help desks, Grafana, GitLab, Nextcloud, your own apps) sign people in with their ForgeOffice account.

- **App types:**
  - **Web apps with a server** get a client ID and a client secret. The secret is shown once, stored encrypted, and can be replaced at any time; it is sent with HTTP Basic or form fields.
  - **Single-page and mobile apps** are public clients and must use PKCE (S256).
- **Redirect URIs:** exact matches only. Use https; http is allowed only for localhost, and mobile apps can use reverse-domain schemes such as `com.example.app:/callback`.
- **What an app can see:** the admin chooses from `openid`, `profile`, `email`, `phone`, `groups` (group names) and `offline_access` (refresh tokens, which need `prompt=consent` as OpenID Connect specifies).
- **Who can sign in:** everyone, or members of chosen groups. Access is checked on every sign-in, token refresh and userinfo call, so removing someone from a group takes effect immediately.
- **Consent:** each person approves the app on first use (on a screen showing what it will see), or an admin approves it for everyone.
- **API access:** apps get ID tokens and userinfo access only. Their access tokens are never accepted by the ForgeOffice API, so an app cannot read people's mail, files or calendars.
- **Admin controls:** turning an app off, narrowing its scopes, *Sign everyone out* and deleting it all end its existing tokens and consents.
- **For people:** each person can review and remove apps under Account → *Connected apps*.
- **Audit:** sign-ins (including refused ones), consents and every registration change are audited.

| Endpoint | Path |
|---|---|
| Issuer / discovery | `<public URL>/oidc`, `/oidc/.well-known/openid-configuration` |
| Authorization, token, userinfo | `/oidc/auth`, `/oidc/token`, `/oidc/me` |
| Keys, sign-out, revocation | `/oidc/jwks`, `/oidc/session/end`, `/oidc/token/revocation` |

**Outgoing smarthost.** Admin → ForgeMail → Mail settings can send mail for other organisations through an SMTP relay instead of delivering it directly. Use this when port 25 is blocked, or to send through Microsoft 365, Google Workspace, SendGrid, Mailgun or your ISP.

- **Connection:** host, port and security: STARTTLS (required, usually 587), TLS from the start (465), or none (trusted private networks only). The relay's certificate is always verified.
- **Login:** an optional username and password. The password is stored encrypted with a key derived from the master secret, so the worker can use it, and it is never shown again.
- **Scope:** optionally limit the relay to some recipient domains (including their subdomains); other mail is delivered directly. Mail between your own people is never relayed.
- **Testing:** *Test connection* checks that it can connect and sign in; *Send* delivers a test message through the relay.
- **Failures:** if the relay is unreachable or rejects the login, messages are deferred and retried rather than bounced. The error is shown in the delivery queue.
- **Environment relay:** `FORGE_SMTP_RELAY` still works and is used when the admin smarthost is off, or for domains outside its list.

**Features.** Admin → Organisation → *Features* switches optional products on and off for the whole organisation: ForgeMail, ForgeCalendar, ForgeContacts and ForgeTasks. ForgeDirectory is always on.

- **Hidden in the web apps:** a product that is off disappears from the launcher, the home page and the admin sidebar, and opening its app shows a "turned off" notice.
- **Refused by the services:** its API answers `403 feature_disabled`, and its CalDAV/CardDAV collections are hidden.
- **ForgeMail off:** mail apps can't sign in over IMAP or SMTP, and mail from outside is refused with a bounce. Calendar invitations and task requests between colleagues still work.
- **ForgeTasks off:** flagging an email no longer creates a task.
- **Nothing is deleted:** switching a product back on restores everything. Every container sees a change within a few seconds, and changes are audited.

**Sessions and devices.** Admin → ForgeDirectory → *Sign-in & security* sets two timeouts:

- **Sign in again after:** 8 hours to 90 days; the default is 14 days.
- **Sign out after inactivity:** never, or 15 minutes to 7 days.

They apply to the web app and to apps using *Sign in with ForgeOffice*. Existing sessions follow a change straight away, because the timeouts are checked when tokens are refreshed, when the API is called, and by the sign-in page, which then asks for the password and second factor again.

Under Account → Security, people see each browser and device they're signed in on: browser, system, IP address, apps used, last activity, and when it must sign in again. They can sign out one device, all other devices, or everywhere. Signing a device out takes effect immediately, because access tokens carry their session ID and the API checks it. Admins can see a person's devices and sign them out everywhere from the user's page; suspending an account does the same. App passwords (for mail, calendar and contacts apps) are managed separately. All of this is audited.

**App passwords.** IMAP, SMTP and DAV cannot prompt for a second factor. Once a user has MFA, these protocols only accept app passwords, which the user creates under Account → App passwords.

**DNS.** Admin → Organisation → Domains → *Mail setup* shows the MX, SPF, DKIM and DMARC records to publish and checks them live.

**Tasks.** The Tasks app works like Outlook / Microsoft To Do:

- **Lists:** everyone has a **Tasks** list and a **Flagged email** list, and can add their own. Shared mailboxes have their own lists, visible to their members.
- **Smart views:** Important, Planned and All tasks.
- **Task details:** a due date, a reminder, importance, notes, and repeating (daily, weekdays, weekly, monthly, yearly). Completing a repeating task creates the next one.

Flagged email follows the message flag in both directions:

| You do this | This happens |
|---|---|
| Flag a message (webmail, any IMAP app, or a mail rule) | A task appears in Flagged email, linked to the message |
| Unflag the message | The task is marked complete |
| Flag it again | The same task reopens |
| Complete or reopen the task (web or a phone task app) | The message is unflagged / flagged |
| Delete the task | The message is unflagged |
| Permanently delete the message | The task is removed |

**Assigning tasks** works like Outlook. Pick *Assign to someone* on a task and choose someone in the organisation.

- **The request:** they get a *Task request* email and the task appears under *Assigned to me*, where they accept or decline it.
- **Who changes what:** the person who assigned the task owns its details (title, notes, due date, importance), and changes are sent to the assignee. The assignee owns the progress (not started, in progress, completed). Each change is reported back as a *Task accepted / in progress / completed* email, and the assigner's copy updates.
- **Changing your mind:** reassigning, taking a task back, or deleting it cancels the assignee's copy. If the assignee declines or deletes it, the assigner sees *Declined* and can reassign it or do it themselves.
- **Phones and desktop apps:** this works from task apps over CalDAV too. Completing an assigned task in iOS Reminders reports back the same way.
- **Under the hood:** the messages are standard iCalendar scheduling for to-dos (iTIP REQUEST / REPLY / CANCEL).
- **Limits:** assignment is limited to people in the organisation, repeating tasks and flagged email can't be assigned, and each task has one assignee.

Moving the message between folders keeps the link. Task lists are CalDAV collections of VTODOs, so they sync to iOS Reminders, Thunderbird and Android task apps (via DAVx⁵), and reminders fire there.

**Calendars & contacts.**

- **Native apps.** CalDAV and CardDAV are served at `/dav/`, with `/.well-known` discovery. Supported operations: PROPFIND, calendar-query with time ranges, multiget, sync-collection, conditional PUT/DELETE and MKCALENDAR. The organisation directory appears as a read-only address book.
- **Invitations.** Sent as standard iMIP email, so the same flow works for internal and external attendees. For internal recipients, delivery adds the invitation to the recipient's calendar and applies replies to the organiser's copy.
- **Rooms.** Rooms accept automatically when free and decline double bookings.
- **Calendar views.** The web calendar has day, week and month views, recurrence, team calendars for groups, and a scheduling assistant showing free/busy. Events can carry a ForgeTeam meeting link, which becomes live in Phase 4.

### ForgeDrive

- **Storage.** Files are streamed to `forge_drive_data` and stored once per SHA-256, whoever uploads them. Each upload or save creates an immutable version that points at a blob; blobs are reference-counted and removed when the last version goes. Thumbnails (480 px WebP, made with sharp) live in `.previews/`, partial uploads in `.uploads/`.
- **Uploads and downloads.** Uploads go in 8 MB chunks (`POST /api/v1/drive/uploads`, then `PATCH` with `Upload-Offset`); after a dropped connection the client asks how much arrived and carries on. Downloads support HTTP Range, so video seeks and large downloads resume. File URLs are short-lived signed tokens, so `<img>` and `<video>` work without exposing a session.
- **Processing.** Each new version goes to the `virus-scan` queue (ClamAV over `INSTREAM`), then `thumbnails`, which also extracts text from PDFs (pdf.js) and text files for search. Infected files can't be downloaded, shared or previewed. Without ClamAV, files are marked "not scanned".
- **Permissions.** Each person has a library; security groups and sites each get one too. Roles are Owner, Editor, Commenter and Viewer. Group owners own their group's library and members edit it. Grants on a folder apply to everything inside, unless a folder stops inheriting. Whoever owns a library always keeps access to it.
- **Versions and the recycle bin.** You can restore or delete any earlier version; restoring makes it the newest version and keeps the history. Deleted items go to the recycle bin with their folder structure. They are purged after the organisation's retention period (93 days by default) by the `purge-drive-trash` job.
- **Sharing links.** Links are signed JWTs. They can be view-only or allow downloads, and can have a password, an expiry date and a download limit. Admins can turn off public links or cap how long they last. Links open at `/drive/s/<token>` without signing in.
- **Check-out.** Check-out and the Office editor's locks are held in Redis, so two people can't save over each other. Checking in can add a comment or discard changes.
- **Office editing.** With Euro-Office set up, Drive's **New** menu creates Word, Excel and PowerPoint files, and Office files open in the browser. ForgeDrive uses the ONLYOFFICE Docs API that Euro-Office speaks natively. The browser loads the editor with a config signed with the shared secret. Everyone who opens the same version edits it together in real time. Shortly after the last person closes it, the document server posts to `/api/v1/drive/office/callback/…` and the edited file becomes a new version, saved as the last person who edited it and is still allowed to. Viewers, commenters, files checked out by someone else, and formats Euro-Office can't save back (such as .doc) open read-only. With Collabora Online (`FORGE_OFFICE_PROTOCOL=wopi`), ForgeDrive is a WOPI host instead: CheckFileInfo, GetFile, PutFile and locks.

- **Stars.** Star documents, folders and list items to follow them (Drive → Starred lists everything you've starred). When someone else changes something you starred, you get an email. That covers a new version, rename, move, delete or restore, check-in or out, a comment, a new file in a starred folder, or a list item's columns changing (shown as "Status: In progress → Completed"). Changes are batched: the worker's `star-notifications` job runs every 2 minutes and sends one email per person. You only hear about what you can still see, and never about your own changes.

### ForgeTeam

- **Teams are security groups.** Creating a team creates a group (owners and members) and its Drive library. Each channel gets a folder in that library, and a private channel's folder is open only to its members. Admins see teams under ForgeDirectory → Groups as well as ForgeTeam → Teams.
- **Conversations.**
  - Standard channels (the whole team), private channels (chosen members), one-to-one chats (one per pair) and group chats.
  - Messages are markdown, rendered without HTML: code blocks, quotes, lists, links. Mentions are stored as `<@user-id>`.
  - Threads, edits, deletes (owners can moderate their channels), emoji reactions and full-text search.
  - Files are uploaded to Drive and attached by id. Chat files go to the sender's "Chat files" folder and are shared with the chat.
- **Live updates and notifications.** The team service runs its own Socket.IO server (`/team-socket`, with a Redis adapter across replicas). It carries new and changed messages, typing, read state across devices, presence and meeting signalling. Unread and mention counts come from per-person read positions. Each conversation has a notification level: every message (the default for chats), mentions only (the default for channels) or muted. The web app shows desktop notifications to match.
- **Presence.** Available, Busy, Do not disturb, Away, In a call, In a meeting, Offline. It's worked out from heartbeats from open tabs (Redis keys with a 90-second TTL; idle for 5 minutes means Away), being in a call, busy calendar events (via free/busy), and a status someone sets, optionally until a time and with a message.
- **Meetings.** "Meet" in any conversation, or the `/team/meet/<code>` link that calendar events already carry.
  - Each meeting is a mediasoup router: Opus audio and VP8 video, with each participant sending their mic, camera and screen once.
  - Signalling is a small Socket.IO protocol: transports, produce and consume, pause, raise a hand, reactions.
  - Organisers can mute or remove people, and admit or deny guests. Guests enter a name and wait in a lobby until someone from the organisation admits them; admins can turn guest access off.
  - When the last person leaves, the meeting's card in the channel shows its duration and who was there.
- **Recording.** Organisers can record when it's allowed. The SFU forwards every voice, plus a screen share (or else a camera), as plain RTP to FFmpeg. FFmpeg writes VP8/Opus WebM to `forge_team_media/recordings`, starting a new segment whenever the streams change and joining the segments at the end without re-encoding. The recording is posted in the meeting's conversation and plays from a signed URL.

### ForgeSites

Sites are intranet pages for a team or the whole organisation. Each site has its own document library, which also controls who can see and edit the site. Pages are edited with a block editor (TipTap) that can embed widgets: the site's latest news, its documents, recent activity, a team calendar and images from the library. News posts can be saved as drafts and then published; the Sites home page combines the news from every site you can see. Sites can also hold **lists** (as in SharePoint): structured data with typed columns (text, multiple lines, number, choice, date, yes/no, person, hyperlink), created blank or from the Tasks, Issue tracker, Contacts or Events templates. Each list has **views**, as in SharePoint: named, saved ways of looking at it that choose the visible columns and their order, sorting (two levels), filters (with `[Me]` and `[Today]`, `[Today]+7`…) and grouping. A view can also be a **board**, with one column per choice of a Choice column, and dragging a card moves the item. Views can use the built-in Created, Modified, Created by and Modified by columns. The first view is the default, and templates come with views such as My tasks, Overdue and Board. Lists can be searched and exported to CSV, and placed on pages as a widget showing any view. Everyone who can see the site can read its lists, and its members can change them. A list holds up to 5,000 items.

### Docker volumes

| Volume | Mounted at | Contents |
|---|---|---|
| `forge_db_data` | postgres | Database files |
| `forge_redis_data` | redis | AOF persistence, BullMQ state |
| `forge_mail_data` | `/data/mail` | Message blobs (content-addressed .eml), composer uploads |
| `forge_drive_data` | `/data/drive` | Drive files (by SHA-256), previews, partial uploads, logos, signature images |
| `forge_team_media` | `/data/team` | Meeting recordings (ForgeTeam) |
| `forge_certs` | `/data/certs` | OIDC signing keys, master secret, setup token, DKIM keys, TLS certificates |
| `forge_clamav_db` | clamav | ClamAV signature database (profile `av`) |
| `forge_office_data` | office | Euro-Office settings and generated secrets (profile `office`) |
| `forge_mdm_data` | — | Reserved for Phase 6 (ForgeManage) |
| `forge_backups` | `/data/backups` | Backup snapshots |

`forge_certs` holds the master secret that encrypts TOTP secrets. Back it up together with the database: one without the other cannot restore MFA.

## API

OpenAPI documentation is served at `/api/docs`. Main route groups:

- `/api/v1/setup`, `/api/v1/branding`: first-run setup and public branding
- `/api/v1/me`: profile (including `PUT /api/v1/me/avatar` for a profile picture), password, TOTP enrolment, recovery codes
- `/api/v1/avatars/<user-id>`: profile pictures. They're served without a session so they work in every app, and they're stored once by hash in `forge_drive_data`. Uploads are cropped to a 512 px WebP square, turned upright and stripped of location data. Admins set them at `/api/v1/admin/users/<id>/avatar`.
- `/api/v1/directory`: people and group search for all signed-in users (powers global search)
- `/api/v1/admin/{users,groups,domains,roles,org,audit,system,resources,mail}`: admin center
- `/api/v1/admin/system/cluster`: storage nodes, copies of files, media servers, and whether another server can join. `PUT`/`DELETE /api/v1/admin/system/storage/<id>` retire or forget a node. `POST /api/v1/admin/system/join-code` returns the installer's join code (*system:manage*, audited)
- `/api/v1/mail`: folders, conversations, search, send/undo/schedule, drafts, uploads, rules, auto-reply
- `/api/v1/calendar`, `/api/v1/contacts`, `/api/v1/directory/gal`: calendars, events, RSVP, free/busy, rooms, contacts, Global Address List
- `/api/v1/drive`: libraries, items, uploads, versions, permissions, links, comments, activity, search; `/api/v1/share/<token>` for sharing links; `/api/v1/drive/office/callback` and `/wopi/files` for the Office editor
- `/api/v1/team`: teams, channels, chats, messages, files, presence, meetings and recordings; `/api/v1/admin/team` for policies and teams; Socket.IO at `/team-socket`
- `/api/v1/sites`: sites, pages and news; `/api/v1/admin/drive`: Drive policies and library storage
- `/dav/`: CalDAV and CardDAV (HTTP Basic with an app password)

## Not yet implemented

Mail and calendar:

- Server-side CalDAV scheduling (RFC 6638). Native calendar apps send invitations themselves over SMTP, which works with ForgeMail.
- Virus scanning of mail attachments (Drive uploads are scanned; mail is not yet).
- IMAP CONDSTORE/QRESYNC, and import/export of existing mailboxes (EML/MBOX import is part of `forge-cli` in Phase 5).

Drive:

- A desktop sync client and WebDAV access to libraries.
- Thumbnails of Office documents and videos (images get thumbnails; PDFs and text files are indexed for search), and OCR of scanned PDFs.

Team:

- Mobile and desktop apps; meeting transcription; breakout rooms; a whiteboard. Each meeting runs on one media server (a single very large meeting isn't spread across several).

Platform:

- External IdP federation (signing in to ForgeOffice with another OIDC/SAML provider)
- Self-service password reset by email (needs ForgeMail)
- A restore command for backups (planned for `forge-cli` in phase 5)
- Group nesting and group-based role assignment
