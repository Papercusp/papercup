/**
 * Smoke test for the tools:find defineTool wiring — importing the file triggers
 * defineTool registration, so a compile/import/capability error fails here.
 * Run with: npx vitest run packages/operator-core/lib/agent-tools/tools/find.test.ts
 */
import { describe, it, expect } from 'vitest';
import toolFind from './find';

describe('tools:find tool registration', () => {
  it('registers with the expected name + capability + args', () => {
    const def = toolFind as unknown as {
      name: string;
      capability: string;
      requirePrincipal: boolean;
      args: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(def.name).toBe('tools:find');
    expect(def.capability).toBe('agent_tools:read');
    expect(def.requirePrincipal).toBe(false);
    // args schema accepts a query, rejects an empty one.
    expect(def.args.safeParse({ query: 'feature flag' }).success).toBe(true);
    expect(def.args.safeParse({ query: '' }).success).toBe(false);
    expect(def.args.safeParse({}).success).toBe(false);
  });
});
