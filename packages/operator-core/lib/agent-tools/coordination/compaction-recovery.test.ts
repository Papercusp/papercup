/**
 * compaction-recovery — unit tests (EI-19952485326105760).
 *
 * The post-compaction recovery fold's held-item checkpoint render used to do
 * a PLAIN head-only `.slice(0, CHECKPOINT_CAP)` — the exact same defect the
 * carry-brief cold-extras render already fixed via `capPreservingOperative`
 * (see carry-brief.test.ts's own EI-19952485326105760 describe block). This
 * file is the surface the incident's own bug report named
 * (`payload.paths: ["packages/operator-core/lib/agent-tools/coordination"]`)
 * and it was left unpatched when the carry-brief fix landed. Guard both
 * surfaces independently so they can't silently diverge again.
 *
 * Dependencies are dynamically imported inside buildCompactionRecovery, so
 * every leg is mocked at the module boundary and made to fail/resolve-empty
 * except the one under test (held-item checkpoints) — every leg is
 * best-effort in the implementation, so a failing mock never throws.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../search/self-session', () => ({
  resolveSelfSession: vi.fn(async () => null),
}));
vi.mock('../../harness/routines/loop', () => ({
  getLoopStatus: vi.fn(async () => null),
}));
vi.mock('./control-anchor', () => ({
  buildAndPersistControlAnchor: vi.fn(async () => {
    throw new Error('not exercised by this test');
  }),
}));

const OLDER_PLAN =
  'the owner report is artifact https://claude.ai/example-artifact-url; republish that path to keep the URL. ' +
  `${'filler context '.repeat(90)}`;
const SUPERSEDING_BLOCK =
  '## ⛔ SUPERSEDING OWNER DIRECTIVE — NO MORE STATUS-REPORT ARTIFACTS\n' +
  `[owner 2026-08-09] "i dont need the live reports stop that"`;
const CHECKPOINT = `${OLDER_PLAN}\n\n${SUPERSEDING_BLOCK}`;

vi.mock('../../carry-brief', () => ({
  readHeldWorkItems: vi.fn(async () => [
    { id: 'WI-37110', title: 'republish the report', body: null, harness: 'h', checkpoint: CHECKPOINT },
  ]),
}));

describe('buildCompactionRecovery — held-item checkpoint fold', () => {
  it('sanity: the incident shape exceeds CHECKPOINT_CAP(1200) and a plain cut lands before the superseding block', () => {
    expect(CHECKPOINT.length).toBeGreaterThan(1200);
    expect(CHECKPOINT.slice(0, 1199)).not.toContain('SUPERSEDING');
  });

  it('preserves a superseding owner directive past the CHECKPOINT_CAP cut', async () => {
    const { buildCompactionRecovery } = await import('./compaction-recovery');
    const recovery = await buildCompactionRecovery('owner-x', 'ws-1');
    expect(recovery.checkpoints).toBeDefined();
    const ckpt = recovery.checkpoints?.[0]?.checkpoint ?? '';
    expect(ckpt).toContain('⚠ OPERATIVE:');
    expect(ckpt).toContain('NO MORE STATUS-REPORT ARTIFACTS');
    expect(ckpt).toContain('i dont need the live reports stop that');
  });

  it('still truncates — this is preservation, not a budget bypass', async () => {
    const { buildCompactionRecovery } = await import('./compaction-recovery');
    const recovery = await buildCompactionRecovery('owner-x', 'ws-1');
    const ckpt = recovery.checkpoints?.[0]?.checkpoint ?? '';
    // Bounded well under the raw checkpoint length; not the full ~1.4KB body.
    expect(ckpt.length).toBeLessThan(CHECKPOINT.length);
    expect(ckpt).toContain('…');
  });

  // EI-20451119672468393: the fold re-delivers held items ACROSS harnesses, so
  // each row must name its CANONICAL harness and the re-fetch hint must be
  // harness-qualified — an unqualified `work_items:get { id }` from a
  // differently-scoped successor session made a real carried item (WI-3496,
  // harness papercusp, read from a sb-devboard-hive session) look GONE.
  it('folds the canonical harness + a harness-qualified re-fetch hint (EI-20451119672468393)', async () => {
    const { buildCompactionRecovery } = await import('./compaction-recovery');
    const recovery = await buildCompactionRecovery('owner-x', 'ws-1');
    const row = recovery.checkpoints?.[0];
    expect(row?.harness).toBe('h');
    expect(row?.checkpointTruncated?.more).toBe("work_items:get { id: 'WI-37110', harness: 'h' }");
    // No session harness supplied ⇒ no cross-harness verdict either way.
    expect(row?.crossHarnessNote).toBeUndefined();
  });

  it('flags a held item whose canonical harness contradicts the session harness', async () => {
    const { buildCompactionRecovery } = await import('./compaction-recovery');
    const recovery = await buildCompactionRecovery('owner-x', 'ws-1', {
      sessionHarness: 'sb-devboard-hive',
    });
    const note = recovery.checkpoints?.[0]?.crossHarnessNote ?? '';
    expect(note).toContain("'h'");
    expect(note).toContain("'sb-devboard-hive'");
    expect(note).toContain('NOT gone');
  });

  it('emits no cross-harness note when the session harness matches', async () => {
    const { buildCompactionRecovery } = await import('./compaction-recovery');
    const recovery = await buildCompactionRecovery('owner-x', 'ws-1', { sessionHarness: 'h' });
    expect(recovery.checkpoints?.[0]?.crossHarnessNote).toBeUndefined();
  });
});
