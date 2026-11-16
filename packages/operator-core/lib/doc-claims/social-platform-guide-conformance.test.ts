/**
 * WI-6554700010049569: the social acceptance runbook follows installed packages
 * and host-owned sync progress. Execute its examples against the real projection;
 * obsolete prose and altered examples are negative controls, never live delivery proof.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ProviderAdapter } from '@papercusp/plugin-sdk';
import { createProviderRegistry } from '../integrations/provider-registry';
import { bundledSocialProviderDescriptors } from '../capability-verbs/social-provider.fixture';
import { socialAdminFacts } from '../external-triggers/admin';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const guide = read('apps/operator-docs/src/content/docs/testing/social-platform-acceptance.mdx');
const now = Date.parse('2026-08-23T12:00:00.000Z');
const registry = createProviderRegistry();
const tick = String.fromCharCode(96);

beforeAll(async () => {
  for (const descriptor of bundledSocialProviderDescriptors()) {
    const adapter: ProviderAdapter = {
      describe: () => descriptor,
      syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
      invoke: async () => { throw new Error('documentation controls must not call a vendor'); },
    };
    await registry.register({ descriptor, adapter, pluginName: descriptor.id });
  }
});

function stateExamples(body: string) {
  return body.split('\n').flatMap(line => {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.length !== 3 || !cells.every(cell => cell.startsWith(tick) && cell.endsWith(tick))) return [];
    const [provider, json, expected] = cells.map(cell => cell.slice(1, -1));
    if (!json?.startsWith('{')) return [];
    return [{ provider: provider!, cursor: JSON.parse(json), expected: expected! }];
  });
}

function stateMismatches(body: string) {
  const examples = stateExamples(body);
  if (!examples.length) return ['missing_state_matrix'];
  return examples.flatMap(example => {
    const actual = socialAdminFacts(example.provider, example.cursor, now, registry);
    return actual?.cursor.state === example.expected ? [] : [example.provider + ':' + example.expected];
  });
}

const obsoleteClaims = [
  ['missing_registry_authority', 'Wave, platforms, and the wall are **derived from the platform registry**'],
  ['no_production_sync', 'No production code persists a social cursor yet'],
  ['vendor_timestamp_inference', 'no timestamp on this platform'],
  ['permanent_agent_wall', 'not verifiable by an agent'],
] as const;

function obsoleteViolations(body: string) {
  return obsoleteClaims.filter(([, claim]) => body.includes(claim)).map(([code]) => code);
}

describe('social platform runbook source conformance', () => {
  it('anchors maintained package, source-store, sync and SDK contracts to real files', () => {
    const frontmatter = guide.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(frontmatter).not.toBeNull();
    const metadata = parseYaml(frontmatter![1]!) as { documents: string[] };
    expect(metadata.documents).toEqual(expect.arrayContaining([
      'packages/operator-core/lib/integrations/provider-registry.ts',
      'packages/operator-core/lib/external-triggers/source-store.ts',
      'packages/operator-core/lib/providers/connector-runtime.ts',
      'packages/plugin-sdk/src/provider.ts',
    ]));
    for (const anchor of metadata.documents) expect(existsSync(resolve(root, anchor)), anchor).toBe(true);
  });

  it('derives the documented state population from real installed package descriptors', () => {
    expect(stateExamples(guide).map(example => example.expected)).toEqual([
      'synced', 'position-only', 'never-synced', 'unrecognized', 'not-readable',
    ]);
    expect(stateMismatches(guide)).toEqual([]);
    const synced = stateExamples(guide).find(example => example.expected === 'synced')!;
    expect(socialAdminFacts(synced.provider, synced.cursor, now, registry)!.cursor.ageMs).toBe(180_000);
  });

  it('rejects an old vendor-specific cursor classified as advancing', () => {
    const altered = guide.replace(
      tick + '{"newestFullname":"t3_example"}' + tick + ' | ' + tick + 'unrecognized' + tick,
      tick + '{"newestFullname":"t3_example"}' + tick + ' | ' + tick + 'position-only' + tick,
    );
    expect(altered).not.toBe(guide);
    expect(stateMismatches(altered)).toContain('reddit:position-only');
  });

  it('rejects classifying write-only LinkedIn as a never-synced readable stream', () => {
    const altered = guide.replace(tick + 'not-readable' + tick + ' |', tick + 'never-synced' + tick + ' |');
    expect(altered).not.toBe(guide);
    expect(stateMismatches(altered)).toContain('linkedin:never-synced');
  });

  it('fails closed when the matrix is missing', () => {
    expect(stateMismatches('No state examples')).toEqual(['missing_state_matrix']);
  });

  it('describes current LinkedIn capabilities without inheriting the historical wave wall', () => {
    const facts = socialAdminFacts('linkedin', {}, now, registry)!;
    expect(facts).toMatchObject({ readTransport: null, blockedOn: null, writeVerbs: ['post', 'delete'] });
    expect(facts).not.toHaveProperty('wave');
    expect(guide).toContain('there is no ' + tick + 'social.reply' + tick);
    expect(guide).toContain('Those waves are historical planning groups');
  });

  it('documents the actual source writer and host-owned timestamp', () => {
    const sourceStore = read('packages/operator-core/lib/external-triggers/source-store.ts');
    const connector = read('packages/operator-core/lib/providers/connector-runtime.ts');
    expect(sourceStore).toContain('INSERT INTO harness_shared.data_sources');
    expect(connector).toContain('UPDATE harness_shared.data_sources');
    expect(connector).toContain('lastSyncedAt: new Date().toISOString()');
    expect(guide).toContain('providerSync.lastSyncedAt');
    expect(guide).toContain('createOwnedExternalTriggerSource');
    expect(guide).toContain('harness_shared.data_sources');
  });

  it('keeps default-off binding creation and current route keys explicit', () => {
    const admin = read('packages/operator-core/lib/external-triggers/admin.ts');
    expect(admin).toContain('armed, storm_policy, created_by');
    expect(admin).toContain('::text::jsonb, FALSE,');
    expect(guide).toContain('armed = FALSE');
    expect(guide).toContain('/admin/triggers?view=sources&sources=social');
    expect(guide).toContain('/admin/plans?plan=<plan-slug>&ptab=triggers');
  });

  it('separates historical observations, fixture scope and authorized live delivery', () => {
    expect(guide).toContain('historical fixture counts');
    expect(guide).toContain('does not certify a new GUI run');
    expect(guide).toContain('VERIFY_TAURI_ISOLATED_DB=1');
    expect(guide).toContain('positive and negative assertion results');
    expect(guide).toContain('An agent with that authorization can perform the check');
    expect(obsoleteViolations(guide)).toEqual([]);
  });

  it.each(obsoleteClaims)('detects the original %s claim even beside corrected prose', (code, claim) => {
    expect(obsoleteViolations(guide + '\n' + claim)).toContain(code);
  });
});
