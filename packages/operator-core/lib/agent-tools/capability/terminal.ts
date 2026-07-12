/**
 * capability:terminal — open a NEW terminal window (or MANY) on the USER'S
 * DESKTOP and run a command in each. The visible-terminal sibling of
 * capability:bash.
 *
 * Two forms:
 *   - single: { command, cwd?, label? }            → one window
 *   - bulk:   { terminals: [{command,cwd?,label?}] } → N windows in ONE call
 * (bulk is the mechanism behind "create a new desktop fleet" — each entry
 * launches one agent terminal; see named-su-agent-fleets-2026-06-29 D-004.)
 *
 * Reuses the maintained console machinery instead of forking a spawner:
 *   buildConsoleEnvelope({ skipMcpJson }) → the base envelope (cwd/env)
 *   spawnConsole({ envelope: {…, greetingCmd} }) → the OS new-window spawn
 * (lib/console-launcher.ts + lib/console-spawn.ts — the same path the global
 * "+" console button uses.)
 *
 * Trust model: identical tier/role gating to capability:bash (arbitrary command,
 * no confirmation). DELIBERATE difference — the whole point is a visible terminal
 * in the user's REAL desktop session, so this runs OUTSIDE the bwrap exec-sandbox
 * that contains capability:bash. Recorded on capability-terminal-tool-2026-06-29.
 *
 * Cross-platform: server-side spawn works on Linux + macOS at this tier — on
 * macOS the operator opens Terminal/iTerm directly (see console-spawn.ts). On
 * Windows the operator runs inside WSL and cannot spawn a Session-1 window
 * itself; `allowDesktopBridge` (WI-3289) relays the spawn to the desktop
 * shell's Tauri `console_launch` command over the sync-bus bridge
 * (console-launch-bridge.ts), so agent-opened terminals work there too —
 * provided the Papercusp desktop window is open (otherwise: a loud timeout).
 *
 * Output is NOT captured — the terminals are interactive and detached. Use
 * capability:bash when you need a command's output / exit code.
 */
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { buildConsoleEnvelope } from '../../console-launcher';
import { spawnConsole } from '../../console-spawn';
import { activeWorkspaceId } from '../../workspace-registry';
import { fleetSlugFromName, getFleetScheme } from '../../agent-fleets-store';
import { fetchPresenceFleet } from '../coordination/presence-fleet';
import { resolveAgentIdentity } from '../coordination/identity';
import type { ColorScheme } from '../../console-color-schemes';

/** Opening more than this many desktop windows in one call is almost certainly a
 *  mistake (and is heavy); cap it. A fleet larger than this should be spawned in
 *  batches. */
const MAX_TERMINALS = 12;

/**
 * named-su-agent-fleets / EI-5835: when the caller passes an explicit `fleet`, a
 * `psu …` launch inside a terminal command should JOIN that fleet — not merely
 * inherit its colour. The `fleet` arg alone is COLOUR-ONLY (it tints the window);
 * fleet MEMBERSHIP comes from psu's own `--fleet=<slug>` flag. Agents repeatedly
 * set `fleet` and forget `--fleet`, so members spawn with `fleetSlug:null` AND miss
 * the launcher's fleet auto-kickoff (they park). Auto-inject `--fleet=<slug>` into a
 * psu command that lacks it so colour and membership can't diverge. Non-psu commands,
 * and commands already carrying `--fleet`, are left untouched.
 */
