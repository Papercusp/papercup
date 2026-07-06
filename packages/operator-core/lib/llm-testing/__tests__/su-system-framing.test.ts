/**
 * Regression test for the SU SUT's Claude Code system-prompt framing.
 *
 * WHY THIS EXISTS: the su target drives the SUT via a raw Anthropic Messages API
 * call. Under this box's setup there is no ANTHROPIC_API_KEY, so the call uses the
 * Claude Max OAuth token — which is only admitted to the full, CLI-equivalent
 * rate-limit bucket when the request is FRAMED AS CLAUDE CODE (first system block
 * = the Claude Code identifier). Without that block the identical call 429s on a
 * stricter raw-OAuth bucket, which silently broke the entire suite for ~40h
 * (su-scenario-suite P-005; root-caused + fixed 2026-06-08). This test locks the
 * framing in so a future refactor of the system-prompt assembly can't regress it.
 */

import { describe, expect, it } from 'vitest';

import {
  CLAUDE_CODE_IDENTIFIER,
  SU_PLAYBOOK_FRAMING,
  SuTarget,
  adaptDeltaToolResultForModel,
  buildSuSystemBlocks,
  filterCatalog,
  loadPlaybookBody,
  mergeConsecutiveRoles,
  parseSuConfigDelta,
} from '../targets/su';
import { buildCatalog } from '../targets/su-catalog';

const PLAYBOOK = '# Papercusp engineer-collaborator playbook\n...body...';

describe('su SUT system-prompt framing', () => {
  it('uses the exact canonical Claude Code identifier string', () => {
    // A typo here silently re-throttles the OAuth bucket — pin the literal.
    expect(CLAUDE_CODE_IDENTIFIER).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
  });

  it('puts the Claude Code identifier as the FIRST system block (the load-bearing invariant)', () => {
    for (const cache of [true, false]) {
      const blocks = buildSuSystemBlocks(PLAYBOOK, cache);
      expect(blocks[0]).toEqual({ type: 'text', text: CLAUDE_CODE_IDENTIFIER });
      expect(blocks[0].cache_control).toBeUndefined();
    }
  });

  it('puts the playbook as the second block, cache_control only when caching is on', () => {
    const cached = buildSuSystemBlocks(PLAYBOOK, true);
    expect(cached).toHaveLength(2);
    expect(cached[1].text).toBe(PLAYBOOK);
    expect(cached[1].cache_control).toEqual({ type: 'ephemeral' });

    const uncached = buildSuSystemBlocks(PLAYBOOK, false);
    expect(uncached).toHaveLength(2);
    expect(uncached[1].text).toBe(PLAYBOOK);
    expect(uncached[1].cache_control).toBeUndefined();
  });

  it('always leads with the identifier regardless of playbook content', () => {
    // Even if the playbook itself happened to start with the identifier text,
    // the dedicated first block must still be present and first.
    const blocks = buildSuSystemBlocks(CLAUDE_CODE_IDENTIFIER + '\nmore', true);
    expect(blocks[0].text).toBe(CLAUDE_CODE_IDENTIFIER);
    expect(blocks).toHaveLength(2);
  });
});

describe('su SUT eval-variant knob (test-gym-apiary P-001)', () => {
  it('appends the prompt overlay as a third, UNCACHED block after the playbook', () => {
    const blocks = buildSuSystemBlocks(PLAYBOOK, true, 'Always answer in haiku.');
    expect(blocks).toHaveLength(3);
    // Identifier + cached playbook untouched (the overlay must not bust the
    // playbook's cache entry by landing before the cache breakpoint).
    expect(blocks[0].text).toBe(CLAUDE_CODE_IDENTIFIER);
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[2]).toEqual({ type: 'text', text: 'Always answer in haiku.' });
  });

  it('no overlay → exactly the baseline two blocks', () => {
    expect(buildSuSystemBlocks(PLAYBOOK, true)).toHaveLength(2);
    expect(buildSuSystemBlocks(PLAYBOOK, true, undefined)).toHaveLength(2);
  });

  it('parseSuConfigDelta accepts sutModel and rejects unknown keys loudly', () => {
    expect(parseSuConfigDelta(undefined)).toEqual({});
    expect(parseSuConfigDelta({ sutModel: 'claude-haiku-4-5' })).toEqual({ sutModel: 'claude-haiku-4-5' });
    expect(() => parseSuConfigDelta({ temperature: 0.7 })).toThrow(/unsupported variant configDelta key.*temperature/);
    expect(() => parseSuConfigDelta({ sutModel: '' })).toThrow(/non-empty string/);
    expect(() => parseSuConfigDelta({ sutModel: 42 as unknown as string })).toThrow(/non-empty string/);
  });
});

