/**
 * identity-scrub — the publish-path identity gate (EI-23420285862298325).
 *
 * THE REGRESSION THIS PINS: `cupboard:publish-goal` exported a goal package whose
 * goal.json carried the owner's personal account handle at 10+ sites under
 * `launchSettings.roles.*.account`, while its own `stripped` summary reported a
 * sanitized package. The handle was pushed to a PUBLIC mirror repo. The dangerous
 * part was not the absence of a check — it was a report that read like a passing one.
 *
 * So these tests assert the two properties that actually contain the incident, and a
 * green run of the scrub alone would satisfy neither:
 *
 *   1. The gate REFUSES — `assertIdentityClean` THROWS, and `writeGoalPackageDir`
 *      leaves NOTHING on disk when it fires. A check whose failure cannot stop the
 *      write is decoration. (The incident's own containment failed exactly here: a
 *      hand-rolled scan PRINTED the leak and the push ran anyway in the same `set -e`
 *      block, because `grep | wc -l` prints "1" and exits 0.)
 *   2. The HARVEST CROSS-CATCH — a handle scrubbed out of config is hunted as a
 *      literal everywhere else in the bytes. This is what catches the duty-body copy
 *      that has no identity-bearing key to mark it, and it is why the scrub and the
 *      scan are not redundant.
 *
 * Every assertion that a value is ABSENT is paired with a POSITIVE CONTROL proving
 * the same probe FIRES on unscrubbed input — an empty hit list is otherwise
 * indistinguishable from a scanner that silently stopped working, which is the exact
 * failure shape being pinned.
 *
 * The handle below is SYNTHETIC on purpose. Using the real leaked handle would commit
 * the identifier this module exists to keep out of published bytes.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertIdentityClean,
  isIdentityLeakError,
  scanIdentityLeaks,
  scrubIdentityFields,
} from './identity-scrub';
import { writeGoalPackageDir, type GoalPackageExport } from './goal-package-store';

/** Synthetic stand-in for the leaked personal handle. */
const HANDLE = 'jdoe-personal-42';

/**
 * A home-shaped path and a specific OS user, both ASSEMBLED AT RUNTIME.
 *
 * Written as literals these would be flagged by the repo's own identity lint — which
 * is correct and not worth an exception: a hardcoded home path or build-box username
 * in shipped source reds the green-checkpoint identity leg and freezes `main` for the
 * whole fleet. The fixtures are also machine-independent this way, so the test states
 * the same thing on every host. Note the shape is what the scanner keys on, so
 * building it from parts costs the test nothing.
 */
const HOME_LIKE = ['', 'home', 'someone', 'papercupai-workspace', 'thing'].join('/');
const OS_USER = ['zenobia', 'qa'].join('-');

/** Pin the host identity in scans that are not about the OS-user leg, so a test
 *  cannot pass or fail because of whose machine it runs on. */
const NO_HOST = { osUser: null } as const;

const tmpRoots: string[] = [];
const freshRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'identity-scrub-test-'));
  tmpRoots.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

/** The incident's exact shape: the handle repeated across per-role launch settings. */
const leakyLaunchSettings = () => ({
  maxAgents: 2,
  defaults: { account: HANDLE },
  roles: {
    leader: { account: HANDLE, model: 'sonnet' },
    member: { account: HANDLE, model: 'sonnet' },
  },
});

