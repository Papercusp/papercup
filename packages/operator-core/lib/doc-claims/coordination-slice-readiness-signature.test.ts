/**
 * Doc claim: the COORDINATION slice of shared-pot-release-testing/RELEASE-READINESS.md
 * keeps the two properties its acceptance BARs grade (plan
 * p2p-coordination-public-release-2026-08-26, rubric
 * p2p-coordination-public-release-acceptance-2026-09-03):
 *
 *  - R-5 / AUTO-BAR-R-5-P-009 — §2.1 row 3 is EVIDENCE RE-BASED: it keeps the prior
 *    transport-level basis as retained history, names the P-008 two-machine witness as
 *    its current basis, and is never quotable without the coordination-slice signature,
 *    which disclaims the document's headline verdict. (D-031 itself lives in the plan
 *    store, not this file; this test pins only the document half of R-5.)
 *  - R-6 / AUTO-BAR-R-6-P-005 (rubric rev 8) — the silent-federation DETECTOR residual is
 *    not absorbed. EITHER branch passes: (b) OPEN — the signature signs GO with ONE named
 *    open residual and a NET amber, records WI-2141796 as open on the detector with the
 *    discriminator WI-2142252; or (a) CLOSED — a green re-signature cites a verified
 *    detector fix. Both branches keep both instances of the pattern: WI-2141796 (the 8h
 *    outage) and the 48h precedent EI-20579195481991931. The work-item half of branch (a)
 *    (WI-2141796 terminal with a landed detector + recurrence guard) lives in the
 *    work-item store, not this file; this test pins only the document half.
 *
 * The subject path is overridable (COORD_READINESS_DOC) so a copy-out mutation probe can
 * point the real assertions at a mutated COPY without dirtying the shared tree.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DOC_PATH =
  process.env.COORD_READINESS_DOC ?? resolve(REPO_ROOT, 'shared-pot-release-testing/RELEASE-READINESS.md');

/** §2.1 row 3: the markdown table row `| 3 | Coord control-plane federation ... |`. */
function row3Of(doc: string): string | null {
  const line = doc.split('\n').find((l) => /^\|\s*3\s*\|\s*Coord control-plane federation/i.test(l));
  return line ?? null;
}

/** The blockquoted coordination-slice signature, from its heading to the end of the quote. */
function signatureOf(doc: string): string | null {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => /^>\s*\*\*Coordination-slice signature/i.test(l));
  if (start < 0) return null;
  const block: string[] = [];
  for (let i = start; i < lines.length && lines[i].startsWith('>'); i++) block.push(lines[i].replace(/^>\s?/, ''));
  return block.join('\n');
}