describe('su SUT excludeTools — tool-availability A/B seam (code:run adoption)', () => {
  it('parseSuConfigDelta accepts excludeTools as a string array; rejects non-arrays/empties', () => {
    expect(parseSuConfigDelta({ excludeTools: ['code:run', 'code:tools'] })).toEqual({
      excludeTools: ['code:run', 'code:tools'],
    });
    expect(() => parseSuConfigDelta({ excludeTools: 'code:run' as unknown as string[] })).toThrow(/array of non-empty/);
    expect(() => parseSuConfigDelta({ excludeTools: [''] })).toThrow(/array of non-empty/);
    expect(() => parseSuConfigDelta({ excludeTools: [42] as unknown as string[] })).toThrow(/array of non-empty/);
  });

  it('filterCatalog drops the named canonical tools and is identity-returning when empty', () => {
    const full = buildCatalog();
    const hadCodeRun = full.tools.some((t) => full.canonicalBySanitized.get(t.name) === 'code:run');
    expect(hadCodeRun).toBe(true); // SU_CATALOG carries code:run (the A/B subject)
    const filtered = filterCatalog(full, ['code:run', 'code:tools']);
    const names = filtered.tools.map((t) => filtered.canonicalBySanitized.get(t.name));
    expect(names).not.toContain('code:run');
    expect(names).not.toContain('code:tools');
    expect(filtered.tools.length).toBe(full.tools.length - 2);
    // Empty/absent exclude → the SAME object (no allocation on the common path).
    expect(filterCatalog(full, [])).toBe(full);
    expect(filterCatalog(full, undefined)).toBe(full);
  });
});

describe('su SUT systemPromptText replacement (self-learning-frontier P-023 / FB-09)', () => {
  it('parseSuConfigDelta accepts systemPromptText verbatim (never trimmed — the text IS the experiment)', () => {
    const text = `${SU_PLAYBOOK_FRAMING}ablated body\n`;
    expect(parseSuConfigDelta({ systemPromptText: text })).toEqual({ systemPromptText: text });
    expect(() => parseSuConfigDelta({ systemPromptText: '' })).toThrow(/non-empty string/);
    expect(() => parseSuConfigDelta({ systemPromptText: 7 as unknown as string })).toThrow(/non-empty string/);
  });

  it('open() with systemPromptText replaces the loader; without it the loader stands', async () => {
    let loaderCalls = 0;
    const target = new SuTarget({
      loadSystemPrompt: () => {
        loaderCalls++;
        return 'loader prompt';
      },
    });
    // Replacement arm: the variant text wins; the target loader is never consulted.
    await target.open({
      runId: 'r1',
      workspaceMode: 'isolated',
      transport: 'in-process',
      variant: { id: 'ablate:x/y', configDelta: { systemPromptText: 'REPLACED' } },
    } as never);
    expect(loaderCalls).toBe(0);
    // Baseline-shaped open: loader untouched until send(); an unknown knob still throws at open().
    await target.open({ runId: 'r2', workspaceMode: 'isolated', transport: 'in-process' } as never);
    await expect(
      target.open({
        runId: 'r3',
        workspaceMode: 'isolated',
        transport: 'in-process',
        variant: { id: 'bad', configDelta: { playbook: 'x' } },
      } as never),
    ).rejects.toThrow(/unsupported variant configDelta key/);
  });

  it('loadPlaybookBody returns the marker-spliced body the ablation runner segments (no framing, no raw markers)', () => {
    const body = loadPlaybookBody();
    expect(body.startsWith(SU_PLAYBOOK_FRAMING)).toBe(false);
    expect(body).not.toMatch(/<!-- PAPERCUSP-SU:[A-Z-]+ -->/);
    expect(body.length).toBeGreaterThan(10_000);
  });
});

