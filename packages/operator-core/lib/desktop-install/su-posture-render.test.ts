/**
 * su-posture-render.test.ts — identities-v1-2026-08-30 P-013 / P-020 ACCEPTANCE,
 * measured against the P-018 baseline: the test-only union accounts for every source
 * byte while remaining illegal as a live stack, and the default/member/leader renders
 * are strict subsets with byte deltas reported.
 *
 * The SUBJECT is the PINNED fixture (`__fixtures__/su-render-baseline/`) — the same frozen
 * su.md / Claude overlay / stub project guide the P-018 baseline was recorded from — so the
 * numbers are comparable across the plan's moves. The BASELINE render is that fixture through
 * `renderSuPlaybook` as-is (the pre-seal su.md: both postures inline). Each POSTURE render is
 * the fixture composed under the seal with ONE posture bound (`composeSuStackSource`, the
 * fleet-posture identity resolved through the prompt chain), then spliced by the same
 * `renderSuPlaybook`.
 *
 * STRICT SUBSET is asserted at the LINE level: every non-blank line of a posture render is a
 * line of the baseline render, except the KERNEL's two additions — the seal's precedence
 * statement (P-003) and the kernel base text `agent-base-preamble.md` (D-018 / P-032, rendered
 * on every tier since the seal; the pre-seal fixture never carried it) — AND at least one
 * baseline line is absent (the other posture's craft). Per-`## `-section byte deltas are reported (they move between
 * sections because the seal reorders kernel tiles under the seal — that is the P-003 shape,
 * not a P-020 leak), together with the whole-render byte delta and the bytes of each posture
 * document. Set `SU_RENDER_BASELINE_DUMP=<dir>` to also write the renders + tables there.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SU_PART_DOCUMENTS,
  SU_TILES,
  composeSuStackSource,
  extractSuPart,
  locateSuTiles,
  normalizeStackBinding,
} from '@papercusp/orchestrator/blueprint';
import { renderSuPlaybook } from './papercusp-files';
import { formatScoreTable, measureSuRender, scoreAgainstBaseline } from './su-render-baseline';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, '__fixtures__', 'su-render-baseline');
const INPUTS = {
  base: join(FIXTURE_DIR, 'su.base.md'),
  overlay: join(FIXTURE_DIR, 'papercusp-su.claude.md'),
  projectGuide: join(FIXTURE_DIR, 'project-guide.md'),
} as const;
const DUMP_DIR = process.env.SU_RENDER_BASELINE_DUMP;

/** The repo root (the dir holding libs/papercusp) → the built-in harness the identities live in. */
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
  throw new Error('su-posture-render: repo root (libs/papercusp) not found above ' + HERE);
})();
const harnessDir = join(repoRoot, 'libs/papercusp/packages/harness');

const read = (p: string) => readFileSync(p, 'utf8');
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const lineSet = (text: string) =>
  new Set(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== ''),
  );

async function splice(baseText: string): Promise<string> {
  const out = await renderSuPlaybook({
    agent: 'claude',
    profile: 'engineer',
    baseSource: INPUTS.base,
    baseText,
    overlayDir: FIXTURE_DIR,
    projectGuideSource: INPUTS.projectGuide,
    tier: 'full',
  });
  return out.text;
}

function dump(name: string, text: string): void {
  if (!DUMP_DIR) return;
  mkdirSync(DUMP_DIR, { recursive: true });
  writeFileSync(join(DUMP_DIR, name), text);
}

const POSTURES = ['member', 'leader'] as const;
type Posture = (typeof POSTURES)[number];
const VARIANTS = ['default', ...POSTURES] as const;
type Variant = (typeof VARIANTS)[number];
/** The first line of every tile that belongs to a posture — the craft that must NOT leak. */
const postureAnchors = (p: Posture) =>
  SU_TILES.filter((t) => t.part === 'fleet-posture' && t.posture === p).map((t) => t.anchor);

