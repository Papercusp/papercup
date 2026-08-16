/**
 * candidates unit tests — the pure/fs halves of the fleet→pack staging area
 * (self-improvement-consume-edges-2026-06-12 P-032, brief B-11; auto-adopt
 * reversal WI-5414): id/version helpers, the rendered learning file
 * ROUND-TRIPPING through the real pack-format parser, materializeCandidateIntoPack
 * against a temp root, the automated review (fs + injected judge — no PG), and
 * the autoAdoptPendingCandidates sweep against injected deps (no PG — the PG
 * half of stage/decide pins in candidates.integration.test.ts).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTO_ADOPT_REVIEWER,
  FLEET_LESSONS_PACK_ID,
  autoAdoptPendingCandidates,
  bumpPatchVersion,
  candidateItemId,
  truncateCandidateTitle,
  materializeCandidateIntoPack,
  renderCandidateLearningFile,
  reviewCandidateForAutoAdopt,
  type KnowledgePackCandidate,
} from './candidates';
import {
  OKF_MANIFEST_KEY,
  OKF_VERSION,
  parseLearningFile,
  parseManifest,
  type LearningKind,
} from './pack-format';
import { loadKnowledgePack } from './load-packs';
// P-006: the LINT'S oracle, so the write paths and the corpus lint can never
// disagree about what conformant means (plan D-003).
import { findOkfDocViolations, findOkfManifestViolations, formatOkfViolations } from '@papercusp/docs-engine';

describe('bumpPatchVersion', () => {
  it('bumps the patch component; degrades garbage to 0.0.1', () => {
    expect(bumpPatchVersion('0.0.0')).toBe('0.0.1');
    expect(bumpPatchVersion('1.2.9')).toBe('1.2.10');
    expect(bumpPatchVersion('not-semver')).toBe('0.0.1');
  });
});

describe('candidateItemId', () => {
  it('kebab-cases the title and dedupes with numeric suffixes', () => {
    expect(candidateItemId('Memory search keeps timing out!', new Set())).toBe(
      'memory-search-keeps-timing-out',
    );
    expect(candidateItemId('Memory search keeps timing out!', new Set(['memory-search-keeps-timing-out']))).toBe(
      'memory-search-keeps-timing-out-2',
    );
    expect(candidateItemId('???', new Set())).toBe('fleet-lesson');
    expect(candidateItemId(`${'very-'.repeat(30)}long`, new Set()).length).toBeLessThanOrEqual(60);
  });

  it('cuts a long multi-word title at a dash (word) boundary, never mid-word (EI-18121665970916886)', () => {
    // A realistic long title made of real words joined by kebab-casing — the
    // historical bug (.slice(0, 60)) produced ids ending mid-word, e.g.
    // "...-work-items-prob" (chopping "problem"/"problematic" in half).
    const title =
      'The hive re-mounts a full escalation cascade work items problematic for downstream consumers';
    const id = candidateItemId(title, new Set());
    expect(id.length).toBeLessThanOrEqual(60);
    // the id must be a PREFIX of the full kebab-cased title up to a dash —
    // i.e. every char before the cut point matches, and the cut lands exactly
    // on a dash boundary (no trailing partial word).
    const fullKebab = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    expect(fullKebab.startsWith(id)).toBe(true);
    expect(fullKebab.length).toBeGreaterThan(id.length); // it really was cut
    // the char immediately after the cut in the full string is a dash (word
    // boundary), i.e. we did not stop mid-word
    expect(fullKebab[id.length]).toBe('-');
  });

  it('falls back to a hard cut only when there is no dash to cut on within budget', () => {
    const id = candidateItemId(`${'x'.repeat(100)}`, new Set());
    expect(id.length).toBeLessThanOrEqual(60);
    expect(id).toBe('x'.repeat(60));
  });
});

describe('renderCandidateLearningFile', () => {
  it('round-trips through the real pack-format parser, provenance included', () => {
    // P-006 / D-017: the footer keeps the recurrence COUNT (the evidential
    // weight a stranger can use) and drops every internal reference — ledger
    // ids, `harness:<slug>` scope literals and the signature hash are dangling
    // on a fresh install. Traceability lives in knowledge_pack_candidates
    // (pack_item_id -> source_item_ids/signature/scopes), not in the artifact.
    const raw = renderCandidateLearningFile({
      itemId: 'lock-before-edit',
      title: 'Always check locks: the "hook" serializes edits',
      text: 'Find how this project serializes concurrent edits before writing.',
      kind: 'feedback',
      appliesTo: ['any'],
      signature: 'lock|edit|serialize',
      scopes: ['operator', 'harness:sheets'],
      recurrenceCount: 4,
      sourceItemIds: ['EI-1', 'EI-2'],
    });
    const { item, error } = parseLearningFile(raw, 'fallback');
    expect(error).toBeUndefined();
    expect(item).toMatchObject({
      id: 'lock-before-edit',
      // fmValue: newlines collapsed, double quotes become single
      title: `Always check locks: the 'hook' serializes edits`,
      kind: 'feedback',
      appliesTo: ['any'],
    });
    expect(item!.text).toContain('Find how this project serializes concurrent edits');
    expect(item!.text).toContain('recurred 4× across the fleet');
  });

  it('renders NO internal ledger ids, scope literals or signature into the shipped artifact', () => {
    const raw = renderCandidateLearningFile({
      itemId: 'lock-before-edit',
      title: 'Always check locks',
      text: 'Find how this project serializes concurrent edits before writing.',
      kind: 'feedback',
      appliesTo: ['any'],
      signature: '183 5741efa1c7dd class connected harness hive',
      scopes: ['operator', 'harness:sheets'],
      recurrenceCount: 4,
      sourceItemIds: ['EI-1', 'EI-8288', 'WI-42'],
    });
    // The three residue classes, asserted individually so a failure names which
    // one regressed rather than just "the footer changed".
    expect(raw).not.toMatch(/\b(?:EI|WI)-\d+/); // dangling ledger ids
    expect(raw).not.toContain('harness:sheets'); // box/scope identity
    expect(raw).not.toContain('5741efa1c7dd'); // recurrence signature hash
    expect(raw).not.toContain('signature');
  });

  // okf-frontmatter-adoption-2026-08-08 P-004. The backfill put `type` on all 70
  // pack docs; THIS is the only code path that mints new ones, so without it the
  // corpus walks back below 100% one adoption at a time — a regression a test of
  // the backfill alone could never catch.
  it('emits OKF `type` as a verbatim copy of `kind`, ADDITIVELY (P-004)', () => {
    const render = (kind: LearningKind) =>
      renderCandidateLearningFile({
        itemId: 'lock-before-edit',
        title: 'Always check locks',
        text: 'Find how this project serializes concurrent edits before writing.',
        kind,
        appliesTo: ['any'],
        signature: 'lock|edit',
        scopes: ['operator'],
        recurrenceCount: 4,
        sourceItemIds: ['EI-1'],
      });

    expect(render('feedback')).toContain('\ntype: feedback\n');
    // A COPY, not a constant: a kind other than today's uniform 'feedback' must
    // carry through, or the field silently mislabels the first pack doc that
    // uses one.
    expect(render('reference')).toContain('\ntype: reference\n');
    // Additive — `kind` is load-bearing (the loader maps it onto the seeded
    // memory row's kind) and must survive alongside.
    expect(render('reference')).toContain('\nkind: reference\n');
    expect(parseLearningFile(render('reference'), 'fallback').item?.kind).toBe('reference');
  });
});

describe('materializeCandidateIntoPack', () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'fleet-lessons-test-'));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const lesson = (title: string) => ({
    title,
    text: 'Discover how this project coordinates shared-tree edits before changing files.',
    kind: 'feedback' as const,
    appliesTo: ['any' as const],
    signature: 'shared|tree|coord',
    scopes: ['operator', 'harness:papercup'],
    recurrenceCount: 3,
    sourceItemIds: ['EI-9'],
  });

  it('first adoption creates the pack (v0.0.1); the next bumps the version and dedupes ids', async () => {
    const first = await materializeCandidateIntoPack(lesson('Coordinate shared-tree edits'), { packsRoot: root });
    expect(first).toEqual({
      packId: FLEET_LESSONS_PACK_ID,
      packItemId: 'coordinate-shared-tree-edits',
      packVersion: '0.0.1',
    });

    const second = await materializeCandidateIntoPack(lesson('Coordinate shared-tree edits'), { packsRoot: root });
    expect(second.packItemId).toBe('coordinate-shared-tree-edits-2');
    expect(second.packVersion).toBe('0.0.2');

    // The written pack is fully loadable through the normal resolution path —
    // which is what lets the EXISTING install/upgrade conflict review carry it.
    const loaded = await loadKnowledgePack(FLEET_LESSONS_PACK_ID, {
      roots: [{ dir: root, source: 'installed' }],
    });
    expect(loaded).not.toBeNull();
    expect(loaded!.warnings).toEqual([]);
    expect(loaded!.pack.manifest.version).toBe('0.0.2');
    expect(loaded!.pack.items.map((i) => i.id).sort()).toEqual([
      'coordinate-shared-tree-edits',
      'coordinate-shared-tree-edits-2',
    ]);
  });

  // okf-frontmatter-adoption-2026-08-08 P-004. renderManifest REWRITES
  // manifest.yaml wholesale on every adoption, so a manifest field it does not
  // emit is ERASED on the next write rather than merely ignored. This is the
  // write-side half of the okf_version thread (parseManifest's read side is
  // pinned in pack-format.test.ts).
  describe('okf_version survives the manifest rewrite (P-004)', () => {
    it('stamps the current OKF version on a manifest that predates the field', async () => {
      const dir = join(root, FLEET_LESSONS_PACK_ID);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        join(dir, 'manifest.yaml'),
        ['id: fleet-lessons', 'title: Fleet lessons', 'description: Pre-OKF.', 'version: 0.0.4', ''].join('\n'),
        'utf8',
      );

      await materializeCandidateIntoPack(lesson('Stamp an un-stamped manifest'), { packsRoot: root });

      const raw = await fs.readFile(join(dir, 'manifest.yaml'), 'utf8');
      expect(raw).toContain(`${OKF_MANIFEST_KEY}:`);
      const { manifest, error } = parseManifest(raw);
      expect(error).toBeUndefined();
      expect(manifest?.okfVersion).toBe(OKF_VERSION);
      // …without disturbing the fields the rewrite already owned.
      expect(manifest?.version).toBe('0.0.5');
    });

    it('preserves an EXISTING declared version rather than overwriting it', async () => {
      const dir = join(root, FLEET_LESSONS_PACK_ID);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        join(dir, 'manifest.yaml'),
        ['id: fleet-lessons', 'title: Fleet lessons', 'description: Newer spec.', 'version: 0.0.4', 'okf_version: "9.9"', ''].join('\n'),
        'utf8',
      );

      await materializeCandidateIntoPack(lesson('Keep a declared okf version'), { packsRoot: root });

      const { manifest } = parseManifest(await fs.readFile(join(dir, 'manifest.yaml'), 'utf8'));
      expect(manifest?.okfVersion).toBe('9.9');
    });
  });

  /**
   * okf-frontmatter-adoption-2026-08-08 P-006, per plan D-003.
   *
   * P-006 adds `lint:okf-conformance`, which walks the pack corpus ON DISK. That
   * lint alone is not enough for a corpus written by CODE: it measures the tree
   * AFTER the writers have already walked it back, so a regression here shows up
   * as a red lint on files nobody edited, at whatever later hour the next
   * adoption happens to run.
   *
   * These tests close that gap by pointing the LINT'S OWN ORACLE at what the
   * write paths MINT — not at hand-written field assertions. The tests above
   * assert specific fields (`type: <kind>`, `okf_version:`); these assert
   * CONFORMANCE, so if a rule is added, tightened, or corrected in
   * `okf-conformance.ts`, the minting paths are judged by the new rule
   * immediately rather than continuing to satisfy an assertion that has quietly
   * stopped meaning what the lint means.
   */
  describe('minted output satisfies the lint\'s own conformance oracle (P-006 / D-003)', () => {
    it('the learning file renderCandidateLearningFile MINTS is conformant', async () => {
      const { packItemId } = await materializeCandidateIntoPack(lesson('Mint a conformant learning file'), {
        packsRoot: root,
      });
      const onDisk = await fs.readFile(join(root, FLEET_LESSONS_PACK_ID, `${packItemId}.md`), 'utf8');

      expect(formatOkfViolations(findOkfDocViolations(onDisk))).toBeNull();
    });

    it('the manifest renderManifest REWRITES is conformant', async () => {
      await materializeCandidateIntoPack(lesson('Mint a conformant manifest'), { packsRoot: root });
      const onDisk = await fs.readFile(join(root, FLEET_LESSONS_PACK_ID, 'manifest.yaml'), 'utf8');

      expect(formatOkfViolations(findOkfManifestViolations(onDisk))).toBeNull();
    });

    // CONTROL. Without this, both assertions above pass just as happily if the
    // oracle stops detecting anything at all — a green detector says nothing
    // about whether it can still fail (CLAUDE.md, "proving a guard is
    // falsifiable"). Deliberately-wrong copies live HERE, in the test file;
    // nothing in the shared tree is ever mutated to prove this.
    it('…and the oracle still FAILS on output that drops the fields', () => {
      const conformantDoc = renderCandidateLearningFile({
        itemId: 'control',
        title: 'Control',
        text: 'Body.',
        kind: 'feedback',
        appliesTo: ['any'],
        signature: 'sig',
        scopes: [],
        recurrenceCount: 1,
        sourceItemIds: [],
      });
      expect(formatOkfViolations(findOkfDocViolations(conformantDoc))).toBeNull();

      // The exact regression D-003 warns about: a write path that stops emitting
      // `type`, which no assertion on `kind` would ever notice.
      const withoutType = conformantDoc.replace(/^type: .*\n/m, '');
      expect(formatOkfViolations(findOkfDocViolations(withoutType))).toContain('missing-type');

      // …and its manifest counterpart: a rewrite that drops `okf_version`.
      const manifestWithoutOkf = ['id: fleet-lessons', 'title: T', 'description: D', 'version: 0.0.1', ''].join('\n');
      expect(formatOkfViolations(findOkfManifestViolations(manifestWithoutOkf))).toContain(
        'manifest-missing-okf-version',
      );
    });
  });
});

