/**
 * carry-drill.test.ts — EI-12618 regression guard: the session:* group is fully
 * INDEXED + DISCOVERABLE via papercusp's own tool finder.
 *
 * Reported symptom: an agent could not reach `session:carry-drill` via Claude's
 * native ToolSearch — `select:session:carry-drill` (colon form), the correctly-
 * mangled `select:mcp__papercusp-su__session_carry-drill`, AND a keyword search
 * all returned "No matching deferred tools found" — and hypothesised "an
 * activation/indexing gap specific to session:* group tools".
 *
 * Root cause (see agent-insights/toolsearch-cannot-select-colon-form-tool-names):
 * ToolSearch is Claude's OWN client-native mechanism — papercusp neither
 * implements nor controls it. On a FULL-catalog Claude session there are ZERO
 * *deferred* tools, so any `select:` trivially returns "No matching deferred
 * tools found" (the tool is already directly callable); on a SEEDED session the
 * sanctioned discovery path is `tools:find` (which activates matches) /
 * `tools:invoke` (server-side dispatch by the real colon-form name). There is NO
 * session:*-specific defect — `session:carry-drill` is registered, MCP-projected,
 * in the tools:find corpus, and dispatchable.
 *
 * This test LOCKS THAT IN so the hypothesised "session:* indexing gap" cannot
 * silently become real: it proves every session:* tool is MCP-projected (the
 * precondition for ANY tools/list / ToolSearch / tools:find visibility) and
 * resolves via `tools:find`'s exact-name-authoritative lexical leg.
 *
 * Deterministic: no embedder (lexical-only) -> no network, no DB. Importing the
 * tool default exports triggers their defineTool registration into the global
 * projected-tool registry that buildCorpus() reads.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/session/carry-drill.test.ts
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
// Importing the default exports self-registers both session:* tools into the
// shared projected-tool registry (their defineTool call runs at module eval).
import carryDrill from './carry-drill';
import requestCompaction from './request-compaction';
import { buildCorpus } from '../tools/find';
import { findTools } from '../../cupboard/tool-find';

/** The full session:* group — both must stay indexed + discoverable. */
const SESSION_TOOLS = ['session:carry-drill', 'session:request-compaction'] as const;
const CARRY_DRILL_SOURCE = readFileSync(new URL('./carry-drill.ts', import.meta.url), 'utf8');

type NamedDef = { name: string };

describe('session:* tools are registered + discoverable (EI-12618 guard)', () => {
  it('each session:* tool registers under its exact colon-form name', () => {
    expect((carryDrill as unknown as NamedDef).name).toBe('session:carry-drill');
    expect((requestCompaction as unknown as NamedDef).name).toBe('session:request-compaction');
  });

  it('start accepts its documented note and explicit history-uncertainty retry acknowledgement', () => {
    expect(carryDrill.args.safeParse({
      op: 'start',
      effectiveWindowTokens: 400_000,
      acknowledgeOwnerHistoryUncertainty: true,
      note: 'live Codex acceptance',
    }).success).toBe(true);
    expect(carryDrill.args.safeParse({
      op: 'grade',
      drillId: 'drill-1',
      acknowledgeOwnerHistoryUncertainty: true,
    }).success).toBe(false);
  });

  it('threads both start-only fields from the public tool handler into the live drill helper', () => {
    expect(CARRY_DRILL_SOURCE).toContain(
      'acknowledgeOwnerHistoryUncertainty: args.acknowledgeOwnerHistoryUncertainty',
    );
    expect(CARRY_DRILL_SOURCE).toContain('note: args.note');
  });

  it('buildCorpus() MCP-indexes every session:* tool (what tools:find searches)', () => {
    // buildCorpus skips any tool without expose.mcp, so a name appearing here
    // PROVES the tool is MCP-projected — the precondition ToolSearch/tools:find
    // visibility both require, and the exact thing EI-12618 hypothesised was
    // missing for the session:* group.
    const { corpus, embedText } = buildCorpus();
    const names = new Set(corpus.map((e) => e.tool));
    for (const name of SESSION_TOOLS) {
      expect(names.has(name)).toBe(true);
      // The embed/search text folds the exact name so both the lexical and the
      // semantic leg can match it.
      expect(embedText.get(name) ?? '').toContain(name);
    }
  });

  it('tools:find resolves session:carry-drill by its exact colon-form name (lexical, no embedder)', async () => {
    const { corpus } = buildCorpus();
    // Lexical-only (no embedder) mirrors how tools:find runs before its embedding
    // index warms; the lexical leg is exact-name-authoritative over the REAL
    // colon-form identity. session:carry-drill must be the top hit for its own name.
    const hits = await findTools(corpus, 'session:carry-drill', { limit: 5 });
    expect(hits[0]?.tool).toBe('session:carry-drill');
  });
});