describe('P-013 / P-020 — identity variants against the P-018 baseline (pinned fixture)', () => {
  const baseText = read(INPUTS.base);
  const preambleText = read(join(harnessDir, 'blueprints/base/prompts/agent-base-preamble.md'));
  const preambleLines = lineSet(preambleText);
  const preambleBytes = bytes(preambleText);

  it('the test-only engineer + collaboration-stance + member + leader union accounts for every source byte, but a live binding rejects its exclusive-slot conflict', () => {
    // D-031 reconciles the original byte-equivalence wording with D-021's intentional
    // seal/order change: this is a COVERAGE/ACCOUNTING fixture, never a legal live stack.
    // Every part is derived from the SAME pinned input — never mix this historical fixture
    // with today's chain-resolved identity files (their live drift has its own golden).
    const located = locateSuTiles(baseText);
    const coverageParts = [
      ...SU_PART_DOCUMENTS.map((doc) => ({ id: doc.id, text: extractSuPart(baseText, doc.id) })),
      {
        id: 'client-seam',
        text: located
          .filter((tile) => tile.part === 'client')
          .map((tile) => tile.text)
          .join(''),
      },
    ];
    expect(() =>
      normalizeStackBinding([
        { slot: 'fleet-posture', id: 'su.fleet-member' },
        { slot: 'fleet-posture', id: 'su.fleet-leader' },
      ]),
    ).toThrow(/exclusive slot "fleet-posture" is bound to two documents/);

    const coveredBytes = coverageParts.reduce((total, part) => total + bytes(part.text), 0);

    expect(coverageParts.map((part) => part.id)).toEqual(
      expect.arrayContaining([
        'client-seam',
        'papercusp-engineer',
        'su-collaborator',
        'su.fleet-member',
        'su.fleet-leader',
        'su.practice',
        'su.instance',
        'su.kernel',
      ]),
    );
    expect(coveredBytes).toBe(bytes(baseText));
    for (const tile of located) {
      expect(
        coverageParts.filter((part) => part.text.includes(tile.text)),
        `source tile must occur in exactly one test-only union part: ${tile.anchor}`,
      ).toHaveLength(1);
    }

    process.stderr.write(
      `[su-posture-render] P-013 test-only union: ${coveredBytes.toLocaleString('en-US')} accounted B = ` +
        `${bytes(baseText).toLocaleString('en-US')} source B; ` +
        `live binding correctly rejects member+leader on exclusive fleet-posture\n`,
    );
  });

  it('default and each single-posture render are STRICT line-subsets of the union baseline (seal lines excepted), carry only their bound posture, and report byte deltas', async () => {
    const baseline = await splice(baseText);
    const baselineLines = lineSet(baseline);
    const baselineMeasure = measureSuRender(baseline, baseText);
    dump('baseline.full.md', baseline);

    const report: string[] = [
      `[su-posture-render] P-020 measurement against the P-018 fixture baseline (tier full, Claude overlay, stub guide)`,
      `baseline (fixture su.md as-is, both postures inline, pre-seal): ${bytes(baseline).toLocaleString('en-US')} B; kernel base text agent-base-preamble.md rendered by the seal: ${preambleBytes.toLocaleString('en-US')} B`,
    ];
    const rendered = {} as Record<Variant, string>;
    for (const variant of VARIANTS) {
      const posture = variant === 'default' ? null : variant;
      const composed = composeSuStackSource({ suText: baseText, harnessDir, posture });
      const text = await splice(composed.text);
      rendered[variant] = text;
      dump(`rendered.${variant}.md`, text);
      const postureDoc = composed.order.find((entry) => entry.slot === 'fleet-posture') ?? null;
      expect(postureDoc?.id ?? null).toBe(
        posture === null ? null : posture === 'member' ? 'su.fleet-member' : 'su.fleet-leader',
      );
      const postureBytes = postureDoc
        ? bytes(read(join(harnessDir, 'blueprints', postureDoc.id, 'prompts', 'fleet-posture.md')))
        : 0;

      // (1) STRICT SUBSET at the line level — the only admitted additions are the KERNEL's: the
      // seal statement (P-003) and the kernel base text `agent-base-preamble.md` (D-018 / P-032:
      // rendered on every tier since the seal; the pre-seal fixture never carried it). Neither is
      // posture text, and both are identical across the two posture renders.
      const kernelAdditions = new Set([...lineSet(composed.seal), ...preambleLines]);
      const extra = [...lineSet(text)].filter((l) => !baselineLines.has(l) && !kernelAdditions.has(l));
      expect(
        extra.slice(0, 12),
        `${variant}: ${extra.length} line(s) in the variant render that the baseline never had (first 12 shown)`,
      ).toEqual([]);
      const missing = [...baselineLines].filter((l) => !lineSet(text).has(l));
      expect(missing.length, `${variant}: a STRICT subset drops at least one posture's lines`).toBeGreaterThan(0);

      // (2) Only the bound posture renders; the interactive default carries neither.
      for (const candidate of POSTURES) {
        for (const anchor of postureAnchors(candidate)) {
          expect(
            text.includes(anchor),
            `${variant} render has wrong ${candidate} posture state: ${anchor.slice(0, 60)}`,
          ).toBe(posture === candidate);
        }
      }

      // (3) Bytes: net of the two kernel additions the render is strictly SMALLER than the
      // baseline (the other posture's document is gone), and the delta is reported per section.
      const score = scoreAgainstBaseline(measureSuRender(text, baseText), baselineMeasure);
      const kernelAdditionBytes = bytes(composed.seal) + preambleBytes;
      expect(
        score.currentBytes - kernelAdditionBytes,
        `${variant}: fewer bytes than the baseline once the seal + preamble are netted out`,
      ).toBeLessThan(score.baselineBytes);
      report.push(
        `${variant}: ${score.currentBytes.toLocaleString('en-US')} B (Δ ${score.totalDelta >= 0 ? '+' : ''}${score.totalDelta.toLocaleString('en-US')} B vs baseline, of which +${kernelAdditionBytes.toLocaleString('en-US')} B is the kernel seal + preamble ⇒ identity-variant Δ ${(score.totalDelta - kernelAdditionBytes).toLocaleString('en-US')} B; posture document ${postureBytes.toLocaleString('en-US')} B; ${missing.length} baseline lines absent, ${extra.length} non-kernel lines added)`,
      );
      dump(`score.${variant}.md`, formatScoreTable(score));
    }
    expect(new Set(Object.values(rendered))).toHaveLength(VARIANTS.length);
    // Not console.* — vitest-fail-on-console turns that into a failure; the measurement is
    // the deliverable, so it goes to stderr where the run log keeps it.
    process.stderr.write(`${report.join('\n')}\n`);
  });

  it('renders every variant deterministically (two composes + splices are byte-identical)', async () => {
    for (const variant of VARIANTS) {
      const posture = variant === 'default' ? null : variant;
      const a = await splice(composeSuStackSource({ suText: baseText, harnessDir, posture }).text);
      const b = await splice(composeSuStackSource({ suText: baseText, harnessDir, posture }).text);
      expect(a).toBe(b);
    }
  });
});
