import { describe, it, expect, vi } from 'vitest';
import { dispatchPaletteTarget, paletteInvokeGuard } from './invoke';
import { paletteEligibility } from './safety-filter';
import type { Capability } from './types';

const base: Capability = {
  id: 't:x', title: 'X', description: 'x', runsIn: 'server', requiresArgs: false, tier: 'low', gating: {},
};

describe('paletteInvokeGuard', () => {
  it('allows a plain low-risk server capability', () => {
    expect(paletteInvokeGuard(base, false)).toEqual({ allow: true, cap: base });
  });

  it('refuses excluded capabilities (streaming/interactive/required-arg) — server-side, regardless of confirm', () => {
    for (const bad of [
      { ...base, requiresArgs: true },
      { ...base, streaming: true },
      { ...base, interactive: true },
    ]) {
      const g = paletteInvokeGuard(bad, true /* even with confirm */);
      expect(g.allow).toBe(false);
      if (!g.allow) {
        expect(g.status).toBe(403);
        expect(g.code).toBe('not_palette_eligible');
      }
    }
  });

  it('requires confirmation for destructive / high-risk', () => {
    const dest = { ...base, destructive: true };
    const g = paletteInvokeGuard(dest, false);
    expect(g.allow).toBe(false);
    if (!g.allow) {
      expect(g.status).toBe(409);
      expect(g.code).toBe('confirmation_required');
    }
    // …but proceeds once confirmed.
    expect(paletteInvokeGuard(dest, true).allow).toBe(true);
    expect(paletteInvokeGuard({ ...base, tier: 'high' }, true).allow).toBe(true);
  });

  it('a browser capability without a palette annotation is excluded', () => {
    expect(paletteInvokeGuard({ ...base, runsIn: 'browser' }, true).allow).toBe(false);
  });
});

/**
 * Regression: every pause/resume control in the Blender, Docs and Agents panes
 * was refused before dispatch. Those panes call `routines:set` through
 * /api/agent-mcp/run-tool with a full, hard-coded argument payload, but the
 * guard excluded the tool merely for HAVING a required arg (`name`) — a rule
 * that exists because the keystroke palette cannot PROMPT for args, which has
 * nothing to do with a caller that already supplied them. Net effect: the
 * surface built so the owner could stop token-spending cron agents could not
 * stop a single one (owner report 2026-07-25).
 */
describe('paletteInvokeGuard — a caller that supplies its own args', () => {
  const needsArgs: Capability = { ...base, id: 'routines:set', requiresArgs: true };

  it('admits an arg-requiring tool when the caller supplied args', () => {
    expect(paletteInvokeGuard(needsArgs, false, true)).toEqual({ allow: true, cap: needsArgs });
  });

  it('still refuses an arg-requiring tool when NO args were supplied, and says why', () => {
    const g = paletteInvokeGuard(needsArgs, true, false);
    expect(g.allow).toBe(false);
    if (!g.allow) {
      expect(g.code).toBe('not_palette_eligible');
      // The message must name the ACTUAL cause; the old one listed all three
      // possible causes at once and misdiagnosed this case as a hard limit.
      expect(g.message).toMatch(/requires arguments/);
      expect(g.message).not.toMatch(/streams or prompts/);
    }
  });

  it('does NOT waive the streaming/interactive exclusion — that is a shim limit, not a prompt limit', () => {
    for (const bad of [
      { ...base, streaming: true, requiresArgs: true },
      { ...base, interactive: true, requiresArgs: true },
    ]) {
      const g = paletteInvokeGuard(bad, true, /* argsSupplied */ true);
      expect(g.allow).toBe(false);
      if (!g.allow) expect(g.message).toMatch(/streams or prompts/);
    }
  });

  it('does NOT waive the destructive/high-risk confirm gate', () => {
    const dangerous = { ...needsArgs, destructive: true };
    const g = paletteInvokeGuard(dangerous, /* confirmed */ false, /* argsSupplied */ true);
    expect(g.allow).toBe(false);
    if (!g.allow) expect(g.code).toBe('confirmation_required');
    expect(paletteInvokeGuard(dangerous, true, true).allow).toBe(true);
  });

  it('leaves the palette LISTING unchanged — an arg-requiring tool is still not offered', () => {
    // The listing path calls paletteEligibility with no args, so an arg-taking
    // tool must stay out of the palette until it grows an arg prompt.
    expect(paletteEligibility(needsArgs)).toBe('exclude');
    expect(paletteEligibility(needsArgs, { argsSupplied: true })).toBe('fire-and-toast');
  });
});

describe('tools:invoke on the loopback palette dispatcher', () => {
  it('re-enters the guarded capability chokepoint with target args, confirmation, and caller attribution', async () => {
    const body = { content: [{ type: 'text' as const, text: '{"ok":true}' }] };
    const invoke = vi.fn(async () => ({ ok: true as const, status: 200, body }));
    const result = await dispatchPaletteTarget(
      {
        name: 'work_items:get',
        args: { id: 'WI-7' },
        confirmed: true,
        callerSid: 'pui-123',
      },
      invoke,
    );
    expect(invoke).toHaveBeenCalledWith({
      name: 'work_items:get',
      args: { id: 'WI-7' },
      confirmed: true,
      callerSid: 'pui-123',
    });
    expect(result).toBe(body);
  });

  it('returns a nested MCP error instead of weakening a target refusal', async () => {
    const invoke = vi.fn(async () => ({
      ok: false as const,
      status: 409,
      code: 'confirmation_required',
      message: 'confirm it',
    }));
    const result = await dispatchPaletteTarget(
      { name: 'danger:write', args: {}, confirmed: false },
      invoke,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: 'confirmation_required: confirm it',
    });
  });

  it('blocks direct self-recursion before calling the nested dispatcher', async () => {
    const invoke = vi.fn();
    const result = await dispatchPaletteTarget(
      { name: 'tools:invoke', args: { name: 'tools:find' } },
      invoke,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('cannot invoke itself') });
    expect(invoke).not.toHaveBeenCalled();
  });
});
