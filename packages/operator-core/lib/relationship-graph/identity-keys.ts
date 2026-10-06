/**
 * Identity keys for the platform relationship graph (crm-agent-sales-onboarding-apps-2026-10-06
 * P-002, D-001 / D-011). Pure: no database, no I/O.
 *
 * Two source records describe the same human when they share an identity key. A key is a
 * normalized email (`email:ada@acme.com`) or phone number (`phone:+15551234567`); an
 * organization's key is its domain (`domain:acme.com`). Normalization is deliberately
 * CONSERVATIVE: a wrong merge (two people shown as one) is worse than a missed merge, so
 *   - an email is only lowercased and trimmed; plus-tags and dots are kept;
 *   - a phone number is matched on its exact digits, with its `+` country prefix when written;
 *     a national-format number is NOT expanded with an assumed country code;
 *   - a free-mail domain (gmail.com, outlook.com, ...) never names an organization.
 */

export type IdentityKey = `email:${string}` | `phone:${string}` | `domain:${string}`;

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

/**
 * Consumer mail domains: an address there says nothing about the person's employer. Not
 * exhaustive; a missing entry only costs a person→organization link by domain, which still
 * needs an organization record with that domain to exist.
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  '126.com', '163.com', 'aol.com', 'fastmail.com', 'gmail.com', 'gmx.com', 'gmx.net', 'googlemail.com',
  'hey.com', 'hotmail.com', 'icloud.com', 'live.com', 'mac.com', 'mail.com', 'me.com', 'msn.com',
  'outlook.com', 'pm.me', 'proton.me', 'protonmail.com', 'qq.com', 'yahoo.com', 'yandex.com',
  'yandex.ru', 'ymail.com', 'zoho.com',
]);

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** `Ada Lovelace <Ada@Acme.com>` → `ada@acme.com`; anything that is not an address → null. */
export function normalizeEmail(raw: unknown): string | null {
  let value = text(raw);
  const angle = /<([^<>]+)>\s*$/.exec(value);
  if (angle) value = angle[1]!.trim();
  value = value.replace(/^mailto:/i, '').toLowerCase();
  return EMAIL_RE.test(value) ? value : null;
}

/**
 * `+1 (555) 123-4567` → `+15551234567`; `00 44 20 7946 0000` → `+442079460000`;
 * `555-123-4567` → `5551234567`. Fewer than 7 or more than 15 digits → null (E.164 bounds).
 */
export function normalizePhone(raw: unknown): string | null {
  let value = text(raw).replace(/^tel:/i, '');
  if (!value) return null;
  // An extension is not part of the line's identity.
  value = value.replace(/\s*(?:ext\.?|x|#)\s*\d+$/i, '');
  let international = value.startsWith('+');
  let digits = value.replace(/\D/g, '');
  if (!international && digits.startsWith('00')) {
    international = true;
    digits = digits.slice(2);
  }
  if (digits.length < 7 || digits.length > 15) return null;
  return international ? `+${digits}` : digits;
}

/** A URL, bare host, or email address → its lowercase host without `www.`; else null. */
export function normalizeDomain(raw: unknown): string | null {
  let value = text(raw).toLowerCase();
  if (!value) return null;
  const at = value.lastIndexOf('@');
  if (at >= 0 && !value.includes('/')) value = value.slice(at + 1);
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  value = value.split(/[/?#]/, 1)[0]!.replace(/:\d+$/, '').replace(/\.$/, '');
  value = value.replace(/^www\./, '');
  return DOMAIN_RE.test(value) ? value : null;
}

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain.toLowerCase());
}

/**
 * Values of a list-or-scalar payload field. Accepts `"a"`, `["a","b"]`, and provider shapes
 * like `[{ value: "a" }]`, `[{ address: "a" }]`, `[{ email: "a" }]`, `[{ number: "a" }]`.
 */
export function listValues(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      if (item.trim()) out.push(item.trim());
      continue;
    }
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      const inner = text(obj.value) || text(obj.address) || text(obj.email) || text(obj.number) || text(obj.phone);
      if (inner) out.push(inner);
    }
  }
  return out;
}

function uniqueSorted<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort();
}

/** Normalized emails of a person payload (`emails[]` and `email`). */
export function personEmails(payload: Record<string, unknown>): string[] {
  return uniqueSorted(
    [...listValues(payload.emails), ...listValues(payload.email)]
      .map(normalizeEmail)
      .filter((v): v is string => v !== null),
  );
}

/** Normalized phones of a person or organization payload (`phones[]` and `phone`). */
export function payloadPhones(payload: Record<string, unknown>): string[] {
  return uniqueSorted(
    [...listValues(payload.phones), ...listValues(payload.phone)]
      .map(normalizePhone)
      .filter((v): v is string => v !== null),
  );
}

/** Normalized domains of an organization payload (`domains[]`, `domain`, `website`). */
export function organizationDomains(payload: Record<string, unknown>): string[] {
  return uniqueSorted(
    [...listValues(payload.domains), ...listValues(payload.domain), ...listValues(payload.website)]
      .map(normalizeDomain)
      .filter((v): v is string => v !== null),
  );
}

export function personIdentityKeys(payload: Record<string, unknown>): IdentityKey[] {
  return uniqueSorted<IdentityKey>([
    ...personEmails(payload).map((e) => `email:${e}` as const),
    ...payloadPhones(payload).map((p) => `phone:${p}` as const),
  ]);
}

export function organizationIdentityKeys(payload: Record<string, unknown>): IdentityKey[] {
  return uniqueSorted<IdentityKey>(organizationDomains(payload).map((d) => `domain:${d}` as const));
}

/**
 * The organization domain a person record points at: an explicit `organizationDomain`, else the
 * domain of the first non-free-mail email. Null when the person only has consumer addresses.
 */
export function personOrganizationDomain(payload: Record<string, unknown>): string | null {
  const explicit = normalizeDomain(payload.organizationDomain);
  if (explicit && !isFreeMailDomain(explicit)) return explicit;
  for (const email of personEmails(payload)) {
    const domain = normalizeDomain(email);
    if (domain && !isFreeMailDomain(domain)) return domain;
  }
  return null;
}

function keysOfContact(value: unknown): IdentityKey[] {
  const out: IdentityKey[] = [];
  for (const raw of listValues(value)) {
    const email = normalizeEmail(raw);
    if (email) {
      out.push(`email:${email}`);
      continue;
    }
    const phone = normalizePhone(raw);
    if (phone) out.push(`phone:${phone}`);
  }
  return out;
}

/**
 * The person identity keys of the participants of one interaction (D-011 point 2). Interactions
 * stay in their own datatypes; this is how they are joined to graph persons at read time.
 * A datatype with no resolvable participant field (social-post handles) yields [].
 */
export function interactionParticipantKeys(datatype: string, payload: Record<string, unknown>): IdentityKey[] {
  const fieldsByDatatype: Record<string, readonly string[]> = {
    'email-message': ['from', 'to', 'cc', 'bcc'],
    'calendar-event': ['organizer', 'attendees'],
    'chat-message': ['sender'],
    call: ['from', 'to', 'participants'],
  };
  const fields = fieldsByDatatype[datatype] ?? [];
  return uniqueSorted(fields.flatMap((field) => keysOfContact(payload[field])));
}
