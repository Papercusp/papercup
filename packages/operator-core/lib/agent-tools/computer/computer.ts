/**
 * capability:computer — bee-operated desktop control.
 *
 * A THIN wrapper (parity with capability:bash — wraps real execution, no
 * reimplementation) over the pure `desktop-driver` planner: it executes the
 * planned `xdotool` input / `import` capture against the agent's LEASED SANDBOX
 * display and returns a screenshot as an MCP image content block (gate #1 — a
 * raw ToolResult `{ content:[{type:'image',…}] }` passes through the dispatcher
 * untouched, so the bee's model SEES the screen).
 *
 * The bee's own agent runtime is the loop (screenshot → reason → act → repeat);
 * this tool is only the eyes + hands + safety catch. The canonical Anthropic
 * `computer` action vocabulary is mirrored verbatim so Claude's trained grounding
 * priors fire.
 *
 * SAFETY: the target display is resolved SERVER-SIDE from the per-agent lease
 * env (`PAPERCUSP_COMPUTER_DISPLAY`), NEVER from the model's args, and the host
 * display `:0` is hard-refused. A bee with no leased desktop gets a loud error,
 * not a fallback — deny-by-default (the whole point of sandboxing computer use).
 *
 * Phase 1 of computer-tool-plan: the display lease is read from env; Phase 2
 * provisions the sandbox desktop + writes the lease. Not live until deployed.
 */

import { spawn } from 'node:child_process';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import {
  assertSandboxDisplay,
  captureCommand,
  planAction,
  xdotoolCommand,
  type ComputerActionInput,
  type DesktopTarget,
} from './desktop-driver';
import { hiveDesktop } from './desktop-lease';

/** The canonical computer-use resolution (best model grounding accuracy). */
const DEFAULT_W = 1024;
const DEFAULT_H = 768;
const EXEC_TIMEOUT_MS = 15_000;

export interface ComputerExecResult {
  status: number | null;
  stdout: Buffer;
  stderr: string;
}

/** Injectable exec seam (overridden in tests so the handler runs with no live X). */
export type ComputerExec = (
  bin: string,
  args: string[],
  opts: { env?: Record<string, string>; signal?: AbortSignal },
) => Promise<ComputerExecResult>;

const realExec: ComputerExec = (bin, args, opts) =>
  new Promise((resolveExec, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...(opts.env ?? {}) },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), EXEC_TIMEOUT_MS);
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolveExec({ status, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() });
    });
  });

let execImpl: ComputerExec = realExec;
/** Test seam — swap the executor. Call `__resetComputerExec()` in afterEach. */
export function __setComputerExecForTests(next: ComputerExec): void {
  execImpl = next;
}
export function __resetComputerExec(): void {
  execImpl = realExec;
}

/** The per-caller identity the resolver needs (a slice of the MCP ToolContext). */
export interface ComputerCtx {
  signal?: AbortSignal;
  /** The caller's harness slug == the hive home-harness slug for a fleet bee. */
  harnessSlug?: string | null;
}

/**
 * Resolve the agent's leased SANDBOX display — SERVER-SIDE only. NEVER from the
 * model's args (a model must not be able to name `:0`), and `:0` is always refused.
 *
 * Resolution order (computer-tool-plan open-Q#2 — "where the per-bee display binding
 * lives in ctx"):
 *   1. PRIMARY — the CALLER'S HIVE in-process desktop lease, keyed by `ctx.harnessSlug`.
 *      This is the operative path for a fleet bee: its capability:computer call lands at
 *      the operator's `/api/mcp`, so the handler runs in the OPERATOR process and the
 *      bee's spawn-env never reaches it — but `ensureHiveDesktop` stores the lease in
 *      THIS process's Map, and `ctx.harnessSlug` identifies the caller's hive. So the
 *      right display is found here regardless of which bee called.
 *   2. FALLBACK — a display in THIS process's env, for the direct / SU / dev path and a
 *      single-tenant (per-frame) operator. `PAPERCUSP_COMPUTER_DISPLAY` is the explicit
 *      provisioner marker; `PAPERCUSP_AGENT_DISPLAY` is the frame per-slot lease marker
 *      (`acquireAgentDisplay`). BOTH are deliberate capability markers — never raw
 *      `DISPLAY`, which can leak a dev box's own `:0` session.
 */
function resolveBoundDisplay(ctx: ComputerCtx): DesktopTarget {
  // 1. The caller's hive lease (operator-process Map).
  const hive = (ctx.harnessSlug ?? '').trim();
  if (hive) {
    const leased = hiveDesktop(hive);
    if (leased) {
      assertSandboxDisplay(leased.display); // belt-and-suspenders: a lease is never :0
      return { display: leased.display, width: leased.width, height: leased.height };
    }
  }
  // 2. Process-env fallback (direct/SU/dev + frame per-slot marker).
  const display = (process.env.PAPERCUSP_COMPUTER_DISPLAY ?? process.env.PAPERCUSP_AGENT_DISPLAY ?? '').trim();
  if (!display) {
    throw new Error(
      'capability:computer — no sandbox desktop is leased to this agent. A desktop must be ' +
        'provisioned (a leased Xvfb/VNC display) for this hive before the agent can operate it. ' +
        '(Refusing to default to any display — the host :0 is never operable.)',
    );
  }
  assertSandboxDisplay(display); // throws on :0 / malformed
  const w = Number(process.env.PAPERCUSP_COMPUTER_WIDTH) || DEFAULT_W;
  const h = Number(process.env.PAPERCUSP_COMPUTER_HEIGHT) || DEFAULT_H;
  return { display, width: w, height: h };
}

