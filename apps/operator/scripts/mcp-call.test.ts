import { describe, expect, it } from 'vitest';

import {
  buildMcpSessionQuery,
  isInvokedDirectly,
  parseArgs,
  jsonSourceKind,
  readJsonArgs,
  resolveMcpClientId,
  resolveMcpWorkspace,
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

  it('accepts the help flags without treating them as unknown options', () => {
    expect(parseArgs(['--help'])).toEqual({
      tool: undefined,
      jsonArgs: undefined,
      flags: { help: true },
    });
    expect(parseArgs(['-h'])).toEqual({
      tool: undefined,
      jsonArgs: undefined,
      flags: { help: true },
    });
  });

  // WI-41249. The reader-only tests below pass `flags: { jsonFile }` by hand, so
  // they proved readJsonArgs worked while the parser was emitting `flags['json-file']`
  // and `--json-file` silently sent EMPTY args. Only an end-to-end assertion over the
  // parser/reader SEAM can catch that, so these drive the real CLI spelling.
  it('routes the kebab-cased --json-file through to the reader (space form)', () => {
    const parsed = parseArgs(['work_items:get', '--json-file', 'payload.json']);
    expect(parsed.flags.jsonFile).toBe('payload.json');
    expect(jsonSourceKind(parsed)).toBe('file');

    const seen: Array<[unknown, unknown]> = [];
    const readFile = (path: unknown, encoding: unknown) => {
      seen.push([path, encoding]);
      return '{"id":"EI-1750"}';
    };
    expect(readJsonArgs(parsed, { readFile })).toEqual({ id: 'EI-1750' });
    expect(seen).toEqual([['payload.json', 'utf8']]);
  });

  it('routes the kebab-cased --json-file through to the reader (equals form)', () => {
    const parsed = parseArgs(['work_items:get', '--json-file=payload.json']);
    expect(parsed.flags.jsonFile).toBe('payload.json');
    expect(jsonSourceKind(parsed)).toBe('file');
  });

  it('never degrades an explicit flag into empty args: unknown flags throw', () => {
    expect(() => parseArgs(['coord:whoami', '--jsonfile', 'payload.json']))
      .toThrow('unknown flag --jsonfile');
    expect(() => parseArgs(['coord:whoami', '--nope=1'])).toThrow(/accepted flags/);
  });

  it('rejects a value flag with no value instead of storing undefined', () => {
    expect(() => parseArgs(['work_items:get', '--json-file'])).toThrow('--json-file requires a value');
  });

  it('accepts --all-workspaces as the explicit unscoped transport flag', () => {
    const parsed = parseArgs(['knowledge_packs:list', '--all-workspaces']);
    expect(parsed.flags.allWorkspaces).toBe(true);
    expect(resolveMcpWorkspace(parsed.flags, { PAPERCUSP_WORKSPACE: 'papercusp-workspace' }))
      .toBe('*');
  });

  it('rejects contradictory scoped and unscoped workspace flags', () => {
    expect(() => resolveMcpWorkspace(
      { allWorkspaces: true, workspace: 'papercusp-workspace' },
      {},
    )).toThrow('--all-workspaces cannot be combined with --workspace');
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

  it('maps --all-workspaces to the unscoped workspace wildcard', () => {
    const query = buildMcpSessionQuery({
      client: 'vm-rig-probe',
      workspace: 'papercusp-workspace',
      allWorkspaces: true,
    });

    expect(query.get('workspace')).toBe('*');
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

describe('mcp-call client identity', () => {
  it('keeps the same launch identity across helper processes', () => {
    const env = { PAPERCUSP_SPAWN_ID: 'content-fixer-spawn-42' };

    expect(resolveMcpClientId({}, env, 101)).toBe('content-fixer-spawn-42');
    expect(resolveMcpClientId({}, env, 202)).toBe('content-fixer-spawn-42');
  });

  it('preserves explicit and full-session identities ahead of the spawn fallback', () => {
    const env = {
      PAPERCUSP_SID: 'su-session',
      PAPERCUSP_SPAWN_ID: 'content-fixer-spawn-42',
    };

    expect(resolveMcpClientId({ client: 'explicit-client' }, env, 101)).toBe('explicit-client');
    expect(resolveMcpClientId({ client: '   ' }, env, 101)).toBe('su-session');
  });

  it('retains the per-process fallback for an ordinary terminal', () => {
    expect(resolveMcpClientId({}, {}, 303)).toBe('mcp-call-303');
  });
});

describe('mcp-call shell-safe JSON input', () => {
  it('keeps the legacy positional JSON source', () => {
    expect(jsonSourceKind({ jsonArgs: '{}', flags: {} })).toBe('inline');
    expect(readJsonArgs({ jsonArgs: '{"message":"it\'s safe"}', flags: {} })).toEqual({
      message: "it's safe",
    });
  });

  it('reads JSON from stdin when --json - is used', () => {
    expect(jsonSourceKind({ jsonArgs: undefined, flags: { json: '-' } })).toBe('stdin');
    const readFile = (path: number | string) => {
      expect(path).toBe(0);
      return '{"message":"it\'s safe"}';
    };
    expect(readJsonArgs({ jsonArgs: undefined, flags: { json: '-' } }, { readFile })).toEqual({
      message: "it's safe",
    });
  });

  it('reads JSON from a file and gives the file source precedence', () => {
    expect(jsonSourceKind({ jsonArgs: '{}', flags: { jsonFile: 'payload.json', json: '{}' } })).toBe('file');
    const readFile = (path: number | string) => {
      expect(path).toBe('payload.json');
      return '{"message":"it\'s safe"}';
    };
    expect(readJsonArgs({ jsonArgs: '{}', flags: { jsonFile: 'payload.json', json: '{}' } }, { readFile })).toEqual({
      message: "it's safe",
    });
  });

  it('reports malformed safe-source JSON instead of dispatching it', () => {
    expect(() => readJsonArgs(
      { jsonArgs: undefined, flags: { json: '-' } },
      { readFile: () => '{not-json' },
    )).toThrow('stdin is not valid JSON');
  });
});
