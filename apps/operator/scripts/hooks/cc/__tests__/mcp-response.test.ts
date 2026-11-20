import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_DIR = join(HERE, '..');
const HELPER = join(HOOK_DIR, 'mcp_response.py');
const TARGET_HOOKS = [
  'pretooluse-locks-acquire.sh',
  'pretooluse-plans-read-guard.sh',
  'posttooluse-activity-report.sh',
  'userpromptsubmit-provenance.sh',
];
const ACTIVITY_REPORT_HOOKS = [
  'lifecycle-report.sh',
  'pretooluse-activity-report.sh',
  'posttooluse-activity-report.sh',
  'pretooluse-bash-resource-gate.sh',
  'workitem-verify-nudge.sh',
];

function parse(raw: string, env: Record<string, string> = {}): { inner: unknown; error: unknown; phase: string } {
  const script = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'from mcp_response import parse_mcp_response',
    'inner, error, phase = parse_mcp_response(sys.stdin.read())',
    'print(json.dumps({"inner": inner, "error": error, "phase": phase}, sort_keys=True))',
  ].join('\n');
  return JSON.parse(
    execFileSync('python3', ['-c', script, HOOK_DIR], {
      input: raw,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    }),
  ) as { inner: unknown; error: unknown; phase: string };
}

function withNativeSession(url: string, sessionId: string): string {
  const script = [
    'import sys',
    'sys.path.insert(0, sys.argv[1])',
    'from mcp_response import with_native_session',
    'print(with_native_session(sys.argv[2], sys.argv[3]))',
  ].join('\n');
  return execFileSync('python3', ['-c', script, HOOK_DIR, url, sessionId], { encoding: 'utf8' }).trim();
}

describe('shared CC MCP response parser', () => {
  it('rejects the measured HTTP-200 result.isError envelope instead of exposing its text as a decision', () => {
    const response = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_input' }) }],
        isError: true,
      },
    };
    expect(parse(JSON.stringify(response))).toEqual({
      inner: null,
      error: response.result,
      phase: 'is-error',
    });
  });

  it('parses a successful JSON response and an SSE-framed response', () => {
    const response = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, value: 7 }) }] },
    };
    expect(parse(JSON.stringify(response))).toEqual({
      inner: { ok: true, value: 7 },
      error: null,
      phase: 'ok',
    });
    expect(parse(`event: message\ndata: ${JSON.stringify(response)}\n\n`)).toEqual({
      inner: { ok: true, value: 7 },
      error: null,
      phase: 'ok',
    });
  });

  it('unwraps inline result-door envelopes before returning the tool result', () => {
    const grant = { ok: true, lock_id: 'inline-lock' };
    const envelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      content: [
        { type: 'text', text: 'See also: locks:release' },
        { type: 'text', text: JSON.stringify(grant) },
      ],
    };
    const response = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(envelope) }] },
    };

    expect(parse(JSON.stringify(response))).toEqual({ inner: grant, error: null, phase: 'ok' });
  });

  it('unwraps a spilled result-door grant from its validated scratch reference, not its preview', () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'mcp-response-spill-'));
    const relative = ['workspace', 'locks:acquire', 'run-id', 'result.spill'];
    const spillPath = join(scratchRoot, ...relative);
    const grant = { ok: true, lock_id: 'spilled-lock' };
    const spilledPayload = {
      content: [
        { type: 'text', text: 'See also: locks:release' },
        { type: 'text', text: JSON.stringify(grant) },
      ],
    };
    const envelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      content: [{
        kind: 'reference',
        uri: `papercusp://scratch/${relative.join('/')}`,
        preview: '{"ok":false,"reason":"preview is not authoritative"}',
      }],
    };
    const response = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(envelope) }] },
    };

    try {
      mkdirSync(dirname(spillPath), { recursive: true });
      writeFileSync(spillPath, `result-door magic\nmanifest\n${JSON.stringify(spilledPayload)}\n`);
      expect(parse(JSON.stringify(response), { PAPERCUSP_SCRATCH_ROOT: scratchRoot })).toEqual({
        inner: grant,
        error: null,
        phase: 'ok',
      });
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it('does not trust a missing spill or its preview as a tool result', () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'mcp-response-missing-spill-'));
    const envelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      content: [{
        kind: 'reference',
        uri: 'papercusp://scratch/workspace/locks:acquire/run-id/result.spill',
        preview: '{"ok":true,"lock_id":"preview-only"}',
      }],
    };
    const response = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(envelope) }] },
    };

    try {
      expect(parse(JSON.stringify(response), { PAPERCUSP_SCRATCH_ROOT: scratchRoot })).toEqual({
        inner: null,
        error: null,
        phase: 'no-text',
      });
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it('preserves JSON-RPC errors and classifies missing content', () => {
    const rpcError = { code: -32602, message: 'invalid args' };
    expect(parse(JSON.stringify({ jsonrpc: '2.0', id: 1, error: rpcError }))).toEqual({
      inner: null,
      error: rpcError,
      phase: 'rpc-error',
    });
    expect(parse(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }))).toEqual({
      inner: null,
      error: null,
      phase: 'no-text',
    });
  });

  it('makes all four sibling hooks import the shared parser', () => {
    for (const hook of TARGET_HOOKS) {
      expect(readFileSync(join(HOOK_DIR, hook), 'utf8'), hook).toContain(
        'from mcp_response import parse_mcp_response',
      );
    }
    expect(readFileSync(join(HOOK_DIR, 'pretooluse-locks-acquire.sh'), 'utf8')).not.toContain(
      'def _parse_mcp_response',
    );
  });
});

