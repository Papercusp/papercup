import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { normalizeEventKey } from '../event-key-registry-store';
import {
  DERIVED_ONLY_MANIFEST_FIELDS,
  EVENT_MANIFEST,
  EVENT_PACKAGE_SCHEMA_VERSION,
  INSTALL_SITE_ONLY_MANIFEST_FIELDS,
  forbiddenManifestFields,
  readEventDir,
  writeEventPackageDir,
  type EventExportSource,
} from './event-store';

const roots: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'event-store-'));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** A key that is already its own normalization — asserted, not assumed, so this
 *  fixture cannot silently stop being canonical if `normalizeEventKey` changes. */
const EVENT_KEY = 'work-item:done';

const DONE: EventExportSource = {
  eventKey: EVENT_KEY,
  title: 'Work item done',
  description: 'fires when a work-item reaches a terminal state',
  keyPattern: 'work-item:done:*',
  tags: ['work-items'],
};

/** Write a package dir by hand so a test can express manifests the writer refuses. */
function handWritten(manifest: Record<string, unknown>, listing?: Record<string, unknown>): string {
  const dir = scratch();
  writeFileSync(join(dir, EVENT_MANIFEST), JSON.stringify(manifest), 'utf8');
  writeFileSync(
    join(dir, 'listing.json'),
    JSON.stringify(
      listing ?? { kind: 'event', ref: EVENT_KEY, source: 'https://github.com/o/r' },
    ),
    'utf8',
  );
  return dir;
}

function goodManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: EVENT_PACKAGE_SCHEMA_VERSION,
    eventKey: EVENT_KEY,
    title: 'Work item done',
    description: 'fires when a work-item reaches a terminal state',
    version: '0.1.0',
    ...over,
  };
}

describe('event package round-trip', () => {
  it('writes a definition and reads back every field the registry row needs', () => {
    const written = writeEventPackageDir(DONE, {
      source: 'https://github.com/papercup/events',
      targetDir: scratch(),
    });
    const read = readEventDir(written.dir, written.ref);
    expect(read).not.toBeNull();
    expect(read!.eventKey).toBe(EVENT_KEY);
    expect(read!.title).toBe('Work item done');
    expect(read!.keyPattern).toBe('work-item:done:*');
    expect(read!.tags).toEqual(['work-items']);
    expect(read!.source).toBe('https://github.com/papercup/events');
    // The package-scoped identity is NOT the registry PK — two workspaces may
    // install the same definition, so the install layer needs its own handle.
    expect(read!.installedId).toMatch(/^installed:[0-9a-f]{16}$/);
    expect(read!.installedId).not.toBe(read!.eventKey);
  });

  it('carries only the curated half: an exported package has no derived fields to drop', () => {
    // The derived half is dropped by the TYPE, not by a hand-written pick — so
    // assert against the emitted manifest, which is what actually ships.
    const written = writeEventPackageDir(DONE, {
      source: 'https://github.com/papercup/events',
      targetDir: scratch(),
    });
    expect(forbiddenManifestFields(written.manifest as unknown as Record<string, unknown>)).toEqual(
      [],
    );
    // POSITIVE CONTROL for that emptiness: the same predicate DOES fire on a
    // manifest that carries one, so an always-[] implementation cannot pass here.
    expect(forbiddenManifestFields({ ...written.manifest, emitSiteCount: 3 })).toEqual([
      'emitSiteCount',
    ]);
  });

  it('accepts the three listing shapes that mark a package as an event', () => {
    for (const listing of [
      { kind: 'event', ref: EVENT_KEY, source: 'https://github.com/o/r' },
      { listing_kind: 'event', ref: EVENT_KEY, source: 'https://github.com/o/r' },
      { scope: 'event', ref: EVENT_KEY, source: 'https://github.com/o/r' },
    ]) {
      expect(readEventDir(handWritten(goodManifest(), listing), EVENT_KEY)).not.toBeNull();
    }
  });
});

