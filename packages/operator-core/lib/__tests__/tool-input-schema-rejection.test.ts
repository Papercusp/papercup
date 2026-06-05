/**
 * tool-input-schema-rejection.test.ts — the `invalid_args` failure class.
 *
 * ~88 of the recorded tool-call failures (harness_shared.tool_invocations,
 * 2026-05-31) were `invalid_args: …` — a tool's input schema rejecting
 * malformed/missing args. There was no registry-wide test that each tool's
 * schema actually enforces its declared contract. This is that guard.
 *
 * Two registries (see agent-insights/failed-tool-call-history):
 *   getCatalog()            → ~28 principal-gated BUILT-INS, each with a Zod
 *                             `args` schema → validate schema-level (no dispatch).
 *   listAllProjectedTools() → all ~217 tools as JSON `inputSchema` (no Zod, no
 *                             name) → structural well-formedness checks.
 */
import { describe, it, expect } from 'vitest';
import '../agent-tools/index'; // side-effect: register the full real tool catalog
import { getCatalog, listAllProjectedTools, validateSync } from '@papercusp/tooldef';

const catalog = getCatalog(); // built-ins with Zod args
const projected = listAllProjectedTools(); // full set, JSON inputSchema

describe('built-in tool args schemas (invalid_args class — schema level)', () => {
  it('the built-in catalog loaded', () => {
    expect(catalog.length).toBeGreaterThan(10);
  });

  it('every built-in args schema validates {} synchronously without throwing', () => {
    // A throw here = an async/broken validator on the dispatch hot path.
    const threw: string[] = [];
    for (const t of catalog) {
      try {
        validateSync(t.args, {});
      } catch {
        threw.push(t.name);
      }
    }
    expect(threw, `validators that threw: ${threw.join(', ')}`).toEqual([]);
  });

  it('required-arg built-ins reject {} with a structured issue', () => {
    const required = ['features:get', 'features:history'];
    for (const name of required) {
      const t = catalog.find((x) => x.name === name);
      expect(t, `tool ${name} present in catalog`).toBeTruthy();
      const r = validateSync(t!.args, {});
      expect(r.ok, `${name} should reject {}`).toBe(false);
      if (!r.ok) expect(r.issues.length).toBeGreaterThan(0);
    }
  });

  it('a no-required-args built-in accepts {} (harness:list)', () => {
    // papercusp:list_workspaces (the former z.object({}).strict() example)
    // moved to the role-gated `defineTool` path, so it's no longer a NAMED
    // entry in getCatalog() (legacy built-ins only). harness:list is the
    // representative no-required legacy built-in. Unknown-key rejection
    // (.strict) is no longer a per-tool Zod property of the legacy built-ins —
    // it's enforced structurally at the projection/transport boundary via
    // additionalProperties:false, asserted for EVERY tool in the projected
    // suite below (stronger than the old single-tool check).
    const t = catalog.find((x) => x.name === 'harness:list');
    expect(t, 'harness:list present in catalog').toBeTruthy();
    expect(validateSync(t!.args, {}).ok).toBe(true);
  });
});

describe('projected tool inputSchemas (invalid_args class — structural)', () => {
  it('the full projection registry loaded', () => {
    expect(projected.length).toBeGreaterThan(150);
  });

  it('every projected tool exposes a well-formed object inputSchema', () => {
    const bad = projected.filter(
      (t) => !t.inputSchema || (t.inputSchema as { type?: string }).type !== 'object',
    );
    expect(bad.length, `${bad.length} tools with a non-object inputSchema`).toBe(0);
  });

  it('every projected tool is strict (additionalProperties:false) — unknown args rejected at the wire', () => {
    // The wire-level equivalent of Zod's `.strict()`: an MCP client validating
    // against the projected inputSchema rejects typo'd / unknown keys. This is
    // where the unknown-key-rejection contract actually lives for ALL tools
    // (legacy + role-gated), regardless of whether the source Zod used .strict().
    const loose = projected.filter(
      (t) => (t.inputSchema as { additionalProperties?: unknown }).additionalProperties !== false,
    );
    expect(loose.length, `${loose.length} projected tools allow unknown keys (want additionalProperties:false)`).toBe(0);
  });

  it('a substantial set of tools declare required args (contract is enforced, not vestigial)', () => {
    const withRequired = projected.filter(
      (t) => Array.isArray((t.inputSchema as { required?: string[] }).required) &&
        (t.inputSchema as { required: string[] }).required.length > 0,
    );
    // ~151 of 217; loose lower bound stays robust to catalog churn.
    expect(withRequired.length).toBeGreaterThan(100);
  });
});
