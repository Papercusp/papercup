/**
 * desktop-driver.ts — the pure I/O driver behind `capability:computer`
 * (bee-operated desktop control).
 *
 * It translates the CANONICAL Anthropic `computer` action vocabulary
 * (`computer_20250124`) into `xdotool` argv + a screen-capture command, against
 * a SANDBOX X display — NEVER the host `:0`. The model was post-trained on this
 * exact action set, so mirroring it (rather than inventing a vocabulary) keeps
 * Claude's grounding priors intact.
 *
 * This module is FRAMEWORK-INDEPENDENT on purpose: no MCP / tooldef imports, so
 * the action→argv planning unit-tests without a live display or the agent
 * runtime. The `defineTool` wrapper (computer.ts) executes the planned action
 * and adapts a screenshot into a `ToolResult` image content block (gate #1 —
 * `{ type:'image', data, mimeType }` passes through the dispatcher untouched).
 *
 * Mechanics proven on the box 2026-06-18: Xvfb :99 + xdotool input +
 * `import -window root` → PNG 1024×768 → base64 (the screenshot ToolResult payload).
 */

/** The canonical computer-use action set (Anthropic `computer_20250124`). */
export type ComputerAction =
  | 'screenshot'
  | 'cursor_position'
  | 'mouse_move'
  | 'left_click'
  | 'right_click'
  | 'middle_click'
  | 'double_click'
  | 'triple_click'
  | 'left_click_drag'
  | 'left_mouse_down'
  | 'left_mouse_up'
  | 'type'
  | 'key'
  | 'hold_key'
  | 'scroll'
  | 'wait';

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/** The argument bag for one action (mirrors the canonical tool's input shape). */
export interface ComputerActionInput {
  action: ComputerAction;
  /** [x, y] in the display's pixel space. Required for move/click-at/drag/scroll-at. */
  coordinate?: [number, number];
  /** For `type` (a string to type) and `key`/`hold_key` (an xdotool keysym/chord, e.g. "Return", "ctrl+s"). */
  text?: string;
  /** For `scroll`. */
  scroll_direction?: ScrollDirection;
  /** For `scroll` — number of wheel clicks (default 3). */
  scroll_amount?: number;
  /** For `wait`/`hold_key` — seconds. */
  duration?: number;
}

/** The sandbox display the actions run against. NEVER the host `:0`. */
export interface DesktopTarget {
  /** X display, e.g. ":99". */
  display: string;
  /** Logical width (the canonical computer-use default is 1024). */
  width: number;
  /** Logical height (768). */
  height: number;
}

/** xdotool wheel buttons: 4 up, 5 down, 6 left, 7 right. */
const SCROLL_BUTTON: Record<ScrollDirection, string> = { up: '4', down: '5', left: '6', right: '7' };

/**
 * Hard safety guard: refuse to drive the host display. A bee's desktop actions
 * must ALWAYS target its leased sandbox display — operating `:0` would let it
 * click around the operator's real machine (the live Papercusp fleet). This is
 * the load-bearing invariant of the whole capability (deny-by-default).
 */
export function assertSandboxDisplay(display: string): void {
  const d = (display ?? '').trim();
  if (!d || !/^:\d+(\.\d+)?$/.test(d)) {
    throw new Error(`capability:computer — invalid display ${JSON.stringify(display)} (expected ":<n>")`);
  }
  if (d === ':0' || d === ':0.0') {
    throw new Error('capability:computer — refusing to operate the HOST display :0 (sandbox display required)');
  }
}

/** Validate + normalize a coordinate against the target bounds. */
function coord(input: ComputerActionInput, target: DesktopTarget): [number, number] {
  if (!input.coordinate) throw new Error(`capability:computer — action '${input.action}' requires a coordinate`);
  const [x, y] = input.coordinate;
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('capability:computer — non-finite coordinate');
  // Clamp into the display so a hallucinated coordinate can't escape the screen.
  const cx = Math.max(0, Math.min(Math.round(x), target.width - 1));
  const cy = Math.max(0, Math.min(Math.round(y), target.height - 1));
  return [cx, cy];
}

/** A planned action — what the executor must do. Pure output of `planAction`. */
export type PlannedAction =
  | { kind: 'xdotool'; args: string[] }
  | { kind: 'screenshot' }
  | { kind: 'cursor_position' }
  | { kind: 'wait'; ms: number };

/**
 * Translate one `ComputerActionInput` into a `PlannedAction` (pure). The returned
 * `xdotool` args do NOT include the `xdotool` binary or the `DISPLAY` env — the
 * executor supplies those (binding `DISPLAY` to the sandbox target).
 */
