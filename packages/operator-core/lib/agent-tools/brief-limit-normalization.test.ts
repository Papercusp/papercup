/**
 * Regression guard for WI-1413 (fleet-backlog-lessons-2026-07-01 P-011):
 * every situational-overlay / "brief" field across the fleet-placement and
 * plan-item-pickup surfaces must share the SAME cap — `LIMITS.BRIEF`
 * (16000 chars) — not a stale, smaller tier (`LIMITS.ANNOTATION` = 2000) or a
 * hand-rolled `.max(4000)`. A telemetry-visible truncation of a Queen brief
 * (even mid-sentence) traces back to exactly this kind of drift: one call
 * site quietly capped below the canonical BRIEF tier.
 *
 * Mechanism-level, not wording-level: this pins the *cap value* advertised in
 * each tool's JSON Schema, so a future edit that reintroduces a tight
 * `.max()` (or reverts to a lower LIMITS tier) fails loudly here instead of
 * silently truncating a rich brief again.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { LIMITS } from './limits';

// z.toJSONSchema is a static on the zod namespace; cast for the call (same
// pattern as limits.test.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toJSONSchema = (s: unknown): Record<string, unknown> => (z as any).toJSONSchema(s);

type PropSchema = { maxLength?: unknown; anyOf?: PropSchema[] };

const propMaxLength = (tool: { args: unknown }, prop: string): unknown => {
  const js = toJSONSchema(tool.args) as { properties?: Record<string, PropSchema> };
  const propSchema = js.properties?.[prop];
  if (!propSchema) return undefined;
  // .nullable() (used by hard-capped-but-clearable fields like set-steering's
  // `directive`) compiles to an `anyOf: [{type, maxLength}, {type: "null"}]`
  // wrapper rather than a flat `maxLength` — unwrap it so this stays a
  // mechanism-level assertion regardless of `.nullable()`/`.optional()`.
  if (propSchema.maxLength !== undefined) return propSchema.maxLength;
  const fromAnyOf = propSchema.anyOf?.find((branch) => branch.maxLength !== undefined);
  return fromAnyOf?.maxLength;
};

describe('brief-carrying fields are normalized to LIMITS.BRIEF', () => {
  it('bee:spawn { brief } is a softText — no hard maxLength (clamped handler-side to LIMITS.BRIEF)', async () => {
    const tool = (await import('./bee/spawn')).default as unknown as { args: unknown };
    // softText never advertises a maxLength (JSON-Schema-representable); the
    // cap is enforced by clampText(args.brief, LIMITS.BRIEF) in the handler.
    expect(propMaxLength(tool, 'brief')).toBeUndefined();
  });

  it('fleet:place_batch { brief } is a softText — no hard maxLength (clamped handler-side to LIMITS.BRIEF)', async () => {
    const tool = (await import('./fleet/place_batch')).default as unknown as { args: unknown };
    expect(propMaxLength(tool, 'brief')).toBeUndefined();
  });

  it('plan_items:convert single-shorthand { brief } accepts up to LIMITS.BRIEF (was ANNOTATION=2000)', async () => {
    const tool = (await import('./plan-items/convert')).default as unknown as { args: unknown };
    expect(propMaxLength(tool, 'brief')).toBeUndefined(); // softText — clamped, not rejected
  });

  it('work_items:expand child { brief } hard-caps at LIMITS.BRIEF (was ANNOTATION=2000)', async () => {
    const tool = (await import('./work_items/expand')).default as unknown as { args: unknown };
    const js = toJSONSchema(tool.args) as {
      properties?: { children?: { items?: { properties?: Record<string, { maxLength?: unknown }> } } };
    };
    expect(js.properties?.children?.items?.properties?.brief?.maxLength).toBe(LIMITS.BRIEF);
  });

  it('hive:set-steering { directive } (surfaced in the Queen wake brief) hard-caps at LIMITS.BRIEF (was hardcoded 4000)', async () => {
    const tool = (await import('./hive/set_steering')).default as unknown as { args: unknown };
    expect(propMaxLength(tool, 'directive')).toBe(LIMITS.BRIEF);
  });
});
