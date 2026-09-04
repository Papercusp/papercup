/**
 * su-render-baseline.test.ts — the DETERMINISTIC su render baseline
 * (identities-v1-2026-08-30 P-018; scored by R12, byte-equivalence target of R17).
 *
 * Renders the PINNED fixture inputs under `__fixtures__/su-render-baseline/` (a frozen copy
 * of the blueprint base `su.md`, the Claude client overlay, a stub project guide) through the
 * live `renderSuPlaybook` for both persona tiers and asserts the per-`## `-section byte +
 * hash table matches `baseline.json`. The live base is NEVER the subject here — it moves
 * with every persona edit; the fixture is what makes the numbers comparable across the
 * plan's Part B moves.
 *
 * A red here means the RENDERER or a GENERATED section (wire schemas, coord legend, modes
 * policy, result door, shared-base notes) changed. That is exactly what the baseline exists
 * to make visible. Read the printed delta table; if the change is intended, re-pin with
 *
 *     BASELINE_UPDATE=1 npm run test:file -- packages/operator-core/lib/desktop-install/su-render-baseline.test.ts
 *
 * and commit the regenerated `baseline.json` WITH the change that moved it.
 *
 * Set `SU_RENDER_BASELINE_DUMP=<dir>` to also write the rendered texts + the live-base score
 * table there (never into the tree — a rendered persona in the repo is a grep trap).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderSuPlaybook } from './papercusp-files';
import {
  REQUIRED_SPLICE_MARKERS_BY_ARTIFACT,
  SPLICE_MARKERS,
  SU_PLAYBOOK_MARKER_IDS,
} from './splice-tooling-overlay';
import {
  formatScoreTable,
  measureSuRender,
  scoreAgainstBaseline,
  sha256,
  type SuRenderBaseline,
  type SuRenderMeasurement,
} from './su-render-baseline';
import { checkSuSpliceMarkers } from '../../../../scripts/check-su-splice-markers';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, '__fixtures__', 'su-render-baseline');
const BASELINE_PATH = join(FIXTURE_DIR, 'baseline.json');
const INPUTS = {
  base: join(FIXTURE_DIR, 'su.base.md'),
  overlay: join(FIXTURE_DIR, 'papercusp-su.claude.md'),
  projectGuide: join(FIXTURE_DIR, 'project-guide.md'),
} as const;
/** Every splice target `renderSuPlaybook` knows. A marker the base lacks is a generated
 *  section that silently does not render (`spliceGeneratedSection` drops on a missing
 *  marker) — recorded in the baseline so P-024's presence assertion has a reference. */
const KNOWN_MARKERS: Record<string, string> = Object.fromEntries(
  SU_PLAYBOOK_MARKER_IDS.map((id) => [id.slice('PAPERCUSP-SU:'.length), SPLICE_MARKERS[id]]),
);
const TIERS = ['full', 'fleet'] as const;
const UPDATE = process.env.BASELINE_UPDATE === '1';
const DUMP_DIR = process.env.SU_RENDER_BASELINE_DUMP;

const read = (p: string) => readFileSync(p, 'utf8');
const inputRecord = (p: string) => {
  const text = read(p);
  return { path: p.slice(FIXTURE_DIR.length + 1), bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text) };
};

async function renderPinned(tier: (typeof TIERS)[number]): Promise<string> {
  const out = await renderSuPlaybook({
    agent: 'claude',
    profile: 'engineer',
    baseSource: INPUTS.base,
    overlayDir: FIXTURE_DIR,
    projectGuideSource: INPUTS.projectGuide,
    tier,
  });
  return out.text;
}

function dump(name: string, text: string): void {
  if (!DUMP_DIR) return;
  mkdirSync(DUMP_DIR, { recursive: true });
  writeFileSync(join(DUMP_DIR, name), text);
}

