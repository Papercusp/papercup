/**
 * MODEL pill (WI-6510 / hud-chat-owner-controls-2026-08-11 P-002).
 *
 * These cases are the plan's decisions made falsifiable, not a coverage pass.
 * The ones that would otherwise be discovered live, on a real session:
 *   • UNKNOWN launch argv renders no pill, and is NOT the same as "no model"
 *     (D-005 §5) — the two absences mean different things and the surface has
 *     already tried to collapse them once;
 *   • the effort tail survives into the POSTED spec (D-007) — the silent-drop
 *     trap, which is invisible in any test that only asserts a model name;
 *   • the write FORKS rather than resuming in place — a plain resume collides
 *     with the still-live session the popup is attached to (WI-3882);
 *   • a colon-bearing model id is not mistaken for an effort tail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChatModeAction } from './registry';
import { modelOptions, readModelSpec } from './ModelActions';
import type { ChatActionContext, ChatModeAction, ChatModeOption } from './types';

const fetchSyncQueryMock = vi.fn();
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  fetchSyncQuery: (...args: unknown[]) => fetchSyncQueryMock(...args) as unknown,
}));

// Side-effect import — registers the axis, exactly as lib/chat-actions/index.ts
// does. (That barrel line is the WI-6450 trap: without it the axis is
// tree-shaken out and the pill never renders.)
import './ModelActions';

const OWNER = 'su-abc123';
const SESSION = 'sess-0001';
const fetchMock = vi.fn();

function axis(): ChatModeAction {
  const a = getChatModeAction('mode-model');
  if (!a) throw new Error('mode-model is not registered');
  return a;
}

/** ctx as the chat modal builds it: a claude session with a resolved id, plus
 *  whatever launch argv the roster row carried. */
function ctxWith(launchArgv: unknown): ChatActionContext {
  return { sessionOwnerId: OWNER, agent: 'claude', sessionId: SESSION, launchArgv };
}

async function optionsOf(ctx: ChatActionContext): Promise<ChatModeOption[]> {
  return await axis().options(ctx);
}

/** The body of the single POST the axis made. */
function postedBody(): Record<string, unknown> {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
  return JSON.parse(init.body) as Record<string, unknown>;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'ok' }) });
  vi.stubGlobal('fetch', fetchMock);
  fetchSyncQueryMock.mockReset();
  fetchSyncQueryMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ModelActions — registration + shape', () => {
  it('registers ONE searchable axis in the config group, capped MODEL', () => {
    const a = axis();
    expect(a.cap).toBe('MODEL');
    expect(a.group).toBe('config');
    expect(a.searchable).toBe(true);
  });

  it('is reachable through the BARREL, not just by importing this module directly', async () => {
    /*
     * The WI-6450 trap, and the one thing the rest of this file cannot catch:
     * every other case here passes because the side-effect import at the TOP of
     * this file registers the axis. That proves the module registers ITSELF — it
     * says nothing about whether `lib/chat-actions/index.ts` imports it. If that
     * one line is missing or "tidied" away, the axis is tree-shaken out and the
     * pill never renders, while this whole suite stays green.
     *
     * ⚠ It has to be done in a FRESH module graph, and the obvious way is wrong:
     * resetting the shared registry and re-importing the barrel proves nothing,
     * because ES modules are cached — ModelActions' body would not re-run (this
     * file already imported it), so the axis would read as MISSING even when the
     * barrel imports it correctly. That false alarm also wipes the registry for
     * every other case here. `vi.resetModules()` instead gives the barrel a new
     * registry instance to populate, and leaves the shared one alone.
     */
    vi.resetModules();
    const freshRegistry = await import('./registry');
    await import('./index');
    expect(freshRegistry.listAllChatModeActionIds()).toContain('mode-model');
  });
});

describe('availability — the two absences are not the same (D-005 §5)', () => {
  it('renders NO pill when the roster row carries no launchArgv at all (UNKNOWN)', () => {
    // The value is unsourced, so a plausible guess is worse than the gap.
    expect(readModelSpec(ctxWith(undefined))).toBeUndefined();
    expect(axis().available(ctxWith(undefined))).toBe(false);
  });

  it('renders NO pill for an EMPTY argv — no launch record is not "no model"', () => {
    // adv-roster's active tier is `launchArgv: adv?.launchArgv ?? []`, so a
    // session with no adv_sessions row arrives as []. Every real launch record
    // is non-empty (argv[0] is the binary), so [] is evidence of nothing —
    // reporting "default" here would describe a launch we never saw.
    expect(readModelSpec(ctxWith([]))).toBeUndefined();
    expect(axis().available(ctxWith([]))).toBe(false);
  });

  it('DOES render a pill for a real launch record that names no model', () => {
    const argv = ['psu', '--no-picker', '--agent=claude', '--auto'];
    expect(readModelSpec(ctxWith(argv))).toBeNull();
    expect(axis().available(ctxWith(argv))).toBe(true);
    expect(axis().current(ctxWith(argv)).on).toBe(false);
    expect(axis().current(ctxWith(argv)).value).toBe('default');
  });

  it('is unavailable on a non-claude backend, where the flag would be refused', () => {
    expect(axis().available({ ...ctxWith(['psu', '--model=sonnet']), agent: 'omp' })).toBe(false);
  });

  it('is unavailable with no resumable session id — there is nothing to branch from', () => {
    expect(axis().available({ sessionOwnerId: OWNER, agent: 'claude', launchArgv: [] })).toBe(false);
  });
});

