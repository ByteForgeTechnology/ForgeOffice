import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { XMLParser } from 'fast-xml-parser';
import {
  accessibleAddressBooks,
  accessibleCalendars,
  buildVCard,
  deleteCalendarObject,
  deleteContact,
  ensureAddressBook,
  ensureDefaultCalendar,
  expandOccurrences,
  InvalidIcsError,
  InvalidVCardError,
  mergeAlarms,
  remindersEnabled,
  stripAlarms,
  PreconditionFailedError,
  putCalendarObject,
  putContact,
  UidConflictError,
  type CalendarAccess,
} from '@forge/calendar';
import { addressBooks, calendarObjects, calendars, contacts, organizations, orm, users, type Calendar, type User } from '@forge/db';
import { authenticateProtocol } from '@forge/mail';
import type { AppContext } from '../context';
import type { App } from '../types';

const { and, asc, eq, gt, inArray, isNull, max } = orm;

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/" xmlns:x="http://apple.com/ns/ical/"';
const GAL_ID = 'directory';
const SYNC_PREFIX = 'http://forgeoffice.dev/ns/sync/';

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: true, isArray: (name) => ['href', 'comp-filter', 'prop-filter', 'set', 'remove'].includes(name) });

type Props = Record<string, string | null>;

interface DavResource {
  href: string;
  props: Props;
}

