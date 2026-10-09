import assert from 'node:assert/strict';

/** Preserve the actual MCP reply when a private acceptance call is refused. */
export function assertManagedToolSuccess(name: string, result: {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
  _meta?: unknown;
}, body: unknown): void {
  assert(!result.isError, JSON.stringify({ name, body, content: result.content,
    structuredContent: result.structuredContent, meta: result._meta }));
}
