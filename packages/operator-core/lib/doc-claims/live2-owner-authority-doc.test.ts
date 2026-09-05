import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// lib/doc-claims -> lib -> operator-core -> packages -> repository root
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CHECKLIST = join(ROOT, 'docs/plans/LIVE-2-shared-fleet-drill-checklist-2026-07-10.md');

const RETRACTED_BLANKET_SIGNOFF = /2026-07-10 blanket unblock[\s\S]{0,120}\bIS the owner sign-off\b/i;

describe('LIVE-2 owner-authority documentation', () => {
  it('detects the stale blanket-signoff claim this guard exists to prevent', () => {
    const stale = "The owner's 2026-07-10 blanket unblock above IS the owner sign-off the NO-GO section asks for.";
    expect(stale).toMatch(RETRACTED_BLANKET_SIGNOFF);
  });

  it('keeps the live checklist on the verified, narrow 2026-06-29 authority', () => {
    const source = readFileSync(CHECKLIST, 'utf8');

    expect(source).toMatch(/PROVENANCE CORRECTED 2026-08-01/);
    expect(source).toMatch(/The \*\*real\*\* owner turn is[\s\S]*2026-06-29/);
    expect(source).toMatch(/does \*\*not\*\* carry any blanket gate approval/);
    expect(source).toMatch(/does \*\*not\*\* authorize a broader[\s\S]*capability envelope/);
    expect(source).toMatch(/any wider envelope stays NO-GO/);
    expect(source).not.toMatch(RETRACTED_BLANKET_SIGNOFF);
  });
});