function loadBaseline(): SuRenderBaseline | null {
  try {
    return JSON.parse(read(BASELINE_PATH)) as SuRenderBaseline;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

describe('su render baseline — pinned fixture inputs (P-018)', () => {
  const baseText = read(INPUTS.base);

  it('every required source/projection carries each declared splice marker exactly once (P-024)', () => {
    const repoRoot = resolve(HERE, '../../../..');
    for (const artifact of REQUIRED_SPLICE_MARKERS_BY_ARTIFACT) {
      let text: string;
      try {
        text = read(join(repoRoot, artifact.path));
      } catch (error) {
        if (!artifact.required && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const id of artifact.markerIds) {
        const marker = SPLICE_MARKERS[id];
        expect(text.split(marker).length - 1, `${artifact.path} :: ${id}`).toBe(1);
      }
    }
  });

  it('the P-024 guard is falsifiable for both a missing and a duplicated marker', () => {
    const markerId = SU_PLAYBOOK_MARKER_IDS[0];
    const marker = SPLICE_MARKERS[markerId];
    const artifact = [{ path: 'synthetic.md', markerIds: [markerId], required: true }] as const;
    const read = ((path: string) => {
      if (path.endsWith('missing/synthetic.md')) return '# no seam\n';
      return `${marker}\n${marker}\n`;
    }) as typeof readFileSync;
    expect(checkSuSpliceMarkers({ root: '/missing', artifacts: artifact, read }).problems).toEqual([
      { path: 'synthetic.md', markerId, count: 0, reason: 'wrong-count' },
    ]);
    expect(checkSuSpliceMarkers({ root: '/duplicate', artifacts: artifact, read }).problems).toEqual([
      { path: 'synthetic.md', markerId, count: 2, reason: 'wrong-count' },
    ]);
  });

  it('renders each tier deterministically (two renders are byte-identical)', async () => {
    for (const tier of TIERS) {
      const a = await renderPinned(tier);
      const b = await renderPinned(tier);
      expect(a, `tier ${tier}`).toBe(b);
      expect(a.length).toBeGreaterThan(10_000);
      dump(`rendered.${tier}.md`, a);
    }
  });

  it('leaks no internal PAPERCUSP-SU marker into either tier (psu-prompt-isolation)', async () => {
    for (const tier of TIERS) {
      const text = await renderPinned(tier);
      // The base's own prose legitimately mentions the marker FAMILY (`<!-- PAPERCUSP-SU:* -->`)
      // when it teaches the edit path; a real marker is a concrete, consumed splice target.
      for (const [name, marker] of Object.entries(KNOWN_MARKERS)) {
        expect(text.includes(marker), `tier ${tier} still carries ${name}`).toBe(false);
      }
      expect(text).not.toContain('PAPERCUSP-SU:FULL-ONLY');
    }
  });

  it('fleet tier never renders MORE bytes than full (FULL-ONLY sections stripped, wire legend filtered)', async () => {
    // identities-v1 P-021 retired the fleet tier's compact AUTO clause — both tiers splice the
    // same kernel modes stub, and a member's AUTO definition binds by registry state, not by
    // tier — so the remaining fleet trims (FULL-ONLY sections, the wire-legend filter) are the
    // only difference, and neither fires on this pinned fixture: equal is the honest reading.
    const full = measureSuRender(await renderPinned('full'), baseText);
    const fleet = measureSuRender(await renderPinned('fleet'), baseText);
    expect(fleet.totalBytes).toBeLessThanOrEqual(full.totalBytes);
  });

  it('per-section bytes + hashes match baseline.json (BASELINE_UPDATE=1 re-pins)', async () => {
    const tiers = {} as Record<(typeof TIERS)[number], SuRenderMeasurement>;
    for (const tier of TIERS) tiers[tier] = measureSuRender(await renderPinned(tier), baseText);
    const present = Object.entries(KNOWN_MARKERS)
      .filter(([, m]) => baseText.includes(m))
      .map(([n]) => n);
    const absent = Object.keys(KNOWN_MARKERS).filter((n) => !present.includes(n));
    const current: SuRenderBaseline = {
      schemaVersion: 1,
      plan: 'identities-v1-2026-08-30',
      item: 'P-018',
      generatedAt: new Date().toISOString(),
      inputs: {
        base: inputRecord(INPUTS.base),
        overlay: inputRecord(INPUTS.overlay),
        projectGuide: inputRecord(INPUTS.projectGuide),
      },
      markers: { present, absent },
      tiers,
    };
    const recorded = loadBaseline();
    if (UPDATE || !recorded) {
      writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
      // Not console.* — vitest-fail-on-console turns that into a failure; a re-pin is a
      // deliberate, visible act, so the notice goes to stderr directly.
      process.stderr.write(`[su-render-baseline] ${recorded ? 're-pinned' : 'created'} ${BASELINE_PATH}\n`);
      return;
    }
    // A fixture edit without a re-pin is the silent way to make the numbers incomparable.
    for (const k of ['base', 'overlay', 'projectGuide'] as const) {
      expect(current.inputs[k].sha256, `fixture input ${k} changed — re-pin with BASELINE_UPDATE=1`).toBe(
        recorded.inputs[k].sha256,
      );
    }
    expect(current.markers).toEqual(recorded.markers);
    const problems: string[] = [];
    for (const tier of TIERS) {
      const score = scoreAgainstBaseline(tiers[tier], recorded.tiers[tier]);
      if (!score.byteEquivalent) {
        problems.push(`tier ${tier}: render differs from baseline (Δ ${score.totalDelta} B)\n${formatScoreTable(score, { onlyChanged: true })}`);
      }
    }
    expect(
      problems,
      `${problems.join('\n\n')}\n\nIf this change is intended, re-pin: BASELINE_UPDATE=1 npm run test:file -- ${import.meta.url.replace(/^file:\/\//, '')}`,
    ).toEqual([]);
  });
});

describe('su render baseline — live blueprint base (informational score)', () => {
  // Walk up to the repo root (the dir that holds libs/papercusp) so the test does not depend
  // on the cwd vitest was started from.
  const repoRoot = (() => {
    let d = HERE;
    for (let i = 0; i < 8; i++) {
      try {
        readFileSync(join(d, 'libs', 'papercusp', 'package.json'));
        return d;
      } catch {
        d = resolve(d, '..');
      }
    }
    return null;
  })();
  const liveBase = repoRoot && join(repoRoot, 'libs/papercusp/packages/harness/blueprints/base/prompts/su.md');
  const liveOverlayDir = repoRoot && join(repoRoot, 'apps/operator/prompts');
  const available = (() => {
    if (!liveBase || !liveOverlayDir) return false;
    try {
      readFileSync(liveBase);
      readFileSync(join(liveOverlayDir, 'papercusp-su.claude.md'));
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!available)('renders deterministically and scores against the pinned baseline', async () => {
    const render = () =>
      renderSuPlaybook({
        agent: 'claude',
        profile: 'engineer',
        baseSource: liveBase!,
        overlayDir: liveOverlayDir!,
        projectGuideSource: INPUTS.projectGuide,
        tier: 'full',
      }).then((r) => r.text);
    const a = await render();
    expect(a).toBe(await render());
    const recorded = loadBaseline();
    if (!recorded) return;
    const score = scoreAgainstBaseline(measureSuRender(a, read(liveBase!)), recorded.tiers.full);
    // Informational: the live base is EXPECTED to drift from the pin as the plan's Part B
    // moves land; the table is the score, not a verdict.
    dump('live-vs-baseline.full.md', formatScoreTable(score));
    expect(score.sections.length).toBeGreaterThan(0);
  });
});
