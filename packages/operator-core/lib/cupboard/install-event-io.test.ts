/**
 * install-event-io — the seam where Cupboard DISTRIBUTION meets registry RESOLUTION
 * for `event` (P-029 / D-010).
 *
 * The shared property with `install-datatype-io` is D-010's: "package on disk" and
 * "install succeeded" must not be the same claim, because a rule's `on` and an agent's
 * `events:await` resolve through the REGISTRY, never through the installed directory —
 * so an unseeded package is a listener parked on a key that resolves nowhere. That is
 * the silent-inertness failure P-029 exists to close, and it is asserted below.
 *
 * What is NOT shared — and is therefore the part worth this file existing — is D-058's
 * curated/derived boundary, which `event` has and `datatype` does not:
 *
 *   - a package may carry NEITHER the derived half (emitter / emitterExists /
 *     emitSiteCount / derivedFrom / derivedAt — measurements of the PUBLISHER's tree)
 *     NOR install-site lifecycle (contributor / status / published / reviewStatus);
 *   - `contributor` is stamped from what the INSTALL observed, never from what the
 *     publisher asserted about itself;
 *   - `registryInputFromPackage` must be a WHITELIST, not a spread, so the projection
 *     into `RegisterEventKeyInput` is total by construction rather than by accident.
 *
 * The two refusal suites iterate the EXPORTED constants rather than a hand-copied list,
 * so adding a forbidden field to the source extends this test automatically. Each gate
 * carries a POSITIVE CONTROL: an all-green run has to be impossible to obtain from a
 * seam that rejects everything, and a whitelist assertion has to be impossible to pass
 * from a mapper that drops everything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fixtureRepo = '';
let resolvedVersion = '1.0.0';
let resolveFails = false;

// importOriginal + spread, NOT a hand-listed factory: a factory listing only the exports
// this test happened to need makes every OTHER export `undefined` the moment the module
// under test reaches for one — while still typechecking, because a vi.mock factory is not
// checked against the real module. That is what red-pinned the gate on install-theme-io
// (WI-10001674). Spreading `actual` means a newly-added export cannot strand this file.
vi.mock('./install-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./install-io')>();
  const cloneRepo = async (_url: string, dest: string): Promise<void> => {
    await fs.cp(fixtureRepo, dest, { recursive: true });
  };
  return {
    ...actual,
    gitCloneShallow: cloneRepo,
    cupboardGitDeps: () => ({ ...actual.cupboardGitDeps(), cloneRepo }),
  };
});
vi.mock('./resolve-listing-by-kind', () => ({
  resolveListingByKind: async (_idOrRef: string, kind: string) => {
    if (resolveFails) return { error: `no ${kind} listing found`, status: 404 };
    return {
      githubUrl: 'https://github.com/acme/events',
      ref: 'work-item-lifecycle',
      listingId: 'listing-work-item-lifecycle',
      releaseVersion: resolvedVersion,
    };
  },
}));

import { _resetPapercuspRootForTests } from '../papercusp-root';
import { installEventFromCupboard, registryInputFromPackage } from './install-event-io';
import {
  DERIVED_ONLY_MANIFEST_FIELDS,
  INSTALL_SITE_ONLY_MANIFEST_FIELDS,
  resolveInstalledEvent,
  type InstalledEvent,
} from './event-store';
import type { RegisterEventKeyInput } from '../event-key-registry-store';

let root = '';

const LISTING_REF = 'work-item-lifecycle';
const EVENT_KEY = 'work-item:done';

/** Write a self-describing `event` package into the fixture mirror. */
async function writePackage(
  opts: { eventKey?: string; version?: string; extra?: Record<string, unknown> } = {},
): Promise<void> {
  const dir = join(fixtureRepo, LISTING_REF);
  await fs.mkdir(dir, { recursive: true });
  const version = opts.version ?? '1.0.0';
  await fs.writeFile(
    join(dir, 'event.json'),
    JSON.stringify({
      schemaVersion: 1,
      // The key IS the registry PK on install, so readEventDir requires it to be ALREADY
      // canonical — it is never re-normalized here, or the package and the row it seeds
      // would disagree about the event's identity.
      eventKey: opts.eventKey ?? EVENT_KEY,
      title: 'Work-item lifecycle',
      description: 'Keys fired as a work-item moves through its lifecycle.',
      version,
      keyPattern: 'work-item:*',
      tags: ['lifecycle'],
      ...(opts.extra ?? {}),
    }),
  );
  await fs.writeFile(
    join(dir, 'listing.json'),
    JSON.stringify({
      kind: 'event',
      ref: LISTING_REF,
      title: 'Work-item lifecycle',
      version,
      source: 'https://github.com/acme/events',
    }),
  );
}

