/**
 * computer:observe + computer:click_element — the accessibility observation path
 * (agent-virtual-desktops-2026-08-23 P-007; D-010).
 *
 * WHY SEPARATE TOOLS AND NOT NEW `capability:computer` ACTIONS. `capability:computer`
 * mirrors the canonical Anthropic `computer_20250124` action vocabulary VERBATIM, and
 * that is load-bearing rather than stylistic: the model was post-trained on that exact
 * action set, so its grounding priors fire on it. Adding `observe` / `click_element`
 * to that enum would make the tool a near-miss of the vocabulary the model knows,
 * which is worse than either a faithful copy or an honestly separate tool. The plan
 * says the tree sits "BESIDE the screenshot path", and this is what beside means.
 *
 * The two are complements, not competitors, and the guidance says so plainly: the tree
 * is cheap and semantic but sees ONLY what the toolkit exports, so a canvas app, a
 * video, or a plain X11 client like `xterm` is invisible to it. The screenshot is the
 * fallback that always works and the tree is the one to reach for first.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  a11yBusFromRootCommand,
  actionCommand,
  buildA11yTree,
  compressA11yTree,
  elementClickPoint,
  estimateImageTokens,
  estimateTextTokens,
  findByRef,
  parseA11yBusAddress,
  parseWalkerOutput,
  renderA11yTree,
  screenBoundsAreTrustworthy,
  walkerCommand,
  NoAccessibilityBusError,
  type A11yActionResult,
} from './accessibility-tree';
import { computerExec, resolveBoundDisplay, type ComputerCtx } from './computer';
import { planAction, xdotoolCommand, type DesktopTarget } from './desktop-driver';

/** Resolve the a11y bus a display advertises, or throw the loud refusal. */
async function resolveBus(display: string, signal?: AbortSignal): Promise<string> {
  const probe = a11yBusFromRootCommand(display);
  const r = await computerExec(probe.bin, probe.args, { env: probe.env, signal });
  const addr = parseA11yBusAddress(r.stdout.toString());
  if (!addr) throw new NoAccessibilityBusError(display);
  return addr;
}

async function walk(target: DesktopTarget, signal?: AbortSignal) {
  const bus = await resolveBus(target.display, signal);
  const cmd = walkerCommand(target.display, bus);
  const r = await computerExec(cmd.bin, cmd.args, { env: cmd.env, signal });
  const parsed = parseWalkerOutput(r.stdout.toString());
  if (!parsed) {
    throw new Error(
      `computer:observe — the accessibility walker produced no result on ${target.display} ` +
        `(exit ${r.status}). ${r.stderr.slice(0, 300)}`.trim(),
    );
  }
  return { bus, parsed };
}

const observeArgs = z.object({
  include_hidden: z.boolean().optional().describe('Include elements the toolkit reports as not on screen (e.g. unopened menus). Default false.'),
  include_bounds: z.boolean().optional().describe('Include each element\'s on-screen box. Default false — you click by #ref, not by coordinate.'),
  max_nodes: z.number().int().positive().max(2000).optional().describe('Cap the elements returned (default 200).'),
});

export async function runObserve(args: z.infer<typeof observeArgs>, ctx: ComputerCtx = {}) {
  const target = await resolveBoundDisplay(ctx);
  const { parsed } = await walk(target, ctx.signal);
  const built = buildA11yTree(parsed.nodes);
  const { roots, stats } = compressA11yTree(built, {
    includeHidden: args.include_hidden ?? false,
    ...(args.max_nodes ? { maxNodes: args.max_nodes } : {}),
  });
  const tree = renderA11yTree(roots, { includeBounds: args.include_bounds ?? false });

  // The comparison the plan asks to measure, computed on the SAME screen, so it is a
  // ratio rather than an absolute claim (see estimate* for why that matters).
  const treeTokens = estimateTextTokens(tree);
  const fit = target.capture ?? { width: target.width, height: target.height };
  const shotTokens = estimateImageTokens(
    Math.min(fit.width, target.width),
    Math.min(fit.height, target.height),
  );

  const header =
    parsed.apps === 0
      ? 'No applications are registered on this desktop\'s accessibility bus. That is NOT the same as ' +
        '"nothing is running": an app only appears here if its toolkit exports accessibility (GTK/Qt do; ' +
        'a plain X11 client like xterm, a canvas app, or a video does not). Take a capability:computer ' +
        'screenshot to see what is actually on screen.'
      : `${parsed.apps} application(s) on the accessibility bus · ${stats.keptNodes} of ${stats.rawNodes} elements shown` +
        `${stats.truncated ? ' (truncated)' : ''} · ~${treeTokens} tokens vs ~${shotTokens} for a screenshot of this desktop` +
        `${!screenBoundsAreTrustworthy(roots) ? '\n⚠ This toolkit reports unusable screen coordinates; click by #ref (computer:click_element), not by pixel.' : ''}`;

  return {
    content: [{ type: 'text' as const, text: parsed.apps === 0 ? header : `${header}\n\n${tree}` }],
  };
}

const clickArgs = z.object({
  ref: z.string().describe('The #ref of the element, exactly as computer:observe printed it (e.g. "0/0/2/1").'),
  action: z.string().optional().describe('Which of the element\'s actions to fire (default: its first). computer:observe does not list these; omit unless a previous error named one.'),
});

