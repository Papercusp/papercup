import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('goal write provenance census', () => {
  it('keeps the non-dispatch holder-respawn writers on the shared goal:write seam', () => {
    const watchdog = readFileSync(resolve(import.meta.dirname, '../system-health/goal-liveness-watchdog.ts'), 'utf8');
    expect(watchdog).toContain('appendGoalWriteAudit');
    expect(watchdog).toContain("writeKind: 'holder-respawn-reserve'");
    expect(watchdog).toContain("writeKind: 'holder-respawn-pause'");
  });

  it('keeps dispatched telemetry goal/actor resolution at the single sink', () => {
    const sink = readFileSync(resolve(import.meta.dirname, '../projected-tool-deps.ts'), 'utf8');
    expect(sink).toContain('goal_actor_class');
    expect(sink).toContain('harness_shared.agent_modes');
    expect(sink).toContain('harness_shared.session_briefs');
    expect(sink).toContain('harness_shared.fleet_membership_events');
  });
});