/** Capture the sandbox screen → an MCP image content block (base64 PNG). */
async function screenshot(target: DesktopTarget, signal?: AbortSignal): Promise<{ type: 'image'; data: string; mimeType: string }> {
  const cap = captureCommand(target);
  const r = await execImpl(cap.bin, cap.args, { signal });
  if (!r.stdout || r.stdout.length < 8 || r.stdout.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`capability:computer — screenshot capture failed (exit ${r.status}): ${r.stderr.slice(0, 200)}`);
  }
  return { type: 'image', data: r.stdout.toString('base64'), mimeType: 'image/png' };
}

const computerArgs = z.object({
  action: z
    .enum([
      'screenshot', 'cursor_position', 'mouse_move',
      'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
      'left_click_drag', 'left_mouse_down', 'left_mouse_up',
      'type', 'key', 'hold_key', 'scroll', 'wait',
    ])
    .describe('The computer-use action (canonical Anthropic vocabulary).'),
  coordinate: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe('[x, y] in the screenshot\'s pixel space — for move/click-at/drag/scroll-at.'),
  text: z.string().optional().describe('For `type` (text to type) and `key`/`hold_key` (an xdotool keysym/chord, e.g. "Return", "ctrl+s").'),
  scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('For `scroll`.'),
  scroll_amount: z.number().int().positive().optional().describe('For `scroll` — wheel clicks (default 3).'),
  duration: z.number().positive().optional().describe('For `wait`/`hold_key` — seconds.'),
});

export type ComputerArgs = z.infer<typeof computerArgs>;

interface ComputerToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}

/**
 * The capability:computer handler — extracted + exported so it unit-tests
 * directly (with an injected exec seam) without the dispatch layer or a live X.
 */
export async function runComputerAction(
  args: ComputerArgs,
  ctx: ComputerCtx = {},
): Promise<ComputerToolResult> {
  const target = resolveBoundDisplay(ctx); // throws loudly if no lease / refuses :0
  const signal = ctx.signal;
  const input = args as ComputerActionInput;
  const plan = planAction(input, target);

  if (plan.kind === 'screenshot') {
    return { content: [await screenshot(target, signal)] };
  }

  if (plan.kind === 'cursor_position') {
    const r = await execImpl('xdotool', ['getmouselocation', '--shell'], { env: { DISPLAY: target.display }, signal });
    return { content: [{ type: 'text', text: r.stdout.toString().trim() || `exit ${r.status}` }] };
  }

  if (plan.kind === 'wait') {
    await new Promise((r) => setTimeout(r, plan.ms));
    return { content: [{ type: 'text', text: `waited ${plan.ms}ms` }, await screenshot(target, signal)] };
  }

  // xdotool input action → execute, then auto-screenshot so the bee sees the effect.
  const cmd = xdotoolCommand(plan, target);
  const r = await execImpl(cmd.bin, cmd.args, { env: cmd.env, signal });
  if (r.status !== 0) {
    return {
      isError: true,
      content: [{ type: 'text', text: `capability:computer — ${input.action} failed (exit ${r.status}): ${r.stderr.slice(0, 300)}` }],
    };
  }
  return { content: [{ type: 'text', text: `did ${input.action}` }, await screenshot(target, signal)] };
}

export default defineTool({
  name: 'capability:computer',
  description:
    'Operate a sandboxed desktop (GUI) — screenshot, click, type, key, scroll — using the canonical computer-use action vocabulary. Returns a screenshot image after each action so you can see the result. ONLY for genuinely visual/GUI steps: for anything scriptable (files, CLIs, APIs) prefer capability:bash, and for web pages prefer a browser tool — both are faster and more reliable than pixel-clicking.',
  guidance: {
    when: 'A task needs a GUI app that has no CLI/API — clicking buttons, reading what is on screen, operating a desktop program. Call `screenshot` first to see, then act on what you see.',
    notWhen:
      'Anything scriptable (create files, run a program, hit an API) → capability:bash. A web page → a browser tool (DOM automation is more reliable + cheaper than pixel-clicking). Never use this to operate the host machine — it only drives the agent\'s leased sandbox desktop.',
    chaining: 'screenshot → inspect the image → left_click/type/key at the coordinates you see → screenshot to confirm. Repeat.',
  },
  capability: 'capability:computer',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  timeoutSec: 30,
  args: computerArgs,
  handler: (args, ctx) => runComputerAction(args, ctx as ComputerCtx),
});