export async function runClickElement(args: z.infer<typeof clickArgs>, ctx: ComputerCtx = {}) {
  const target = await resolveBoundDisplay(ctx);
  const bus = await resolveBus(target.display, ctx.signal);
  const cmd = actionCommand(target.display, bus, args.ref, args.action);
  const r = await computerExec(cmd.bin, cmd.args, { env: cmd.env, signal: ctx.signal });
  const parsed = parseWalkerOutput(r.stdout.toString()) as unknown as A11yActionResult | null;

  if (parsed?.ok) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Activated ${parsed.role ?? 'element'}${parsed.name ? ` "${parsed.name}"` : ''} (#${args.ref.replace(/^#/, '')}) via "${parsed.performed}". Call computer:observe again to see the result.`,
        },
      ],
    };
  }

  // No activating action: fall back to a pixel click, but ONLY where the tree's own
  // coordinates are believable. On GTK4/X11 every element reports (0,0) with its real
  // size, so a centre computed there sends every click to the same wrong place — and
  // the screenshot still looks right, which is what makes that failure so expensive.
  const { parsed: walked } = await walk(target, ctx.signal);
  const roots = compressA11yTree(buildA11yTree(walked.nodes), { includeHidden: true }).roots;
  const node = findByRef(roots, args.ref);
  if (!node) {
    throw new Error(
      `computer:click_element — no element #${args.ref.replace(/^#/, '')} on this desktop. ` +
        'Refs are positions in the tree and go stale when the UI changes: call computer:observe again and use a fresh one.',
    );
  }
  if (!screenBoundsAreTrustworthy(roots)) {
    throw new Error(
      `computer:click_element — #${args.ref.replace(/^#/, '')} (${node.role}${node.name ? ` "${node.name}"` : ''}) ` +
        `exposes no activating action${parsed?.actions?.length ? ` (it has: ${parsed.actions.join(', ')} — pass one as \`action\`)` : ''}, ` +
        'and this toolkit reports unusable screen coordinates, so a pixel click cannot be aimed either. ' +
        'Use capability:computer with a screenshot to locate and click it.',
    );
  }
  const [x, y] = elementClickPoint(node, target);
  const plan = planAction({ action: 'left_click', coordinate: [x, y] }, { ...target, capture: undefined });
  if (plan.kind !== 'xdotool') throw new Error('computer:click_element — unexpected plan');
  const clickCmd = xdotoolCommand(plan, target);
  const click = await computerExec(clickCmd.bin, clickCmd.args, { env: clickCmd.env, signal: ctx.signal });
  if (click.status !== 0) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `computer:click_element — pixel-click fallback failed (exit ${click.status}): ${click.stderr.slice(0, 200)}` }],
    };
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: `Clicked ${node.role}${node.name ? ` "${node.name}"` : ''} at (${x}, ${y}) — it exposed no activating action, so this was a pixel click at its centre. Call computer:observe to see the result.`,
      },
    ],
  };
}

export const observeTool = defineTool({
  name: 'computer:observe',
  description:
    'Read the sandbox desktop\'s ACCESSIBILITY TREE — every on-screen element with its role, name, text and state, as compact text. Far cheaper than a screenshot and carries semantics a screenshot cannot (which node is focused, what an entry actually contains). Each interactive element gets a #ref you pass to computer:click_element.',
  guidance: {
    when: 'FIRST, before screenshotting, whenever you need to know what is on a GUI and act on it. It is a fraction of a screenshot\'s tokens per step, and a computer-use loop pays that cost on every step.',
    notWhen:
      'It only sees what the toolkit exports. A canvas/game/video, a PDF or image viewer\'s content, or a plain X11 app (xterm) reports little or nothing — if it returns no applications or a tree that clearly does not match the task, take a capability:computer screenshot. Also use the screenshot when you need to judge LAYOUT or appearance rather than structure.',
    chaining: 'computer:observe → pick an element → computer:click_element { ref } → computer:observe to confirm. Drop to capability:computer for typing, keys, scrolling and anything the tree cannot see.',
    seeAlso: [
      'capability:computer (screenshot + type/key/scroll; the fallback that always works)',
      'computer:click_element (activate an element this tool listed)',
      'computer:provision_desktop (stand up the sandbox desktop first)',
    ],
  },
  capability: 'capability:computer',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  timeoutSec: 45,
  args: observeArgs,
  handler: (args, ctx) => runObserve(args, ctx as ComputerCtx),
});

export const clickElementTool = defineTool({
  name: 'computer:click_element',
  description:
    'Activate an element by the #ref computer:observe gave it — semantically, over the accessibility bus, rather than by clicking pixels. Works on elements that are scrolled out of view or overlapped, and is immune to screenshot scaling.',
  guidance: {
    when: 'To press a button, activate an entry, or toggle a control that computer:observe listed with a #ref.',
    notWhen:
      'Anything the tree cannot see (canvas, video, a plain X11 app) → capability:computer left_click at a coordinate you read off a screenshot. Typing, keys and scrolling are capability:computer too — this tool only activates.',
    chaining: 'computer:observe → computer:click_element { ref } → computer:observe to confirm the result.',
    seeAlso: ['computer:observe (get the refs)', 'capability:computer (type / key / scroll / screenshot)'],
  },
  capability: 'capability:computer',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  timeoutSec: 45,
  args: clickArgs,
  handler: (args, ctx) => runClickElement(args, ctx as ComputerCtx),
});

export default observeTool;
