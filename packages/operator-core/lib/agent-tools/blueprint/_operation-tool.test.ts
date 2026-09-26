import { describe, expect, it } from 'vitest';
import { checkHandleScope } from './_operation-tool';

type Scope = Parameters<typeof checkHandleScope>[0];
type Handle = Parameters<typeof checkHandleScope>[1];

describe('blueprint operation workspace scope', () => {
  it('accepts a handle from the caller workspace', () => {
    const scope = { workspaceId: 'consumer-a' } as Scope;
    const handle = { workspaceId: 'consumer-a' } as Handle;

    expect(() => checkHandleScope(scope, handle)).not.toThrow();
  });

  it('refuses a handle from another consumer workspace', () => {
    const scope = { workspaceId: 'consumer-a' } as Scope;
    const handle = { workspaceId: 'consumer-b' } as Handle;

    expect(() => checkHandleScope(scope, handle)).toThrow(/scope_mismatch:.*different workspace/);
  });
});
