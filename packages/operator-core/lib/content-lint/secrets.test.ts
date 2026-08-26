/**
 * Tests for the COMMIT-TIME secrets detector (EI-21230011589307899).
 *
 * ⚠ EVERY CREDENTIAL-SHAPED FIXTURE IN THIS FILE IS ASSEMBLED AT RUNTIME, and
 * that is load-bearing, not fussiness. A literal credential shape in this file's
 * TEXT would be caught by the very scanner under test the moment git-sync swept
 * the tree — freezing the pot's p2p egress at this blob, which no later edit can
 * undo. Writing a detector's test suite is the single most likely way to arm the
 * trap the detector exists to prevent (it is why four unrelated files already sit
 * in secrets-guard.ts's static FIXTURE_FILES set).
 *
 * The split-literal technique below keeps this file scannable-clean while still
 * exercising real matches, so it needs no exemption entry at all. Prefer it over
 * adding another exemption — an exemption is a permanent security waiver, and
 * this is a formatting choice.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  findCommitBlockingSecrets,
  describeCommitBlockingSecrets,
  cachedExemptionLoader,
  EXEMPTION_CACHE_TTL_MS,
} from './secrets';

/** An AWS-access-key-shaped value, assembled so this file's own text never
 *  carries the contiguous shape. Deliberately NOT suffixed `EXAMPLE`: the
 *  scanner treats AWS's reserved docs suffix as a documented example and skips
 *  it, which would make this fixture silently non-matching. */
const awsShape = (): string => 'AK' + 'IA' + 'QRSTUVWXYZ234567';

/** A PEM private-key HEADER, assembled the same way. No key body — the rule
 *  matches the header alone, which is exactly how a NEGATIVE test fixture in an
 *  unrelated package froze egress on 2026-08-26. */
const pemHeader = (): string => ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');

const NO_EXEMPTIONS: ReadonlySet<string> = new Set();

describe('findCommitBlockingSecrets', () => {
  it('flags a credential shape in ordinary source', () => {
    const findings = findCommitBlockingSecrets('apps/operator/lib/thing.ts', `const id = '${awsShape()}';\n`, NO_EXEMPTIONS);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('aws-access-key-id');
    expect(findings[0].line).toBe(1);
  });

  it('flags a bare PEM header with no key body — the shape that froze egress', () => {
    const findings = findCommitBlockingSecrets('libs/x/harness.test.ts', `\n\nexpect(scan('${pemHeader()}')).toThrow();\n`, NO_EXEMPTIONS);
    expect(findings.map((f) => f.rule)).toContain('private-key-pem');
    expect(findings[0].line).toBe(3);
  });

  it('reports clean text as clean', () => {
    expect(findCommitBlockingSecrets('a/b.ts', "const NEVER_EMIT_MARKER = 'never-emit-me';\n", NO_EXEMPTIONS)).toEqual([]);
  });

  it('skips a STATIC fixture file (isFixtureFile) so the scanner cannot wedge its own suite', () => {
    const path = 'packages/operator-core/lib/sync/pot-git/secrets-guard.test.ts';
    expect(findCommitBlockingSecrets(path, `const v = '${awsShape()}';\n`, NO_EXEMPTIONS)).toEqual([]);
  });

  it('skips a RUNTIME-exempt exact path', () => {
    // Not optional: a path exempted to unfreeze PUBLISH would otherwise be
    // quarantined from COMMIT forever, trading one deadlock for another.
    const path = 'libs/generic/deployment-driver/src/workspace-host-test-harness.test.ts';
    expect(findCommitBlockingSecrets(path, `const v = '${awsShape()}';\n`, new Set([path]))).toEqual([]);
  });

  it('honours the directory-PREFIX exemption form', () => {
    const exemptions = new Set(['libs/generic/fixtures/']);
    expect(findCommitBlockingSecrets('libs/generic/fixtures/creds.ts', `const v = '${awsShape()}';\n`, exemptions)).toEqual([]);
  });

  it('does NOT let a directory-prefix exemption leak to a sibling path', () => {
    const exemptions = new Set(['libs/generic/fixtures/']);
    const findings = findCommitBlockingSecrets('libs/generic/fixtures-other.ts', `const v = '${awsShape()}';\n`, exemptions);
    expect(findings).toHaveLength(1);
  });
});

