/**
 * PIN: `apps/operator/scripts/psu-launcher.mjs`'s hand-written deny literals must
 * agree, name for name, with the ONE capability policy
 * (`managed-capability-policy.ts`, plan
 * managed-agent-capability-contract-and-native-cutover-2026-09-13 P-005).
 *
 * ## Why a pin and not an import
 *
 * The launcher holds its restrictions as string literals
 * (`NO_SUBAGENTS_DENY_FLAG = "--disallowedTools=Task,Agent,Workflow"`, …) rather
 * than calling the policy. That is deliberate: psu-launcher.mjs is the hot
 * launch path and a plain `.mjs` outside the orchestrator's build, so importing
 * the TS policy at runtime buys a module-resolution hazard on the one path that
 * must never fail to start. Rung 2 of the repo's derived-truth ladder covers
 * exactly this case — prose (or here, a literal) that must remain gets a
 * build-time divergence check instead of being hand-maintained on trust.
 *
 * ## What this pin caught on the way in
 *
 * The su and headless launches are NOT the same restriction set, and the
 * difference is intentional: D-003 keeps the owner-facing scheduling surfaces
 * reachable for a human at the keyboard, so the su launch ships
 * `SU_SCHEDULER_TOOLS_DENY_FLAG` — a STRICT SUBSET naming only the four
 * Cron/ScheduleWakeup tools. The policy's first draft applied the OS-shell
 * routes (`Bash(crontab:*)`, `Bash(systemd-run:*)`, `Bash(batch:*)`) to every
 * audience, which would have had it hand the su launcher a WIDER posture than
 * the launcher ships — and `Bash(systemd-run:*)` is not hypothetical collateral:
 * capability:bash and scripts/verify-tauri-headless.sh both shell out to
 * systemd-run. Splitting `no-os-scheduler-shell` onto the headless audience is
 * what makes the two sets equal HONESTLY, rather than by widening su to match.
 *
 * ## Scope — read this before trusting a green run
 *
 * This pins the LITERALS against the policy. It does NOT prove either launch
 * site actually PUSHES every literal it holds: a site that simply forgets one
 * still passes here. That omission class is what the drift behind P-005 actually
 * was (the wake path pushed three of four), and it is covered by wiring the real
 * call sites to `capabilityPolicyFlags` — which invoke.ts and wake-executor.ts
 * now do — not by this file.
 */
import { describe, expect, it } from 'vitest';
import { capabilityPolicyFlags } from '@papercusp/orchestrator/managed-capability-policy';
import {
  NATIVE_SCHEDULER_DENY_FLAG,
  NATIVE_TOOL_SEARCH_DENY_FLAG,
  NO_SUBAGENTS_DENY_FLAG,
  OWNER_DESKTOP_NOTIFY_DENY_FLAG,
  SU_SCHEDULER_TOOLS_DENY_FLAG,
} from '../../../apps/operator/scripts/psu-launcher.mjs';

const PREFIX = '--disallowedTools=';

/**
 * Split `--disallowedTools=A,B(c:*),C` into its names.
 *
 * Comma-splitting is safe for these specific literals (no name contains a comma
 * inside its parentheses) and the assertion below would fail loudly if that ever
 * stopped holding, since the policy's own names are compared against it.
 */
function denyNames(...flags: readonly string[]): readonly string[] {
  return flags
    .flatMap((flag) => {
      expect(flag.startsWith(PREFIX), `not a --disallowedTools token: ${flag}`).toBe(true);
      return flag.slice(PREFIX.length).split(',');
    })
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

const sorted = (names: readonly string[]): readonly string[] => [...new Set(names)].sort();

describe('psu-launcher deny literals are pinned to the ONE capability policy', () => {
  it('the interactive su launch set equals the policy for audience interactive-su', () => {
    const fromLauncher = denyNames(
      NO_SUBAGENTS_DENY_FLAG,
      NATIVE_TOOL_SEARCH_DENY_FLAG,
      OWNER_DESKTOP_NOTIFY_DENY_FLAG,
      SU_SCHEDULER_TOOLS_DENY_FLAG,
    );
    const fromPolicy = denyNames(
      ...capabilityPolicyFlags({
        client: 'claude',
        surface: 'launch',
        audience: 'interactive-su',
      }),
    );

    expect(sorted(fromPolicy)).toEqual(sorted(fromLauncher));
  });

  it('the headless role/bee launch set equals the policy for audience headless-agent', () => {
    const fromLauncher = denyNames(
      NO_SUBAGENTS_DENY_FLAG,
      NATIVE_TOOL_SEARCH_DENY_FLAG,
      OWNER_DESKTOP_NOTIFY_DENY_FLAG,
      NATIVE_SCHEDULER_DENY_FLAG,
    );
    const fromPolicy = denyNames(
      ...capabilityPolicyFlags({
        client: 'claude',
        surface: 'launch',
        audience: 'headless-agent',
      }),
    );

    expect(sorted(fromPolicy)).toEqual(sorted(fromLauncher));
  });

  it('su keeps the owner-facing scheduling surfaces the launcher leaves reachable (D-003)', () => {
    const su = denyNames(
      ...capabilityPolicyFlags({
        client: 'claude',
        surface: 'launch',
        audience: 'interactive-su',
      }),
    );

    // The exact names SU_SCHEDULER_TOOLS_DENY_FLAG deliberately omits. Asserted
    // as an ABSENCE because the equality above would also pass if BOTH sides
    // gained them together — which is precisely how su would silently lose
    // working tooling (capability:bash and verify-tauri-headless shell out to
    // systemd-run).
    for (const kept of [
      'Skill(schedule)',
      'Skill(loop)',
      'Bash(crontab:*)',
      'Bash(systemd-run:*)',
      'Bash(batch:*)',
    ]) {
      expect(su, `su must keep ${kept} reachable per D-003`).not.toContain(kept);
    }

    // …while still losing the four model-facing scheduling TOOLS.
    for (const denied of ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup']) {
      expect(su).toContain(denied);
    }
  });

  it('the --allow-subagents override clears exactly the subagent names, on both audiences', () => {
    for (const audience of ['interactive-su', 'headless-agent'] as const) {
      const withOverride = denyNames(
        ...capabilityPolicyFlags({
          client: 'claude',
          surface: 'launch',
          audience,
          overrides: ['allow-subagents'],
        }),
      );
      const withoutOverride = denyNames(
        ...capabilityPolicyFlags({ client: 'claude', surface: 'launch', audience }),
      );

      // Mirrors the launcher's `...(allowSubagents ? [] : [NO_SUBAGENTS_DENY_FLAG])`.
      expect(sorted(withOverride)).toEqual(
        sorted(withoutOverride.filter((name) => !denyNames(NO_SUBAGENTS_DENY_FLAG).includes(name))),
      );
      for (const name of denyNames(NO_SUBAGENTS_DENY_FLAG)) {
        expect(withOverride).not.toContain(name);
      }
      // The override is scoped: it must not clear anything else.
      expect(withOverride).toContain('ToolSearch');
    }
  });
});
