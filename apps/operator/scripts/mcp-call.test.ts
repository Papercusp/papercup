import { describe, expect, it } from 'vitest';

import {
  buildMcpSessionQuery,
  isInvokedDirectly,
  parseArgs,
  // @ts-expect-error -- plain .mjs launcher script, no type declarations.
} from '../../../scripts/mcp-call.mjs';

describe('mcp-call argument parsing', () => {
  it('preserves the existing space-separated value flag form', () => {
    expect(parseArgs([
      'coord:whoami',
      '{}',
      '--client',
      'su-space',
      '--workspace',
      'papercusp-workspace',
      '--harness',
      'papercusp',
      '--port',
      '3170',
      '--raw',
    ])).toEqual({
      tool: 'coord:whoami',
      jsonArgs: '{}',
      flags: {
        client: 'su-space',
        workspace: 'papercusp-workspace',
        harness: 'papercusp',
        port: '3170',
        raw: true,
      },
    });
  });

  it('accepts equals-form value flags without consuming the next argument', () => {
    expect(parseArgs([
      'coord:whoami',
      '{}',
      '--client=su-equals',
      '--workspace=papercusp-workspace',
      '--harness=papercusp',
      '--port=3170',
      '--raw',
      'trailing-positional',
    ])).toEqual({
      tool: 'coord:whoami',
      jsonArgs: '{}',
      flags: {
        client: 'su-equals',
        workspace: 'papercusp-workspace',
        harness: 'papercusp',
        port: '3170',
        raw: true,
      },
    });
  });

  it('rejects an accidental value on the boolean raw flag', () => {
    expect(() => parseArgs(['coord:whoami', '--raw=true'])).toThrow('--raw does not take a value');
  });
});

describe('mcp-call result-format contract', () => {
  it('pins JSON so the maintained vmcall driver can validate successful output', () => {
    const query = buildMcpSessionQuery({
      client: 'vm-rig-probe',
      workspace: 'papercusp-workspace',
      harness: 'papercusp',
    });

    expect(Object.fromEntries(query)).toEqual({
      superuser: '1',
      client: 'vm-rig-probe',
      workspace: 'papercusp-workspace',
      format: 'json',
      harness: 'papercusp',
    });
  });

  it('runs when macOS canonicalizes /tmp to /private/tmp', () => {
    const canonical = '/private/tmp/mcp-call.mjs';
    const realpath = (path: string) =>
      path === '/tmp/mcp-call.mjs' ? canonical : path;

    expect(
      isInvokedDirectly(
        '/tmp/mcp-call.mjs',
        'file:///private/tmp/mcp-call.mjs',
        realpath,
      ),
    ).toBe(true);
  });

  it('does not run main when imported by a different script', () => {
    expect(
      isInvokedDirectly(
        '/workspace/vitest.mjs',
        'file:///workspace/scripts/mcp-call.mjs',
        (path: string) => path,
      ),
    ).toBe(false);
  });
});