describe('shared CC native-session MCP URL context', () => {
  it('preserves existing query values, safely encodes the native id, and replaces stale duplicates', () => {
    const url = withNativeSession(
      'http://operator.test/api/mcp?superuser=1&origin=hook&client=su-1&native_session=stale&native_session=older',
      'native session/+1',
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get('superuser')).toBe('1');
    expect(parsed.searchParams.get('origin')).toBe('hook');
    expect(parsed.searchParams.get('client')).toBe('su-1');
    expect(parsed.searchParams.getAll('native_session')).toEqual(['native session/+1']);
  });

  it('leaves the request unchanged when no native id is available', () => {
    const url = 'http://operator.test/api/mcp?superuser=1&client=su-1';
    expect(withNativeSession(url, '')).toBe(url);
  });

  it.each(ACTIVITY_REPORT_HOOKS)('%s uses the shared URL helper for activity:report', (file) => {
    const source = readFileSync(join(HOOK_DIR, file), 'utf8');
    expect(source).toContain('with_native_session');
    expect(source).toContain("'activity:report'");
    expect(source).toMatch(/native_session_id\s*=|session_id\s+or\s+os\.environ/);
  });
});


describe('scoped feasibility patch grammar', () => {
  const ROOT = join(HERE, '../../../../../..');
  const frame = (...operations: string[]) => ['*** Begin Patch', ...operations, '*** End Patch'].join('\n');
  const add = (path: string) => `*** Add File: ${path}\n+literal content`;
  const update = (path: string) => `*** Update File: ${path}\n@@\n-old\n+new`;
  const move = (source: string, destination: string) =>
    `*** Update File: ${source}\n*** Move to: ${destination}\n@@\n-old\n+new`;
  const valid = [
    frame(add("fixtures/new 'file.txt"), update('tests/current.test.ts'),
      '*** Delete File: fixtures/obsolete.txt', move('fixtures/old.txt', 'fixtures/moved.txt')),
    frame('*** Add File: fixtures/header.txt\n+*** Update File: content-is-not-an-operation'),
    frame('*** Update File: tests/a.test.ts\n@@ first context\n same\n-old\n+new\n@@\n-a\n+b\n*** End of File'),
    frame('*** Add File: fixtures/empty.txt'),
    frame(add('fixtures/ trailing space ')),
  ];
  const invalid = [
    '', '*** Begin Patch\n*** End Patch', frame('*** Unknown File: a\n+x'),
    frame('*** Add File: a\nunprefixed'), frame('*** Update File: a\n@@'),
    frame('*** Update File: a\n@@\n context only'), frame('*** Update File: a\n@@bad\n-x\n+y'),
    frame('*** Update File: a\n@@\n-x\nraw'), frame('*** Update File: a\n*** Move to: b'),
    frame(add('a')) + '\ntrailing', frame(add('a')) + '\n\n',
    'prefix\n' + frame(add('a')), frame(add('a'), '*** Begin Patch'),
    frame('*** Move to: orphan'), frame(add('a'), '*** Move to: orphan'),
    frame(add('a'), add('a')), frame(update('a'), '*** Delete File: a'),
    frame(move('a', 'b'), add('b')), frame(move('a', 'a')),
    frame(add('b'), move('a', 'b')), frame('*** Delete File: a\n+unexpected'),
    frame('*** Update File: a\n@@\n-x\n+y\n*** End of File\n@@\n-a\n+b'),
    frame('*** Add File: '), frame(add('nul\0target')),
  ];

  function imported(patch: unknown): { parsed: import('../../../../../../packages/operator-core/lib/agent-tools/plans/plan-execution-guard').ScopedPatchParse; paths: string[] } {
    const script = [
      'import json, sys',
      'sys.path.insert(0, sys.argv[1])',
      'from mcp_response import parse_codex_apply_patch, codex_apply_patch_paths',
      'patch = json.loads(sys.stdin.read())',
      'print(json.dumps({"parsed": parse_codex_apply_patch(patch), "paths": codex_apply_patch_paths(patch)}))',
    ].join('\n');
    return JSON.parse(execFileSync('python3', ['-c', script, HOOK_DIR], {
      input: JSON.stringify(patch), encoding: 'utf8',
    }));
  }

  it('accepts complete ordered Add Update Delete Move operations', () => {
    const result = imported(valid[0]);
    expect(result.parsed).toEqual({
      complete: true,
      operations: [
        { kind: 'add', destination: "fixtures/new 'file.txt" },
        { kind: 'update', source: 'tests/current.test.ts' },
        { kind: 'delete', source: 'fixtures/obsolete.txt' },
        { kind: 'move', source: 'fixtures/old.txt', destination: 'fixtures/moved.txt' },
      ],
      targets: ["fixtures/new 'file.txt", 'tests/current.test.ts', 'fixtures/obsolete.txt',
        'fixtures/old.txt', 'fixtures/moved.txt'],
      errors: [],
    });
    expect(result.paths).toEqual(result.parsed.targets);
    for (const patch of valid) expect(imported(patch).parsed.complete).toBe(true);
    expect(imported(valid[0]!.replaceAll('\n', '\r\n') + '\r\n').parsed).toEqual(result.parsed);
  });

  it('rejects malformed frames hunks and unknown operations', () => {
    for (const patch of [...invalid, null, { patch: valid[0] }]) {
      const result = imported(patch);
      expect(result.parsed.complete, JSON.stringify(patch)).toBe(false);
      expect(result.parsed.operations).toEqual([]);
      expect(result.parsed.targets).toEqual([]);
      expect(result.paths).toEqual([]);
      expect(result.parsed.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects trailing input extra headers and orphan Move', () => {
    for (const patch of [valid[0] + '\nmore', frame(add('a'), '*** End Patch'),
      frame('*** Move to: b'), frame(add('a'), '*** Move to: b')]) {
      expect(imported(patch).parsed).toMatchObject({ complete: false, operations: [], targets: [] });
    }
  });

  it('rejects duplicate operations and source destination conflicts', () => {
    for (const patch of [frame(add('a'), add('a')), frame(update('a'), '*** Delete File: a'),
      frame(move('a', 'b'), update('b')), frame(add('b'), move('a', 'b')), frame(move('a', 'a'))]) {
      expect(imported(patch).parsed).toMatchObject({ complete: false, operations: [], targets: [] });
    }
  });

  it('matches ordered Python and TypeScript consumer results', async () => {
    const { readScopedFeasibilityPatch } = await import('../../../../../../packages/operator-core/lib/agent-tools/plans/plan-execution-guard');
    for (const patch of [...valid, ...invalid]) {
      expect(await readScopedFeasibilityPatch(patch, ROOT), patch).toEqual(imported(patch).parsed);
    }
  });

  it('rejects helper failure and malformed protocol responses', async () => {
    const { readScopedFeasibilityPatch } = await import('../../../../../../packages/operator-core/lib/agent-tools/plans/plan-execution-guard');
    const good = imported(valid[0]).parsed;
    const bad = [
      'not JSON', '{}', JSON.stringify({ ...good, extra: true }),
      JSON.stringify({ ...good, complete: false }), JSON.stringify({ ...good, targets: [...good.targets].reverse() }),
      JSON.stringify({ ...good, operations: [{ kind: 'unknown', source: 'a' }] }),
      JSON.stringify({ ...good, errors: [{ line: -1, message: 'bad' }] }),
      JSON.stringify({ complete: false, operations: [], targets: ['prefix'], errors: [{ line: 0, message: 'bad' }] }),
    ];
    for (const response of bad) {
      expect(await readScopedFeasibilityPatch(valid[0], ROOT, async () => response))
        .toMatchObject({ complete: false, operations: [], targets: [] });
    }
    expect(await readScopedFeasibilityPatch(valid[0], ROOT, async () => { throw new Error('reader failed'); }))
      .toMatchObject({ complete: false, operations: [], targets: [], errors: [{ message: 'reader failed' }] });
    expect(await readScopedFeasibilityPatch(valid[0], join(ROOT, 'missing-helper-root')))
      .toMatchObject({ complete: false, operations: [], targets: [] });
  });

  it('preserves the complete large operation population and rejects a decisive final conflict', async () => {
    const { readScopedFeasibilityPatch } = await import('../../../../../../packages/operator-core/lib/agent-tools/plans/plan-execution-guard');
    const operations = Array.from({ length: 2049 }, (_, i) => add(`fixtures/entry-${i}.txt`));
    const parsed = await readScopedFeasibilityPatch(frame(...operations), ROOT);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets).toEqual(operations.map((_, i) => `fixtures/entry-${i}.txt`));
    expect(await readScopedFeasibilityPatch(frame(...operations, update('fixtures/entry-2048.txt')), ROOT))
      .toMatchObject({ complete: false, operations: [], targets: [] });
  });
});
