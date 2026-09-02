/**
 * _guidance-adapter.live.test.ts — the guidance corpus measured against the REAL
 * tree and the REAL tool registry (plan guidance-overlap-contradiction-scan-2026-08-08,
 * P-001). Split from `_guidance-adapter.test.ts` because the barrel import below
 * registers ~900 tool modules; the unit file stays fixture-only and fast.
 *
 * These are the assertions the unit tests structurally cannot make: that the
 * ALLOWLIST of canonical roots (plan D-002) actually resolves on this tree, and
 * that the tool-guidance leg reads the field the registry really carries.
 */
import { describe, it, expect } from 'vitest';
// Registers every defineTool module — the same warm-up tool-auth-gating.test.ts
// performs. Without it `listAllProjectedTools()` is EMPTY and the tool-guidance
// leg measures nothing while looking like a clean zero.
import '../index';
import { guidanceAdapter, renderToolGuidancePage } from './_guidance-adapter';

describe('guidance corpus — live tree', () => {
  it('resolves every canonical root, with no build-copy leakage', async () => {
    const a = guidanceAdapter({ includeToolGuidance: false });
    const pages = await a.listPages();
    const c = a.lastCensus()!;

    // Each root must be NON-EMPTY. A root that silently stops resolving (a
    // rename, a submodule that failed to check out) would otherwise shrink the
    // corpus quietly, and a smaller corpus finds fewer overlaps — which reads as
    // an improving codebase rather than a broken adapter.
    expect(c.claudeMd).toBe(1);
    expect(c.prompts).toBeGreaterThan(30);
    expect(c.blueprints).toBeGreaterThan(50);

    // D-002: a glob over this tree returns 6-9 copies of every prompt. The roots
    // are an allowlist, so no page may resolve out of a build tree.
    const copyPaths = pages.filter((p) =>
      /sidecar|dist-host|dist-sidecar|cargo-target|materialized|node_modules/.test(p.slug),
    );
    expect(copyPaths.map((p) => p.slug)).toEqual([]);

    // And nothing byte-identical survived. This assertion is only meaningful
    // because the CONTROL in _guidance-adapter.test.ts proves the detector fires
    // — a bare 0 here would equally well mean the check never ran.
    expect(c.duplicatesDropped).toBe(0);
  });

  it('indexes per-tool guidance off the runtime registry', async () => {
    const a = guidanceAdapter();
    const pages = await a.listPages();
    const c = a.lastCensus()!;

    expect(c.toolGuidance).toBeGreaterThan(100);
    expect(c.warnings.join(' ')).not.toMatch(/registry is EMPTY|accessor missing|unreadable/);
    expect(c.registrySource).toBe('projected-tool-registry');
    expect(c.registryRevision).toMatch(/^projected-tool-registry-v1:/);
    expect(c.correctiveCallsChecked).toBeGreaterThan(0);

    const one = pages.find((p) => p.slug.startsWith('tool-guidance/'));
    expect(one).toBeDefined();
    const body = await a.getContent(one!);
    expect(body).toMatch(/^# /);
    expect(body).toMatch(/## (When|Not when|Chaining|Returns)/);

    const updatePage = pages.find((p) => p.slug === 'tool-guidance/work_items-update');
    expect(updatePage).toBeDefined();
    const updateBody = await a.getContent(updatePage!);
    expect(updateBody).toContain('## Correction for rejected arg: tags');
    expect(updateBody).toContain('work_items:tag {"id":"<work-item-id>","topic":"<topic>"}');
  });

  it('CROSS-CHECK: the tool-guidance page count matches an independently-derived count', async () => {
    // EI-19283613546965405: an invented `{ name }` shape built a silently EMPTY
    // set from a healthy registry — the name lives at `expose.mcp.name`. A count
    // assertion alone cannot catch that regression (0 > 100 fails, but so does a
    // registry that legitimately shrank). So derive the expected set HERE, from
    // the registry directly, and require the adapter to agree exactly.
    const { listAllProjectedTools } = await import('@papercusp/tooldef');
    const expected = new Set(
      listAllProjectedTools()
        .filter((t) => {
          const name = t.expose?.mcp?.name;
          return Boolean(name) && renderToolGuidancePage(name!, t as never) !== null;
        })
        .map((t) => t.expose!.mcp!.name!),
    );
    // Sanity: the independent derivation must itself be non-trivial, or the
    // comparison below is two empty sets agreeing.
    expect(expected.size).toBeGreaterThan(100);

    const a = guidanceAdapter();
    const pages = await a.listPages();
    const c = a.lastCensus()!;
    const got = pages.filter((p) => p.slug.startsWith('tool-guidance/'));

    // Skip-and-warn (EI-22187811297314993): a tool whose corrective-call
    // remedy fails registry conformance drops ONLY its own page, named in
    // `toolGuidanceSkipped` — never the whole corpus. In the healthy case
    // nothing is skipped, so this is asserted explicitly rather than folded
    // silently into the count below: a regression that starts skipping real
    // tools must fail THIS assertion loudly, not be absorbed by a permissive
    // "count minus however many" comparison.
    expect(c.toolGuidanceSkipped).toEqual([]);
    expect(got.length).toBe(expected.size - c.toolGuidanceSkipped.length);
  });
});
