/**
 * done-without-test-collect.integration.test.ts — RETIREMENT GUARD.
 *
 * This file used to exercise `collectDoneWithoutTestSignals`, the PG collector that
 * read the inline-VAL assertion store to flag done-without-test work-items
 * (enforce-system-on-generic-work P-009). verification-system-improvements-2026-10-10
 * P-003 (SPEC-P-003-VAL-READERS) retires inline VAL-* assertions, so the collector and
 * its watchdog registration are gone; the successor signal is the P-002
 * `verification.health` cell. These cases fail if either comes back. The file is
 * pending owner deletion with the rest of the VAL-* residue.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripCommentsOnly } from '../../../../../scripts/lib/strip-comments-and-strings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('done-without-test collector stays retired (P-003)', () => {
  it('the detector module no longer exports a PG collector', async () => {
    const mod: Record<string, unknown> = await import('./done-without-test-detect');
    expect(Object.keys(mod)).not.toContain('collectDoneWithoutTestSignals');
  });

  it('the watchdog no longer registers the papercusp-done-without-test collector', () => {
    const file = resolve(HERE, 'watchdog.ts');
    const live = stripCommentsOnly(readFileSync(file, 'utf8'), file);
    // Control: the collector list still exists, so an empty read cannot pass vacuously.
    expect(live).toContain("name: 'papercusp-zero-promotion'");
    expect(live).not.toContain("'papercusp-done-without-test'");
    expect(live).not.toContain('collectDoneWithoutTestSignals');
  });
});