describe('describeCommitBlockingSecrets', () => {
  const message = (): string =>
    describeCommitBlockingSecrets('a/b.test.ts', findCommitBlockingSecrets('a/b.test.ts', `const v = '${awsShape()}';\n`, NO_EXEMPTIONS));

  it('says the file was excluded and left on disk, not that the commit failed', () => {
    // The D-001 contract the whole design rests on: quarantine the FILE, never
    // stall the tree's commit. An agent reading "commit failed" would retry.
    expect(message()).toMatch(/EXCLUDED from the commit and left on disk/);
    expect(message()).toMatch(/do not retry the write/i);
  });

  it('names the low-entropy-marker remedy BEFORE the exemption path', () => {
    // THE ordering assertion. Its predecessor (the publish-time refusal) named
    // only the exemption path — the heavier, riskier remedy — and that is how the
    // exemption surface grew. A credential stand-in in a test is a naming choice.
    const m = message();
    const markerAt = m.indexOf('NEVER_EMIT_MARKER');
    const exemptionAt = m.indexOf('secrets_exemptions');
    expect(markerAt).toBeGreaterThan(-1);
    expect(exemptionAt).toBeGreaterThan(-1);
    expect(markerAt).toBeLessThan(exemptionAt);
  });

  it('embeds the offending path in a ready-to-run exemption command', () => {
    expect(message()).toContain("path:'a/b.test.ts'");
  });

  it('does not echo the matched secret in the clear', () => {
    expect(message()).not.toContain(awsShape());
  });
});

describe('cachedExemptionLoader', () => {
  it('reads once across a burst of per-file scans within the TTL', async () => {
    const load = vi.fn(async (): Promise<ReadonlySet<string>> => new Set(['a/']));
    let now = 1_000;
    const cached = cachedExemptionLoader(load, () => now);
    await cached();
    now += EXEMPTION_CACHE_TTL_MS - 1;
    await cached();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('re-reads once the TTL has elapsed', async () => {
    const load = vi.fn(async (): Promise<ReadonlySet<string>> => new Set());
    let now = 1_000;
    const cached = cachedExemptionLoader(load, () => now);
    await cached();
    now += EXEMPTION_CACHE_TTL_MS + 1;
    await cached();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent callers onto a single read', async () => {
    const load = vi.fn(async (): Promise<ReadonlySet<string>> => new Set());
    const cached = cachedExemptionLoader(load, () => 1_000);
    await Promise.all([cached(), cached(), cached()]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('yields an EMPTY set instead of THROWING when the exemption read fails', async () => {
    // The failure-direction test, and the reason it is not a style choice: the
    // content guard FAILS OPEN — a detector that throws is skipped and the file
    // commits. For every other detector that is right (a miss costs a broken
    // build). Here a miss costs a permanent egress freeze that no edit can undo,
    // so a load failure must degrade to "scan everything" rather than escape as
    // an exception into the guard's fail-open path.
    const cached = cachedExemptionLoader(async () => {
      throw new Error('db down');
    });
    await expect(cached()).resolves.toEqual(new Set());
  });

  it('recovers on the next call after a failed read', async () => {
    let fail = true;
    const load = vi.fn(async (): Promise<ReadonlySet<string>> => {
      if (fail) throw new Error('db down');
      return new Set(['x/']);
    });
    let now = 1_000;
    const cached = cachedExemptionLoader(load, () => now);
    expect(await cached()).toEqual(new Set());
    fail = false;
    // A failed read caches nothing, so the very next call retries — it must not
    // be pinned to the empty set for a whole TTL.
    expect(await cached()).toEqual(new Set(['x/']));
  });
});
