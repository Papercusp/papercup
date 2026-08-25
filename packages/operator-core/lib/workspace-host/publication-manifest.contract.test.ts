import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_HOST_PUBLICATION_KIND,
  WORKSPACE_HOST_PUBLICATION_MANIFEST_KEYS,
  WORKSPACE_HOST_PUBLICATION_SCHEMA_VERSION,
  WORKSPACE_HOST_PUBLISHED_BUNDLE_NAME,
  WORKSPACE_HOST_PUBLISHED_SIGNATURE_NAME,
} from './publication-manifest';

/**
 * D-108 makes `manifest.json` ONE contract with two halves: operator-core constructs it, and
 * operator-public (WI-41736) validates it at the network boundary and owns the public routes.
 * Nothing links the two at compile time — operator-public must not import the operator-core
 * runtime — so the halves can drift apart with both packages green.
 *
 * They already did. The producer emitted `{version, objects{…bytes}, trust}` while the publisher's
 * CLOSED top-level allowlist demanded `{schemaVersion, kind, artifact, files{…sizeBytes},
 * trustReport}`. Every manifest the producer could build was rejected by the route meant to serve
 * it, and both test suites passed throughout, because each half only ever tested itself.
 *
 * This pins the producer's published names against the publisher's SOURCE (the derived-truth
 * ladder's PIN tier: a build-time divergence check where a shared import is not available).
 * It deliberately reads the route file as text rather than restating its rules, so the check
 * cannot quietly become a third copy of the contract.
 *
 * The subject path is overridable so this guard's own falsifiability can be proven against a
 * MUTATED COPY outside the tree (scripts/mutation-probe.sh tier 2), never by mutating the shared
 * checkout, which git-sync would commit mid-probe.
 */
const PUBLISHER_ROUTE =
  process.env.PAPERCUSP_WORKSPACE_HOST_PUBLISHER_ROUTE ??
  join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../apps/operator-public/src/routes/workspace-host-artifacts.ts',
  );

function publisherSource(): string {
  const source = readFileSync(PUBLISHER_ROUTE, 'utf8');
  // A moved or renamed route would otherwise make every assertion below vacuously true.
  expect(
    source,
    `${PUBLISHER_ROUTE} no longer looks like the workspace-host publication route`,
  ).toContain('function validatePublicationManifest(');
  return source;
}

/** Extract a literal from the publisher, failing loudly rather than returning undefined. */
function capture(source: string, pattern: RegExp, what: string): string {
  const match = source.match(pattern);
  expect(match?.[1], `could not read ${what} from ${PUBLISHER_ROUTE}`).toBeDefined();
  return match![1];
}

describe('publication manifest contract (D-108 producer/publisher agreement)', () => {
  it('emits exactly the top-level fields the publisher allows', () => {
    const allowed = capture(
      publisherSource(),
      /const allowedTopLevel = new Set\(\[([^\]]*)\]\)/,
      "validatePublicationManifest's allowedTopLevel set",
    );
    const publisherKeys = [...allowed.matchAll(/'([^']+)'/g)].map((match) => match[1]);

    expect(publisherKeys.length).toBeGreaterThan(0);
    // Set equality both ways: a field the producer omits fails publication, and a field the
    // producer adds is rejected by the publisher's closed allowlist.
    expect([...publisherKeys].sort()).toEqual([...WORKSPACE_HOST_PUBLICATION_MANIFEST_KEYS].sort());
  });

  it('stamps the schemaVersion and kind the publisher requires', () => {
    const source = publisherSource();

    expect(
      Number(capture(source, /const PUBLICATION_SCHEMA_VERSION = (\d+)/, 'PUBLICATION_SCHEMA_VERSION')),
    ).toBe(WORKSPACE_HOST_PUBLICATION_SCHEMA_VERSION);
    expect(capture(source, /const PUBLICATION_KIND = '([^']+)'/, 'PUBLICATION_KIND')).toBe(
      WORKSPACE_HOST_PUBLICATION_KIND,
    );
  });

  it('names the two published objects exactly as the publisher expects to find them', () => {
    const source = publisherSource();
    const descriptors = capture(
      source,
      /const bundle = isRecord\(files\) \? fileDescriptor\(files\.bundle, '([^']+)'\)/,
      'the expected bundle object name',
    );
    const signature = capture(
      source,
      /const signature = isRecord\(files\) \? fileDescriptor\(files\.signature, '([^']+)'\)/,
      'the expected signature object name',
    );

    expect(descriptors).toBe(WORKSPACE_HOST_PUBLISHED_BUNDLE_NAME);
    expect(signature).toBe(WORKSPACE_HOST_PUBLISHED_SIGNATURE_NAME);
  });

  it('uses the size field name the publisher reads, not a synonym', () => {
    // `bytes` vs `sizeBytes` is the single most drift-prone name in the envelope: both are
    // natural, the trust report itself uses `bytes`, and a mismatch here is invisible until a
    // real upload is rejected.
    const source = publisherSource();
    const descriptor = capture(
      source,
      /function fileDescriptor\([^)]*\)[^{]*\{([\s\S]*?)\n\}/,
      "the publisher's fileDescriptor body",
    );

    expect(descriptor).toContain('sizeBytes');
    expect(descriptor).not.toMatch(/value\.bytes\b/);
  });
});