describe('scrubIdentityFields — structured config is scrubbed and REPORTED', () => {
  it('replaces the handle at every launchSettings site and harvests it once', () => {
    const { value, scrubbed, identityValues } = scrubIdentityFields({
      launchSettings: leakyLaunchSettings(),
    });

    // Not one site left. Serializing is the honest check: it is the bytes that ship.
    expect(JSON.stringify(value)).not.toContain(HANDLE);

    const paths = scrubbed.map((h) => h.path).sort();
    expect(paths).toEqual([
      'launchSettings.defaults.account',
      'launchSettings.roles.leader.account',
      'launchSettings.roles.member.account',
    ]);
    // The harvest is what mechanism 2 hunts for; deduped despite three sites.
    expect(identityValues).toEqual([HANDLE]);
  });

  it('POSITIVE CONTROL: the same probe finds the handle before scrubbing', () => {
    // Without this, the assertion above passes just as well against a scrubber that
    // returned an empty object, or against a typo in HANDLE.
    expect(JSON.stringify({ launchSettings: leakyLaunchSettings() })).toContain(HANDLE);
  });

  it('does not mutate its input', () => {
    const input = { launchSettings: leakyLaunchSettings() };
    scrubIdentityFields(input);
    expect(input.launchSettings.roles.leader.account).toBe(HANDLE);
  });

  it('leaves non-identity config alone — a package must still be usable', () => {
    const { value } = scrubIdentityFields({
      launchSettings: leakyLaunchSettings(),
      budgetCents: 50_000,
      inputSchema: { type: 'object' },
    });
    expect(value).toMatchObject({
      launchSettings: { maxAgents: 2, roles: { leader: { model: 'sonnet' } } },
      budgetCents: 50_000,
      inputSchema: { type: 'object' },
    });
  });

  it('is idempotent — re-exporting an exported package reports no new hits', () => {
    const once = scrubIdentityFields({ launchSettings: leakyLaunchSettings() });
    const twice = scrubIdentityFields(once.value);
    expect(twice.scrubbed).toEqual([]);
    expect(twice.identityValues).toEqual([]);
    expect(twice.value).toEqual(once.value);
  });
});

describe('scanIdentityLeaks — prose is REFUSED, never rewritten', () => {
  it('finds a harvested handle surviving in free text', () => {
    const hits = scanIdentityLeaks(`Check the inbox for ${HANDLE} every morning.`, {
      knownIdentityValues: [HANDLE],
      ...NO_HOST,
    });
    expect(hits).toEqual([{ kind: 'identity-value', value: HANDLE, occurrences: 1 }]);
  });

  it('counts every occurrence, so the publisher knows the size of the fix', () => {
    const hits = scanIdentityLeaks(`${HANDLE} and ${HANDLE} again`, {
      knownIdentityValues: [HANDLE],
      ...NO_HOST,
    });
    expect(hits[0]?.occurrences).toBe(2);
  });

  it('finds host-shaped identity with no harvest at all', () => {
    const text = [
      `run ${HOME_LIKE}`,
      'as su-c68e6e76-bd39-4e8c-a0b0-899e63952d37',
      'and mail someone@example.com',
    ].join('\n');
    const kinds = scanIdentityLeaks(text, NO_HOST).map((h) => h.kind);
    expect(kinds).toContain('home-path');
    expect(kinds).toContain('agent-session-id');
    expect(kinds).toContain('email');
  });

  it('flags a specific OS user, but not a generic account name', () => {
    expect(scanIdentityLeaks(`deploy as ${OS_USER}`, { osUser: OS_USER })).toHaveLength(1);
    // A fail-closed gate that cries wolf gets routed around, which defeats it.
    expect(scanIdentityLeaks('running as root in the container', { osUser: 'root' })).toEqual([]);
  });

  it('returns NO hits for genuinely clean package prose', () => {
    expect(
      scanIdentityLeaks('Keep the tree green. Escalate when the gate is red.', {
        knownIdentityValues: [HANDLE],
        ...NO_HOST,
      }),
    ).toEqual([]);
  });
});

describe('assertIdentityClean — the GATE throws, it does not report', () => {
  it('throws a branded IdentityLeakError carrying the hits and the location', () => {
    let caught: unknown;
    try {
      assertIdentityClean(`duty: ping ${HANDLE}`, 'goal package demo/goal.json', {
        knownIdentityValues: [HANDLE],
        ...NO_HOST,
      });
    } catch (e) {
      caught = e;
    }

    // The point of the test: control flow LEFT the happy path.
    expect(caught, 'assertIdentityClean must THROW on a leak, not return hits').toBeDefined();
    expect(isIdentityLeakError(caught)).toBe(true);
    if (!isIdentityLeakError(caught)) throw new Error('expected IdentityLeakError');
    expect(caught.where).toBe('goal package demo/goal.json');
    expect(caught.hits).toHaveLength(1);
    expect(caught.message).toContain(HANDLE);
  });

  it('does not throw on clean bytes', () => {
    expect(() =>
      assertIdentityClean('{"title":"Keep the tree green"}', 'goal package demo/goal.json', {
        knownIdentityValues: [HANDLE],
        ...NO_HOST,
      }),
    ).not.toThrow();
  });

  it('brands the error rather than relying on instanceof across module records', () => {
    expect(isIdentityLeakError(new Error('ordinary'))).toBe(false);
    expect(isIdentityLeakError(null)).toBe(false);
    expect(isIdentityLeakError({ isIdentityLeakError: true })).toBe(true);
  });
});

