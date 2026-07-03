/**
 * launch-on-plan.test.ts — WI-1408 (fleet-registration-persists): the
 * `fleet:launch-on-plan` path builds every member's `psu` invocation via
 * `memberLaunchCommand`. The Queen's brief called this out as one of the TWO
 * launch paths that must thread `--fleet` all the way to registration (the
 * other being a direct `psu --fleet=<slug>` member launch, covered by
 * apps/operator/lib/psu-launcher.test.ts + bootstrap-su/-role's own WI-1408
 * suites). This pins the pure, PG-free half of that contract: the command
 * string a member actually execs always carries `--fleet=<slug>` — the flag
 * bootstrap-su/-role's `resolveFleet` + presence.ts's pending-fleet bridge
 * need to persist a non-null fleetSlug onto the member's presence row (and
 * therefore group it under the fleet in fleet:assignments, per
 * packages/operator-core/lib/fleet/assignments.ts's `groupByAgent`).
 */
import { describe, it, expect } from 'vitest';
import { memberLaunchCommand, isOmpLocalModel, type MemberLaunchOpts } from './launch-on-plan';

const base: MemberLaunchOpts = {
  fleetSlug: 'atlas-fleet',
  agent: 'claude',
  harness: 'papercup',
  plan: 'p-plan',
};

describe('memberLaunchCommand (WI-1408 — fleet:launch-on-plan threads --fleet into the member launch)', () => {
  it('always includes --fleet=<slug> — never a colour-only, unfleeted member launch', () => {
    const cmd = memberLaunchCommand(base);
    expect(cmd).toMatch(/(^|\s)--fleet=atlas-fleet(\s|$)/);
  });

  it('the flag carries the REAL fleet slug (not the display name) even with a fancy fleet name-derived slug', () => {
    const cmd = memberLaunchCommand({ ...base, fleetSlug: 'my-new-fleet' });
    expect(cmd).toContain('--fleet=my-new-fleet');
  });

  it('--fleet is present alongside the other required tokens (--no-picker, agent/harness/plan) — parity with a direct member launch', () => {
    const cmd = memberLaunchCommand(base);
    const tokens = cmd.split(' ');
    expect(tokens[0]).toBe('psu');
    expect(tokens).toContain('--no-picker');
    expect(tokens).toContain('--fleet=atlas-fleet');
    expect(tokens).toContain('--agent=claude');
    expect(tokens).toContain('--harness=papercup');
    expect(tokens).toContain('--plan=p-plan');
  });

  it('optional flags (role/account/model/...) never crowd out or duplicate --fleet', () => {
    const cmd = memberLaunchCommand({
      ...base,
      account: 'acct-1',
      role: 'worker',
      model: 'opus:high',
      feature: 'F-001',
      contextSize: 'trimmed',
      brain: true,
    });
    const fleetOccurrences = cmd.match(/--fleet=/g) ?? [];
    expect(fleetOccurrences).toHaveLength(1);
    expect(cmd).toContain('--fleet=atlas-fleet');
  });

  it('allowSubagents (owner mandate 2026-07-02): omitted by default (deny), --allow-subagents when opted in', () => {
    expect(memberLaunchCommand(base)).not.toContain('--allow-subagents');
    expect(memberLaunchCommand({ ...base, allowSubagents: true }).split(' ')).toContain('--allow-subagents');
    expect(memberLaunchCommand({ ...base, allowSubagents: false })).not.toContain('--allow-subagents');
  });
});

describe('isOmpLocalModel (agent/model coupling — "thought ornith, got claude" guard, 2026-07-03)', () => {
  it('flags local/gateway models that ONLY the omp backend can run', () => {
    expect(isOmpLocalModel('ollama-cc/maxwell1500/ornith-35b:IQ3_M')).toBe(true); // the exact id the leader passed
    expect(isOmpLocalModel('ollama/llama3')).toBe(true);
    expect(isOmpLocalModel('ornith:35b')).toBe(true);
    expect(isOmpLocalModel('ornith:fast')).toBe(true);
    expect(isOmpLocalModel('  ollama-cc/x ')).toBe(true); // tolerant of surrounding space
  });

  it('does NOT flag claude/codex model ids (they stay on their default backend)', () => {
    expect(isOmpLocalModel('opus:high')).toBe(false);
    expect(isOmpLocalModel('opus[1m]')).toBe(false);
    expect(isOmpLocalModel('claude-sonnet-4-6')).toBe(false);
    expect(isOmpLocalModel('gpt-4o')).toBe(false);
    expect(isOmpLocalModel(undefined)).toBe(false);
    expect(isOmpLocalModel('')).toBe(false);
  });
});
