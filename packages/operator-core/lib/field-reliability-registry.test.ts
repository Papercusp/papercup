/**
 * field-reliability-registry.test.ts — the coverage test that turns the registry into a guard.
 *
 * A registry nothing checks is a second place to be wrong. These are the assertions that make an
 * entry a FACT about the code rather than a claim about it (plan `silent-wrong-answers-2026-08-01`,
 * D-104), and they close the loop in both directions:
 *
 *   registry → code   every registered site really attaches its caveat, verified by reading the
 *                     file the entry names. Enforced here.
 *   code → registry   a site cannot attach a caveat the registry has never heard of, because
 *                     `caveatForSite` throws on an unregistered pair. Enforced at the call site,
 *                     asserted here.
 *
 * ## Falsifiability
 *
 * A guard that has never failed is a guard nobody has tested. Both checkers below are pure
 * functions exercised against BOTH a deliberately-wrong control (which must be caught) and the real
 * registry (which must pass) — the calibration case, without which a checker that always reports
 * "violation" would look just as green. The controls live here permanently rather than being
 * produced by mutating production code: this tree is swept into commits every few minutes, so a
 * probe that edits a real file can be committed mid-probe even when nothing goes wrong.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIELD_RELIABILITY_SITES,
  UNMIGRATED_CAVEAT_SPELLINGS,
  UNMIGRATED_CAVEAT_HIGH_WATERMARK,
  caveatForSite,
  lookupSite,
  siteKey,
  type EpistemicSite,
  type UnmigratedCaveatSpelling,
} from './field-reliability-registry';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does `site.emittedIn` really contain the `caveatForSite(surface, field)` call?
 *
 * Matches the (surface, field) pair as SOURCE LITERALS, which is what makes this a fact about the
 * emitting site rather than a name-pattern guess about it — the distinction D-104 turns on.
 */
function attachmentFailure(site: Pick<EpistemicSite, 'surface' | 'field' | 'emittedIn'>): string | null {
  const abs = resolve(REPO_ROOT, site.emittedIn);
  if (!existsSync(abs)) return `emittedIn does not exist: ${site.emittedIn}`;
  const quote = "['\"`]";
  const call = new RegExp(
    `caveatForSite\\(\\s*${quote}${escapeForRegExp(site.surface)}${quote}\\s*,\\s*${quote}${escapeForRegExp(site.field)}${quote}\\s*\\)`,
  );
  if (!call.test(readFileSync(abs, 'utf8'))) {
    return `${site.emittedIn} does not call caveatForSite('${site.surface}', '${site.field}')`;
  }
  return null;
}

/** Is the allowlisted ad-hoc spelling still really emitted by the file it names? */
function spellingFailure(entry: Pick<UnmigratedCaveatSpelling, 'field' | 'emittedIn'>): string | null {
  const abs = resolve(REPO_ROOT, entry.emittedIn);
  if (!existsSync(abs)) return `emittedIn does not exist: ${entry.emittedIn}`;
  if (!readFileSync(abs, 'utf8').includes(entry.field)) {
    return `${entry.emittedIn} no longer mentions \`${entry.field}\` — the entry is stale; DELETE it (this list may only shrink)`;
  }
  return null;
}

