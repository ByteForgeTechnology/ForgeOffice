import { convert as htmlToText } from 'html-to-text';
import { emailSignatures, groupMembers, orm, organizations, type EmailSignature, type User } from '@forge/db';
import type { MailContext } from './context';

const { and, asc, eq } = orm;

/** Variables available in signatures, in the order the editor offers them. */
export const SIGNATURE_VARIABLES = [
  { key: 'displayName', label: 'Display name', sample: 'Alex Morgan' },
  { key: 'firstName', label: 'First name', sample: 'Alex' },
  { key: 'lastName', label: 'Last name', sample: 'Morgan' },
  { key: 'pronouns', label: 'Pronouns', sample: 'they/them' },
  { key: 'jobTitle', label: 'Job title', sample: 'Head of Sales' },
  { key: 'department', label: 'Department', sample: 'Sales' },
  { key: 'company', label: 'Company', sample: 'Acme Ltd' },
  { key: 'email', label: 'Email address', sample: 'alex.morgan@acme.com' },
  { key: 'workPhone', label: 'Work phone', sample: '+44 20 7946 0000' },
  { key: 'mobilePhone', label: 'Mobile phone', sample: '+44 7700 900000' },
  { key: 'website', label: 'Website', sample: 'www.acme.com' },
  { key: 'websiteUrl', label: 'Website link (https://…)', sample: 'https://www.acme.com' },
  { key: 'officeLocation', label: 'Office', sample: 'London HQ' },
  { key: 'streetAddress', label: 'Street address', sample: '1 High Street' },
  { key: 'city', label: 'City', sample: 'London' },
  { key: 'region', label: 'County / state', sample: '' },
  { key: 'postalCode', label: 'Postcode', sample: 'EC1A 1AA' },
  { key: 'country', label: 'Country', sample: 'United Kingdom' },
] as const;

export type SignatureVariable = (typeof SIGNATURE_VARIABLES)[number]['key'];
export type SignatureValues = Partial<Record<SignatureVariable, string>>;

export const sampleSignatureValues = (): SignatureValues => Object.fromEntries(SIGNATURE_VARIABLES.map((v) => [v.key, v.sample]));

/** Contact details of a person, as signature variable values. */
export function signatureValues(user: Pick<User, 'displayName' | 'givenName' | 'familyName' | 'email' | 'jobTitle' | 'department' | 'company' | 'officeLocation' | 'workPhone' | 'mobilePhone' | 'website' | 'streetAddress' | 'city' | 'region' | 'postalCode' | 'country' | 'pronouns'>, orgName: string): SignatureValues {
  const website = user.website?.trim() ?? '';
  return {
    displayName: user.displayName,
    firstName: user.givenName ?? user.displayName.split(' ')[0] ?? '',
    lastName: user.familyName ?? '',
    pronouns: user.pronouns ?? '',
    jobTitle: user.jobTitle ?? '',
    department: user.department ?? '',
    company: user.company || orgName,
    email: user.email,
    workPhone: user.workPhone ?? '',
    mobilePhone: user.mobilePhone ?? '',
    website: website.replace(/^https?:\/\//i, '').replace(/\/$/, ''),
    websiteUrl: website ? (/^https?:\/\//i.test(website) ? website : `https://${website}`) : '',
    officeLocation: user.officeLocation ?? '',
    streetAddress: user.streetAddress ?? '',
    city: user.city ?? '',
    region: user.region ?? '',
    postalCode: user.postalCode ?? '',
    country: user.country ?? '',
  };
}

const VAR = /\{\{\s*([A-Za-z]+)\s*\}\}/g;
const SEP = String.raw`[ \t]*(?:\||·|•|–|—|,|/)[ \t]*`;
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;');
const varsIn = (s: string) => [...s.matchAll(VAR)].map((m) => m[1]!);
const value = (values: SignatureValues, key: string) => (values as Record<string, string | undefined>)[key]?.trim() ?? '';

/** Fill one line: drop separators next to empty values, escape, and fill attributes (links). */
function fillLine(line: string, values: SignatureValues): string {
  // "{{workPhone}} | {{mobilePhone}}" with no work phone → "{{mobilePhone}}".
  for (const key of new Set(varsIn(line))) {
    if (value(values, key)) continue;
    const v = String.raw`\{\{\s*${key}\s*\}\}`;
    line = line.replace(new RegExp(`${SEP}${v}`, 'g'), '').replace(new RegExp(`${v}${SEP}`, 'g'), '');
  }
  return line.replace(/(<[^>]*>)|([^<]+)/g, (_m, tag: string | undefined, text: string | undefined) => {
    if (tag) {
      return tag.replace(/(\s[\w-]+=")([^"]*)"/g, (_a, pre: string, attr: string) => {
        const isHref = /href="$/i.test(pre);
        let out = attr.replace(VAR, (_v, key: string) => {
          // A link to {{website}} needs the full URL.
          const val = isHref && key === 'website' ? value(values, 'websiteUrl') : value(values, key);
          return /^\s*tel:/i.test(attr) ? val.replace(/[^\d+]/g, '') : val;
        });
        if (isHref && /^\s*(javascript|data|vbscript):/i.test(out)) out = '#';
        return `${pre}${escAttr(out.replace(/&amp;/g, '&'))}"`;
      });
    }
    return text!.replace(VAR, (_v, key: string) => escText(value(values, key)));
  });
}