describe('D-058: the derived half and install-site lifecycle are not distributable', () => {
  // CALIBRATION for every refusal below — a parser that rejected everything would
  // produce the same all-green run without it.
  it('reads a manifest carrying NONE of the forbidden fields', () => {
    expect(readEventDir(handWritten(goodManifest()), EVENT_KEY)).not.toBeNull();
  });

  it('refuses a package asserting any DERIVED field — a measurement of the publisher tree', () => {
    expect(DERIVED_ONLY_MANIFEST_FIELDS.length).toBeGreaterThan(0);
    for (const field of DERIVED_ONLY_MANIFEST_FIELDS) {
      expect(
        readEventDir(handWritten(goodManifest({ [field]: 'anything' })), EVENT_KEY),
        `derived field ${field} must refuse the package`,
      ).toBeNull();
      expect(forbiddenManifestFields(goodManifest({ [field]: 'anything' }))).toContain(field);
    }
  });

  it('refuses a package asserting any INSTALL-SITE field — an authority a publisher lacks', () => {
    expect(INSTALL_SITE_ONLY_MANIFEST_FIELDS.length).toBeGreaterThan(0);
    for (const field of INSTALL_SITE_ONLY_MANIFEST_FIELDS) {
      expect(
        readEventDir(handWritten(goodManifest({ [field]: 'anything' })), EVENT_KEY),
        `install-site field ${field} must refuse the package`,
      ).toBeNull();
      expect(forbiddenManifestFields(goodManifest({ [field]: 'anything' }))).toContain(field);
    }
  });

  it('refuses rather than silently dropping — a publisher must learn the attestation did not ship', () => {
    // The distinction this asserts: a SILENT DROP would return a usable package
    // whose derived claim vanished. Refusal is the documented behaviour.
    const dir = handWritten(goodManifest({ emitter: 'packages/x/y.ts', emitSiteCount: 4 }));
    expect(readEventDir(dir, EVENT_KEY)).toBeNull();
    expect(forbiddenManifestFields(goodManifest({ emitter: 'a', emitSiteCount: 4 }))).toEqual([
      'emitter',
      'emitSiteCount',
    ]);
  });

  it('treats an explicitly-undefined forbidden field as absent, not as an assertion', () => {
    expect(forbiddenManifestFields(goodManifest({ emitter: undefined }))).toEqual([]);
    expect(readEventDir(handWritten(goodManifest({ emitter: undefined })), EVENT_KEY)).not.toBeNull();
  });
});

describe('the key a package ships must already be the registry PK', () => {
  it('holds the fixture key canonical, so the refusal below cannot pass vacuously', () => {
    expect(normalizeEventKey(EVENT_KEY)).toBe(EVENT_KEY);
  });

  // PINS THE REACHABLE BEHAVIOUR, NOT THE COMMENT. `readEventDir` tests
  // `normalizeEventKey(k) !== k`, but `stringValue()` has already trimmed `k` and
  // the imported `normalizeEventKey` (event-key-registry-store) is TRIM-ONLY — so
  // that comparison cannot fire. The only key it rejects is an empty one, via the
  // `!eventKey` arm. Do not read these as endorsing the gap; they record it so a
  // future real normalizer (lowercasing, separator collapsing — as the SEPARATELY
  // NAMED `normalizeEventKey` in announce-key.ts does) fails here and gets tests.
  it('canonicalization is trim-only today: a padded key is accepted, stored trimmed', () => {
    expect(normalizeEventKey('  work-item:done  ')).toBe('work-item:done');
    const read = readEventDir(
      handWritten(goodManifest({ eventKey: '  work-item:done  ' })),
      EVENT_KEY,
    );
    expect(read).not.toBeNull();
    expect(read!.eventKey).toBe('work-item:done');
  });

  it('treats case as significant: a differently-cased key is a DIFFERENT key, not a refusal', () => {
    const cased = readEventDir(handWritten(goodManifest({ eventKey: 'Work-Item:DONE' })), EVENT_KEY);
    expect(cased).not.toBeNull();
    expect(cased!.eventKey).toBe('Work-Item:DONE');
  });

  it('refuses an empty key — the one arm of the canonical check that is reachable', () => {
    expect(readEventDir(handWritten(goodManifest({ eventKey: '   ' })), EVENT_KEY)).toBeNull();
    expect(() =>
      writeEventPackageDir({ ...DONE, eventKey: '   ' }, {
        source: 'https://github.com/o/r',
        targetDir: scratch(),
      }),
    ).toThrow(/canonical event key/);
  });

  it('refuses a missing key and a mismatched listing kind', () => {
    expect(readEventDir(handWritten(goodManifest({ eventKey: '' })), EVENT_KEY)).toBeNull();
    expect(
      readEventDir(
        handWritten(goodManifest(), {
          kind: 'datatype',
          ref: EVENT_KEY,
          source: 'https://github.com/o/r',
        }),
        EVENT_KEY,
      ),
    ).toBeNull();
  });

  it('refuses a manifest from a future schema version', () => {
    expect(readEventDir(handWritten(goodManifest({ schemaVersion: 2 })), EVENT_KEY)).toBeNull();
  });

  it('refuses an unusable version string', () => {
    expect(readEventDir(handWritten(goodManifest({ version: 'not a version' })), EVENT_KEY)).toBeNull();
    expect(() =>
      writeEventPackageDir(DONE, {
        source: 'https://github.com/o/r',
        version: 'not a version',
        targetDir: scratch(),
      }),
    ).toThrow(/invalid event version/);
  });

  it('refuses a tag list that is not a list of usable strings', () => {
    expect(readEventDir(handWritten(goodManifest({ tags: 'work-items' })), EVENT_KEY)).toBeNull();
    expect(readEventDir(handWritten(goodManifest({ tags: [''] })), EVENT_KEY)).toBeNull();
    // POSITIVE CONTROL: a well-formed list on the same path is accepted.
    expect(readEventDir(handWritten(goodManifest({ tags: ['ok'] })), EVENT_KEY)).not.toBeNull();
  });
});