describe('field-reliability registry — every registered site attaches its caveat', () => {
  it('is non-empty (a registry with no sites guards nothing)', () => {
    expect(FIELD_RELIABILITY_SITES.length).toBeGreaterThan(0);
  });

  it('COVERAGE: every registered (surface, field) really calls caveatForSite in the file it names', () => {
    const failures = FIELD_RELIABILITY_SITES.map(attachmentFailure).filter((f): f is string => f !== null);
    expect(
      failures,
      `Registered sites that do not attach their caveat:\n  • ${failures.join('\n  • ')}\n` +
        `Either wire the site up, or remove its entry — a registered site that does not attach is ` +
        `exactly the silence this registry exists to make impossible.`,
    ).toEqual([]);
  });

  it('CONTROL: the coverage checker CATCHES a site that does not attach (and passes the real ones)', () => {
    // Deliberately wrong on purpose, kept permanently: this file is a real file that certainly does
    // not contain the call, so a checker that always reported "fine" would fail here.
    expect(
      attachmentFailure({
        surface: 'never:emitted',
        field: 'ghostField',
        emittedIn: 'packages/operator-core/lib/field-reliability.ts',
      }),
    ).toMatch(/does not call caveatForSite/);
    // A path that does not exist is caught as a distinct failure, not silently passed.
    expect(
      attachmentFailure({ surface: 'a', field: 'b', emittedIn: 'packages/operator-core/lib/no-such-file.ts' }),
    ).toMatch(/does not exist/);
    // CALIBRATION: the real subject must pass the same checker, or the two controls above prove
    // nothing but that the checker can say "no".
    expect(FIELD_RELIABILITY_SITES.map(attachmentFailure).filter(Boolean)).toEqual([]);
  });

  it('has no duplicate (surface, field) keys', () => {
    const keys = FIELD_RELIABILITY_SITES.map((s) => siteKey(s.surface, s.field));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keys on the PAIR — the same field name on two surfaces cannot collide', () => {
    // The reason D-104 rejected a field-keyed registry: `endedAt` names an unreliable sweeper write
    // on one surface and a real observation on another, so a field-keyed key would carry the wrong
    // cannotAnswer to one of them.
    expect(siteKey('adv:sessions', 'endedAt')).not.toBe(siteKey('capability:bash', 'endedAt'));
  });

  it('every entry carries a non-empty cannotAnswer and insteadRead', () => {
    for (const site of FIELD_RELIABILITY_SITES) {
      // insteadRead is required by field-reliability.ts by design: a caveat with no alternative
      // relocates the reader's confusion instead of resolving it.
      expect(site.cannotAnswer.trim().length, `${site.surface}.${site.field} cannotAnswer`).toBeGreaterThan(0);
      expect(site.insteadRead.trim().length, `${site.surface}.${site.field} insteadRead`).toBeGreaterThan(0);
    }
  });
});

describe('field-reliability registry — caveatForSite closes the code → registry direction', () => {
  it('builds the registered caveat for EVERY registered pair, round-tripping every field', () => {
    // Asserts the whole entry, not a sample: the registry is now the single source of a caveat's
    // text, so a field silently dropped in transit would put different words in front of the reader
    // than the registry (and the review of it) says are there.
    for (const site of FIELD_RELIABILITY_SITES) {
      const built = caveatForSite(site.surface, site.field);
      expect(built.field).toBe(site.field);
      expect(built.reliability).toBe(site.reliability);
      expect(built.cannotAnswer).toBe(site.cannotAnswer);
      expect(built.insteadRead).toBe(site.insteadRead);
      expect(built.because).toBe(site.because);
    }
  });

  it('omits `because` entirely when the entry has none (rather than emitting undefined)', () => {
    // Mirrors caveat()'s conditional spread in field-reliability.ts. An explicit `because:
    // undefined` key renders as a present-but-empty provenance, which reads as "no evidence was
    // found" rather than "none was claimed" — a small instance of this plan's own bug.
    const [first] = FIELD_RELIABILITY_SITES;
    expect(first).toBeDefined();
    // Registered entries currently all carry `because`; assert the invariant through the shared
    // builder so it holds for the first entry added without one.
    for (const site of FIELD_RELIABILITY_SITES) {
      const built = caveatForSite(site.surface, site.field);
      expect(Object.hasOwn(built, 'because')).toBe(site.because !== undefined);
    }
  });

  it('THROWS on an unregistered pair rather than inventing a caveat', () => {
    // The whole point: a seventh ad-hoc spelling cannot be introduced through this function.
    expect(() => caveatForSite('never:registered', 'someNewWarning')).toThrow(/no registered site/);
  });

  it('THROWS when only one half of the pair matches a registered site', () => {
    const site = FIELD_RELIABILITY_SITES[0]!;
    expect(() => caveatForSite(site.surface, 'someOtherField')).toThrow(/no registered site/);
    expect(() => caveatForSite('some:other-surface', site.field)).toThrow(/no registered site/);
  });

  it('lookupSite returns null (not a fabricated site) for an unregistered pair', () => {
    // Returning null here is safe precisely because caveatForSite refuses to coerce it into a
    // caveat — the same "fail loud, never plausible" rule field-reliability.ts states.
    expect(lookupSite('never:registered', 'someNewWarning')).toBeNull();
  });
});