/**
 * Render a signature template for one person. Lines (paragraphs, headings,
 * list items or <br>-separated lines) whose variables are all empty are
 * removed, so an optional "Mobile: {{mobilePhone}}" line disappears for
 * people without a mobile number.
 */
export function renderSignature(template: string, values: SignatureValues): string {
  const blocks = template.replace(/<(p|h[1-6]|li)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (whole, tag: string, attrs: string, inner: string) => {
    const lines = inner.split(/<br\s*\/?>/i);
    const kept = lines.filter((line) => {
      const vars = varsIn(line.replace(/<[^>]*>/g, ''));
      return !vars.length || vars.some((k) => value(values, k));
    });
    if (!kept.length) return '';
    return `<${tag}${attrs}>${kept.join('<br>')}</${tag}>`;
  });
  return fillLine(blocks, values);
}

/** Plain-text version for the text/plain part. */
export function signatureText(html: string): string {
  return htmlToText(html, { wordwrap: 78, selectors: [{ selector: 'img', format: 'skip' }, { selector: 'a', options: { hideLinkHrefIfSameAsText: true, ignoreHref: false } }] }).trim();
}

/** The signature that applies to a person: the first enabled one (by priority) whose audience includes them. */
export async function signatureFor(ctx: Pick<MailContext, 'db'>, user: Pick<User, 'id' | 'orgId'>): Promise<EmailSignature | null> {
  const all = await ctx.db
    .select()
    .from(emailSignatures)
    .where(and(eq(emailSignatures.orgId, user.orgId), eq(emailSignatures.enabled, true)))
    .orderBy(asc(emailSignatures.priority), asc(emailSignatures.createdAt));
  if (!all.length) return null;
  const memberOf = new Set((await ctx.db.select({ g: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.userId, user.id))).map((r) => r.g));
  return all.find((s) => s.audience === 'all' || s.groupIds.some((g) => memberOf.has(g))) ?? null;
}

/** A person's rendered signature (HTML and text), or null if none applies. */
export async function renderSignatureFor(ctx: Pick<MailContext, 'db'>, user: User): Promise<{ signature: EmailSignature; html: string; text: string } | null> {
  const signature = await signatureFor(ctx, user);
  if (!signature) return null;
  const [org] = await ctx.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, user.orgId)).limit(1);
  const html = renderSignature(signature.html, signatureValues(user, org?.name ?? ''));
  return { signature, html, text: signatureText(html) };
}