describe('reviewCandidateForAutoAdopt (WI-5414 automated review + P-001 transferability bar)', () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'fleet-lessons-review-test-'));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const draft = (title: string, draftText: string): Pick<KnowledgePackCandidate, 'title' | 'draftText'> => ({
    title,
    draftText,
  });

  /** A distiller that judges pass and rewrites the draft to `lesson`. */
  const passDistiller = (title: string, lesson: string) =>
    vi.fn(async () => ({ text: JSON.stringify({ verdict: 'pass', title, lesson }), costUsd: 0 }));

  it('passes a transferable candidate when the fleet-lessons pack does not exist yet, carrying the DISTILLED lesson', async () => {
    const empty = await fs.mkdtemp(join(tmpdir(), 'fleet-lessons-review-empty-'));
    const distiller = passDistiller('Lock before concurrent edits', 'Acquire the file lock before editing shared files.');
    const verdict = await reviewCandidateForAutoAdopt(draft('New lesson', 'Some new draft text.'), {
      packsRoot: empty,
      distiller,
    });
    expect(verdict).toEqual({
      verdict: 'pass',
      reason: 'transferable; fleet-lessons pack is empty — nothing to conflict with (knowledge-pack sweep scoring)',
      distilled: { title: 'Lock before concurrent edits', text: 'Acquire the file lock before editing shared files.' },
    });
    await fs.rm(empty, { recursive: true, force: true });
  });

  it('fails at stage 1 when the transferability judge rejects the draft — the conflict judge never runs', async () => {
    const distiller = vi.fn(async () => ({
      text: '{"verdict":"fail","reason":"raw incident report bound to a specific log hash"}',
      costUsd: 0,
    }));
    const judge = vi.fn(async () => ({ conflicts: [] }));
    const verdict = await reviewCandidateForAutoAdopt(
      draft('[replication-liveness] log=6b29d5e853eb…', 'log=6b29d5e853eb… has NEVER attached a replicator (181s).'),
      { packsRoot: root, distiller, judge },
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toContain('not a transferable lesson');
    expect(verdict.reason).toContain('raw incident report');
    expect(judge).not.toHaveBeenCalled();
  });

  it('returns verdict error (stays pending, D-004) when the transferability judge is unusable — e.g. the no-API-key distiller', async () => {
    const distiller = vi.fn(async () => ({ text: '[]', costUsd: 0 }));
    const verdict = await reviewCandidateForAutoAdopt(draft('Whatever', 'Whatever text.'), {
      packsRoot: root,
      distiller,
    });
    expect(verdict.verdict).toBe('error');
  });

  it('fails at stage 2 when the conflict judge reports a contradiction with an existing item (judged on the DISTILLED text)', async () => {
    await materializeCandidateIntoPack(
      {
        title: 'Use Postgres for durable state',
        text: 'Always write new durable state to Postgres, never a flat file.',
        kind: 'feedback',
        appliesTo: ['any'],
        signature: 'storage|policy',
        scopes: ['operator', 'harness:sheets'],
        recurrenceCount: 3,
        sourceItemIds: ['EI-1'],
      },
      { packsRoot: root },
    );

    const distiller = passDistiller('Use SQLite for durable state', 'Write durable state to a local SQLite file.');
    const judge = vi.fn(async ({ newText, neighbors }: { newText: string; neighbors: Array<{ id: string }> }) => {
      expect(newText).toBe('Write durable state to a local SQLite file.'); // the DISTILLED text, not the raw draft
      return {
        conflicts: [{ memory_id: neighbors[0]!.id, summary: 'contradicts the existing Postgres-only lesson' }],
      };
    });
    const verdict = await reviewCandidateForAutoAdopt(
      draft('Use SQLite for durable state', 'RAW DRAFT: sqlite kept timing out on host xyz-123.'),
      { packsRoot: root, judge, distiller },
    );
    expect(judge).toHaveBeenCalledOnce();
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toContain('contradicts the existing Postgres-only lesson');
    expect(verdict.reason).toContain('knowledge-pack sweep scoring');
  });

  it('passes when the conflict judge reports no conflict', async () => {
    const distiller = passDistiller('Lock files first', 'Lock a file before editing it concurrently.');
    const judge = vi.fn(async () => ({ conflicts: [] }));
    const verdict = await reviewCandidateForAutoAdopt(
      draft('Unrelated lesson', 'Lock a file before editing it concurrently.'),
      { packsRoot: root, judge, distiller },
    );
    expect(verdict).toEqual({
      verdict: 'pass',
      reason: 'transferable; no conflict with existing fleet-lessons content (knowledge-pack sweep scoring)',
      distilled: { title: 'Lock files first', text: 'Lock a file before editing it concurrently.' },
    });
  });

  it('still passes stage 2 when the conflict judge itself errors (checkConflicts fails open — stage 1 is the load-bearing bar)', async () => {
    const distiller = passDistiller('Whatever lesson', 'Whatever transferable text.');
    const judge = vi.fn(async () => {
      throw new Error('LLM timeout');
    });
    const verdict = await reviewCandidateForAutoAdopt(draft('Whatever lesson', 'Whatever text.'), {
      packsRoot: root,
      judge,
      distiller,
    });
    expect(verdict.verdict).toBe('pass');
  });
});

