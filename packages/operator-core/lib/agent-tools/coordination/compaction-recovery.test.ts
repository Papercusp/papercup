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
});
