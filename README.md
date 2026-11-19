# ForgeOffice

Self-hosted, subscription-free productivity suite. Built so far:

- **Phase 1 – Foundation, Identity & Unified Shell:** monorepo, OIDC identity provider, users/groups/RBAC, audit log, web portal and admin center.
- **Phase 2 – ForgeMail:** SMTP and IMAP servers written in Node.js, webmail, server-side rules, auto-replies, quarantine, calendars and contacts with CalDAV/CardDAV, meeting rooms and free/busy.

Drive and Team (phases 3–4) plug into this foundation.

## Quick start (Docker)

```bash
cp .env.example .env          # set FORGE_PUBLIC_URL and POSTGRES_PASSWORD
docker compose up -d --build
docker compose logs api | grep -A3 "setup token"
```

Ports 25, 587, 465, 143 and 993 are published by the `mail` container for SMTP and IMAP.

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
| `pnpm build` | Build web, API and worker bundles |
| `pnpm db:generate` | Generate a SQL migration after editing `packages/db/src/schema.ts` |

## Layout

```
apps/
  api/        Fastify API + oidc-provider + Socket.IO + CalDAV/CardDAV; serves the web client
  worker/     BullMQ worker: outbound mail delivery, backups, scheduled maintenance
  mailserver/ SMTP (25/587/465) and IMAP (143/993) listeners
  web/      React + Vite + Tailwind SPA: portal, sign-in, setup wizard, admin center
packages/
  db/       Drizzle schema, migrations, Postgres/PGlite connection
  auth/     RBAC permissions & roles, argon2id, TOTP + recovery codes, JWT verification
  storage/  Content-addressable SHA-256 blob store on node:fs streams, volume statfs
  events/   Typed BullMQ queues, Redis pub/sub event bus, service heartbeats
  mail/     Mail engine: MIME parsing, mailbox store, delivery, rules, spam, DKIM, IMAP & SMTP servers
  calendar/ iCalendar/vCard handling, calendar & contact storage, iTIP scheduling, free/busy
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
3. The worker delivers it directly to the recipient's MX with opportunistic TLS, or through `FORGE_SMTP_RELAY`.
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

### Docker volumes

| Volume | Mounted at | Contents |
|---|---|---|
| `forge_db_data` | postgres | Database files |
| `forge_redis_data` | redis | AOF persistence, BullMQ state |
| `forge_mail_data` | `/data/mail` | Message blobs (content-addressed .eml), composer uploads |
| `forge_drive_data` | `/data/drive` | Blobs: logos now, Drive files in phase 3 |
| `forge_team_media` | `/data/team` | Team media (phase 4) |
| `forge_certs` | `/data/certs` | OIDC signing keys, master secret, setup token, DKIM keys, TLS certificates |
| `forge_mdm_data` | — | Reserved for Phase 6 (ForgeManage) |
| `forge_backups` | `/data/backups` | Backup snapshots |

`forge_certs` holds the master secret that encrypts TOTP secrets. Back it up together with the database: one without the other cannot restore MFA.

## API

OpenAPI documentation is served at `/api/docs`. Main route groups:

- `/api/v1/setup`, `/api/v1/branding`: first-run setup and public branding
- `/api/v1/me`: profile, password, TOTP enrolment, recovery codes
- `/api/v1/directory`: people and group search for all signed-in users (powers global search)
- `/api/v1/admin/{users,groups,domains,roles,org,audit,system,resources,mail}`: admin center
- `/api/v1/mail`: folders, conversations, search, send/undo/schedule, drafts, uploads, rules, auto-reply
- `/api/v1/calendar`, `/api/v1/contacts`, `/api/v1/directory/gal`: calendars, events, RSVP, free/busy, rooms, contacts, Global Address List
- `/dav/`: CalDAV and CardDAV (HTTP Basic with an app password)

## Not yet implemented

Mail and calendar:

- Server-side CalDAV scheduling (RFC 6638). Native calendar apps send invitations themselves over SMTP, which works with ForgeMail.
- Virus scanning of attachments (the `virus-scan` queue arrives with Phase 3's ClamAV worker).
- IMAP CONDSTORE/QRESYNC, and import/export of existing mailboxes (EML/MBOX import is part of `forge-cli` in Phase 5).

Platform:

- External IdP federation (signing in to ForgeOffice with another OIDC/SAML provider)
- Self-service password reset by email (needs ForgeMail)
- A restore command for backups (planned for `forge-cli` in phase 5)
- Group nesting and group-based role assignment
