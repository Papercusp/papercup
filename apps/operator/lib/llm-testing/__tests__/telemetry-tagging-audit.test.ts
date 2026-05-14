/**
 * Telemetry-tagging audit — Plan §5.4 (Phase 0 CI gate).
 *
 * Verifies the two load-bearing pieces that make
 * `metadata_json @> '{"uiClientId": "llm-testing/<runId>"}'` reliable:
 *
 *   1. **Dispatcher auto-fill** — `packages/agent-mcp/dispatch-projected.ts`
 *      threads `ctx.uiClientId` into `metadata_json` when the handler
 *      didn't override. Five focused unit tests live in
 *      `packages/agent-mcp/src/dispatch-projected.test.ts` (search for
 *      "metadata_json auto-fill"). They're the foundation.
 *
 *   2. **Operator route plumbing** — `apps/operator/app/api/agent-mcp/
 *      operator-converse/route.ts` must put `body.uiClientId` into the
 *      `UnifiedToolContext.uiClientId` field so the dispatcher's
 *      auto-fill has something to fill in. This file's static-source
 *      check guards that plumbing — regressing the route's ctxBase
 *      drops the tag silently and breaks scenario isolation.
 *
 * Catalog walking (every registered tool) was tried first and pulled
 * in `@/lib/source` (Fumadocs MDX), which Vite's import-analysis can't
 * parse. The route-plus-dispatcher approach is narrower but proves
 * the actual invariant: when a tool runs via the operator-converse
 * path, its metadata_json carries uiClientId.
 *
 * If a future tool calls `ctx.metadata()` and DOESN'T include
 * uiClientId, the handler-supplied payload wins (overrides the
 * auto-fill). The cure: code review for `ctx.metadata({` call sites
 * to confirm they spread `uiClientId: ctx.uiClientId` or omit the
 * field entirely. As of 2026-05-14, only two tools call ctx.metadata
 * (docs:search, docs:get) and the framework's filter doesn't depend
 * on them carrying uiClientId because they're not invoked from the
 * operator chat path — they're invoked by agents directly.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTE_PATH = resolve(
  __dirname,
  '../../../app/api/agent-mcp/operator-converse/route.ts',
);

describe('telemetry-tagging audit (plan §5.4)', () => {
  describe('operator-converse route plumbs body.uiClientId into ctxBase', () => {
    const source = readFileSync(ROUTE_PATH, 'utf8');

    it('declares ctxBase as UnifiedToolContext', () => {
      expect(source).toMatch(/const ctxBase: UnifiedToolContext = \{/);
    });

    it('ctxBase carries uiClientId from body', () => {
      // Tolerant of small reformatting: must contain a literal
      // `uiClientId: body.uiClientId` (with optional ?? null) somewhere
      // inside the ctxBase block.
      const ctxBaseBlock = extractBlock(source, /const ctxBase: UnifiedToolContext = \{/);
      expect(ctxBaseBlock, 'ctxBase block not found in route.ts').toBeTruthy();
      expect(ctxBaseBlock!).toMatch(/uiClientId:\s*body\.uiClientId(\s*\?\?\s*null)?/);
    });
  });

  describe('dispatcher auto-fill foundation (verified in agent-mcp/)', () => {
    it('points readers at the canonical tests', () => {
      // This describe block exists to keep the link visible from this
      // file. The actual behavior is exercised by 5 vitest cases in
      // packages/agent-mcp/src/dispatch-projected.test.ts under the
      // describe('metadata_json auto-fill from ctx.uiClientId ...')
      // block. Run them with:
      //
      //   pnpm --filter @papercusp/agent-mcp test
      //
      // or in CI alongside this suite.
      expect(true).toBe(true);
    });
  });
});

/**
 * Extract the matching block ({ ... }) starting at `marker`. Returns
 * the substring from the brace after the marker through its matching
 * brace, or null if not found.
 */
function extractBlock(source: string, marker: RegExp): string | null {
  const m = marker.exec(source);
  if (!m) return null;
  // Find the open brace that the marker captured.
  const openIdx = source.indexOf('{', m.index);
  if (openIdx === -1) return null;
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(openIdx, i + 1);
    }
  }
  return null;
}
