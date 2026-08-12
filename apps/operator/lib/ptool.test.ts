import { describe, it, expect, vi } from 'vitest';
import {
  parseArgs,
  serviceOf,
  groupTools,
  firstLine,
  normalizeType,
  promptSpecsFromSchema,
  coerceArg,
  mergeConvenienceArgs,
  prettyText,
  resultToText,
  buildMcpUrl,
  buildCallToolParams,
  listAllTools,
  PTOOL_LIST_TOOLS_TIMEOUT_MS,
  PTOOL_CALL_TOOL_TIMEOUT_MS,
  isLoopPressureShed,
  callToolWithPressureRetry,
  connectWithLocalRetry,
  resolveWorkspaceScope,
  jsonSourceKind,
  scriptSourceKind,
  shouldPrintInvocationLine,
  shouldPrintRawResult,
} from '../scripts/ptool.mjs';

describe('ptool parseArgs', () => {
  it('defaults to the interactive picker', () => {
    expect(parseArgs([])).toEqual({
      tool: null,
      json: null,
      jsonFile: null,
      script: null,
      scriptFile: null,
      list: false,
      listFilter: null,
      workspace: null,
      harness: null,
      raw: false,
      url: null,
      help: false,
    });
  });

  it('takes the first positional as the tool name', () => {
    expect(parseArgs(['harness:list']).tool).toBe('harness:list');
  });

  it('parses --json / --args as the args payload (= form)', () => {
    expect(parseArgs(['x:y', '--json={"a":1}']).json).toBe('{"a":1}');
    expect(parseArgs(['x:y', '--args={"a":1}']).json).toBe('{"a":1}');
  });

  it('parses value flags in the space-separated form', () => {
    expect(parseArgs(['x:y', '--json', '{"a":1}']).json).toBe('{"a":1}');
    const a = parseArgs(['x:y', '--workspace', 'ws1', '--harness', 'h', '--url', 'http://h:9']);
    expect(a).toMatchObject({ tool: 'x:y', workspace: 'ws1', harness: 'h', url: 'http://h:9' });
  });

  it('does not mistake a value-flag argument for the tool name', () => {
    // `{}` here is --json's value, not a positional tool name.
    expect(parseArgs(['--json', '{}', 'x:y']).tool).toBe('x:y');
    expect(parseArgs(['x:y', '--workspace', 'ws']).tool).toBe('x:y');
  });

  it('parses convenience + control flags', () => {
    const a = parseArgs(['x:y', '--workspace=ws1', '--harness=papercup', '--raw', '--url=http://h:9']);
    expect(a).toMatchObject({
      tool: 'x:y',
      workspace: 'ws1',
      harness: 'papercup',
      raw: true,
      url: 'http://h:9',
    });
  });

  it('treats a positional after --list as the catalog filter, not the tool', () => {
    const a = parseArgs(['--list', 'coord']);
    expect(a.list).toBe(true);
    expect(a.listFilter).toBe('coord');
    expect(a.tool).toBeNull();
  });

  it('recognizes help flags', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('parses --json-file (EI-14958: quoting-free JSON source)', () => {
    expect(parseArgs(['x:y', '--json-file=payload.json']).jsonFile).toBe('payload.json');
    expect(parseArgs(['x:y', '--json-file', 'payload.json']).jsonFile).toBe('payload.json');
  });

  it('parses --json - as the stdin sentinel, not a positional', () => {
    const a = parseArgs(['x:y', '--json', '-']);
    expect(a.json).toBe('-');
    expect(a.tool).toBe('x:y');
  });

  it('parses the quoting-safe code:run script sources', () => {
    expect(parseArgs(['code:run', '--script-file=batch.js'])).toMatchObject({
      tool: 'code:run',
      scriptFile: 'batch.js',
    });
    expect(parseArgs(['code:run', '--script', '-'])).toMatchObject({
      tool: 'code:run',
      script: '-',
    });
  });
});

describe('ptool workspace scope', () => {
  it('prefers an explicit workspace flag over session-derived scope', () => {
    expect(
      resolveWorkspaceScope({
        workspace: '  explicit-workspace  ',
        env: { PAPERCUSP_WORKSPACE: 'env-workspace' },
        cwd: '/tmp/.papercusp-workspaces/cwd-workspace/.papercusp',
      }),
    ).toBe('explicit-workspace');
  });

  it('uses PAPERCUSP_WORKSPACE when the CLI flag is absent', () => {
    expect(resolveWorkspaceScope({ env: { PAPERCUSP_WORKSPACE: '  env-workspace ' }, cwd: '/tmp' })).toBe('env-workspace');
  });

  it('recovers the workspace from PAPERCUSP_HOME after a warm wake drops PAPERCUSP_WORKSPACE', () => {
    expect(
      resolveWorkspaceScope({
        env: { PAPERCUSP_HOME: '/home/agent/.papercusp-workspaces/papercusp-workspace/.papercusp' },
        cwd: '/tmp/repo',
      }),
    ).toBe('papercusp-workspace');
  });

  it('also recovers from a workspace-scoped cwd', () => {
    expect(
      resolveWorkspaceScope({ env: {}, cwd: '/home/agent/.papercusp-workspaces/ws-9/.papercusp' }),
    ).toBe('ws-9');
  });

  it('does not guess a workspace outside a tracked workspace path', () => {
    expect(resolveWorkspaceScope({ env: {}, cwd: '/tmp/repo' })).toBeNull();
  });
});

describe('ptool jsonSourceKind (EI-14958)', () => {
  const base = { tool: 'x:y', json: null, jsonFile: null };

  it('returns null when no JSON source was given (prompt interactively)', () => {
    expect(jsonSourceKind(base)).toBeNull();
  });

  it('returns "inline" for a normal --json value', () => {
    expect(jsonSourceKind({ ...base, json: '{"a":1}' })).toBe('inline');
  });

  it('returns "inline" even for a payload containing an apostrophe — the caller decided how to carry it, ptool itself is fine either way', () => {
    expect(jsonSourceKind({ ...base, json: '{"copy":"it\'s fine"}' })).toBe('inline');
  });

  it('returns "stdin" for the --json - sentinel', () => {
    expect(jsonSourceKind({ ...base, json: '-' })).toBe('stdin');
  });

  it('returns "file" when --json-file is set', () => {
    expect(jsonSourceKind({ ...base, jsonFile: 'payload.json' })).toBe('file');
  });

  it('prefers --json-file over --json when (incorrectly) both are given', () => {
    expect(jsonSourceKind({ ...base, json: '{"a":1}', jsonFile: 'payload.json' })).toBe('file');
  });
});

describe('ptool scriptSourceKind (EI-20235746813390458)', () => {
  const base = { tool: 'code:run', script: null, scriptFile: null };

  it('returns null when no direct script source was given', () => {
    expect(scriptSourceKind(base)).toBeNull();
  });

  it('returns file for --script-file and prefers it over --script', () => {
    expect(scriptSourceKind({ ...base, scriptFile: 'batch.js' })).toBe('file');
    expect(scriptSourceKind({ ...base, script: 'inline', scriptFile: 'batch.js' })).toBe('file');
  });

  it('returns stdin for the --script - sentinel', () => {
    expect(scriptSourceKind({ ...base, script: '-' })).toBe('stdin');
  });

  it('keeps an explicitly supplied inline script as a distinct source', () => {
    expect(scriptSourceKind({ ...base, script: "return \'it\\'s safe\';" })).toBe('inline');
  });
});

describe('ptool invocation output mode (EI-20202581520430575)', () => {
  it('keeps the invocation line for interactive calls', () => {
    expect(shouldPrintInvocationLine(null)).toBe(true);
  });

  it('suppresses the invocation line for every scripted JSON source', () => {
    expect(shouldPrintInvocationLine('inline')).toBe(false);
    expect(shouldPrintInvocationLine('file')).toBe(false);
    expect(shouldPrintInvocationLine('stdin')).toBe(false);
  });

  it('routes every scripted JSON source through the raw extractor even without --raw', () => {
    expect(shouldPrintRawResult('inline', false)).toBe(true);
    expect(shouldPrintRawResult('file', false)).toBe(true);
    expect(shouldPrintRawResult('stdin', false)).toBe(true);
    expect(shouldPrintRawResult(null, false)).toBe(false);
    expect(shouldPrintRawResult(null, true)).toBe(true);
  });
});

describe('ptool loop-pressure admission retry (EI-20209060351693879)', () => {
  it('bounds every tools/call request so a saturated operator cannot hang the CLI indefinitely', async () => {
    const result = { content: [{ type: 'text', text: '{"ok":true}' }] };
    const params = { name: 'coord:send', arguments: {} };
    const callTool = vi.fn().mockResolvedValue(result);

    await expect(callToolWithPressureRetry({ callTool }, params)).resolves.toBe(result);
    expect(callTool).toHaveBeenCalledWith(
      params,
      undefined,
      { timeout: PTOOL_CALL_TOOL_TIMEOUT_MS, maxTotalTimeout: PTOOL_CALL_TOOL_TIMEOUT_MS },
    );
  });

  it('allows an explicitly unbounded tools/call request for a caller-owned long-running operation', async () => {
    const result = { content: [{ type: 'text', text: '{"ok":true}' }] };
    const callTool = vi.fn().mockResolvedValue(result);

    await expect(
      callToolWithPressureRetry({ callTool }, { name: 'testing:run', arguments: {} }, { timeoutMs: 0 }),
    ).resolves.toBe(result);
    expect(callTool).toHaveBeenCalledWith({ name: 'testing:run', arguments: {} }, undefined, undefined);
  });

  it('recognizes only the pre-dispatch critical-pressure shed signal', () => {
    expect(isLoopPressureShed(new Error('retryable: loop_pressure_critical'))).toBe(true);
    expect(isLoopPressureShed(new Error('operator event loop critically saturated — request shed'))).toBe(true);
    expect(isLoopPressureShed(new Error('tool failed after dispatch'))).toBe(false);
  });

  it('absorbs bounded pre-dispatch sheds and returns the eventual result', async () => {
    const result = { content: [{ type: 'text', text: '{"ok":true}' }] };
    const callTool = vi
      .fn()
      .mockRejectedValueOnce(new Error('loop_pressure_critical'))
      .mockRejectedValueOnce(new Error('operator event loop critically saturated'))
      .mockResolvedValue(result);
    const sleep = vi.fn(async () => {});

    await expect(
      callToolWithPressureRetry({ callTool }, { name: 'git-sync:run', arguments: {} }, { maxAttempts: 3, sleep }),
    ).resolves.toBe(result);
    expect(callTool).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('never retries an ambiguous error that may follow dispatch', async () => {
    const error = new Error('transport closed after tools/call');
    const callTool = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(async () => {});

    await expect(callToolWithPressureRetry({ callTool }, { name: 'x:y' }, { sleep })).rejects.toBe(error);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('ptool local operator connect retry (EI-20207246136942518)', () => {
  it('absorbs a bounded localhost restart window before any tool dispatch', async () => {
    const client = { close: vi.fn() };
    const connectOnce = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(client);
    const sleep = vi.fn(async () => {});

    await expect(
      connectWithLocalRetry(connectOnce, 'http://127.0.0.1:3170', { harness: 'papercusp' }, { maxAttempts: 3, sleep }),
    ).resolves.toBe(client);
    expect(connectOnce).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry a remote operator connection failure', async () => {
    const error = new Error('fetch failed');
    const connectOnce = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(async () => {});

    await expect(
      connectWithLocalRetry(connectOnce, 'https://operator.example.test', {}, { sleep }),
    ).rejects.toBe(error);
    expect(connectOnce).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('bounds a hung local handshake before retrying', async () => {
    const client = { close: vi.fn() };
    const connectOnce = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(client);
    const sleep = vi.fn(async () => {});

    await expect(
      connectWithLocalRetry(connectOnce, 'http://127.0.0.1:3170', {}, {
        maxAttempts: 2,
        attemptTimeoutMs: 1,
        sleep,
      }),
    ).resolves.toBe(client);
    expect(connectOnce).toHaveBeenCalledTimes(2);
    expect(connectOnce.mock.calls[0][2]).toEqual({ timeoutMs: 1 });
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe('ptool tool catalog request budget (EI-20224721374462856)', () => {
  it('passes a bounded request and total timeout to every tools/list page', async () => {
    const client = {
      listTools: vi
        .fn()
        .mockResolvedValueOnce({ tools: [{ name: 'first' }], nextCursor: 'next-page' })
        .mockResolvedValueOnce({ tools: [{ name: 'second' }] }),
    };

    await expect(listAllTools(client)).resolves.toEqual([{ name: 'first' }, { name: 'second' }]);
    expect(client.listTools).toHaveBeenNthCalledWith(
      1,
      {},
      { timeout: PTOOL_LIST_TOOLS_TIMEOUT_MS, maxTotalTimeout: PTOOL_LIST_TOOLS_TIMEOUT_MS },
    );
    expect(client.listTools).toHaveBeenNthCalledWith(
      2,
      { cursor: 'next-page' },
      { timeout: PTOOL_LIST_TOOLS_TIMEOUT_MS, maxTotalTimeout: PTOOL_LIST_TOOLS_TIMEOUT_MS },
    );
  });

  it('allows a caller-owned budget when explicitly set to zero', async () => {
    const client = { listTools: vi.fn().mockResolvedValue({ tools: [] }) };

    await expect(listAllTools(client, { timeoutMs: 0 })).resolves.toEqual([]);
    expect(client.listTools).toHaveBeenCalledWith({}, undefined);
  });
});

describe('ptool serviceOf / groupTools', () => {
  it('splits the service off the colon', () => {
    expect(serviceOf('work_items:list')).toBe('work_items');
    expect(serviceOf('papercusp:list_workspaces')).toBe('papercusp');
  });

  it('groups colon-less names under (misc)', () => {
    expect(serviceOf('weird')).toBe('(misc)');
  });

  it('groups + sorts services and tools', () => {
    const tools = [
      { name: 'harness:status', description: '' },
      { name: 'coord:send', description: '' },
      { name: 'harness:list', description: '' },
    ];
    const g = groupTools(tools);
    expect([...g.keys()]).toEqual(['coord', 'harness']);
    expect(g.get('harness').map((t) => t.name)).toEqual(['harness:list', 'harness:status']);
  });
});

describe('ptool firstLine', () => {
  it('returns the first non-empty line, truncated', () => {
    expect(firstLine('\n\nWhen to use: foo\nmore')).toBe('When to use: foo');
    expect(firstLine('a'.repeat(200), 10)).toBe('aaaaaaaaa…');
    expect(firstLine('')).toBe('');
    expect(firstLine(undefined)).toBe('');
  });
});

describe('ptool normalizeType', () => {
  it('passes through a plain type', () => {
    expect(normalizeType('string')).toBe('string');
  });
  it('drops null from a type union array', () => {
    expect(normalizeType(['string', 'null'])).toBe('string');
    expect(normalizeType(['null'])).toBeNull();
  });
  it('returns null for an absent type', () => {
    expect(normalizeType(undefined)).toBeNull();
  });
});

describe('ptool promptSpecsFromSchema', () => {
  it('classifies scalar kinds and marks required', () => {
    const schema = {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'the name' },
        count: { type: 'integer' },
        ratio: { type: 'number' },
        on: { type: 'boolean', default: true },
        mode: { enum: ['a', 'b'] },
      },
    };
    const specs = promptSpecsFromSchema(schema);
    const byName = Object.fromEntries(specs.map((s) => [s.name, s]));
    expect(byName.name).toMatchObject({ kind: 'string', required: true, description: 'the name' });
    expect(byName.count.kind).toBe('integer');
    expect(byName.ratio.kind).toBe('number');
    expect(byName.on).toMatchObject({ kind: 'boolean', default: true });
    expect(byName.mode).toMatchObject({ kind: 'enum', enumValues: ['a', 'b'] });
  });

  it('falls back to json for arrays, objects, and unions', () => {
    const schema = {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
        meta: { type: 'object' },
        either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
    };
    const kinds = Object.fromEntries(promptSpecsFromSchema(schema).map((s) => [s.name, s.kind]));
    expect(kinds).toEqual({ tags: 'json', meta: 'json', either: 'json' });
  });

  it('orders required props before optional ones', () => {
    const schema = {
      type: 'object',
      required: ['b'],
      properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } },
    };
    expect(promptSpecsFromSchema(schema).map((s) => s.name)).toEqual(['b', 'a', 'c']);
  });

  it('handles an empty / missing schema', () => {
    expect(promptSpecsFromSchema(undefined)).toEqual([]);
    expect(promptSpecsFromSchema({ type: 'object' })).toEqual([]);
  });
});

describe('ptool coerceArg', () => {
  it('coerces numbers and integers', () => {
    expect(coerceArg('number', '3.5')).toBe(3.5);
    expect(coerceArg('integer', '7')).toBe(7);
  });
  it('throws on malformed numbers', () => {
    expect(() => coerceArg('number', 'x')).toThrow(/not a number/);
    expect(() => coerceArg('integer', '3.5')).toThrow(/not an integer/);
  });
  it('parses json', () => {
    expect(coerceArg('json', '{"a":[1,2]}')).toEqual({ a: [1, 2] });
    expect(() => coerceArg('json', '{bad')).toThrow(/not valid JSON/);
  });
  it('passes strings, booleans, enums through', () => {
    expect(coerceArg('string', 'hi')).toBe('hi');
    expect(coerceArg('boolean', true)).toBe(true);
    expect(coerceArg('enum', 'a')).toBe('a');
  });
});

describe('ptool mergeConvenienceArgs', () => {
  const schema = { properties: { workspace: { type: 'string' }, harness: { type: 'string' }, x: { type: 'string' } } };

  it('injects workspace/harness only when the schema declares them', () => {
    expect(mergeConvenienceArgs({}, { workspace: 'ws', harness: 'h' }, schema)).toEqual({
      workspace: 'ws',
      harness: 'h',
    });
  });

  it('does not inject a flag the schema lacks', () => {
    const noHarness = { properties: { workspace: { type: 'string' } } };
    expect(mergeConvenienceArgs({}, { workspace: 'ws', harness: 'h' }, noHarness)).toEqual({ workspace: 'ws' });
  });

  it('existing args win over the convenience flags', () => {
    expect(mergeConvenienceArgs({ workspace: 'explicit' }, { workspace: 'flag' }, schema)).toEqual({
      workspace: 'explicit',
    });
  });

  it('ignores null flags', () => {
    expect(mergeConvenienceArgs({ x: 1 }, { workspace: null, harness: null }, schema)).toEqual({ x: 1 });
  });
});

describe('ptool buildMcpUrl', () => {
  it('carries the tracked psu session identity into the MCP client query', () => {
    const url = buildMcpUrl('http://127.0.0.1:9071', {
      workspace: 'papercusp-workspace',
      harness: 'papercusp',
      client: 'su-session-123',
    });
    expect(url.pathname).toBe('/api/mcp');
    expect(url.searchParams.get('superuser')).toBe('1');
    expect(url.searchParams.get('workspace')).toBe('papercusp-workspace');
    expect(url.searchParams.get('harness')).toBe('papercusp');
    expect(url.searchParams.get('client')).toBe('su-session-123');
  });

  it('omits client for an ordinary untracked terminal invocation', () => {
    expect(buildMcpUrl('http://127.0.0.1:9071').searchParams.has('client')).toBe(false);
  });
});

describe('ptool buildCallToolParams', () => {
  // EI-13245: the MCP SDK's Client.callTool throws "has an output schema but
  // did not return structured content" for any tool that advertises an
  // outputSchema unless the caller opts in via `_meta.structured` — the host
  // only fills structuredContent when explicitly asked. Array-rooted tools are
  // the opposite case: MCP's structuredContent validator rejects an array, so
  // ptool asks for lossless JSON text instead.
  it('requests structuredContent for an object-rooted output schema', () => {
    const params = buildCallToolParams(
      'work_items:burn_down',
      { harness: 'papercusp', ids: ['WI-1'] },
      { outputSchema: { type: 'object' } },
    );
    expect(params).toEqual({
      name: 'work_items:burn_down',
      arguments: { harness: 'papercusp', ids: ['WI-1'] },
      _meta: { structured: true },
    });
  });

  it('requests JSON text for an array-rooted list result', () => {
    expect(buildCallToolParams('work_items:list', { harness: 'papercusp' }, { outputSchema: { type: 'array' } })).toEqual({
      name: 'work_items:list',
      arguments: { harness: 'papercusp' },
      _meta: { format: 'json' },
    });
  });

  it('requests JSON text when a tool has no output schema', () => {
    expect(buildCallToolParams('harness:list', {})).toEqual({
      name: 'harness:list',
      arguments: {},
      _meta: { format: 'json' },
    });
  });
});

describe('ptool prettyText / resultToText', () => {
  it('pretty-prints JSON payloads, leaves plain text alone', () => {
    expect(prettyText('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyText('hello')).toBe('hello');
    expect(prettyText('{not json')).toBe('{not json');
    expect(prettyText('')).toBe('');
  });

  it('flattens an MCP content[] into text', () => {
    const result = { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] };
    expect(resultToText(result)).toBe('a\nb');
  });

  it('renders non-text content parts as JSON', () => {
    const result = { content: [{ type: 'image', data: 'x' }] };
    expect(resultToText(result)).toBe('{"type":"image","data":"x"}');
  });

  it('raw extraction drops MCP guidance appended after a complete JSON content item', () => {
    const result = {
      content: [
        { type: 'text', text: '{"ok":true,"state":"done"}' },
        { type: 'text', text: 'See also: work_items:get' },
      ],
    };
    expect(resultToText(result, { raw: true })).toBe('{"ok":true,"state":"done"}');
  });
});
