/**
 * §15.9 — CF project name and vanity URL generation.
 *
 *   cf project name = sha256(secret || "/" || harnessSlug).slice(0,16) + "-" + sanitize(slug)
 *   vanity subdomain = sanitize(slug) + "-" + 8-base32-random
 *
 * The hash prefix hides cross-project tenant correlation from anyone reading
 * CF's account-internal listings (incl. CF support for abuse responses).
 */

import { randomBase32 } from '@papercusp/publish-auth';

const HEX = '0123456789abcdef';

export async function cfProjectName(
  tenantSecret: string,
  harnessSlug: string,
): Promise<string> {
  const data = new TextEncoder().encode(tenantSecret + '/' + harnessSlug);
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 8; i++) {
    const b = bytes[i]!;
    hex += HEX[b >> 4]! + HEX[b & 0xf]!;
  }
  // CF Pages project names: lowercase letters, digits, hyphens, max 58 chars.
  return hex + '-' + sanitizeSlug(harnessSlug).slice(0, 41);
}

export function sanitizeSlug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/--+/g, '-') || 'untitled'
  );
}

export function vanitySubdomain(harnessSlug: string): string {
  return sanitizeSlug(harnessSlug) + '-' + randomBase32(8);
}