export function judgeR5(doc: string): string[] {
  const problems: string[] = [];
  const row = row3Of(doc);
  if (!row) return ['§2.1 row 3 (Coord control-plane federation) is missing'];
  if (!/EVIDENCE RE-BASED/.test(row)) problems.push('row 3 lacks the EVIDENCE RE-BASED annotation (silent evidence swap)');
  if (!/prior basis/i.test(row) || !/scn\.coord_bidir/.test(row))
    problems.push('row 3 does not retain its prior basis (scn.coord_bidir) as history');
  if (!/transport-level/i.test(row)) problems.push('row 3 does not record that the prior basis was transport-level / insufficient');
  if (!/current basis/i.test(row) || !/P-008/.test(row) || !/WI-42225/.test(row))
    problems.push('row 3 does not name the P-008 two-machine witness (WI-42225) as its current basis');
  const sig = signatureOf(doc);
  if (!sig) problems.push('row 3 is quotable without a coordination-slice signature block');
  else {
    if (!/§2\.1 row 3/.test(sig)) problems.push('the coordination-slice signature does not scope §2.1 row 3');
    if (!/does NOT touch, soften, or contribute to the document's headline\s+verdict/i.test(sig))
      problems.push('the coordination-slice signature does not disclaim the headline verdict');
  }
  return problems;
}

export function judgeR6(doc: string): string[] {
  const problems: string[] = [];
  const sig = signatureOf(doc);
  if (!sig) return ['coordination-slice signature block is missing'];
  if (!/WI-2141796/.test(sig)) problems.push('the 8h silent-outage instance (WI-2141796) was dropped');
  if (!/EI-20579195481991931/.test(sig) || !/48h/.test(sig))
    problems.push('the 48h precedent (EI-20579195481991931) was dropped, reducing the pattern to one incident');
  const netGreen = /Net for the slice:\s*🟢/.test(sig);
  if (netGreen) {
    // Branch (a): the residual is closed — only on a verified, landed detector.
    if (!/verified detector fix/i.test(sig))
      problems.push('the slice is signed NET green while the detector gap is open (no verified detector fix cited)');
  } else {
    // Branch (b): the residual is open — disclosed at NET amber, tracked with its discriminator.
    if (!/Net for the slice:\s*🟡/.test(sig)) problems.push('the signature records no NET amber for the slice');
    if (!/contributes GO/.test(sig)) problems.push('the signature does not record the slice GO on functional correctness');
    if (!/ONE named OPEN\s+observability residual/i.test(sig))
      problems.push('the signature does not carry exactly one named open residual');
    if (!/remains correctly OPEN on the detector/i.test(sig))
      problems.push('WI-2141796 is not recorded as open on the detector');
    if (!/WI-2142252/.test(sig)) problems.push('the open residual is not tracked with its discriminator (WI-2142252)');
  }
  return problems;
}

const CONFORMING = [
  '| 3 | Coord control-plane federation + trust boundary | 🟢 | ⚠ **EVIDENCE RE-BASED 2026-09-02.** ⟨prior basis, retained as history⟩ `scn.coord_bidir-220032.log` — TRANSPORT-LEVEL. ⟨current basis⟩ P-008 witness, `WI-42225`. |',
  '',
  '> **Coordination-slice signature — 2026-09-02: the coordination slice contributes GO on functional correctness, carrying',
  '> ONE named OPEN observability residual. Net for the slice: 🟡, not 🟢.**',
  '> **SCOPE.** §2.1 row 3. **It does NOT touch, soften, or contribute to the document\'s headline',
  '> verdict**.',
  '> `WI-2141796` therefore remains correctly OPEN on the detector, with the discriminator tracked as `WI-2142252`.',
  '> Peer B federated nothing for 48h (`EI-20579195481991931`).',
].join('\n');

describe('coordination-slice readiness signature (fixture controls — the judges must be able to FAIL)', () => {
  it('accepts a conforming fixture', () => {
    expect(judgeR5(CONFORMING)).toEqual([]);
    expect(judgeR6(CONFORMING)).toEqual([]);
  });

  it('R-5 catches a silent evidence swap (no EVIDENCE RE-BASED, prior basis dropped)', () => {
    const swapped = CONFORMING.replace('EVIDENCE RE-BASED 2026-09-02.', '').replace(/⟨prior basis[^⟩]*⟩ `scn\.coord_bidir-220032\.log` — TRANSPORT-LEVEL\./, '');
    expect(judgeR5(swapped).join(' ')).toMatch(/EVIDENCE RE-BASED/);
    expect(judgeR5(swapped).join(' ')).toMatch(/prior basis/);
  });

  it('R-5 catches row 3 left quotable without its signature block', () => {
    expect(judgeR5(CONFORMING.split('\n')[0]).join(' ')).toMatch(/without a coordination-slice signature/);
  });

  it('R-6 catches a NET-green signature with the detector gap still open', () => {
    const green = CONFORMING.replace('Net for the slice: 🟡, not 🟢.', 'Net for the slice: 🟢.');
    expect(judgeR6(green).join(' ')).toMatch(/NET green while the detector gap is open/);
  });

  it('R-6 accepts a later green re-signature only when it cites a verified detector fix', () => {
    const regreen = CONFORMING.replace('Net for the slice: 🟡, not 🟢.', 'Net for the slice: 🟢 (verified detector fix WI-2142252).');
    expect(judgeR6(regreen)).toEqual([]);
  });

  it('R-6 catches the 48h precedent being dropped', () => {
    const dropped = CONFORMING.replace('> Peer B federated nothing for 48h (`EI-20579195481991931`).', '>');
    expect(judgeR6(dropped).join(' ')).toMatch(/48h precedent/);
  });

  it('R-6 catches an open residual left untracked by its discriminator (WI-2142252)', () => {
    const untracked = CONFORMING.replace(', with the discriminator tracked as `WI-2142252`', '');
    expect(judgeR6(untracked).join(' ')).toMatch(/discriminator \(WI-2142252\)/);
  });

  it('R-6 does not reward leaving the residual open: a closed residual with a verified detector fix passes without the discriminator', () => {
    const closed = CONFORMING.replace('Net for the slice: 🟡, not 🟢.', 'Net for the slice: 🟢 (verified detector fix landed).').replace(
      ', with the discriminator tracked as `WI-2142252`',
      '',
    );
    expect(judgeR6(closed)).toEqual([]);
  });
});

describe('coordination-slice readiness signature (the real RELEASE-READINESS.md)', () => {
  const doc = readFileSync(DOC_PATH, 'utf8');

  it('AUTO-BAR-R-5-P-009: row 3 is evidence re-based and bound to a headline-disclaiming signature', () => {
    expect(judgeR5(doc)).toEqual([]);
  });

  it('AUTO-BAR-R-6-P-005: the detector residual is not absorbed (open at NET amber with its discriminator, or closed on a verified detector fix) and both instances are cited', () => {
    expect(judgeR6(doc)).toEqual([]);
  });
});
