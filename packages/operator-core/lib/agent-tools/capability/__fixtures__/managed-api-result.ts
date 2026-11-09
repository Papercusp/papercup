import assert from 'node:assert/strict';

/** Bounded probes of the excluded local authorization surface, not an inventory
 * of every possible spelling or evidence that an installed client journey ran. */
export const excludedRecoveryTools = ['capability:offline_recovery', 'capability:local_recovery',
  'capability:recovery'] as const;

export function assertManagedRecoveryRefusal(name: string, result: {
  isError?: boolean;
  content?: unknown;
}, before: string, after: string): void {
  assert.equal(result.isError, true, 'Excluded recovery request must be explicitly refused');
  const content = Array.isArray(result.content) ? result.content : [];
  assert.ok(content.some(part => part?.type === 'text' && typeof part.text === 'string'
    && part.text.startsWith(`unknown_tool: no tool named "${name}".`)),
  'Refusal must identify the requested absent route, not an auth, build or transport failure');
  assert.equal(after, before, 'Excluded recovery request changed its effect control');
}

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

/** Close the private venue before checking assertions that require a successful run. */
export async function finishManagedApiTeardown(options: {
  hasProof: boolean;
  rowCount: number;
  cleanupErrors: unknown[];
  close: ReadonlyArray<() => Promise<unknown>>;
}): Promise<void> {
  for (const close of options.close) {
    try { await close(); }
    catch (error) { options.cleanupErrors.push(error); }
  }
  assert.equal(options.cleanupErrors.length, 0,
    String(new AggregateError(options.cleanupErrors, 'Owned resource cleanup failed')));
  if (options.hasProof) assert.equal(options.rowCount, 1,
    'Refused PTY must create no task row; one owned browser is expected');
}