describe('field-reliability registry — the un-migrated allowlist is SHRINK-ONLY', () => {
  it('every allowlisted ad-hoc spelling is still really emitted where it says', () => {
    const failures = UNMIGRATED_CAVEAT_SPELLINGS.map(spellingFailure).filter((f): f is string => f !== null);
    expect(
      failures,
      `Stale allowlist entries:\n  • ${failures.join('\n  • ')}`,
    ).toEqual([]);
  });

  it('CONTROL: the allowlist checker CATCHES a stale entry (and passes the real ones)', () => {
    expect(
      spellingFailure({
        field: 'thisFieldNameIsNotEmittedAnywhereInThatFile',
        emittedIn: 'packages/operator-core/lib/field-reliability-registry.ts',
      }),
    ).toMatch(/no longer mentions/);
    // CALIBRATION — the real allowlist must pass the same checker.
    expect(UNMIGRATED_CAVEAT_SPELLINGS.map(spellingFailure).filter(Boolean)).toEqual([]);
  });

  it('does not exceed the high watermark', () => {
    const count = UNMIGRATED_CAVEAT_SPELLINGS.length;
    expect(
      count <= UNMIGRATED_CAVEAT_HIGH_WATERMARK,
      `The un-migrated ad-hoc caveat list GREW to ${count} (watermark ${UNMIGRATED_CAVEAT_HIGH_WATERMARK}). ` +
        `Do NOT append a seventh spelling: use the shared vocabulary in field-reliability.ts and register ` +
        `the site in FIELD_RELIABILITY_SITES, or migrate an existing entry to make room. Raising ` +
        `UNMIGRATED_CAVEAT_HIGH_WATERMARK re-opens the exact drift this guard exists to close.`,
    ).toBe(true);
  });

  it('the watermark tracks the list rather than banking headroom', () => {
    // Shrink-only means the ceiling comes DOWN with each migration. Leaving headroom behind would
    // silently re-authorise the next ad-hoc spelling — the KNOWN_DARK_FLAGS parking-lot failure.
    expect(UNMIGRATED_CAVEAT_HIGH_WATERMARK).toBe(UNMIGRATED_CAVEAT_SPELLINGS.length);
  });

  it('has no duplicate (surface, field) entries', () => {
    const keys = UNMIGRATED_CAVEAT_SPELLINGS.map((s) => siteKey(s.surface, s.field));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a site is either MIGRATED or ALLOWLISTED, never both', () => {
    const migrated = new Set(FIELD_RELIABILITY_SITES.map((s) => siteKey(s.surface, s.field)));
    const both = UNMIGRATED_CAVEAT_SPELLINGS.filter((s) => migrated.has(siteKey(s.surface, s.field)));
    expect(
      both.map((s) => `${s.surface}.${s.field}`),
      'These sites are registered as migrated AND still allowlisted as un-migrated — delete the allowlist row.',
    ).toEqual([]);
  });

  it('every allowlist entry states WHY it has not migrated', () => {
    for (const entry of UNMIGRATED_CAVEAT_SPELLINGS) {
      expect(entry.why.trim().length, `${entry.surface}.${entry.field} why`).toBeGreaterThan(0);
    }
  });

  it('records that the six ad-hoc NAMES are more than six SITES', () => {
    // The concrete argument for keying on the pair: `zeroHitCaveat` and `priorWorkWarning` each
    // render on two surfaces answering two different questions, so a name-keyed registry could not
    // have carried the right cannotAnswer for either.
    const names = new Set(UNMIGRATED_CAVEAT_SPELLINGS.map((s) => s.field));
    expect(UNMIGRATED_CAVEAT_SPELLINGS.length).toBeGreaterThan(names.size);
  });
});
