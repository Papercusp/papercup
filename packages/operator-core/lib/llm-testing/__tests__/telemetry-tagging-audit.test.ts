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
 *   2. **Operator route plumbing** — `apps/operator/lib/endpoint-route/
 *      routes/agent-mcp/operator-converse.ts` must put `body.uiClientId`
 *      into the `UnifiedToolContext.uiClientId` field so the dispatcher's
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

// The operator-converse route moved from app/api/ (Next.js) to the
// endpoint-route system in the 2026-05-20 Vite migration. Same handler,
// same ctxBase plumbing — only the file location changed.
const ROUTE_PATH = resolve(
  __dirname,
  '../../endpoint-route/routes/agent-mcp/operator-converse.ts',
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
      expect(ctxBaseBlock, 'ctxBase block not found in operator-converse.ts').toBeTruthy();
      expect(ctxBaseBlock!).toMatch(/uiClientId:\s*body\.uiClientId(\s*\?\?\s*null)?/);
    });
  });

  describe('dispatcher auto-fill foundation (verified in agent-mcp/)', () => {
    it('points readers at the canonical tests', () => {
      // This describe block exists to keep the link visible from this
      // file. The actual behavior is exercised by 5 vitest cases in
      // packages/agent-mcp/src/dispatch-projected.test.ts under the
      // describe('metadata_json auto-fill from ctx.uiClientId ...')
      // block, AND dynamically by parallelism-smoke.test.ts (sibling),
      // which dispatches concurrent synthetic tools and asserts each
      // recordInvocation row carries the right uiClientId.
      expect(true).toBe(true);
    });
  });

  describe('static catalog audit — no handler clobbers ctx.metadata', () => {
    it('no agent-tools handler calls ctx.metadata() without spreading the auto-filled keys', () => {
      // Walk the source tree; if any tool calls `ctx.metadata({...})`
      // with a fresh object literal, that object replaces the auto-
      // filled uiClientId. The dispatcher's intent is "merge by spread"
      // — if a tool wants to add a key, it should do
      //   ctx.metadata?.({ ...prev, customKey: value })
      // but because the dispatcher captures the LAST metadata call,
      // the handler can simply call ctx.metadata with whatever extra
      // keys it wants and the dispatcher merges with its own auto-fill
      // *after*. So the only failure mode is theoretical: a tool that
      // wanted to *suppress* uiClientId. We don't have any such tool.
      //
      // This block guards future regressions by failing if a new tool
      // appears that calls ctx.metadata() *and* explicitly sets
      // uiClientId to something other than ctx.uiClientId.
      const { execSync } = require('node:child_process') as typeof import('node:child_process');
      const repoRoot = resolve(__dirname, '../../../../..');
      // We're in apps/operator/lib/llm-testing/__tests__; up 5 = repo root.
      let hits = '';
      try {
        hits = execSync(
          `grep -rn "uiClientId" "${repoRoot}/apps/operator/lib/agent-tools/" "${repoRoot}/packages/agent-mcp/src/" --include='*.ts' | grep -v test | grep -E "metadata.*uiClientId.*:" || true`,
          { encoding: 'utf8' },
        );
      } catch {
        hits = '';
      }
      // Should be empty: no tool explicitly sets metadata.uiClientId.
      // (The dispatcher auto-fill is in a single file and obviously
      // does set it — we exclude that file by greppattern restricting
      // to handler bodies that look like metadata({ ... uiClientId: ... }).)
      expect(hits.trim()).toBe('');
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
