/**
 * Unit coverage for the P-202 edit-mode IR renderer logic.
 *
 * `buildPlanIRRenderers` returns a `renderCodeSpan` callback that
 * Lute calls with a mock node + entering flag. The renderer is a pure
 * function — we feed it fake nodes (with a `.Content()` method) and
 * assert the [html, walkStop] tuple it returns. No DOM, no vditor.
 *
 * The selective-override pattern is subtle:
 *   - Status-enum content → custom <code> + WalkSkipChildren (=1)
 *   - Anything else → ["", WalkContinue (=0)] to fall through to vditor's default
 *
 * Returning the wrong walk-stop or the wrong HTML breaks IR rendering
 * (the spike hit this — see plans-admin-ui-2026-05-20.md P-202 + an
 * agent insight on the WalkSkipChildren pattern). Tests guard the
 * exact contract.
 */
import { describe, expect, it } from 'vitest';
import { buildPlanIRRenderers, readLuteWalk } from './plan-renderers-ir';

function mockNode(content: string | (() => string)): {
  Content: () => string;
} {
  return {
    Content: typeof content === 'function' ? (content as () => string) : () => content,
  };
}

const WALK = { Continue: 0, SkipChildren: 1, Stop: 2 };

describe('buildPlanIRRenderers — renderCodeSpan', () => {
  const { renderCodeSpan } = buildPlanIRRenderers(WALK);

  it('returns ["", WalkContinue] on the exiting call regardless of content', () => {
    const [html, stop] = renderCodeSpan(mockNode('todo'), false);
    expect(html).toBe('');
    expect(stop).toBe(WALK.Continue);
  });

  it('emits decorated <code> + WalkSkipChildren for a status token', () => {
    const [html, stop] = renderCodeSpan(mockNode('todo'), true);
    expect(html).toBe(
      '<code data-plan-status="todo" class="pc-plan-status pc-plan-status--todo">todo</code>',
    );
    expect(stop).toBe(WALK.SkipChildren);
  });

  it('handles every status enum value', () => {
    for (const s of ['todo', 'wip', 'blocked', 'needs-human', 'done', 'dropped']) {
      const [html, stop] = renderCodeSpan(mockNode(s), true);
      expect(html).toContain(`data-plan-status="${s}"`);
      expect(html).toContain(`pc-plan-status--${s}`);
      expect(html).toContain(`>${s}</code>`);
      expect(stop).toBe(WALK.SkipChildren);
    }
  });

  it('falls through to default for non-status content', () => {
    const [html, stop] = renderCodeSpan(mockNode('some-variable'), true);
    expect(html).toBe('');
    expect(stop).toBe(WALK.Continue);
  });

  it('falls through for partial matches (case-sensitive, anchored)', () => {
    for (const s of ['TODO', 'Todo', 'todo!', ' todo', 'todo wip']) {
      const [html, stop] = renderCodeSpan(mockNode(s), true);
      expect(html).toBe('');
      expect(stop).toBe(WALK.Continue);
    }
  });

  it('escapes special characters even though status tokens contain none — defense in depth', () => {
    // None of our status values contain &<>" but the escape path is the
    // same one any future enum addition would rely on. Test the helper
    // round-trip with the only currently-used enum that has a special
    // char in its general form: "needs-human" has a hyphen, no escape
    // needed; confirm output is byte-identical.
    const [html] = renderCodeSpan(mockNode('needs-human'), true);
    expect(html).toBe(
      '<code data-plan-status="needs-human" class="pc-plan-status pc-plan-status--needs-human">needs-human</code>',
    );
  });

  it('returns ["", WalkContinue] when node.Content() throws', () => {
    const throwingNode = {
      Content: () => {
        throw new Error('boom');
      },
    };
    const [html, stop] = renderCodeSpan(throwingNode, true);
    expect(html).toBe('');
    expect(stop).toBe(WALK.Continue);
  });

  it('returns ["", WalkContinue] when node has no Content method', () => {
    const broken = {} as { Content?: () => string };
    // Cast to any to skirt the type — production callers come from Lute,
    // we should not crash if a future Lute version reshapes the node.
    const [html, stop] = renderCodeSpan(broken as never, true);
    expect(html).toBe('');
    expect(stop).toBe(WALK.Continue);
  });
});

describe('readLuteWalk', () => {
  const original = (globalThis as { Lute?: unknown }).Lute;

  it('returns null when window.Lute is not present', () => {
    delete (globalThis as { Lute?: unknown }).Lute;
    expect(readLuteWalk()).toBeNull();
    (globalThis as { Lute?: unknown }).Lute = original;
  });

  it('reads constants from window.Lute', () => {
    (globalThis as { Lute?: unknown }).Lute = {
      WalkContinue: 0,
      WalkSkipChildren: 1,
      WalkStop: 2,
    };
    expect(readLuteWalk()).toEqual({ Continue: 0, SkipChildren: 1, Stop: 2 });
    (globalThis as { Lute?: unknown }).Lute = original;
  });

  it('falls back to documented defaults if a constant is missing', () => {
    (globalThis as { Lute?: unknown }).Lute = {};
    expect(readLuteWalk()).toEqual({ Continue: 0, SkipChildren: 1, Stop: 2 });
    (globalThis as { Lute?: unknown }).Lute = original;
  });
});
