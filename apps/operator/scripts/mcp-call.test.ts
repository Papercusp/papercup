import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain .mjs launcher script, no type declarations.
import { parseArgs } from '../../../scripts/mcp-call.mjs';

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
