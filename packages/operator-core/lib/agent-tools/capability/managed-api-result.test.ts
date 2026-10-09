import { describe, expect, it } from 'vitest';
import { assertManagedToolSuccess } from './__fixtures__/managed-api-result';

describe('managed HTTP acceptance failure evidence', () => {
  it('keeps a plain-text refusal when no JSON body exists', () => {
    const message = 'tool_error: systemd-run refused: Failed to connect to bus';
    expect(() => assertManagedToolSuccess('capability:pty_open', {
      isError: true, content: [{ type: 'text', text: message }],
    }, null)).toThrow(message);
  });

  it('keeps structured and media evidence alongside the rejected operation', () => {
    let caught: unknown;
    try {
      assertManagedToolSuccess('capability:fetch', {
        isError: true,
        content: [{ type: 'resource', resource: { uri: 'papercusp://scratch/owned-ref' } }],
        structuredContent: { reason: 'browser_operation_aborted' },
        _meta: { stage: 'launch' },
      }, { ok: false });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    const evidence = JSON.parse((caught as Error).message);
    expect(evidence).toMatchObject({ name: 'capability:fetch', body: { ok: false },
      content: [{ resource: { uri: 'papercusp://scratch/owned-ref' } }],
      structuredContent: { reason: 'browser_operation_aborted' }, meta: { stage: 'launch' } });
  });

  it('accepts successful non-text results without requiring a JSON body', () => {
    expect(() => assertManagedToolSuccess('capability:pty_read_screen', {
      content: [{ type: 'resource', resource: { text: 'terminal screen' } }],
    }, null)).not.toThrow();
  });
});