/** Multi-status document; null-valued props are reported as 404. */
function multistatus(resources: DavResource[], extra = ''): string {
  const body = resources
    .map((r) => {
      const found = Object.entries(r.props).filter(([, v]) => v !== null);
      const missing = Object.entries(r.props).filter(([, v]) => v === null);
      const stat = (entries: [string, string | null][], status: string) =>
        entries.length ? `<d:propstat><d:prop>${entries.map(([k, v]) => (v === null ? `<${k}/>` : v === '' ? `<${k}/>` : `<${k}>${v}</${k}>`)).join('')}</d:prop><d:status>HTTP/1.1 ${status}</d:status></d:propstat>` : '';
      return `<d:response><d:href>${xml(r.href)}</d:href>${stat(found, '200 OK')}${stat(missing, '404 Not Found')}</d:response>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus ${NS}>${body}${extra}</d:multistatus>`;
}

const PROP_PREFIX: Record<string, string> = {
  resourcetype: 'd',
  displayname: 'd',
  getetag: 'd',
  getcontenttype: 'd',
  getctag: 'cs',
  'sync-token': 'd',
  'current-user-principal': 'd',
  'principal-url': 'd',
  'principal-collection-set': 'd',
  'current-user-privilege-set': 'd',
  owner: 'd',
  'supported-report-set': 'd',
  'calendar-home-set': 'c',
  'calendar-user-address-set': 'c',
  'schedule-inbox-URL': 'c',
  'supported-calendar-component-set': 'c',
  'calendar-description': 'c',
  'calendar-timezone': 'c',
  'calendar-data': 'c',
  'max-resource-size': 'c',
  'calendar-color': 'x',
  'calendar-order': 'x',
  'addressbook-home-set': 'card',
  'addressbook-description': 'card',
  'address-data': 'card',
  'supported-address-data': 'card',
  'getlastmodified': 'd',
  'getcontentlength': 'd',
};

/** Requested property names (local names), or null for allprop. */
function requestedProps(body: unknown): string[] | null {
  const root = (body as Record<string, Record<string, unknown>>)?.propfind ?? (body as Record<string, unknown>);
  const prop = (root as Record<string, unknown>)?.prop;
  if (!prop || typeof prop !== 'object') return null;
  return Object.keys(prop as object);
}

function pick(available: Props, wanted: string[] | null): Props {
  const out: Props = {};
  const keys = wanted ?? Object.keys(available).map((k) => k.split(':')[1]!);
  for (const key of keys) {
    const fq = `${PROP_PREFIX[key] ?? 'd'}:${key}`;
    out[fq] = fq in available ? available[fq]! : null;
  }
  return out;
}

const privileges = (access: CalendarAccess | 'owner' | 'read') => {
  const list = access === 'read' || access === 'freebusy' ? ['read'] : ['read', 'write', 'write-content', 'write-properties', 'bind', 'unbind'];
  return list.map((p) => `<d:privilege><d:${p}/></d:privilege>`).join('');
};

const syncToken = (rev: number) => `${SYNC_PREFIX}${rev}`;
const parseSyncToken = (token: string | undefined) => (token?.startsWith(SYNC_PREFIX) ? Number(token.slice(SYNC_PREFIX.length)) : 0);

export function davRoutes(app: App, ctx: AppContext) {
  const { db } = ctx;
  for (const method of ['PROPFIND', 'PROPPATCH', 'REPORT', 'MKCALENDAR', 'MKCOL']) {
    try {
      app.addHttpMethod(method, { hasBody: true });
    } catch {
      /* already registered */
    }
  }
  app.addContentTypeParser(['application/xml', 'text/xml', 'text/calendar', 'text/vcard', 'text/x-vcard', 'text/plain'], { parseAs: 'string', bodyLimit: 10 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );

  // Discovery (RFC 6764).
  app.route({ method: ['GET', 'PROPFIND', 'HEAD'], url: '/.well-known/caldav', schema: { hide: true }, handler: (_req, reply) => reply.redirect('/dav/', 301) });
  app.route({ method: ['GET', 'PROPFIND', 'HEAD'], url: '/.well-known/carddav', schema: { hide: true }, handler: (_req, reply) => reply.redirect('/dav/', 301) });

  /** HTTP Basic with the account password (no MFA) or an app password. */
  const auth = async (req: FastifyRequest, reply: FastifyReply): Promise<User | null> => {
    const header = req.headers.authorization ?? '';
    const m = /^Basic\s+(.+)$/i.exec(header);
    if (m) {
      const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      const user = await authenticateProtocol(ctx.mail, decoded.slice(0, idx), decoded.slice(idx + 1), { protocol: 'caldav', ip: req.ip });
      if (user) return user;
    }
    reply.header('WWW-Authenticate', 'Basic realm="ForgeOffice", charset="UTF-8"').code(401).type('text/plain').send('Authentication required. If two-step verification is on, use an app password.');
    return null;
  };

  const sendXml = (reply: FastifyReply, status: number, body: string) => reply.code(status).header('Content-Type', 'application/xml; charset=utf-8').send(body);
  const davHeaders = (reply: FastifyReply) => reply.header('DAV', '1, 2, 3, calendar-access, addressbook, extended-mkcol').header('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT, MKCALENDAR');

  const parseBody = (req: FastifyRequest) => {
    const raw = typeof req.body === 'string' ? req.body : '';
    if (!raw.trim()) return {};
    try {
      return parser.parse(raw);
    } catch {
      return {};
    }
  };

  const principalHref = (u: User) => `/dav/principals/${u.id}/`;
  const calHome = (u: User) => `/dav/calendars/${u.id}/`;
  const bookHome = (u: User) => `/dav/addressbooks/${u.id}/`;

  const principalProps = (u: User): Props => ({
    'd:resourcetype': '<d:principal/>',
    'd:displayname': xml(u.displayName),
    'd:current-user-principal': `<d:href>${principalHref(u)}</d:href>`,
    'd:principal-url': `<d:href>${principalHref(u)}</d:href>`,
    'd:principal-collection-set': '<d:href>/dav/principals/</d:href>',
    'c:calendar-home-set': `<d:href>${calHome(u)}</d:href>`,
    'card:addressbook-home-set': `<d:href>${bookHome(u)}</d:href>`,
    'c:calendar-user-address-set': `<d:href>mailto:${xml(u.email)}</d:href><d:href>${principalHref(u)}</d:href>`,
    'd:owner': `<d:href>${principalHref(u)}</d:href>`,
  });

  const calendarProps = (u: User, c: Calendar & { access: CalendarAccess }): Props => ({
    'd:resourcetype': '<d:collection/><c:calendar/>',
    'd:displayname': xml(c.name),
    'c:calendar-description': xml(c.description),
    'x:calendar-color': xml(c.color),
    'cs:getctag': xml(`"${c.syncRevision}"`),
    'd:sync-token': syncToken(c.syncRevision),
    'c:supported-calendar-component-set': '<c:comp name="VEVENT"/><c:comp name="VTODO"/>',
    'd:current-user-privilege-set': privileges(c.access),
    'd:owner': `<d:href>${principalHref(u)}</d:href>`,
    'd:current-user-principal': `<d:href>${principalHref(u)}</d:href>`,
    'd:supported-report-set':
      '<d:supported-report><d:report><c:calendar-multiget/></d:report></d:supported-report><d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report><d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report>',
    'c:max-resource-size': String(5 * 1024 * 1024),
  });

  const galRevision = async (u: User) => {
    const [row] = await db.select({ m: max(users.updatedAt) }).from(users).where(eq(users.orgId, u.orgId));
    return row?.m ? Math.floor(new Date(row.m).getTime() / 1000) : 0;
  };

  const galCards = async (u: User) => {
    const people = await db.select().from(users).where(and(eq(users.orgId, u.orgId), eq(users.status, 'active'))).orderBy(asc(users.displayName));
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, u.orgId));
    const orgName = org?.name ?? '';
    return people.map((p) => {
      const vcard = buildVCard({
        uid: p.id,
        fullName: p.displayName,
        givenName: p.givenName ?? '',
        familyName: p.familyName ?? '',
        emails: [{ type: 'work', value: p.email }],
        phones: [
          ...(p.workPhone ? [{ type: 'work', value: p.workPhone }] : []),
          ...(p.mobilePhone ? [{ type: 'cell', value: p.mobilePhone }] : []),
        ],
        organization: p.company ?? orgName,
        orgUnit: p.department ?? '',
        title: p.jobTitle ?? '',
        url: p.website ? (/^https?:\/\//i.test(p.website) ? p.website : `https://${p.website}`) : '',
        address: { street: p.streetAddress ?? '', city: p.city ?? '', region: p.region ?? '', postalCode: p.postalCode ?? '', country: p.country ?? '' },
      }).replace(/^REV:.*\r\n/m, `REV:${p.updatedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}\r\n`);
      return { href: `${p.id}.vcf`, etag: `"${createHash('sha256').update(vcard).digest('hex').slice(0, 32)}"`, vcard };
    });
  };

  // ---------------------------------------------------------------------------
  // Dispatcher for everything under /dav
  // ---------------------------------------------------------------------------

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    davHeaders(reply);
    if (req.method === 'OPTIONS') return reply.code(200).send();
    const user = await auth(req, reply);
    if (!user) return;
    const path = req.url.split('?')[0]!.replace(/\/+/g, '/');
    const parts = path.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // after "dav"
    const depth = String(req.headers.depth ?? '0');
    const body = parseBody(req);

    // /dav/ and /dav/principals/<me>/
    if (parts.length === 0 || parts[0] === 'principals') {
      if (req.method !== 'PROPFIND') return reply.code(405).send();
      if (parts[1] && parts[1] !== user.id) return reply.code(403).send();
      const wanted = requestedProps(body);
      const href = parts.length === 0 ? '/dav/' : principalHref(user);
      return sendXml(reply, 207, multistatus([{ href, props: pick({ ...principalProps(user), 'd:resourcetype': parts.length === 0 ? '<d:collection/>' : '<d:principal/>' }, wanted) }]));
    }

    if (parts[1] && parts[1] !== user.id) return reply.code(403).send();

    if (parts[0] === 'calendars') return calendarsHandler(req, reply, user, parts.slice(2), depth, body);
    if (parts[0] === 'addressbooks') return addressBookHandler(req, reply, user, parts.slice(2), depth, body);
    return reply.code(404).send();
  };

  // ---------------------------------------------------------------------------
  // CalDAV
  // ---------------------------------------------------------------------------

  // People who turned a calendar's reminders off get it without VALARMs, under a
  // distinct ETag so their devices refetch when the setting changes.
  const variantEtag = (etag: string, noAlarms: boolean) => (noAlarms ? etag.replace(/"$/, '-r"') : etag);
  const baseEtag = (etag: string | null) => etag?.replace(/-r"$/, '"') ?? null;

  const objectProps = (calHref: string, o: typeof calendarObjects.$inferSelect, wanted: string[] | null, withData: boolean, noAlarms = false): DavResource => {
    const available: Props = {
      'd:getetag': xml(variantEtag(o.etag, noAlarms)),
      'd:getcontenttype': 'text/calendar; charset=utf-8; component=vevent',
      'd:resourcetype': '',
      'd:getlastmodified': o.updatedAt.toUTCString(),
      ...(withData ? { 'c:calendar-data': xml(noAlarms ? stripAlarms(o.ics) : o.ics) } : {}),
    };
    return { href: calHref + o.href, props: pick(available, wanted ?? ['getetag', 'getcontenttype', 'resourcetype']) };
  };

  const calendarsHandler = async (req: FastifyRequest, reply: FastifyReply, user: User, rest: string[], depth: string, body: Record<string, unknown>) => {
    await ensureDefaultCalendar(db, user);
    const visible = (await accessibleCalendars(db, user.id)).filter((c) => c.access !== 'freebusy');
    const home = calHome(user);
    const wanted = requestedProps(body);

    if (rest.length === 0) {
      if (req.method !== 'PROPFIND') return reply.code(405).send();
      const resources: DavResource[] = [{ href: home, props: pick({ 'd:resourcetype': '<d:collection/>', 'd:displayname': 'Calendars', 'd:current-user-principal': `<d:href>${principalHref(user)}</d:href>`, 'd:owner': `<d:href>${principalHref(user)}</d:href>`, 'd:current-user-privilege-set': privileges('owner') }, wanted) }];
      if (depth !== '0') for (const c of visible) resources.push({ href: `${home}${c.id}/`, props: pick(calendarProps(user, c), wanted) });
      return sendXml(reply, 207, multistatus(resources));
    }

    const calId = rest[0]!;
    const cal = visible.find((c) => c.id === calId);
    const calHref = `${home}${calId}/`;
    const noAlarms = cal ? !(await remindersEnabled(db, user.id, cal)) : false;

    if (req.method === 'MKCALENDAR' || (req.method === 'MKCOL' && rest.length === 1)) {
      if (cal) return reply.code(405).send();
      if (!/^[0-9a-f-]{36}$/i.test(calId)) return reply.code(403).send();
      const set = JSON.stringify(body);
      const name = /"displayname":"([^"]*)"/.exec(set)?.[1] ?? 'Calendar';
      const color = /"calendar-color":"(#[0-9A-Fa-f]{6})/.exec(set)?.[1] ?? '#0ea5e9';
      await db.insert(calendars).values({ id: calId, orgId: user.orgId, ownerType: 'user', ownerId: user.id, name, color });
      return reply.code(201).send();
    }

    if (!cal) return reply.code(404).send();
    const canWrite = cal.access === 'owner' || cal.access === 'write';

    if (rest.length === 1) {
      switch (req.method) {
        case 'PROPFIND': {
          const resources: DavResource[] = [{ href: calHref, props: pick(calendarProps(user, cal), wanted) }];
          if (depth !== '0') {
            const objs = await db.select().from(calendarObjects).where(and(eq(calendarObjects.calendarId, cal.id), isNull(calendarObjects.deletedAt)));
            for (const o of objs) resources.push(objectProps(calHref, o, wanted, false, noAlarms));
          }
          return sendXml(reply, 207, multistatus(resources));
        }
        case 'PROPPATCH': {
          if (!canWrite) return reply.code(403).send();
          const set = JSON.stringify((body as { propertyupdate?: unknown }).propertyupdate ?? body);
          const name = /"displayname":"([^"]*)"/.exec(set)?.[1];
          const color = /"calendar-color":"(#[0-9A-Fa-f]{6})/.exec(set)?.[1];
          await db
            .update(calendars)
            .set({ ...(name ? { name } : {}), ...(color ? { color } : {}) })
            .where(eq(calendars.id, cal.id));
          return sendXml(reply, 207, multistatus([{ href: calHref, props: { ...(name ? { 'd:displayname': '' } : {}), ...(color ? { 'x:calendar-color': '' } : {}) } }]));
        }
        case 'REPORT':
          return calendarReport(reply, cal, calHref, body, noAlarms);
        case 'DELETE':
          if (cal.access !== 'owner' || cal.isDefault) return reply.code(403).send();
          await db.delete(calendars).where(eq(calendars.id, cal.id));
          return reply.code(204).send();
        default:
          return reply.code(405).send();
      }
    }

    const href = rest[1]!;
    const ifMatch = baseEtag((req.headers['if-match'] as string | undefined) ?? null);
    const ifNoneMatch = (req.headers['if-none-match'] as string | undefined) ?? null;
    const [obj] = await db
      .select()
      .from(calendarObjects)
      .where(and(eq(calendarObjects.calendarId, cal.id), eq(calendarObjects.href, href), isNull(calendarObjects.deletedAt)))
      .limit(1);
    switch (req.method) {
      case 'GET':
      case 'HEAD':
        if (!obj) return reply.code(404).send();
        return reply
          .header('ETag', variantEtag(obj.etag, noAlarms))
          .type('text/calendar; charset=utf-8')
          .send(req.method === 'HEAD' ? '' : noAlarms ? stripAlarms(obj.ics) : obj.ics);
      case 'PUT': {
        if (!canWrite) return reply.code(403).send();
        try {
          // Without reminders, keep everyone else's alarms and ignore any the device added.
          const incoming = noAlarms ? mergeAlarms(String(req.body ?? ''), obj?.ics ?? null) : String(req.body ?? '');
          const { object, created } = await putCalendarObject(db, cal.id, href, incoming, { ifMatch, ifNoneMatch });
          void ctx.bus?.publish('calendar.changed', { userIds: [user.id] }).catch(() => {});
          return reply.code(created ? 201 : 204).header('ETag', variantEtag(object.etag, noAlarms)).send();
        } catch (err) {
          return davError(reply, err);
        }
      }
      case 'DELETE':
        if (!canWrite) return reply.code(403).send();
        try {
          return reply.code((await deleteCalendarObject(db, cal.id, href, ifMatch)) ? 204 : 404).send();
        } catch (err) {
          return davError(reply, err);
        }
      case 'PROPFIND':
        if (!obj) return reply.code(404).send();
        return sendXml(reply, 207, multistatus([objectProps(calHref, obj, wanted, false, noAlarms)]));
      default:
        return reply.code(405).send();
    }
  };

  const davError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof PreconditionFailedError) return reply.code(412).send();
    if (err instanceof UidConflictError) return sendXml(reply, 409, `<?xml version="1.0"?><d:error ${NS}><c:no-uid-conflict><d:href>${xml(err.existingHref)}</d:href></c:no-uid-conflict></d:error>`);
    if (err instanceof InvalidIcsError || err instanceof InvalidVCardError) return sendXml(reply, 415, `<?xml version="1.0"?><d:error ${NS}><c:valid-calendar-data/></d:error>`);
    throw err;
  };

  const findTimeRange = (node: unknown): { start?: string; end?: string } | null => {
    if (!node || typeof node !== 'object') return null;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'time-range' && v && typeof v === 'object') return { start: (v as Record<string, string>)['@_start'], end: (v as Record<string, string>)['@_end'] };
      const inner = Array.isArray(v) ? v.map(findTimeRange).find(Boolean) : findTimeRange(v);
      if (inner) return inner;
    }
    return null;
  };

  const icalDate = (s: string | undefined, fallback: Date) => {
    if (!s) return fallback;
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
    return m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)) : fallback;
  };

  const calendarReport = async (reply: FastifyReply, cal: Calendar, calHref: string, body: Record<string, unknown>, noAlarms: boolean) => {
    const [type, report] = Object.entries(body)[0] ?? [];
    const r = (report ?? {}) as Record<string, unknown>;
    const wanted = requestedProps(r);
    const withData = !wanted || wanted.includes('calendar-data');

    if (type === 'calendar-multiget') {
      const hrefs = ((r.href as string[]) ?? []).map((h) => decodeURIComponent(String(h)).split('/').filter(Boolean).at(-1)!);
      const objs = hrefs.length ? await db.select().from(calendarObjects).where(and(eq(calendarObjects.calendarId, cal.id), inArray(calendarObjects.href, hrefs), isNull(calendarObjects.deletedAt))) : [];
      const found = objs.map((o) => objectProps(calHref, o, wanted, withData, noAlarms));
      const missing = hrefs.filter((h) => !objs.some((o) => o.href === h)).map((h) => `<d:response><d:href>${xml(calHref + h)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`);
      return sendXml(reply, 207, multistatus(found, missing.join('')));
    }

    if (type === 'calendar-query') {
      const range = findTimeRange(r.filter);
      let objs = await db.select().from(calendarObjects).where(and(eq(calendarObjects.calendarId, cal.id), isNull(calendarObjects.deletedAt)));
      if (range) {
        const from = icalDate(range.start, new Date(0));
        const to = icalDate(range.end, new Date(8640000000000000));
        objs = objs.filter((o) => {
          if (o.startsAt && o.startsAt >= to) return false;
          if (o.endsAt && o.endsAt <= from) return false;
          return !o.recurring || expandOccurrences(o.ics, from, to).length > 0;
        });
      }
      return sendXml(reply, 207, multistatus(objs.map((o) => objectProps(calHref, o, wanted, withData, noAlarms))));
    }

    if (type === 'sync-collection') {
      const since = parseSyncToken(String(r['sync-token'] ?? ''));
      const [fresh] = await db.select().from(calendars).where(eq(calendars.id, cal.id));
      const changed = await db
        .select()
        .from(calendarObjects)
        .where(and(eq(calendarObjects.calendarId, cal.id), gt(calendarObjects.syncRevision, since)));
      const live = changed.filter((o) => !o.deletedAt).map((o) => objectProps(calHref, o, wanted, withData, noAlarms));
      const gone = since ? changed.filter((o) => o.deletedAt).map((o) => `<d:response><d:href>${xml(calHref + o.href)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`) : [];
      return sendXml(reply, 207, multistatus(live, gone.join('') + `<d:sync-token>${syncToken(fresh!.syncRevision)}</d:sync-token>`));
    }
    return reply.code(501).send();
  };

  // ---------------------------------------------------------------------------
  // CardDAV
  // ---------------------------------------------------------------------------

  const addressBookHandler = async (req: FastifyRequest, reply: FastifyReply, user: User, rest: string[], depth: string, body: Record<string, unknown>) => {
    await ensureAddressBook(db, user.id);
    // Own books plus shared mailboxes' books (read-only when the grant is read-only).
    const books = await accessibleAddressBooks(db, user.id);
    const home = bookHome(user);
    const wanted = requestedProps(body);
    const galRev = await galRevision(user);

    const bookProps = (b: { id: string; name: string; description: string; syncRevision: number }, readOnly = false): Props => ({
      'd:resourcetype': '<d:collection/><card:addressbook/>',
      'd:displayname': xml(b.name),
      'card:addressbook-description': xml(b.description),
      'cs:getctag': xml(`"${b.syncRevision}"`),
      'd:sync-token': syncToken(b.syncRevision),
      'd:current-user-privilege-set': privileges(readOnly ? 'read' : 'owner'),
      'card:supported-address-data': '<card:address-data-type content-type="text/vcard" version="3.0"/>',
      'd:supported-report-set':
        '<d:supported-report><d:report><card:addressbook-multiget/></d:report></d:supported-report><d:supported-report><d:report><card:addressbook-query/></d:report></d:supported-report><d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report>',
      'd:owner': `<d:href>${principalHref(user)}</d:href>`,
    });
    const gal = { id: GAL_ID, name: 'Organisation directory', description: 'Global Address List (read-only)', syncRevision: galRev };

    if (rest.length === 0) {
      if (req.method !== 'PROPFIND') return reply.code(405).send();
      const resources: DavResource[] = [{ href: home, props: pick({ 'd:resourcetype': '<d:collection/>', 'd:displayname': 'Address books', 'd:current-user-principal': `<d:href>${principalHref(user)}</d:href>` }, wanted) }];
      if (depth !== '0') {
        for (const b of books) resources.push({ href: `${home}${b.id}/`, props: pick(bookProps({ ...b, name: b.ownerName ?? b.name }, b.access === 'read'), wanted) });
        resources.push({ href: `${home}${GAL_ID}/`, props: pick(bookProps(gal, true), wanted) });
      }
      return sendXml(reply, 207, multistatus(resources));
    }

    const bookId = rest[0]!;
    const bookHref = `${home}${bookId}/`;
    const isGal = bookId === GAL_ID;
    const book = isGal ? gal : books.find((b) => b.id === bookId);
    if (!book) return reply.code(404).send();

    type Card = { href: string; etag: string; vcard: string; deleted?: boolean; rev?: number };
    const loadCards = async (sinceRev = 0): Promise<Card[]> =>
      isGal
        ? await galCards(user)
        : (await db.select().from(contacts).where(and(eq(contacts.addressBookId, book.id), gt(contacts.syncRevision, sinceRev)))).map((c) => ({ href: c.href, etag: c.etag, vcard: c.vcard, deleted: !!c.deletedAt, rev: c.syncRevision }));
    const cardProps = (c: Card, withData: boolean, w: string[] | null): DavResource => ({
      href: bookHref + c.href,
      props: pick({ 'd:getetag': xml(c.etag), 'd:getcontenttype': 'text/vcard; charset=utf-8', 'd:resourcetype': '', ...(withData ? { 'card:address-data': xml(c.vcard) } : {}) }, w ?? ['getetag', 'getcontenttype', 'resourcetype']),
    });

    if (rest.length === 1) {
      if (req.method === 'PROPFIND') {
        const resources: DavResource[] = [{ href: bookHref, props: pick(bookProps(book, isGal || (book as { access?: string }).access === 'read'), wanted) }];
        if (depth !== '0') for (const c of (await loadCards()).filter((x) => !x.deleted)) resources.push(cardProps(c, false, wanted));
        return sendXml(reply, 207, multistatus(resources));
      }
      if (req.method === 'REPORT') {
        const [type, report] = Object.entries(body)[0] ?? [];
        const r = (report ?? {}) as Record<string, unknown>;
        const w = requestedProps(r);
        const withData = !w || w.includes('address-data');
        if (type === 'addressbook-multiget') {
          const hrefs = ((r.href as string[]) ?? []).map((h) => decodeURIComponent(String(h)).split('/').filter(Boolean).at(-1)!);
          const cards = (await loadCards()).filter((c) => !c.deleted && hrefs.includes(c.href));
          return sendXml(reply, 207, multistatus(cards.map((c) => cardProps(c, withData, w))));
        }
        if (type === 'addressbook-query') return sendXml(reply, 207, multistatus((await loadCards()).filter((c) => !c.deleted).map((c) => cardProps(c, withData, w))));
        if (type === 'sync-collection') {
          const since = parseSyncToken(String(r['sync-token'] ?? ''));
          if (isGal) {
            const cards = since >= galRev ? [] : await loadCards();
            return sendXml(reply, 207, multistatus(cards.map((c) => cardProps(c, withData, w)), `<d:sync-token>${syncToken(galRev)}</d:sync-token>`));
          }
          const changed = await loadCards(since);
          const [fresh] = await db.select().from(addressBooks).where(eq(addressBooks.id, book.id));
          const gone = since ? changed.filter((c) => c.deleted).map((c) => `<d:response><d:href>${xml(bookHref + c.href)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`) : [];
          return sendXml(reply, 207, multistatus(changed.filter((c) => !c.deleted).map((c) => cardProps(c, withData, w)), gone.join('') + `<d:sync-token>${syncToken(fresh!.syncRevision)}</d:sync-token>`));
        }
        return reply.code(501).send();
      }
      return reply.code(405).send();
    }

    const href = rest[1]!;
    if (req.method === 'GET' || req.method === 'HEAD') {
      const card = (await loadCards()).find((c) => c.href === href && !c.deleted);
      if (!card) return reply.code(404).send();
      return reply.header('ETag', card.etag).type('text/vcard; charset=utf-8').send(req.method === 'HEAD' ? '' : card.vcard);
    }
    if (isGal || (book as { access?: string }).access === 'read') return reply.code(403).send();
    const ifMatch = (req.headers['if-match'] as string | undefined) ?? null;
    const ifNoneMatch = (req.headers['if-none-match'] as string | undefined) ?? null;
    try {
      if (req.method === 'PUT') {
        const { contact, created } = await putContact(db, book.id, href, String(req.body ?? ''), { ifMatch, ifNoneMatch });
        return reply.code(created ? 201 : 204).header('ETag', contact.etag).send();
      }
      if (req.method === 'DELETE') return reply.code((await deleteContact(db, book.id, href, ifMatch)) ? 204 : 404).send();
    } catch (err) {
      return davError(reply, err);
    }
    return reply.code(405).send();
  };

  app.route({ method: ['OPTIONS', 'GET', 'HEAD', 'PUT', 'DELETE', 'PROPFIND', 'PROPPATCH', 'REPORT', 'MKCALENDAR', 'MKCOL'], url: '/dav', schema: { hide: true }, handler });
  app.route({ method: ['OPTIONS', 'GET', 'HEAD', 'PUT', 'DELETE', 'PROPFIND', 'PROPPATCH', 'REPORT', 'MKCALENDAR', 'MKCOL'], url: '/dav/*', schema: { hide: true }, handler });
}
