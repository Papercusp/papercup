import { describe, it, expect, vi } from 'vitest';
// Smoke-import only: the CLI wraps pg in a runtime require inside
// `audit()`; importing the module doesn't open a connection.
import { audit, runMemoryAnchorAuditOnce } from './audit-memory-anchors';

describe('audit-memory-anchors CLI', () => {
  it('module imports cleanly without opening a pg connection', () => {
    expect(typeof audit).toBe('function');
  });
});

describe('runMemoryAnchorAuditOnce — periodic wrapper', () => {
  it('SKIPS (no pg) when no repo root is detected (packaged / non-repo host)', async () => {
    const auditFn = vi.fn();
    const r = await runMemoryAnchorAuditOnce({
      resolveRepoRoot: () => null,
      auditFn,
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/no repo root/i);
    // The expensive pg-touching audit must NOT run on the skip path.
    expect(auditFn).not.toHaveBeenCalled();
  });

  it('runs the audit against the resolved repo root (write mode by default)', async () => {
    const auditFn = vi
      .fn()
      .mockResolvedValue({ skipped: false, ok: true, summary: 'checked=3 anchors=5' });
    const r = await runMemoryAnchorAuditOnce({
      resolveRepoRoot: () => '/repo/root',
      auditFn,
    });
    expect(auditFn).toHaveBeenCalledWith({ dryRun: false, repoRoot: '/repo/root' });
    expect(r).toEqual({ skipped: false, ok: true, summary: 'checked=3 anchors=5' });
  });

  it('threads dryRun through to the audit runner', async () => {
    const auditFn = vi.fn().mockResolvedValue({ skipped: false, ok: true, summary: 'dry' });
    await runMemoryAnchorAuditOnce({
      dryRun: true,
      resolveRepoRoot: () => '/repo/root',
      auditFn,
    });
    expect(auditFn).toHaveBeenCalledWith({ dryRun: true, repoRoot: '/repo/root' });
  });
});
