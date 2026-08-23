/**
 * BULK RESOLVE policy + contract coverage (inbox-bulk-resolve-2026-08-23,
 * P-004/P-007). Three things are pinned here, all of them cross-file
 * invariants that no single file's own tests can hold:
 *
 *  1. THE NAVIGATE LOCKSTEP. `NAVIGATE_ACTION_IDS` is declared TWICE — once in
 *     the client card (attention-card.ts) and once server-side in the agent
 *     tool that validates a resolver's report. They must name the same ids. A
 *     divergence is silent and dangerous in one specific direction: an id the
 *     SERVER thinks is terminal but the CLIENT treats as navigation is an
 *     action a resolver may auto-resolve with and that resolves nothing. That
 *     exact drift (`discuss` missing from the set) once let the Discuss button
 *     silently close real owner gates (EI-13037).
 *
 *  2. THE RESOLVER BRIEF'S POLICY (D-001/D-002). The brief is what carries the
 *     plan's decisions into the run, and it is prose — so nothing but a test
 *     stops a later edit from quietly dropping the clause that keeps the agent
 *     from inventing option ids or from resolving what the owner must decide.
 *
 *  3. THE SYNC RESOLVER'S SHAPE. `plans.attentionBulkRun` must return ONE row
 *     with an explicit `run: null` when there is no run — never an empty row
 *     set, which is indistinguishable from a read that failed, and would render
 *     the strip's idle state on "unknown" rather than on "no run".
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildResolverBrief } from '../endpoint-route/routes/admin/attention-bulk-resolve';
import { NAVIGATE_ACTION_IDS } from '../agent-tools/inbox/bulk-run';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

describe('NAVIGATE_ACTION_IDS lockstep (server ↔ client)', () => {
  it('names exactly the ids the client card treats as navigation', () => {
    // Read the CLIENT declaration from source rather than importing it: the
    // client module pulls in React/`@/` alias machinery that has no business in
    // an operator-core test, and the text IS the declaration.
    const src = readFileSync(
      join(REPO_ROOT, 'apps/operator/app/admin/plans/attention-card.ts'),
      'utf8',
    );
    const block = src.match(
      /export const NAVIGATE_ACTION_IDS[^=]*=\s*new Set<AttentionActionId>\(\[([\s\S]*?)\]\)/,
    );
    expect(block, 'client NAVIGATE_ACTION_IDS declaration not found — did it move?').toBeTruthy();

    const clientIds = [...block![1]!.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!);
    // Positive control: the parse actually found ids, so an empty match cannot
    // pass as agreement.
    expect(clientIds.length).toBeGreaterThan(0);
    expect(clientIds).toContain('discuss'); // the EI-13037 id specifically

    expect([...NAVIGATE_ACTION_IDS].sort()).toEqual([...clientIds].sort());
  });
});

describe('resolver brief — the D-001/D-002 policy it carries into the run', () => {
  const brief = buildResolverBrief('run-abc123', 12);

  it('names the run and its size, so the agent is bound to THIS run', () => {
    expect(brief).toContain('run-abc123');
    expect(brief).toContain('12');
    // The manifest call must carry the run id, or the agent reads whatever run
    // happens to be active.
    expect(brief).toMatch(/inbox:bulk-run-manifest \{ runId: "run-abc123" \}/);
  });

  it('forbids inventing an option id', () => {
    expect(brief).toMatch(/NEVER invent an option id/i);
    expect(brief).toMatch(/Only ids the manifest listed/i);
  });

  it('requires a rationale on every auto-resolve — it is the audit note', () => {
    expect(brief).toMatch(/rationale is REQUIRED on every auto_resolved/i);
    expect(brief).toMatch(/reason is REQUIRED on skipped\/failed/i);
  });

  it('prefers RECOMMEND over resolve for owner-preference, money and irreversible calls', () => {
    // D-001 grants full-resolve authority; this is the clause that bounds it.
    expect(brief).toMatch(/Prefer recommending over resolving/i);
    expect(brief).toMatch(/owner's preference/i);
    expect(brief).toMatch(/money/i);
    expect(brief).toMatch(/irreversible/i);
  });

  it('encodes the D-002 consult loop: a bounded window, and a LAPSE downgrades confidence', () => {
    expect(brief).toMatch(/CONSULT/);
    expect(brief).toMatch(/coord:presence/);
    expect(brief).toMatch(/bounded window/i);
    // The honesty requirement: a lapsed consult is an inference, and must be
    // labelled as one rather than presented like a confirmed answer.
    expect(brief).toMatch(/confidence:"high"/);
    expect(brief).toMatch(/confidence:"low"/);
    expect(brief).toMatch(/lapse/i);
  });

  it('tells the agent a non-terminal option resolves nothing', () => {
    expect(brief).toMatch(/terminal:false/);
    expect(brief).toMatch(/never treat one as a resolution/i);
  });

  it('gives it a way to give up VISIBLY rather than stalling the run', () => {
    expect(brief).toMatch(/inbox:bulk-run-settle \{ failed: true, error \}/);
  });
});

describe('plans.attentionBulkRun sync resolver', () => {
  it('returns ONE row with an explicit null run when no run exists', async () => {
    vi.doMock('../attention/bulk-run-store', () => ({
      getRun: vi.fn(),
      getLatestRun: vi.fn(async () => null),
      getRunItems: vi.fn(async () => []),
    }));
    const { getRegistryEntryV2 } = await import('../sync-resolver/index');
    const entry = getRegistryEntryV2('plans.attentionBulkRun');
    expect(entry, 'plans.attentionBulkRun is not registered').toBeTruthy();

    const rows = await entry!.resolve!({}, {} as never);
    // NOT `[]`: an empty set is indistinguishable from a failed read, and the
    // strip must render IDLE on "no run", never on "unknown".
    expect(rows).toEqual([{ run: null, items: [] }]);
    vi.doUnmock('../attention/bulk-run-store');
  });

  it('degrades to the same idle row when the store THROWS', async () => {
    vi.resetModules();
    vi.doMock('../attention/bulk-run-store', () => ({
      getRun: vi.fn(),
      getLatestRun: vi.fn(async () => {
        throw new Error('pg down');
      }),
      getRunItems: vi.fn(async () => []),
    }));
    const { getRegistryEntryV2 } = await import('../sync-resolver/index');
    const rows = await getRegistryEntryV2('plans.attentionBulkRun')!.resolve!({}, {} as never);
    // The inbox itself must stay usable when the bulk substrate is unavailable —
    // every item remains resolvable by hand.
    expect(rows).toEqual([{ run: null, items: [] }]);
    vi.doUnmock('../attention/bulk-run-store');
    vi.resetModules();
  });

  it('reads the SPECIFIC run when one is named (the ?opcbr= deep link)', async () => {
    vi.resetModules();
    const getRun = vi.fn(async () => ({ runId: 'run-x', phase: 'review' }));
    const getLatestRun = vi.fn();
    vi.doMock('../attention/bulk-run-store', () => ({
      getRun,
      getLatestRun,
      getRunItems: vi.fn(async () => [{ itemId: 'a' }]),
    }));
    const { getRegistryEntryV2 } = await import('../sync-resolver/index');
    const rows = (await getRegistryEntryV2('plans.attentionBulkRun')!.resolve!(
      { runId: 'run-x' },
      {} as never,
    )) as Array<{ run: { runId: string }; items: unknown[] }>;

    expect(getRun).toHaveBeenCalledWith('run-x');
    // A named run must NOT fall through to "latest" — that would silently show
    // a different run than the link asked for.
    expect(getLatestRun).not.toHaveBeenCalled();
    expect(rows[0]!.run.runId).toBe('run-x');
    expect(rows[0]!.items).toHaveLength(1);
    vi.doUnmock('../attention/bulk-run-store');
    vi.resetModules();
  });
});