export function planAction(input: ComputerActionInput, target: DesktopTarget): PlannedAction {
  switch (input.action) {
    case 'screenshot':
      return { kind: 'screenshot' };
    case 'cursor_position':
      return { kind: 'cursor_position' };
    case 'wait': {
      const secs = typeof input.duration === 'number' && input.duration > 0 ? input.duration : 1;
      return { kind: 'wait', ms: Math.min(secs, 30) * 1000 };
    }
    case 'mouse_move': {
      const [x, y] = coord(input, target);
      return { kind: 'xdotool', args: ['mousemove', '--sync', String(x), String(y)] };
    }
    case 'left_click':
    case 'right_click':
    case 'middle_click': {
      const button = input.action === 'left_click' ? '1' : input.action === 'middle_click' ? '2' : '3';
      const args: string[] = [];
      if (input.coordinate) {
        const [x, y] = coord(input, target);
        args.push('mousemove', '--sync', String(x), String(y));
      }
      args.push('click', button);
      return { kind: 'xdotool', args };
    }
    case 'double_click':
    case 'triple_click': {
      const repeat = input.action === 'double_click' ? '2' : '3';
      const args: string[] = [];
      if (input.coordinate) {
        const [x, y] = coord(input, target);
        args.push('mousemove', '--sync', String(x), String(y));
      }
      args.push('click', '--repeat', repeat, '--delay', '120', '1');
      return { kind: 'xdotool', args };
    }
    case 'left_mouse_down':
      return { kind: 'xdotool', args: ['mousedown', '1'] };
    case 'left_mouse_up':
      return { kind: 'xdotool', args: ['mouseup', '1'] };
    case 'left_click_drag': {
      const [x, y] = coord(input, target);
      // Press at current position, drag to the target, release.
      return { kind: 'xdotool', args: ['mousedown', '1', 'mousemove', '--sync', String(x), String(y), 'mouseup', '1'] };
    }
    case 'type': {
      if (typeof input.text !== 'string') throw new Error("capability:computer — 'type' requires text");
      return { kind: 'xdotool', args: ['type', '--clearmodifiers', '--', input.text] };
    }
    case 'key': {
      if (!input.text) throw new Error("capability:computer — 'key' requires text (an xdotool keysym/chord)");
      return { kind: 'xdotool', args: ['key', '--clearmodifiers', '--', input.text] };
    }
    case 'hold_key': {
      if (!input.text) throw new Error("capability:computer — 'hold_key' requires text");
      const secs = typeof input.duration === 'number' && input.duration > 0 ? Math.min(input.duration, 10) : 1;
      // keydown, (executor waits `duration`), keyup — encoded as a down+up pair the
      // executor sequences with the wait. We model it as keydown here; the wrapper
      // schedules the matching keyup after the hold.
      return { kind: 'xdotool', args: ['keydown', '--clearmodifiers', '--', input.text, 'sleep', String(secs), 'keyup', '--clearmodifiers', '--', input.text] };
    }
    case 'scroll': {
      const dir = input.scroll_direction ?? 'down';
      const button = SCROLL_BUTTON[dir];
      const amount = Math.max(1, Math.min(Math.round(input.scroll_amount ?? 3), 100));
      const args: string[] = [];
      if (input.coordinate) {
        const [x, y] = coord(input, target);
        args.push('mousemove', '--sync', String(x), String(y));
      }
      args.push('click', '--repeat', String(amount), button);
      return { kind: 'xdotool', args };
    }
    default: {
      const never: never = input.action;
      throw new Error(`capability:computer — unsupported action ${String(never)}`);
    }
  }
}

/**
 * The screen-capture command for a target display. ImageMagick `import -window
 * root` (proven on the box) → PNG on stdout. The executor runs this and
 * base64-encodes the bytes into the image `ToolResult`.
 */
export function captureCommand(target: DesktopTarget): { bin: string; args: string[] } {
  assertSandboxDisplay(target.display);
  // `-silent` suppresses the bell; `png:-` writes PNG to stdout.
  return { bin: 'import', args: ['-display', target.display, '-silent', '-window', 'root', 'png:-'] };
}

/** The full `xdotool` invocation for a planned xdotool action, with DISPLAY bound. */
export function xdotoolCommand(plan: Extract<PlannedAction, { kind: 'xdotool' }>, target: DesktopTarget): {
  bin: string;
  args: string[];
  env: { DISPLAY: string };
} {
  assertSandboxDisplay(target.display);
  return { bin: 'xdotool', args: plan.args, env: { DISPLAY: target.display } };
}