describe('materializeCandidateIntoPack is GATED (P-009)', () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'fleet-lessons-gate-'));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Synthetic — never this box's real identity (see pack-residue.test.ts's note). */
  const SYNTHETIC_ENTRIES: [string, string][] = [['build-hostname', 'zzhost-fixture-9x']];

  const admissible = (over: Partial<Parameters<typeof materializeCandidateIntoPack>[0]> = {}) => ({
    title: 'Serialize concurrent edits',
    text: 'Discover how this project coordinates shared-tree edits before changing files.',
    kind: 'feedback' as const,
    appliesTo: ['any' as const],
    signature: 'shared|tree|coord',
    scopes: ['operator', 'harness:papercup'],
    recurrenceCount: 3,
    sourceItemIds: ['EI-9'],
    ...over,
  });

  it.each([
    ['a dangling ledger id', { text: 'See EI-9411 for the original repro of this whole class of bug.' }],
    ['a body below the length floor', { text: 'Use locks.' }],
    ["kind 'user'", { kind: 'user' as const }],
    [
      'tier-3 box identity',
      { text: `Set the operator port on zzhost-fixture-9x before cutting the release bundle.` },
    ],
  ])('REFUSES %s, and writes nothing at all', async (_label, over) => {
    const before = await fs.readdir(root).catch(() => [] as string[]);

    await expect(
      materializeCandidateIntoPack(admissible(over), {
        packsRoot: root,
        identityEntries: SYNTHETIC_ENTRIES,
      }),
    ).rejects.toThrow(/pack-admission gate refused/);

    // The gate runs BEFORE any fs write, so a refusal must leave no item file and
    // no bumped manifest behind — a half-written pack would ship on the next export.
    expect(await fs.readdir(root).catch(() => [] as string[])).toEqual(before);
  });

  it('admits a clean, well-shaped item through the same call', async () => {
    const written = await materializeCandidateIntoPack(admissible(), {
      packsRoot: root,
      identityEntries: SYNTHETIC_ENTRIES,
    });
    expect(written.packItemId).toBe('serialize-concurrent-edits');
    expect(await fs.readdir(join(root, FLEET_LESSONS_PACK_ID))).toContain(
      'serialize-concurrent-edits.md',
    );
  });
});