/** A seeder that records the FULL registry write, so a projection defect is visible. */
function recordingSeeder() {
  const writes: RegisterEventKeyInput[] = [];
  return {
    writes,
    deps: {
      seedRegistry: async (input: RegisterEventKeyInput) => {
        writes.push(input);
        return { eventKey: input.eventKey };
      },
    },
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'pc-event-io-'));
  fixtureRepo = await fs.mkdtemp(join(tmpdir(), 'pc-event-mirror-'));
  // PAPERCUSP_HOME, not PAPERCUSP_ROOT: `papercuspRoot()` reads PAPERCUSP_HOME and IGNORES
  // PAPERCUSP_ROOT entirely, so setting the latter isolates NOTHING — the install silently
  // lands in the live workspace layer and PERSISTS, which then 409s every later run as
  // "already installed".
  process.env.PAPERCUSP_HOME = join(root, 'home');
  _resetPapercuspRootForTests();
  resolvedVersion = '1.0.0';
  resolveFails = false;
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  _resetPapercuspRootForTests();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(fixtureRepo, { recursive: true, force: true });
});

describe('installEventFromCupboard', () => {
  it('installs the package AND seeds the registry row — the two halves of D-010', async () => {
    await writePackage();
    const seeder = recordingSeeder();

    const result = await installEventFromCupboard(
      { listingId: 'listing-work-item-lifecycle', workspaceId: 'ws-1', createdBy: 'agent-7' },
      seeder.deps,
    );

    // toMatchObject, not `.ok === true`: on failure it prints the WHOLE result, so a
    // refusal names its own status/error/detail instead of "expected false to be true".
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    // Distribution half: the package is resolvable on disk.
    expect(result.result.operation).toBe('install');
    expect(resolveInstalledEvent(result.result.ref)).not.toBeNull();
    // Resolution half: exactly one registry write, into the CALLER's workspace.
    expect(seeder.writes).toHaveLength(1);
    expect(seeder.writes[0]).toMatchObject({
      workspaceId: 'ws-1',
      eventKey: EVENT_KEY,
      title: 'Work-item lifecycle',
      keyPattern: 'work-item:*',
      tags: ['lifecycle'],
      createdBy: 'agent-7',
    });
    // `registeredKey` is the NATURAL key, not a surrogate id: `event_key_registry` is keyed
    // on (workspaceId, eventKey) and `EventKeyRow` has no `id` column at all, so the key an
    // `events:await` can now resolve is the only identity the row has.
    expect(result.result.registeredKey).toBe(EVENT_KEY);
  });

  it('reports a FAILED install when the registry seed throws — a package with no row is INERT', async () => {
    await writePackage();

    const result = await installEventFromCupboard(
      { listingId: 'listing-work-item-lifecycle', workspaceId: 'ws-1' },
      {
        seedRegistry: async () => {
          throw new Error('pool exhausted');
        },
      },
    );

    // Never a success with a warning: the package is on disk but its keys resolve nowhere,
    // so an `events:await` on this vocabulary would be silently inert forever.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(500);
    expect(result.error).toMatch(/not resolvable yet/);
    expect(result.detail).toMatch(/pool exhausted/);

    // POSITIVE CONTROL: the identical install with a working seeder succeeds, so the refusal
    // above is attributable to the seed and not to a broken fixture.
    const ok = await installEventFromCupboard(
      { listingId: 'listing-work-item-lifecycle', workspaceId: 'ws-1', update: true },
      recordingSeeder().deps,
    );
    expect(ok.ok).toBe(true);
  });

  it('re-seeds on a version-matched no-op, so a package stranded by an earlier failed seed recovers', async () => {
    await writePackage();
    const first = recordingSeeder();
    expect((await installEventFromCupboard(
      { listingId: 'listing-work-item-lifecycle', workspaceId: 'ws-1' },
      first.deps,
    )).ok).toBe(true);

    const second = recordingSeeder();
    const again = await installEventFromCupboard(
      { listingId: 'listing-work-item-lifecycle', workspaceId: 'ws-1' },
      second.deps,
    );

    expect(again).toMatchObject({ ok: true });
    if (!again.ok) return;
    expect(again.result.operation).toBe('no-op');
    // The row is re-written even though no bytes moved — the package being present says
    // NOTHING about the row, which is exactly the repair path for an inert install.
    expect(second.writes).toHaveLength(1);
    expect(second.writes[0]?.eventKey).toBe(EVENT_KEY);
    expect(again.result.registeredKey).toBe(EVENT_KEY);
  });

  it('refuses a re-install of a DIFFERENT version without update:true, seeding nothing', async () => {
    await writePackage();
    expect((await installEventFromCupboard(
      { listingId: 'listing-work-item-lifecycle', workspaceId: 'ws-1' },
      recordingSeeder().deps,
    )).ok).toBe(true);

    resolvedVersion = '2.0.0';
    await writePackage({ version: '2.0.0' });
    const seeder = recordingSeeder();
    const result = await installEventFromCupboard(
      { listingId: 'listing-work-item-lifecycle', workspaceId: 'ws-1' },
      seeder.deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toMatch(/already installed/);
    expect(seeder.writes).toEqual([]);

    // POSITIVE CONTROL: update:true is accepted and re-seeds.
    const updated = await installEventFromCupboard(
      { listingId: 'listing-work-item-lifecycle', workspaceId: 'ws-1', update: true },
      seeder.deps,
    );
    expect(updated).toMatchObject({ ok: true });
    if (!updated.ok) return;
    expect(updated.result.operation).toBe('update');
    expect(updated.result.version).toBe('2.0.0');
    expect(seeder.writes).toHaveLength(1);
  });

  it('requires a workspaceId, and surfaces a listing-resolution failure unchanged', async () => {
    await writePackage();
    const seeder = recordingSeeder();

    const noWorkspace = await installEventFromCupboard(
      { listingId: 'listing-work-item-lifecycle', workspaceId: '  ' },
      seeder.deps,
    );
    expect(noWorkspace.ok).toBe(false);
    if (!noWorkspace.ok) expect(noWorkspace.error).toMatch(/workspaceId required/);

    resolveFails = true;
    const unresolvable = await installEventFromCupboard(
      { listingId: 'missing', workspaceId: 'ws-1' },
      seeder.deps,
    );
    expect(unresolvable.ok).toBe(false);
    if (!unresolvable.ok) {
      expect(unresolvable.status).toBe(404);
      expect(unresolvable.error).toMatch(/no event listing found/);
    }
    expect(seeder.writes).toEqual([]);

    // POSITIVE CONTROL: with a workspace and a resolvable listing the same call succeeds.
    resolveFails = false;
    const ok = await installEventFromCupboard(
      { listingId: 'listing-work-item-lifecycle', workspaceId: 'ws-1' },
      seeder.deps,
    );
    expect(ok.ok).toBe(true);
  });
});

/**
 * D-058 at the INSTALL boundary. The refusal itself lives one level down in `readEventDir`,
 * and this suite deliberately does not re-implement it — what is asserted here is the
 * consequence that matters at this seam: a package carrying a non-distributable field is
 * refused as an INSTALL and seeds NOTHING, so the boundary cannot be crossed by publishing.
 *
 * Both loops iterate the exported constants, so a field added to either list is covered
 * without editing this file.
 */
describe('installEventFromCupboard — D-058 non-distributable fields', () => {
  it('has a positive control: the same package installs once the forbidden field is gone', async () => {
    // CALIBRATION for both loops below. Without it, a fixture broken for any unrelated
    // reason would make every refusal pass while proving nothing about D-058.
    await writePackage();
    const seeder = recordingSeeder();
    const ok = await installEventFromCupboard(
      { listingId: 'listing-work-item-lifecycle', workspaceId: 'ws-1' },
      seeder.deps,
    );
    expect(ok).toMatchObject({ ok: true });
    expect(seeder.writes).toHaveLength(1);
  });

  it('both forbidden-field lists are non-empty — the loops below cannot pass vacuously', () => {
    expect(DERIVED_ONLY_MANIFEST_FIELDS.length).toBeGreaterThan(0);
    expect(INSTALL_SITE_ONLY_MANIFEST_FIELDS.length).toBeGreaterThan(0);
  });

  for (const field of DERIVED_ONLY_MANIFEST_FIELDS) {
    it(`REFUSES a package whose manifest carries the DERIVED field "${field}", seeding nothing`, async () => {
      // The derived half is a measurement of the PUBLISHER's tree. Carrying it across an
      // install would let a publisher assert emit-site facts about the INSTALLING pot —
      // the hand-authored claim the derived-truth ladder forbids. It is written only by
      // `recordEventKeyDerivation`, against this pot's own tree.
      await writePackage({ extra: { [field]: 'published-by-someone-else' } });
      const seeder = recordingSeeder();

      const result = await installEventFromCupboard(
        { listingId: 'listing-work-item-lifecycle', workspaceId: 'ws-1' },
        seeder.deps,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(422);
      expect(seeder.writes).toEqual([]);
    });
  }

  for (const field of INSTALL_SITE_ONLY_MANIFEST_FIELDS) {
    it(`REFUSES a package whose manifest carries the INSTALL-SITE field "${field}", seeding nothing`, async () => {
      // Lifecycle belongs to the install site: a publisher that could ship `status` or
      // `reviewStatus` would be moderating itself, and one that could ship `contributor`
      // would be authoring its own provenance.
      await writePackage({ extra: { [field]: 'self-asserted' } });
      const seeder = recordingSeeder();

      const result = await installEventFromCupboard(
        { listingId: 'listing-work-item-lifecycle', workspaceId: 'ws-1' },
        seeder.deps,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(422);
      expect(seeder.writes).toEqual([]);
    });
  }
});

describe('registryInputFromPackage', () => {
  /** A parsed package, as `readEventDir` would hand one back. */
  function pkg(over: Partial<InstalledEvent> = {}): InstalledEvent {
    return {
      installed: true,
      packageRef: 'github.com/acme/events#work-item-lifecycle',
      listingRef: LISTING_REF,
      installedId: 'installed:abc',
      eventKey: EVENT_KEY,
      title: 'Work-item lifecycle',
      description: 'Keys fired as a work-item moves through its lifecycle.',
      version: '1.0.0',
      keyPattern: 'work-item:*',
      tags: ['lifecycle'],
      source: 'https://github.com/acme/events',
      dir: '/tmp/x',
      ...over,
    };
  }

  it('stamps contributor from what the INSTALL observed, not from the package', () => {
    const input = registryInputFromPackage(pkg(), 'ws-1');

    // The row's provenance is a fact about THIS pot — which listing the key arrived from —
    // never a publisher's assertion about itself. (`readEventDir` already refuses a manifest
    // that carries `contributor`; this is the other half of the same boundary.)
    expect(input.contributor).toBe('cupboard:github.com/acme/events#work-item-lifecycle');

    // POSITIVE CONTROL: the stamp tracks the package it was installed from, so the assertion
    // above cannot pass from a hard-coded constant.
    const other = registryInputFromPackage(pkg({ packageRef: 'github.com/other/pack#v2' }), 'ws-1');
    expect(other.contributor).toBe('cupboard:github.com/other/pack#v2');
  });

  it('is a WHITELIST, not a spread: no derived or install-site field can leak into the write', () => {
    // The projection into `RegisterEventKeyInput` is meant to be total by construction —
    // the type has no field for a derived measurement. This asserts the MAPPER enforces it
    // too, so rewriting it as `{ ...event, workspaceId }` is caught here rather than by the
    // derived-dated CHECK constraint at 3am.
    const contaminated = pkg({
      ...Object.fromEntries(DERIVED_ONLY_MANIFEST_FIELDS.map((f) => [f, 'leaked'])),
      ...Object.fromEntries(INSTALL_SITE_ONLY_MANIFEST_FIELDS.map((f) => [f, 'leaked'])),
    } as Partial<InstalledEvent>);

    // `as unknown as` is required, not stylistic: RegisterEventKeyInput is a closed shape
    // with no index signature, so TS2352 rejects the direct assertion. That refusal is the
    // type system stating the very property under test — the input type has no slot for a
    // derived field — which is why the dynamic probe below has to reach it through unknown.
    const input = registryInputFromPackage(contaminated, 'ws-1') as unknown as Record<string, unknown>;

    for (const field of DERIVED_ONLY_MANIFEST_FIELDS) {
      expect(input[field]).toBeUndefined();
    }
    for (const field of INSTALL_SITE_ONLY_MANIFEST_FIELDS) {
      // `contributor` is the one install-site field the mapper DOES write — but it must be
      // the install's own stamp, never the value that rode in on the package.
      if (field === 'contributor') {
        expect(input.contributor).toBe('cupboard:github.com/acme/events#work-item-lifecycle');
        continue;
      }
      expect(input[field]).toBeUndefined();
    }

    // CALIBRATION: the assertions above all pass for a mapper that returns `{}`, so prove
    // the curated half actually came through on this very same contaminated input.
    expect(input.eventKey).toBe(EVENT_KEY);
    expect(input.title).toBe('Work-item lifecycle');
    expect(input.keyPattern).toBe('work-item:*');
    expect(input.tags).toEqual(['lifecycle']);
  });

  it('omits createdBy when absent rather than writing a null over an existing row', () => {
    const anonymous = registryInputFromPackage(pkg(), 'ws-1');
    expect('createdBy' in anonymous).toBe(false);

    // POSITIVE CONTROL: it IS passed through when supplied, so the assertion above cannot
    // pass merely because the mapper drops the field unconditionally.
    expect(registryInputFromPackage(pkg(), 'ws-1', 'agent-7').createdBy).toBe('agent-7');
  });

  it('carries a null keyPattern through — an event with no pattern is not an event with a missing one', () => {
    expect(registryInputFromPackage(pkg({ keyPattern: null }), 'ws-1').keyPattern).toBeNull();
    // POSITIVE CONTROL: a present pattern still arrives intact.
    expect(registryInputFromPackage(pkg(), 'ws-1').keyPattern).toBe('work-item:*');
  });
});