export function injectFleetArg(
  command: string,
  fleetSlug: string | null,
): { command: string; injected: boolean } {
  if (!fleetSlug) return { command, injected: false };
  if (/(^|\s)--fleet(=|\s|$)/.test(command)) return { command, injected: false };
  // Only a `psu` invocation joins a fleet — match psu as a command token (start of
  // line, or after whitespace / a shell separator), followed by whitespace.
  const psuToken = /(^|[\s&;|(])psu(\s)/;
  if (!psuToken.test(command)) return { command, injected: false };
  return { command: command.replace(psuToken, `$1psu --fleet=${fleetSlug}$2`), injected: true };
}

/**
 * solo-launch-provenance (the EI-5835 pattern, applied to WHO-launched-you): a `psu …`
 * launch spawned from this tool should carry `--launched-by=<caller ownerId>` so
 * bootstrap-su can bake the provenance into the launched session (system prompt +
 * PAPERCUSP_LAUNCHED_BY + an owner-scoped standing fact). Without it a solo-launched
 * agent has NO way to answer "who launched / supervises you" — su-8ab32510
 * (2026-07-03) described its launcher as "an observer who doesn't assign or
 * supervise my work". Auto-inject like `--fleet`; commands already carrying the
 * flag, and non-psu commands, are left untouched. The ownerId is injected into a
 * shell string, so only identity-shaped values are accepted.
 */
export function injectLaunchedByArg(
  command: string,
  launcherOwnerId: string | null,
): { command: string; injected: boolean } {
  if (!launcherOwnerId || !/^[A-Za-z0-9._:-]{1,120}$/.test(launcherOwnerId)) {
    return { command, injected: false };
  }
  if (/(^|\s)--launched-by(=|\s|$)/.test(command)) return { command, injected: false };
  const psuToken = /(^|[\s&;|(])psu(\s)/;
  if (!psuToken.test(command)) return { command, injected: false };
  return {
    command: command.replace(psuToken, `$1psu --launched-by=${launcherOwnerId}$2`),
    injected: true,
  };
}

/**
 * The operator's own base URL, used for the terminal's PAPERCUSP_OPERATOR_URL /
 * API-callback env. `PAPERCUSP_OPERATOR_URL` is commonly set to the full
 * `…/api/mcp` endpoint, so strip that suffix back to the bare origin.
 */
function resolveOperatorBaseUrl(): string {
  const fromEnv = process.env.PAPERCUSP_OPERATOR_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/api\/mcp\/?$/, '').replace(/\/$/, '');
  const port = process.env.PAPERCUSP_HONO_PORT?.trim() || '3070';
  return `http://localhost:${port}`;
}

const terminalSpec = z.object({
  command: z
    .string()
    .min(1)
    .describe('The command to run in this terminal (bash). Runs verbatim, then the terminal drops to an interactive shell.'),
  cwd: z
    .string()
    .optional()
    .describe('Working dir for this terminal (absolute, or relative to the harness project dir).'),
  label: z
    .string()
    .optional()
    .describe('Display label for this terminal (shown in /adv/sessions and the window title).'),
});

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export default defineTool({
  name: 'capability:terminal',
  description:
    "Open a NEW terminal window on the user's desktop and run a command in it — or open MANY at once with `terminals: [...]`. Each command runs, then its terminal drops to an interactive shell (stays open). Use this when the user should SEE / interact with real terminals (a dev server, a REPL, a watch process, an installer, a desktop fleet of agents). For headless execution with captured output, use capability:bash instead.",
  guidance: {
    when: 'Open one or more visible desktop terminals and run commands the user should watch or interact with — a dev server, a REPL/installer, a `tail -f`, or N agent windows at once (pass `terminals: [...]`).',
    notWhen:
      'For headless command execution with captured output / exit code, use capability:bash. This tool returns as soon as the terminals are spawned and CANNOT capture output (they are interactive and detached).',
    chaining:
      'Returns immediately after spawning — it does NOT wait for the commands and has no output channel. Use EITHER `command` (single) or `terminals` (bulk, max 12), not both.',
    seeAlso: [
      'capability:bash (headless execution with captured output / exit code)',
      'fleet:launch-on-plan (spawn desktop fleet members that auto-join + kickoff)',
    ],
  },
  capability: 'capability:terminal',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'cup'],
  args: z.object({
    command: z
      .string()
      .min(1)
      .optional()
      .describe('Single-terminal form: the command to run. Use EITHER `command` or `terminals`.'),
    cwd: z.string().optional().describe('Single-terminal form: working dir (absolute, or relative to the harness project dir).'),
    label: z.string().optional().describe('Single-terminal form: display label for the terminal.'),
    terminals: z
      .array(terminalSpec)
      .min(1)
      .max(MAX_TERMINALS)
      .optional()
      .describe(`Bulk form: open N terminals (one per entry, max ${MAX_TERMINALS}) in a single call. Use EITHER \`command\` or \`terminals\`.`),
    fleet: z
      .string()
      .optional()
      .describe(
        "Optional fleet name or slug — every terminal in this call uses that fleet's permanently-bound color scheme, and any `psu` command in it auto-joins that fleet (--fleet=<slug> injected). When omitted, the tool automatically resolves your OWN presence-fleet (if you are a fleet member) for both color AND `psu` membership (WI-4234) — so a bare `psu ...` spawned by a fleet leader/member joins the caller's fleet by default. Pass an explicit `fleet` to OVERRIDE which fleet a spawned `psu` joins, or to color/join a fleet you are not currently a member of. Prefer `fleet:launch-on-plan` over hand-rolling a fleet spawn here when you can — it also seeds plan/launch-context.",
      ),
  }),
  async handler(args, ctx) {
    // Normalize the single | bulk forms to one items[] list.
    if (args.terminals && args.command) {
      return err('Provide EITHER `command` (single) or `terminals` (bulk), not both.');
    }
    const items = args.terminals ?? (args.command ? [{ command: args.command, cwd: args.cwd, label: args.label }] : []);
    if (items.length === 0) {
      return err('Provide a `command` (single terminal) or `terminals: [...]` (bulk).');
    }

    const workspaceId =
      ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId();
    // Treat the unscoped wildcard like "no harness" (workspace-only launch) —
    // mirrors the workspaceId === '*' guard above. An unscoped su session has
    // harnessSlug '*', which buildConsoleEnvelope would otherwise reject as an
    // "unknown harness slug". (capability-terminal-unscoped-slug-fix-2026-06-30)
    const slug = ctx.harnessSlug && ctx.harnessSlug !== '*' ? ctx.harnessSlug : null;

    // Build the base envelope ONCE (cwd/env), skipping the superuser .mcp.json —
    // this tool runs commands, it does not host an MCP-connected agent console.
    let base;
    try {
      base = await buildConsoleEnvelope({
        workspaceId,
        slug,
        operatorBaseUrl: resolveOperatorBaseUrl(),
        skipMcpJson: true,
      });
    } catch (e: any) {
      return err(`Failed to prepare terminal(s): ${e?.message ?? e}`);
    }

    // solo-launch-provenance: the CALLER is the launcher — resolve once (best-effort)
    // so every psu command spawned here carries `--launched-by=<caller ownerId>`.
    let callerOwnerId: string | null = null;
    try {
      callerOwnerId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      callerOwnerId = null;
    }

    // Resolve the fleet's permanently-bound color scheme AND the fleet a spawned
    // `psu` command should JOIN. Precedence: explicit `fleet` arg → caller's
    // shared_presence fleet_slug → null. Color is cosmetic — a lookup failure
    // must never block the launch. `fleetSlug` drives BOTH the colour lookup
    // AND the `--fleet` membership injection below, so they can never diverge —
    // this now ALSO covers the inferred (no explicit `fleet` arg) case (WI-4234):
    // previously only an explicit `fleet` arg reached injectFleetArg, so a fleet
    // leader/member hand-rolling a bare `psu` spawn via this tool (instead of
    // fleet:launch-on-plan) got fleet-colored windows whose agents never actually
    // JOINED the fleet — no plan/launch-context, and no WI-2185 auto wake-mode
    // pin (which only fires once bootstrap-su sees a real fleetSlug), so the
    // spawned member inherited whatever the GLOBAL wake-mode default was and its
    // leader's steering wakes silently STAGED instead of landing.
    let fleetSlug: string | null = args.fleet ? fleetSlugFromName(args.fleet) : null;
    let scheme: ColorScheme | null = null;
    if (fleetSlug) {
      // Explicit fleet name wins.
      try {
        scheme = await getFleetScheme(workspaceId, fleetSlug);
      } catch {
        scheme = null;
      }
    } else if (callerOwnerId) {
      // Fallback: resolve from the caller's shared_presence fleet_slug so every
      // terminal a fleet member opens inherits their fleet's color (capability-
      // terminal fleet-color-schemes-2026-06-30 P-003) AND membership (WI-4234)
      // without an explicit `fleet` arg.
      try {
        const fleetMap = await fetchPresenceFleet([callerOwnerId]);
        const membership = fleetMap.get(callerOwnerId);
        if (membership?.fleetSlug) {
          fleetSlug = membership.fleetSlug;
          scheme = await getFleetScheme(workspaceId, membership.fleetSlug);
        }
      } catch {
        scheme = null;
      }
    }

    const opened: Array<{
      command: string;
      cwd: string;
      terminal: string;
      pid: number | null;
      display: string | null;
      desktopEnvResolvedVia: 'operator-env' | 'active-seat' | 'socket-scan' | null;
    }> = [];
    const failed: Array<{ command: string; error: string; code: number }> = [];

    let fleetInjected = false;
    let launchedByInjected = false;
    // Spawn all windows CONCURRENTLY: spawnConsole is async since WI-1886 (it
    // watches each child for an early off-screen death) — serializing N spawns
    // would stack N probe windows.
    const results = await Promise.all(
      items.map(async (item) => {
        const cwd = item.cwd
          ? isAbsolute(item.cwd)
            ? item.cwd
            : resolvePath(base.cwd, item.cwd)
          : base.cwd;
        // With an explicit `fleet`, a psu launch JOINS it (membership), not just colour.
        const fleetInj = injectFleetArg(item.command, fleetSlug);
        // solo-launch-provenance: every psu launch carries WHO launched it.
        const provInj = injectLaunchedByArg(fleetInj.command, callerOwnerId);
        const command = provInj.command;
        // Override the greeting per terminal (runs the command, then drops to a shell).
        const result = await spawnConsole({
          envelope: { ...base, greetingCmd: command, cwd },
          label: item.label ?? null,
          writeMcpJson: false,
          scheme,
          // WI-3289: on a Windows desktop host, relay to the desktop shell's
          // Tauri console_launch instead of hard-501ing the agent.
          allowDesktopBridge: true,
        });
        return { command, cwd, injected: fleetInj.injected, provenanceInjected: provInj.injected, result };
      }),
    );
    for (const r of results) {
      if (r.injected) fleetInjected = true;
      if (r.provenanceInjected) launchedByInjected = true;
      if (r.result.status === 'ok') {
        opened.push({
          command: r.command,
          cwd: r.cwd,
          terminal: r.result.terminal,
          pid: r.result.pid,
          display: r.result.display,
          desktopEnvResolvedVia: r.result.desktopEnvResolvedVia,
        });
      } else {
        failed.push({ command: r.command, error: r.result.error, code: r.result.code });
      }
    }

    const lines: string[] = [];
    if (opened.length) {
      const schemeNote = scheme
        ? args.fleet
          ? ` (fleet scheme: ${scheme.name})`
          : ` (fleet scheme: ${scheme.name} — from your presence fleet)`
        : '';
      lines.push(`Opened ${opened.length} terminal${opened.length > 1 ? 's' : ''}${schemeNote}:`);
      for (const o of opened) {
        const displayNote = o.display ? ` [DISPLAY=${o.display}]` : '';
        lines.push(`  • ${o.terminal} (pid ${o.pid ?? '?'}) in ${o.cwd}${displayNote} — ${o.command}`);
      }
      // EI-8289: a socket-scan placement means no real logged-in seat was found —
      // the window MAY have landed on a virtual/sandbox display instead of the
      // owner's real desktop. Disclose this loudly instead of reporting a bare
      // "opened" that silently strands the owner's supervision.
      if (opened.some((o) => o.desktopEnvResolvedVia === 'socket-scan')) {
        lines.push(
          '  ⚠ no active login seat was detected (who) — the DISPLAY above was picked by a raw X11 ' +
            'socket scan and MAY be a virtual/sandbox display rather than your real desktop (EI-8289). ' +
            'If you cannot see the window(s), tell me and I will re-check `who` / your active seat.',
        );
      }
      if (fleetInjected) {
        lines.push(
          `  ↳ auto-added \`--fleet=${fleetSlug}\` to psu launch(es) so the spawned agents JOIN the fleet (membership, not just colour). EI-5835.`,
        );
      }
      if (launchedByInjected) {
        lines.push(
          `  ↳ auto-added \`--launched-by=${callerOwnerId}\` to psu launch(es) — the spawned agents know YOU launched + supervise them (system prompt + standing fact).`,
        );
      }
    }
    if (failed.length) {
      lines.push(`${failed.length} failed:`);
      for (const f of failed) lines.push(`  • ${f.command} — ${f.error}`);
      if (failed.some((f) => f.code === 501 || f.error.includes('desktop-bridge'))) {
        lines.push(
          '(On Windows the spawn is relayed to the desktop shell via the sync-bus bridge (WI-3289) — the Papercusp desktop window must be OPEN for the relay to land. macOS + Linux spawn server-side directly.)',
        );
      }
    }
    lines.push(
      'Terminals stay open as interactive shells after their command; output is NOT captured — use capability:bash if you need results.',
    );

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      isError: opened.length === 0,
    };
  },
});
