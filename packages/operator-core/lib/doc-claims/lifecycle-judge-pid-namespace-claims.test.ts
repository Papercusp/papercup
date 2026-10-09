import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const INSIGHT = fileURLToPath(new URL(
  '../../../../apps/operator-docs/src/content/docs/agent-insights/is-this-process-actually-doing-work.mdx',
  import.meta.url,
));
const JUDGE_INSIGHT = fileURLToPath(new URL(
  '../../../../apps/operator-docs/src/content/docs/agent-insights/process-lifecycle-judge-verdict-traps.mdx',
  import.meta.url,
));

describe('the process-liveness insight explains PID-namespace readings', () => {
  const source = () => readFileSync(INSIGHT, 'utf8');

  it('defines cgroup.procs zero as hidden presence, not an empty cgroup', () => {
    const text = source();
    expect(text.length, `${INSIGHT} is empty or unreadable`).toBeGreaterThan(1000);
    expect(text).toMatch(/cgroup\.procs.*only `0` means at least one process exists.*invisible.*PID namespace/i);
    expect(text).toMatch(/does not mean the cgroup is empty.*`0` is not a process ID/i);
  });

  it('says pids.current counts kernel tasks, including threads', () => {
    expect(source()).toMatch(/`?pids\.current`? counts kernel tasks, including threads, rather than task-manager process rows/i);
  });

  it('says proxied loopback 502 is not a connection-refused result', () => {
    const text = source();
    expect(text).toMatch(/loopback traffic is proxied/i);
    expect(text).toMatch(/HTTP 502 rather than `ECONNREFUSED` \(`curl` exit 7\)/i);
  });

  it('documents the candidate liveness field as timestamped and non-negative when unknown', () => {
    const text = source();
    expect(text).toMatch(/processLifecycleCandidate\.liveness.*`present`.*observedAt/i);
    expect(text).toMatch(/`unknown` means no such safe observation was established and does not mean dead/i);
  });

  it('requires same-kind controls and a complete census before using exact scope absence', () => {
    const text = source();
    expect(text).toContain('only `live.exactScopeUnitMatches` entries with kind "unaccounted"');
    expect(text).toContain('For a non-empty unfiltered census, require a known-present same-kind unaccounted control');
    expect(text).toContain('live.degraded=false');
    expect(text).toContain('live.ownedTruncated=false');
    expect(text).toContain('live.foreignTruncated=false');
    expect(text).toContain('live.unaccountedCount');
    expect(text).toContain('live.unaccountedPidCount');
    expect(text).toContain('live.unaccountedGroups.length');
    expect(text).toContain('readlink /proc/self/ns/pid');
    expect(text).toContain('visible numeric /proc PID count');
    expect(text).toMatch(/[\x60]?\$\$[\x60]? in the same call/);
    expect(text).toContain('If `$$` is tiny or only a few PIDs are visible');
    expect(text).toMatch(/For a non-empty unfiltered census, require a known-present same-kind unaccounted control and read it twice, confirming [\x60]?tasks\[\]\.ageSec[\x60]? advances by elapsed wall time/);
    expect(text).toMatch(/[\x60]?confined:false[\x60]? does not prove abandonment/);
  });

  it('provides an independent cgroupfs positive control when the unaccounted census is empty', () => {
    const text = source();
    expect(text).toContain('When `live.unaccountedGroups` is empty, a same-kind control is impossible');
    expect(text).toContain('structurally unavailable, not a failed read');
    expect(text).toContain('independently enumerate the complete, readable Papercusp cgroupfs subtree under `/sys/fs/cgroup`');
    expect(text).toContain('exact `scopeUnit` directory absence');
    expect(text).toContain('a populated peer `pc-*.scope`');
    expect(text).toMatch(/`pids\.current` > 0 or `cgroup\.events` reports `populated 1`/);
    expect(text).toMatch(/unreadable or incomplete tree/i);
    expect(text).toContain('Never use stored `cgroupPath`, `/proc` absence, detector reason, or empty filtered output');

    const judge = readFileSync(JUDGE_INSIGHT, 'utf8');
    expect(judge).toContain('When the census is empty, the control is structurally unavailable');
    expect(judge).toContain('Recursively enumerate the complete, readable Papercusp slice subtree under `/sys/fs/cgroup` by exact unit name');
    expect(judge).toMatch(/peer `pc-\*\.scope` elsewhere in the same subtree is populated/);
    expect(judge).toContain('Never use stored `cgroupPath`, `/proc` absence, the detector reason, or empty filtered output');
  });
});