describe('current() — reports the EFFECTIVE spec off the launch argv (D-009 §B)', () => {
  /*
   * `adv_sessions.launch_argv` has TWO real shapes and this control must read
   * both. The fixtures below are copied from live rows rather than invented,
   * because the difference is not cosmetic: the SECOND shape is the one this
   * control's own fork writes, so getting it wrong makes the pill report
   * "default" for a session it just put on opus.
   */
  it('reads a model+effort spec from TOKENIZED argv (every psu/fleet launch)', () => {
    const st = axis().current(
      ctxWith(['psu', '--no-picker', '--agent=claude', '--model=opus[1m]:high', '--auto']),
    );
    expect(st.value).toBe('opus[1m]:high');
    expect(st.on).toBe(true);
    expect(st.title).toContain('high effort');
  });

  it('reads it from a recorded GREETING COMMAND, quotes and all (what a fork records)', () => {
    // Live shape: ["gnome-terminal", "echo \"resuming …\"; exec psu --resume=<id> …"].
    // The emitter single-quotes the spec, so the quotes must not survive into
    // the displayed value.
    const st = axis().current(
      ctxWith([
        'gnome-terminal',
        `echo "resuming plan-run 74af9bce…"; exec psu --resume=74af9bce --fork --model='opus[1m]:high'`,
      ]),
    );
    expect(st.value).toBe('opus[1m]:high');
    expect(st.on).toBe(true);
  });

  it('still reports the default when a greeting carries no --model', () => {
    const st = axis().current(
      ctxWith(['gnome-terminal', `echo "resuming x…"; exec psu --resume=74af9bce --fork`]),
    );
    expect(st.value).toBe('default');
    expect(st.on).toBe(false);
  });

  it('does NOT mistake a colon inside a model id for an effort tail', () => {
    // `anthropic.claude-3-5-sonnet-v2:0` is one model name; `0` is not an effort.
    const st = axis().current(ctxWith(['psu', '--model=anthropic.claude-3-5-sonnet-v2:0']));
    expect(st.value).toBe('anthropic.claude-3-5-sonnet-v2:0');
    expect(st.title).toContain('model default effort');
  });
});

describe('options() — the tier menu', () => {
  it('falls back to the built-in tiers when the workspace defines none', async () => {
    fetchSyncQueryMock.mockResolvedValue([]);
    const opts = await optionsOf(ctxWith([]));
    expect(opts.length).toBeGreaterThan(0);
    // Every row's id is a whole composed spec — never a bare model or effort.
    for (const o of opts) expect(o.id.length).toBeGreaterThan(0);
  });

  it('is LAZY — no tier query is issued just to render the pill', () => {
    axis().current(ctxWith([]));
    axis().available(ctxWith([]));
    expect(fetchSyncQueryMock).not.toHaveBeenCalled();
  });

  it('surfaces the tier\'s user-authored `when` line as the hint', () => {
    const opts = modelOptions([{ name: 'deep', spec: 'opus[1m]:high', when: 'architectural work' }]);
    expect(opts[0].hint).toBe('architectural work');
    expect(opts[0].label).toContain('deep');
    expect(opts[0].label).toContain('high effort');
  });
});

describe('set() — the write (D-007 + WI-3882)', () => {
  it('POSTS the COMPOSED spec, effort tail intact', async () => {
    await axis().set(ctxWith([]), 'opus[1m]:high');
    const body = postedBody();
    // The whole point of D-007: effort rides the model spec. A separate
    // `--effort` would be dropped by psu's parseArgs without erroring, so a
    // control that split them here would pass a naive test and change nothing.
    expect(body.resumeModel).toBe('opus[1m]:high');
    expect(body).not.toHaveProperty('effort');
  });

  it('FORKS rather than resuming in place', async () => {
    await axis().set(ctxWith([]), 'sonnet[1m]');
    const body = postedBody();
    // The popup is attached to a live session; two processes resuming one
    // session id collide, which is exactly what --fork-session exists to avoid.
    expect(body.fork).toBe(true);
    expect(body.resumeSessionId).toBe(SESSION);
  });

  it('THROWS when the launch is refused, rather than reporting a silent success', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'model changes need a claude backend' }) });
    await expect(axis().set(ctxWith([]), 'sonnet[1m]')).rejects.toThrow(/claude backend/);
  });

  it('refuses the reported-only default row instead of posting a model-less launch', async () => {
    await expect(axis().set(ctxWith([]), '__backend-default')).rejects.toThrow(/pick a specific model/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