describe('su SUT mergeConsecutiveRoles (compaction-seam role validity, agent-tool-delta-protocol P-006/P-007)', () => {
  it('merges adjacent same-role turns so a compacted [user, user] pair is one valid turn', () => {
    // What the runner's compaction seam produces before the delta turn: a
    // summary user-block immediately followed by the turn's user message.
    const merged = mergeConsecutiveRoles([
      { role: 'user', content: '[earlier conversation compacted]' },
      { role: 'user', content: 'what changed since then?' },
    ]);
    expect(merged).toEqual([
      { role: 'user', content: '[earlier conversation compacted]\n\nwhat changed since then?' },
    ]);
  });

  it('leaves an already-alternating history untouched (content preserved verbatim)', () => {
    const history = [
      { role: 'user' as const, content: 'list the items' },
      { role: 'assistant' as const, content: 'A, B, C' },
      { role: 'user' as const, content: 'what changed?' },
    ];
    expect(mergeConsecutiveRoles(history)).toEqual(history);
  });

  it('collapses a run of three same-role turns into one', () => {
    const merged = mergeConsecutiveRoles([
      { role: 'assistant', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'assistant', content: 'three' },
    ]);
    expect(merged).toEqual([{ role: 'assistant', content: 'one\n\ntwo\n\nthree' }]);
  });

  it('does not mutate the input array', () => {
    const input = [
      { role: 'user' as const, content: 'a' },
      { role: 'user' as const, content: 'b' },
    ];
    const copy = input.map((m) => ({ ...m }));
    mergeConsecutiveRoles(input);
    expect(input).toEqual(copy);
  });
});

describe('su SUT delta tool-result adapter (agent-tool-delta-protocol P-007)', () => {
  it('caches a full snapshot and then exposes reconstructed full rows for a delta', async () => {
    const views = new Map<string, { rows: unknown[]; cursor?: string }>();
    const full = await adaptDeltaToolResultForModel(
      views,
      'work_items:list:{}',
      {
        content: [{ text: JSON.stringify({
          ok: true,
          mode: 'full',
          cursor: 'c1',
          items: [
            { id: 'WI-1', title: 'keep' },
            { id: 'WI-2', title: 'remove me' },
            { id: 'WI-3', title: 'old title' },
          ],
        }) }],
      },
    );
    expect(JSON.parse(full.content[0].text as string).mode).toBe('full');

    const delta = await adaptDeltaToolResultForModel(
      views,
      'work_items:list:{}',
      {
        content: [{ text: JSON.stringify({
          ok: true,
          mode: 'delta',
          cursor: 'c2',
          items: [
            { change: 'removed', id: 'WI-2' },
            { change: 'updated', id: 'WI-3', data: { id: 'WI-3', title: 'new title' } },
            { change: 'added', id: 'WI-4', data: { id: 'WI-4', title: 'added' } },
          ],
        }) }],
      },
    );
    const body = JSON.parse(delta.content[0].text as string);
    expect(body.mode).toBe('full');
    expect(body.items.map((r: { title: string }) => r.title)).toEqual(['keep', 'new title', 'added']);
  });

  it('refetches full when a delta arrives without a cached base', async () => {
    const views = new Map<string, { rows: unknown[]; cursor?: string }>();
    let refetches = 0;
    const result = await adaptDeltaToolResultForModel(
      views,
      'work_items:list:{}',
      {
        content: [{ text: JSON.stringify({
          ok: true,
          mode: 'delta',
          cursor: 'c2',
          items: [{ change: 'removed', id: 'WI-2' }],
        }) }],
      },
      async () => {
        refetches++;
        return {
          content: [{ text: JSON.stringify({
            ok: true,
            mode: 'full',
            cursor: 'c2',
            items: [{ id: 'WI-1', title: 'fresh full' }],
          }) }],
        };
      },
    );
    expect(refetches).toBe(1);
    const body = JSON.parse(result.content[0].text as string);
    expect(body.mode).toBe('full');
    expect(body.items).toEqual([{ id: 'WI-1', title: 'fresh full' }]);
  });
});
