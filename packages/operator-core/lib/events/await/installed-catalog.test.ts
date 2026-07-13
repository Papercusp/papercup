/**
 * The events:catalog INSTALLED tier — installed units' `provides.events` merged over
 * the builtin registry with provenance (cupboard-public-release-2026-07-12 P-006, D-003).
 *
 * The load-bearing property here is the SHADOWING REFUSAL. The sugar verbs resolve key
 * TEMPLATES by family id through this registry (`buildKey`), so if an installed pack
 * could re-declare `deploy` with its own keyTemplate, `deploy:await` would silently
 * start registering waits on a key nothing emits — and the awaiting agent would hang
 * forever. A wait that never fires is the worst failure this subsystem has, so the
 * builtin must win, and the refusal must be REPORTED rather than silently dropped.
 */
import { describe, expect, it } from 'vitest';
import {
  mergeInstalledEventCatalog,
  renderCatalog,
  buildKey,
  catalogEntry,
  EVENT_CATALOG,
  type InstalledUnitEvents,
} from './catalog';

const unit = (name: string, events: unknown[]): InstalledUnitEvents =>
  ({ unit: name, events }) as InstalledUnitEvents;

describe('mergeInstalledEventCatalog — the installed tier', () => {
  it('with no installed units, is exactly the builtin registry (pre-P-006 behaviour)', () => {
    const { entries, collisions } = mergeInstalledEventCatalog([]);
    expect(entries).toHaveLength(EVENT_CATALOG.length);
    expect(collisions).toEqual([]);
    expect(entries.every((e) => e.provenance === 'builtin')).toBe(true);
  });

  it('lifts a unit\'s provides.events in, tagged installed:<unit>', () => {
    const { entries, collisions } = mergeInstalledEventCatalog([
      unit('@papercupai/repomix', [
        {
          family: 'repomix-pack',
          keyTemplate: 'repomix:packed:<repo>',
          params: [{ name: 'repo', required: true, describe: 'the repo slug' }],
          describe: 'A repo finished packing.',
        },
      ]),
    ]);
    expect(collisions).toEqual([]);

    const lifted = entries.find((e) => e.family === 'repomix-pack');
    expect(lifted).toBeDefined();
    expect(lifted).toMatchObject({
      family: 'repomix-pack',
      keyTemplate: 'repomix:packed:<repo>',
      describe: 'A repo finished packing.',
      emitter: '@papercupai/repomix',
      provenance: 'installed:@papercupai/repomix',
      // An INSTALLED unit declaring provides.events is asserting its runtime fires the
      // key — unlike a builtin `exists:false` (a key with no emitter wired yet).
      exists: true,
    });
    expect(lifted!.params).toEqual([{ name: 'repo', required: true, describe: 'the repo slug' }]);

    // Builtins are untouched and still come first (they are the platform guarantees).
    expect(entries[0]!.provenance).toBe('builtin');
    expect(entries).toHaveLength(EVENT_CATALOG.length + 1);
  });

  it('REFUSES an installed family that shadows a BUILTIN, and reports the collision', () => {
    // The attack/mistake this exists to stop: a pack re-declaring `deploy` with its own
    // key. If it merged, buildKey('deploy') could resolve to a key nothing emits and
    // every deploy:await would hang forever.
    const hijack = unit('@evil/pack', [
      { family: 'deploy', keyTemplate: 'evil:not-a-deploy', describe: 'hijacked' },
    ]);
    const { entries, collisions } = mergeInstalledEventCatalog([hijack]);

    // The builtin `deploy` survives, untouched and still builtin-provenanced.
    const deploy = entries.filter((e) => e.family === 'deploy');
    expect(deploy).toHaveLength(1);
    expect(deploy[0]!.provenance).toBe('builtin');
    expect(deploy[0]!.keyTemplate).toBe(catalogEntry('deploy')!.keyTemplate);
    expect(deploy[0]!.keyTemplate).not.toBe('evil:not-a-deploy');

    // The refusal is REPORTED — a silent drop leaves the author debugging a ghost.
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({ family: 'deploy', unit: '@evil/pack', heldBy: 'builtin' });
    expect(collisions[0]!.reason).toMatch(/BUILTIN/);

    // And the real guarantee: the sugar path still resolves to the builtin key.
    expect(buildKey('deploy', { sha: 'abc123' })).toBe('release:deployed:abc123');
  });

  it('REFUSES a family a previous installed unit already declared (first unit wins)', () => {
    const { entries, collisions } = mergeInstalledEventCatalog([
      unit('@a/pack', [{ family: 'shared', keyTemplate: 'a:done', describe: 'from a' }]),
      unit('@b/pack', [{ family: 'shared', keyTemplate: 'b:done', describe: 'from b' }]),
    ]);
    const shared = entries.filter((e) => e.family === 'shared');
    expect(shared).toHaveLength(1);
    expect(shared[0]!.provenance).toBe('installed:@a/pack');
    expect(collisions).toEqual([
      expect.objectContaining({ family: 'shared', unit: '@b/pack', heldBy: 'installed:@a/pack' }),
    ]);
  });

  it('skips malformed declarations rather than emitting a broken, un-awaitable row', () => {
    // P-005 validates at load time, but this merge is also fed by tests and by
    // not-yet-installed Cupboard listings — third-party data, so stay defensive.
    const { entries, collisions } = mergeInstalledEventCatalog([
      unit('@sloppy/pack', [
        { family: 'no-template' }, // no keyTemplate → cannot be awaited
        { keyTemplate: 'x:y' }, // no family → cannot be looked up
        null,
        'not-an-object',
        { family: '   ', keyTemplate: 'blank:family' },
        { family: 'good', keyTemplate: 'sloppy:good' }, // the one survivor
      ]),
    ]);
    const fromUnit = entries.filter((e) => e.provenance === 'installed:@sloppy/pack');
    expect(fromUnit.map((e) => e.family)).toEqual(['good']);
    expect(collisions).toEqual([]); // malformed ≠ collision
  });

  it('drops malformed params but keeps the family, and defaults a missing describe', () => {
    const { entries } = mergeInstalledEventCatalog([
      unit('@p/pack', [
        {
          family: 'f',
          keyTemplate: 'p:f:<id>',
          params: [{ name: 'id', required: true, describe: 'the id' }, { required: true }, null, 'x'],
          // no describe
        },
      ]),
    ]);
    const f = entries.find((e) => e.family === 'f')!;
    expect(f.params).toEqual([{ name: 'id', required: true, describe: 'the id' }]);
    expect(f.describe).toBe('Provided by @p/pack.');
  });

  it('ignores a unit with no events, and one with a blank name', () => {
    const { entries, collisions } = mergeInstalledEventCatalog([
      unit('@empty/pack', []),
      { unit: '', events: [{ family: 'x', keyTemplate: 'x:y' }] } as InstalledUnitEvents,
      { unit: '@noevents/pack' } as InstalledUnitEvents,
    ]);
    expect(entries).toHaveLength(EVENT_CATALOG.length);
    expect(collisions).toEqual([]);
  });

  it('does NOT mutate the process-global EVENT_CATALOG', () => {
    // The registry is a module const shared across the process and read by the sugar
    // verbs. A merge that grew it with whatever was installed last would be
    // unreproducible and order-dependent.
    const before = EVENT_CATALOG.length;
    mergeInstalledEventCatalog([unit('@x/pack', [{ family: 'brand-new', keyTemplate: 'x:new' }])]);
    expect(EVENT_CATALOG).toHaveLength(before);
    expect(catalogEntry('brand-new')).toBeUndefined();
  });
});

describe('renderCatalog — installed rows', () => {
  it('stamps provenance on every row and renders an await example for an installed family', () => {
    const rows = renderCatalog([
      unit('@papercupai/repomix', [
        { family: 'repomix-pack', keyTemplate: 'repomix:packed:<repo>', describe: 'packed.' },
      ]),
    ]);
    expect(rows.every((r) => r.provenance !== undefined)).toBe(true);

    const row = rows.find((r) => r.family === 'repomix-pack')!;
    expect(row).toMatchObject({
      key: 'repomix:packed:<repo>',
      awaitable_now: true,
      await_example: 'events:await { event: "repomix:packed:<repo>" }',
      emitter: '@papercupai/repomix',
      provenance: 'installed:@papercupai/repomix',
    });
  });

  it('with no argument, still renders the builtin catalog (every existing caller keeps working)', () => {
    const rows = renderCatalog();
    expect(rows).toHaveLength(EVENT_CATALOG.length);
    expect(rows.every((r) => r.provenance === 'builtin')).toBe(true);
  });
});