describe('autoAdoptPendingCandidates (WI-5414 sweep, injected deps)', () => {
  // P-001 (blender-loop-repair-2026-08-16): the sweep records/clears per-candidate
  // review-error streaks. Injected in every test so the unit suite never touches PG.
  const recordReviewError = vi.fn(async () => {});
  const clearReviewErrors = vi.fn(async () => {});
  beforeEach(() => {
    recordReviewError.mockClear();
    clearReviewErrors.mockClear();
  });

  const pendingOf = (id: string): KnowledgePackCandidate => ({
    id,
    signature: `sig-${id}`,
    title: `Candidate ${id}`,
    draftText: 'Draft text.',
    kind: 'feedback',
    appliesTo: ['any'],
    scopes: ['operator', 'harness:sheets'],
    recurrenceCount: 3,
    sourceItemIds: ['EI-1'],
    status: 'pending',
    createdBy: 'recurrence-escalation',
    createdAt: new Date(0).toISOString(),
  });

  it('adopts a passing candidate WITH the distilled overrides and dismisses a failing one, stamping the machine identity + verdict note', async () => {
    const list = vi.fn(async () => [pendingOf('a'), pendingOf('b')]);
    const review = vi.fn(async (c: KnowledgePackCandidate) =>
      c.id === 'a'
        ? {
            verdict: 'pass' as const,
            reason: 'transferable; no conflict (knowledge-pack sweep scoring)',
            distilled: { title: 'Distilled title', text: 'Distilled transferable lesson.' },
          }
        : { verdict: 'fail' as const, reason: 'conflicts with X (knowledge-pack sweep scoring)' },
    );
    const decide = vi.fn(async (input: { id: string; action: string }) => ({
      ok: true as const,
      action: input.action as 'adopt' | 'dismiss',
      id: input.id,
      ...(input.action === 'adopt' ? { packId: 'fleet-lessons', packItemId: input.id, packVersion: '0.0.1' } : {}),
    }));

    const result = await autoAdoptPendingCandidates({}, { list, decide, review, recordReviewError, clearReviewErrors } as never);
    expect(result).toEqual({ reviewed: 2, adopted: 1, dismissed: 1, failed: 0 });
    expect(decide).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: 'a',
        action: 'adopt',
        by: AUTO_ADOPT_REVIEWER,
        note: expect.stringContaining('no conflict'),
        // P-001/D-003: the pack materializes the DISTILLED lesson, not the raw draft
        title: 'Distilled title',
        text: 'Distilled transferable lesson.',
      }),
    );
    expect(decide).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'b', action: 'dismiss', by: AUTO_ADOPT_REVIEWER, note: expect.stringContaining('conflicts with X') }),
    );
  });

  it('an ERRORED review (D-004) counts as failed and never calls decide — the candidate stays pending', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list = vi.fn(async () => [pendingOf('e1'), pendingOf('e2')]);
    const review = vi.fn(async (c: KnowledgePackCandidate) =>
      c.id === 'e1'
        ? { verdict: 'error' as const, reason: 'transferability judge returned no usable verdict' }
        : { verdict: 'pass' as const, reason: 'ok', distilled: { title: 'T', text: 'L.' } },
    );
    const decide = vi.fn(async (input: { id: string; action: string }) => ({
      ok: true as const,
      action: input.action as 'adopt' | 'dismiss',
      id: input.id,
      packId: 'fleet-lessons',
      packItemId: input.id,
      packVersion: '0.0.1',
    }));

    const result = await autoAdoptPendingCandidates({}, { list, decide, review, recordReviewError, clearReviewErrors } as never);
    expect(result).toEqual({ reviewed: 2, adopted: 1, dismissed: 0, failed: 1 });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ id: 'e2', action: 'adopt' }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stays pending'));
    // P-001: the errored candidate's streak is recorded WITH the reason; the
    // usable verdict resets its own streak.
    expect(recordReviewError).toHaveBeenCalledTimes(1);
    expect(recordReviewError).toHaveBeenCalledWith('e1', expect.stringContaining('no usable verdict'));
    expect(clearReviewErrors).toHaveBeenCalledWith('e2');
    warn.mockRestore();
  });

  it('a review that THROWS is treated as errored (stays pending), never adopt-by-default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list = vi.fn(async () => [pendingOf('t')]);
    const review = vi.fn(async () => {
      throw new Error('pack fs I/O');
    });
    const decide = vi.fn();

    const result = await autoAdoptPendingCandidates({}, { list, decide, review, recordReviewError, clearReviewErrors } as never);
    expect(result).toEqual({ reviewed: 1, adopted: 0, dismissed: 0, failed: 1 });
    expect(decide).not.toHaveBeenCalled();
    // P-001: a THROWN review is an error verdict — the streak records it too.
    expect(recordReviewError).toHaveBeenCalledWith('t', expect.stringContaining('pack fs I/O'));
    warn.mockRestore();
  });

  it('counts a decide() failure (e.g. the transfer bar) as `failed`, leaving the candidate for the next tick', async () => {
    const list = vi.fn(async () => [pendingOf('c')]);
    const review = vi.fn(async () => ({ verdict: 'pass' as const, reason: 'clean' }));
    const decide = vi.fn(async () => ({ ok: false as const, reason: 'transfer_bar' as const }));

    const result = await autoAdoptPendingCandidates({}, { list, decide, review, recordReviewError, clearReviewErrors } as never);
    expect(result).toEqual({ reviewed: 1, adopted: 0, dismissed: 0, failed: 1 });
  });

  it('DISMISSES an admission_gate refusal instead of leaving it pending forever (P-009)', async () => {
    // The distinction that matters: `transfer_bar` above is potentially
    // transient, so staying pending is right. `admission_gate` is DETERMINISTIC —
    // the candidate's own text trips it — so "stays pending, next tick retries"
    // would re-judge (and re-spend an LLM call on) the same doomed item on every
    // sweep, forever. This test is the guard against that retry loop.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list = vi.fn(async () => [pendingOf('g')]);
    const review = vi.fn(async () => ({ verdict: 'pass' as const, reason: 'clean' }));
    const decide = vi.fn(async (input: { id: string; action: string }) =>
      input.action === 'adopt'
        ? { ok: false as const, reason: 'admission_gate' as const, error: 'carries EI-1' }
        : { ok: true as const, action: 'dismiss' as const, id: input.id },
    );

    const result = await autoAdoptPendingCandidates({}, { list, decide, review, recordReviewError, clearReviewErrors } as never);
    expect(result).toEqual({ reviewed: 1, adopted: 0, dismissed: 1, failed: 0 });

    // The dismissal records WHY on the row — not only in a log line that scrolls away.
    expect(decide).toHaveBeenCalledTimes(2);
    expect(decide).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: 'g',
        action: 'dismiss',
        by: AUTO_ADOPT_REVIEWER,
        note: expect.stringContaining('pack-admission gate'),
      }),
    );
    warn.mockRestore();
  });

  it('counts a FAILED gate-dismissal as `failed` rather than silently claiming a dismissal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list = vi.fn(async () => [pendingOf('h')]);
    const review = vi.fn(async () => ({ verdict: 'pass' as const, reason: 'clean' }));
    const decide = vi.fn(async () => ({ ok: false as const, reason: 'admission_gate' as const }));

    const result = await autoAdoptPendingCandidates({}, { list, decide, review, recordReviewError, clearReviewErrors } as never);
    expect(result).toEqual({ reviewed: 1, adopted: 0, dismissed: 0, failed: 1 });
    warn.mockRestore();
  });

  it('maxPerRun: 0 reviews nothing', async () => {
    const list = vi.fn(async () => [pendingOf('d')]);
    const result = await autoAdoptPendingCandidates({ maxPerRun: 0 }, { list } as never);
    expect(result).toEqual({ reviewed: 0, adopted: 0, dismissed: 0, failed: 0 });
    expect(list).not.toHaveBeenCalled();
  });
});

describe('truncateCandidateTitle', () => {
  it('short titles pass through untouched', () => {
    expect(truncateCandidateTitle('A short title')).toBe('A short title');
  });

  it('long titles cut at a word boundary with an ellipsis, trailing punctuation stripped', () => {
    const long = `${'word '.repeat(50)}tail`; // 254 chars
    const cut = truncateCandidateTitle(long);
    expect(cut.length).toBeLessThanOrEqual(200);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/ …$/);
    expect(cut).not.toMatch(/wor…$/); // never mid-word
  });

  it('one unbroken word falls back to a hard cut', () => {
    const cut = truncateCandidateTitle('x'.repeat(300), 20);
    expect(cut.length).toBeLessThanOrEqual(20);
    expect(cut.endsWith('…')).toBe(true);
  });
});
