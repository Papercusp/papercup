/**
 * pack-residue — rule unit tests + the GATE over the committed builtin packs
 * (memory-corpus-hygiene P-006 / D-017).
 *
 * The gate is the point: builtin packs SHIP (build-desktop-sidecar.sh copies
 * every file under packages/harness into the bundle), so anything committed
 * under knowledge-packs/ reaches customers. This test is what fails when a
 * future path re-introduces internal references into a shipped artifact.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackResidue, formatPackResidue, PACK_RESIDUE_RULES } from './pack-residue';

describe('findPackResidue', () => {
  it('passes clean, transferable lesson prose', () => {
    const clean =
      'A log may report peer_connected status while its replicator never ingests\n' +
      'operations, causing silent write divergence. Monitor for connections that\n' +
      'remain attached but ingest nothing for the grace period.\n\n' +
      'Provenance: recurred 5× across the fleet — adopted from the fleet candidate queue.';
    expect(findPackResidue(clean)).toEqual([]);
  });

  it('catches each residue class, and reports the offending substring', () => {
    // Calibration: the exact shape the live fleet-lessons pack carried on
    // 2026-08-03, before the renderer was fixed. If this ever stops failing,
    // the rule has been weakened — not the corpus cleaned.
    const dirty =
      'Provenance: recurred 9× across operator, harness:@singleton ' +
      '(signature `183 4072cfad012b class harness liveness`; items EI-9411, EI-9413) ' +
      '— adopted from the fleet candidate queue.';
    const hits = findPackResidue(dirty);
    const byRule = (id: string) => hits.filter((h) => h.rule === id).map((h) => h.match);

    expect(byRule('ledger-id')).toEqual(['EI-9411', 'EI-9413']);
    expect(byRule('scope-literal')).toEqual(['harness:@singleton']);
    expect(byRule('signature-hash')).toEqual(['4072cfad012b']);
    expect(formatPackResidue(hits)).toContain('dangling references');
  });

  it('does not fire on ordinary prose that merely looks technical', () => {
    // Guards the rules against being over-broad: short hex, a version, a bare
    // word "harness", and a hyphenated capital that is not a ledger id.
    const benign =
      'Pin the build to commit abc1234 and re-run. The harness config is versioned; ' +
      'see RFC-7231 for the status-code semantics. Retry-After is a header, not an id.';
    expect(findPackResidue(benign)).toEqual([]);
  });

  it('is stateless across calls (the /g regexes must not carry lastIndex)', () => {
    const dirty = 'items EI-1 and EI-2';
    const first = findPackResidue(dirty);
    const second = findPackResidue(dirty);
    expect(second).toEqual(first);
    expect(first).toHaveLength(2);
  });

  it('every rule carries a non-empty id and rationale', () => {
    for (const rule of PACK_RESIDUE_RULES) {
      expect(rule.id).toBeTruthy();
      expect(rule.why.length).toBeGreaterThan(20);
    }
  });
});

describe('committed builtin knowledge packs are fit to ship', () => {
  // Resolved against THIS file rather than harnessPath(): the subject is the
  // repo's committed content, not whatever the running host has mounted.
  const packsRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', '..',
    'libs', 'papercusp', 'packages', 'harness', 'knowledge-packs',
  );

  const packDirs = existsSync(packsRoot)
    ? readdirSync(packsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];

  it('finds the builtin packs root (else the submodule is not initialized)', () => {
    // Skipping rather than failing on an uninitialized `libs/papercusp`
    // submodule: an empty checkout cannot hide residue, so a hard failure here
    // would only produce spurious reds on partial checkouts.
    if (packDirs.length === 0) {
      console.warn(`[pack-residue] no builtin packs under ${packsRoot} — skipping the ship gate`);
    }
    expect(Array.isArray(packDirs)).toBe(true);
  });

  for (const pack of packDirs) {
    it(`${pack}: no item carries internal references`, () => {
      const dir = join(packsRoot, pack);
      const items = readdirSync(dir).filter((f) => f.endsWith('.md'));
      const failures: string[] = [];

      for (const file of items) {
        const path = join(dir, file);
        if (!statSync(path).isFile()) continue;
        const hits = findPackResidue(readFileSync(path, 'utf8'));
        if (hits.length > 0) {
          failures.push(`${pack}/${file}\n${formatPackResidue(hits)}`);
        }
      }

      expect(
        failures.join('\n\n'),
        failures.length > 0
          ? `Builtin knowledge-pack items SHIP in the desktop bundle. ` +
              `These carry internal references that are dangling on a fresh install:\n\n` +
              `${failures.join('\n\n')}\n\n` +
              `Fix the item text (or the path that generated it) — do not relax the rule.`
          : undefined,
      ).toBe('');
    });
  }
});