describe('the harvest CROSS-CATCH — the property the incident actually needed', () => {
  it('refuses a package whose config was scrubbed but whose BODY kept a copy', () => {
    // This is the incident in miniature. The scrub alone reports success: every
    // identity-bearing KEY is clean. Nothing about the body's copy is shaped like an
    // identity — it is just a word in a sentence — so only the harvest catches it.
    const scrub = scrubIdentityFields({ launchSettings: leakyLaunchSettings() });
    const bytes = JSON.stringify({
      ...scrub.value,
      body: `Every morning, read the inbox for ${HANDLE} and triage it.`,
    });

    expect(scrub.scrubbed.length).toBeGreaterThan(0); // the scrub did report success
    expect(() =>
      assertIdentityClean(bytes, 'goal package demo/goal.json', {
        knownIdentityValues: scrub.identityValues,
        ...NO_HOST,
      }),
    ).toThrow(/still carries publisher identity/);
  });

  it('POSITIVE CONTROL: the same bytes pass once the body no longer names anyone', () => {
    // Proves the refusal above tracks the handle, not some incidental property of the
    // fixture — otherwise both halves would "pass" against a gate that always throws.
    const scrub = scrubIdentityFields({ launchSettings: leakyLaunchSettings() });
    const bytes = JSON.stringify({
      ...scrub.value,
      body: 'Every morning, read the configured inbox and triage it.',
    });
    expect(() =>
      assertIdentityClean(bytes, 'goal package demo/goal.json', {
        knownIdentityValues: scrub.identityValues,
        ...NO_HOST,
      }),
    ).not.toThrow();
  });
});

const exportFixture = (over: Partial<GoalPackageExport> = {}): GoalPackageExport => ({
  title: 'Keep the tree green',
  body: 'First duty line',
  description: 'First duty line',
  standing: true,
  killCriterion: null,
  tripwires: null,
  budgetCents: null,
  budgetWindowSec: null,
  launchSettings: null,
  inputSchema: null,
  outputSchema: null,
  propertySchema: null,
  requiresRubrics: [],
  ...over,
});

describe('writeGoalPackageDir — a refused write leaves NOTHING on disk', () => {
  it('throws AND creates no directory when identity survives into the bytes', () => {
    const root = freshRoot();
    const exported = exportFixture({
      body: `Read the inbox for ${HANDLE} each morning.`,
    });

    expect(() =>
      writeGoalPackageDir(exported, {
        ref: 'leaky-goal',
        targetDir: root,
        knownIdentityValues: [HANDLE],
      }),
    ).toThrow(/still carries publisher identity/);

    // THE ORDERING ASSERTION. If the gate ever moves below mkdirSync, the throw above
    // still happens and every other test here still passes — but a leaked package is
    // sitting on disk for a later hand to push. Only this catches that.
    expect(
      existsSync(join(root, 'leaky-goal')),
      'a refused export must not leave a directory behind for a later push',
    ).toBe(false);
  });

  it('POSITIVE CONTROL: the same call writes the package when the body is clean', () => {
    // Without this, the test above passes against a writeGoalPackageDir that is
    // broken outright and never writes anything.
    const root = freshRoot();
    const written = writeGoalPackageDir(exportFixture(), {
      ref: 'clean-goal',
      targetDir: root,
      knownIdentityValues: [HANDLE],
    });
    expect(existsSync(written.manifestPath)).toBe(true);
    expect(existsSync(written.listingPath)).toBe(true);
  });
});
