/**
 * Pasted provider credentials (cupboard-distributable-integrations-2026-10-10 P-001;
 * SPEC-R-2-P-001, SPEC-R-7-P-001).
 *
 * A provider package declares paste-a-secret fields as data (`descriptor.setup.credentials`). The
 * host owns everything else, the same way it owns OAuth tokens:
 *
 *   - checks each value with the SDK's `providerCredentialValueIssue` (the same check the page runs
 *     before sending, so the two never disagree);
 *   - stores it in the OAuth token store (a 0600 file plus the encrypted PG mirror) under
 *     `provider-setup:<providerId>`. That name contains a colon, which the plain plugin-config read
 *     routes (`/plugins/config`, `/plugins/configs`) refuse as a slug, so they cannot return it;
 *   - reports only whether each field is configured and when it was saved, never the value, its
 *     length, or a prefix;
 *   - hands the value to exactly two host paths: `host.fetch` (as a bearer token for the field's
 *     declared `hosts`) and host-held ingress (P-003). Provider code never receives it.
 */
import {
  providerCredentialValueIssue,
  type ProviderCredentialField,
  type ProviderDescriptor,
} from '@papercusp/plugin-sdk';
import { fsTokenStorage } from '../oauth/storage-fs';
import type { TokenStorage } from '../oauth/token';

const STORE_PREFIX = 'provider-setup:';
const SAVED_AT_SUFFIX = '__saved_at';

/** Token-store plugin key holding one provider's pasted credentials. */
export function providerSetupStoreKey(providerId: string): string {
  return `${STORE_PREFIX}${providerId}`;
}

/** What a read may say about one field. Deliberately has no value-bearing member. */
export interface ProviderCredentialStatus {
  key: string;
  label: string;
  help: string | null;
  helpUrl: string | null;
  placeholder: string | null;
  /** The provider's format (regular-expression source), so the page can refuse a bad value before sending. */
  pattern: string | null;
  /** Hosts whose requests carry the value; empty for an ingress-only field. */
  hosts: string[];
  configured: boolean;
  /** ISO time the current value was saved, or null when not configured. */
  savedAt: string | null;
}

export type ProviderCredentialErrorCode = 'no-credential-fields' | 'unknown-field' | 'invalid-value' | 'empty-request';

export class ProviderCredentialError extends Error {
  constructor(
    readonly code: ProviderCredentialErrorCode,
    message: string,
    readonly field: string | null = null,
  ) {
    super(message);
    this.name = 'ProviderCredentialError';
  }
}

function fieldsOf(descriptor: Pick<ProviderDescriptor, 'id' | 'setup'>): ProviderCredentialField[] {
  return descriptor.setup?.credentials ?? [];
}

function statusOf(field: ProviderCredentialField, stored: Record<string, unknown>): ProviderCredentialStatus {
  const value = stored[field.key];
  const configured = typeof value === 'string' && value !== '';
  const savedAt = stored[`${field.key}${SAVED_AT_SUFFIX}`];
  return {
    key: field.key,
    label: field.label,
    help: field.help ?? null,
    helpUrl: field.helpUrl ?? null,
    placeholder: field.placeholder ?? null,
    pattern: field.pattern ?? null,
    hosts: [...(field.hosts ?? [])],
    configured,
    savedAt: configured && typeof savedAt === 'string' ? savedAt : null,
  };
}

/** Each declared field and whether it is configured. Never includes a value. */
export async function providerCredentialStatus(
  descriptor: Pick<ProviderDescriptor, 'id' | 'setup'>,
  harness: string,
  storage: TokenStorage = fsTokenStorage,
): Promise<ProviderCredentialStatus[]> {
  const fields = fieldsOf(descriptor);
  if (fields.length === 0) return [];
  const stored = await storage.read(providerSetupStoreKey(descriptor.id), harness);
  return fields.map((field) => statusOf(field, stored));
}

/**
 * Check and store some or all of a provider's credentials. Every value is checked before any is
 * written, so a request with one bad value changes nothing. Returns the status, not the values.
 */
export async function saveProviderCredentials(
  descriptor: Pick<ProviderDescriptor, 'id' | 'setup'>,
  harness: string,
  values: Record<string, unknown>,
  opts: { storage?: TokenStorage; now?: () => Date } = {},
): Promise<ProviderCredentialStatus[]> {
  const storage = opts.storage ?? fsTokenStorage;
  const fields = fieldsOf(descriptor);
  if (fields.length === 0) {
    throw new ProviderCredentialError('no-credential-fields', `provider "${descriptor.id}" declares no credential fields`);
  }
  const entries = Object.entries(values);
  if (entries.length === 0) throw new ProviderCredentialError('empty-request', 'no credential values were sent');
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const patch: Record<string, unknown> = {};
  const savedAt = (opts.now?.() ?? new Date()).toISOString();
  for (const [key, value] of entries) {
    const field = byKey.get(key);
    if (!field) {
      throw new ProviderCredentialError('unknown-field', `provider "${descriptor.id}" has no credential field "${key}"`, key);
    }
    const issue = providerCredentialValueIssue(field, value);
    if (issue) throw new ProviderCredentialError('invalid-value', issue, key);
    patch[key] = (value as string).trim();
    patch[`${key}${SAVED_AT_SUFFIX}`] = savedAt;
  }
  await storage.update(providerSetupStoreKey(descriptor.id), harness, patch);
  return providerCredentialStatus(descriptor, harness, storage);
}

/** Forget one stored credential. */
export async function clearProviderCredential(
  descriptor: Pick<ProviderDescriptor, 'id' | 'setup'>,
  harness: string,
  key: string,
  storage: TokenStorage = fsTokenStorage,
): Promise<ProviderCredentialStatus[]> {
  if (!fieldsOf(descriptor).some((field) => field.key === key)) {
    throw new ProviderCredentialError('unknown-field', `provider "${descriptor.id}" has no credential field "${key}"`, key);
  }
  await storage.update(providerSetupStoreKey(descriptor.id), harness, { [key]: null, [`${key}${SAVED_AT_SUFFIX}`]: null });
  return providerCredentialStatus(descriptor, harness, storage);
}

/**
 * The stored value of one declared field, or null when it is not configured. HOST-INTERNAL: only
 * `host.fetch` (bearer injection) and host-held ingress may call this. Never return its result
 * from a route, a tool, a sync query, or anything provider code can reach.
 */
export async function readProviderCredentialValue(
  descriptor: Pick<ProviderDescriptor, 'id' | 'setup'>,
  harness: string,
  key: string,
  storage: TokenStorage = fsTokenStorage,
): Promise<string | null> {
  if (!fieldsOf(descriptor).some((field) => field.key === key)) return null;
  const value = (await storage.read(providerSetupStoreKey(descriptor.id), harness))[key];
  return typeof value === 'string' && value !== '' ? value : null;
}
