/**
 * plans:new `force` — string-tolerant boolean coercion (EI-302).
 *
 * A long-lived MCP session's tools/list schema is manifest-PINNED
 * (tool-manifest.ts freezes the exposed surface for prompt-cache stability),
 * so a session that began before `force` was added to plans:new cannot see it
 * in its cached schema. Such a "stale-schema client" passes `force` as the JSON
 * string "true", and a bare z.boolean() rejected it — the dispatch layer
 * (define-tool.ts) threw `invalid_args`, forcing a hand-call of the raw HTTP
 * MCP projection. The arg now accepts the exact wire strings "true"/"false"
 * while keeping the advertised JSON schema a plain boolean.
 *
 * (whole-app-test-coverage-breadth — pure schema test, no PG / lock fixture.)
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { argsSchema } from '../new';

const base = { slug: 'demo-plan', title: 'Demo plan' };

describe('plans:new force coercion (EI-302)', () => {
  it('coerces the wire string "true" → boolean true (the stale-schema client case)', () => {
    expect(argsSchema.parse({ ...base, force: 'true' }).force).toBe(true);
  });

  it('coerces the wire string "false" → boolean false (NOT the z.coerce.boolean footgun)', () => {
    // z.coerce.boolean()("false") would be `true` (any non-empty string is
    // truthy). The explicit-string preprocess must produce `false`.
    expect(argsSchema.parse({ ...base, force: 'false' }).force).toBe(false);
  });

  it('passes a real boolean through unchanged', () => {
    expect(argsSchema.parse({ ...base, force: true }).force).toBe(true);
    expect(argsSchema.parse({ ...base, force: false }).force).toBe(false);
  });

  it('leaves force undefined when omitted (optional)', () => {
    expect(argsSchema.parse(base).force).toBeUndefined();
  });

  it('still rejects a non-boolean-ish value (no silent truthiness)', () => {
    // A typo like "yes" / "1" is NOT coerced — it falls through to z.boolean()
    // and fails loudly, so a genuine mistake never silently becomes `true`.
    expect(() => argsSchema.parse({ ...base, force: 'yes' })).toThrow();
    expect(() => argsSchema.parse({ ...base, force: 1 })).toThrow();
  });

  it('advertises force as a plain boolean in the published (tools/list) JSON schema', () => {
    // This is the projection the MCP transport serves (_mcp-handler.ts:
    // `z.toJSONSchema(tool.args)`) and openapi.json derives from. The original
    // bug was "force missing from published catalog schema" — guard that the
    // string-tolerant pipe still surfaces as a boolean property here.
    const json = z.toJSONSchema(argsSchema) as {
      properties?: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
    expect(json.properties?.force?.type).toBe('boolean');
    expect(json.properties?.force?.description).toMatch(/EI-134/);
    // force is optional — it must NOT be in the required set.
    expect(json.required ?? []).not.toContain('force');
  });
});
