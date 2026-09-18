/**
 * DENY-LIVENESS GUARD — every tool psu deny-lists must actually be ABSENT from
 * the advertised tool list, observed against a real `claude`.
 *
 * Why the unit tests next door are not enough: psu-launcher.test.ts pins what
 * the deny FLAGS CONTAIN. It cannot see whether claude still HONOURS them.
 * That gap has produced a silent no-op twice:
 *   - the Task -> Agent rename made the subagent deny a no-op while the literal
 *     still read correctly (recorded in NO_SUBAGENTS_DENY_FLAG's doc comment);
 *   - EI-23579531831719394 was filed claiming exactly this class of failure and
 *     was only disproven by observing the advertised list directly.
 * `--disallowedTools` is closed-source policy, so nothing in-tree can predict a
 * behaviour change. Only observation catches it.
 *
 * NOT VACUOUS BY CONSTRUCTION: a no-deny control arm runs first and the suite
 * fails unless that control shows the denied tools PRESENT. Without it a
 * silently-failed capture is indistinguishable from a perfect deny.
 *
 * INTEGRATION-classified because it spawns real `claude` processes (~7s). It is
 * therefore excluded from the unit sweep and runs under test:affected:integration.
 */
import { describe, it, expect } from 'vitest';
import {
  captureAdvertisedTools,
  claudeBinaryAvailable,
  bareDeniedToolNames,
} from './advertised-tools.js';
import { suLaunchArgs, roleLaunchArgs } from '../scripts/psu-launcher.mjs';

const AVAILABLE = claudeBinaryAvailable();

/**
 * Names psu denies that claude does NOT advertise even with nothing denied.
 * Each is harmless but inert, and each needs a stated reason — an UNEXPLAINED
 * entry appearing here is the Task->Agent regression signal.
 *
 * The assertion is a SUBSET check, deliberately asymmetric: a NEW never-seen
 * name fails (we must look at it), while a name becoming available again does
 * not (the absence assertion below already covers it).
 */
const KNOWN_NOT_ADVERTISED: Record<string, string> = {
  Task: 'renamed to `Agent` around claude 2.1.198; kept in the literal for older clients',
  ToolSearch:
    'only advertised when MCP servers are configured; this capture runs with --strict-mcp-config and an empty config',
  Artifact: 'requires claude.ai account auth, absent under an API-key/gateway route',
  SendFeedback: 'first-party surface, not present on this client/account route',
  RemoteTrigger: 'first-party surface, not present on this client/account route',
};

const files = {
  promptFile: '/tmp/deny-liveness-prompt.md',
  coordExtPath: '/tmp/deny-liveness-coord.ts',
};

/**
 * Only the launch flags that shape the advertised surface.
 *
 * Filters to strings first: these fixtures deliberately omit path options the
 * launchers otherwise interpolate (e.g. role's --mcp-config value), leaving
 * undefined holes in the argv. Those holes are irrelevant here — we take only
 * the deny tokens — so tolerate them rather than over-specifying a fixture
 * whose extra fields this guard does not exercise.
 */
function denyFlagsOf(args: unknown[]): string[] {
  return args.filter(
    (a): a is string =>
      typeof a === 'string' &&
      (a.startsWith('--disallowedTools=') || a === '--no-chrome'),
  );
}

// A skip is "not measured", never a pass — the name says so in the runner output.
describe.skipIf(!AVAILABLE)(
  'psu deny flags are LIVE (observed against a real claude; SKIPPED = not measured, not passing)',
  () => {
    it(
      'every bare tool name psu denies is ABSENT from what claude advertises',
      async () => {
        const suDeny = denyFlagsOf(suLaunchArgs('claude', files).args);
        const roleDeny = denyFlagsOf(roleLaunchArgs('claude', files).args);
        const denied = [
          ...new Set([
            ...bareDeniedToolNames(suDeny),
            ...bareDeniedToolNames(roleDeny),
          ]),
        ];
        expect(denied.length).toBeGreaterThan(0);

        const control = await captureAdvertisedTools([]);
        const suArm = await captureAdvertisedTools(suDeny);
        const roleArm = await captureAdvertisedTools(roleDeny);

        // A null capture is "not measured" — never read it as an empty toolset.
        expect(control, 'no-deny control captured nothing').not.toBeNull();
        expect(suArm, 'su arm captured nothing').not.toBeNull();
        expect(roleArm, 'role arm captured nothing').not.toBeNull();

        const catalog = control!.names;

        // POSITIVE CONTROL: some denied tool must appear when NOTHING is denied.
        // If none does, the capture is broken and every absence below is vacuous.
        const seenInControl = denied.filter((n) => catalog.includes(n));
        expect(
          seenInControl.length,
          `positive control failed: none of [${denied.join(', ')}] appeared in the ` +
            `no-deny catalog [${catalog.join(', ')}] — the absences below would be vacuous`,
        ).toBeGreaterThan(0);

        // THE GUARD: anything denied AND reachable must be gone. Restricting to
        // names the control proved reachable stops an environment-gated tool
        // from "passing" without testing anything.
        for (const arm of [
          { label: 'su', deny: suDeny, cap: suArm! },
          { label: 'role', deny: roleDeny, cap: roleArm! },
        ]) {
          const armDenied = bareDeniedToolNames(arm.deny).filter((n) =>
            seenInControl.includes(n),
          );
          const leaked = armDenied.filter((n) => arm.cap.names.includes(n));
          expect(
            leaked,
            `${arm.label} launch DENIES [${armDenied.join(', ')}] but claude still ` +
              `advertises [${leaked.join(', ')}]. The deny flag has become a silent ` +
              `no-op — the Task->Agent class of failure. Check those names against ` +
              `claude's current catalog: [${catalog.join(', ')}].`,
          ).toEqual([]);
        }

        // DEAD-ENTRY DETECTOR: a denied name absent even from the no-deny catalog
        // denies nothing. Known-inert entries are documented above with reasons;
        // anything NEW here means a name we rely on has moved upstream.
        const unexplained = denied.filter(
          (n) => !catalog.includes(n) && !(n in KNOWN_NOT_ADVERTISED),
        );
        expect(
          unexplained,
          `psu denies [${unexplained.join(', ')}], but claude does not advertise ` +
            `them even with NOTHING denied — so those denies are inert. Either the ` +
            `tool was renamed/removed upstream (update the deny literal) or it is ` +
            `environment-gated (add it to KNOWN_NOT_ADVERTISED with a reason). ` +
            `Current catalog: [${catalog.join(', ')}].`,
        ).toEqual([]);
      },
      240_000,
    );
  },
);
