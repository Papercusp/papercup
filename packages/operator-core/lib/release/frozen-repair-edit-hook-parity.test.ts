import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  normalizeRepoPath,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';
import {
  frozenRepairEditWarning,
  projectFrozenRepairMarker,
  readFrozenRepairMarker,
  type FrozenRepairEditMarker,
} from './frozen-repair-edit-marker';
import { unwritablePath } from '../testing/unwritable-path';
// The installed hook is plain .mjs living outside this package on purpose (it runs detached
// from any repo). Importing it HERE is what makes the parity claim below checkable.
import {
  normalizeRepoPath as hookNormalizeRepoPath,
  warningFor as hookWarningFor,
  editedPathsFrom,
  hunksFrom as hookHunksFrom,
  repairRadius as hookRepairRadius,
  parseMcpToolResult,
  recordOneHunk,
  scratchUriToPath,
} from '../../../../apps/operator/scripts/hooks/cc/posttooluse-frozen-candidate-edit-nudge.mjs';
import { hunksFromToolCall } from './frozen-repair-edit-ledger';

/**
 * The corpus is deliberately nastier than real input. The hook goes silent whenever its
 * normalization disagrees with the gate's, and silence is indistinguishable from "no
 * collision" — so the drift this pins would present as the hook simply never firing.
 */
const PATH_CORPUS = [
  'packages/operator-core/lib/release/x.test.ts',
  './packages/operator-core/lib/release/x.test.ts',
  '/packages/operator-core/lib/release/x.test.ts',
  '///packages/operator-core/lib/release/x.test.ts',
  'packages\\operator-core\\lib\\release\\x.test.ts',
  '  packages/operator-core/lib/release/x.test.ts  ',
  './a.ts',
  'a.ts',
  '',
  '   ',
  './/nested/./path.ts',
  'apps/operator/lib/release/green-checkpoint.ts',
];

describe('hook/gate path-normalization parity (P-004)', () => {
  it('the hook normalizes every corpus path exactly as the gate does', () => {
    for (const path of PATH_CORPUS) {
      expect(hookNormalizeRepoPath(path), `disagreement on ${JSON.stringify(path)}`).toBe(
        normalizeRepoPath(path),
      );
    }
  });

  it('is a real check — a deliberately-wrong normalizer is caught by this corpus', () => {
    // Control: without this, the parity test above could pass vacuously if the corpus
    // happened to contain nothing the two implementations treat differently.
    const wrong = (v: string) => String(v ?? '').trim(); // drops ./, /, and \ handling
    const disagreements = PATH_CORPUS.filter((p) => wrong(p) !== normalizeRepoPath(p));
    expect(disagreements.length).toBeGreaterThan(0);
  });
});

const marker: FrozenRepairEditMarker = {
  candidate: 'c'.repeat(40),
  repairHead: 'r'.repeat(40),
  phase: 'repair-in-progress',
  failingPaths: ['packages/operator-core/lib/release/x.test.ts'],
  updatedAtMs: 1,
  admittedPaths: [],
  legs: [],
};

describe('hook/module warning parity', () => {
  it('agrees with the TS implementation on whether to warn, across the corpus', () => {
    for (const path of PATH_CORPUS) {
      const hookWarned = hookWarningFor(marker, path) !== null;
      const tsWarned = frozenRepairEditWarning(marker, path) !== null;
      expect(hookWarned, `disagreement on ${JSON.stringify(path)}`).toBe(tsWarned);
    }
  });

  it('warns on the failing path however it is spelled', () => {
    for (const spelling of [
      'packages/operator-core/lib/release/x.test.ts',
      './packages/operator-core/lib/release/x.test.ts',
      'packages\\operator-core\\lib\\release\\x.test.ts',
    ]) {
      expect(hookWarningFor(marker, spelling)).not.toBeNull();
    }
  });

  it('stays silent on a path outside the failing set', () => {
    expect(hookWarningFor(marker, 'packages/operator-core/lib/release/other.ts')).toBeNull();
    expect(frozenRepairEditWarning(marker, 'packages/operator-core/lib/release/other.ts')).toBeNull();
    expect(
      hookWarningFor(marker, 'packages/operator-core/lib/release/other.ts', { recorded: true }),
    ).toBeNull();
  });

  it('reports an outside-radius recording failure without radius admission guidance', () => {
    const warning =
      hookWarningFor(marker, 'packages/operator-core/lib/release/other.ts', {
        recorded: false,
        detail: 'HTTP 404',
      }) ?? '';
    expect(warning).toContain('NOT recorded');
    expect(warning).toContain('other.ts');
    expect(warning).not.toContain('WILL NOT REACH THE GATE');
    expect(warning).not.toContain('wholeBlob:true');
  });

  it('stays silent when nothing is frozen', () => {
    expect(hookWarningFor(null, 'packages/operator-core/lib/release/x.test.ts')).toBeNull();
    expect(frozenRepairEditWarning(null, 'packages/operator-core/lib/release/x.test.ts')).toBeNull();
  });
});

describe('P-005: the message names the CONSEQUENCE and the one command', () => {
  const msg = frozenRepairEditWarning(marker, 'packages/operator-core/lib/release/x.test.ts') ?? '';

  it('leads with the outcome, not the rule', () => {
    expect(msg).toContain('WILL NOT REACH THE GATE');
  });

  it('names the sanctioned command', () => {
    expect(msg).toContain("op:'admit'");
  });

  it('does NOT lean on the prose that already failed', () => {
    // "remember freeze-and-converge" is precisely the guidance this plan exists because
    // it did not hold; the message must not fall back to restating the regime.
    expect(msg.toLowerCase()).not.toContain('remember freeze-and-converge');
  });

  it('names the judged sha so the reader can check it themselves', () => {
    expect(msg).toContain(marker.repairHead.slice(0, 12));
  });

  it('warns off the two moves that make it worse', () => {
    expect(msg).toContain('release:checkpoint-run');
    expect(msg).toContain('retire');
  });
});

describe('marker projection round-trip', () => {
  const queue = (phase: string): FrozenCandidateRepairQueue =>
    ({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase,
      failingTests: ['./a/b.test.ts', 'a/b.test.ts', 'c/d.test.ts'],
      updatedAtMs: 7,
    }) as unknown as FrozenCandidateRepairQueue;

  it('writes normalized, de-duplicated paths and reads back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frozen-marker-'));
    const path = join(dir, 'marker.json');
    try {
      projectFrozenRepairMarker(queue('repair-in-progress'), path);
      const read = readFrozenRepairMarker(path);
      expect(read?.failingPaths).toEqual(['a/b.test.ts', 'c/d.test.ts']);
      expect(read?.repairHead).toBe('r'.repeat(40));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears the marker for a null queue, and for ready-to-test (no repair exists yet)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frozen-marker-'));
    const path = join(dir, 'marker.json');
    try {
      projectFrozenRepairMarker(queue('repair-in-progress'), path);
      expect(existsSync(path)).toBe(true);
      projectFrozenRepairMarker(queue('ready-to-test'), path);
      expect(existsSync(path)).toBe(false);

      projectFrozenRepairMarker(queue('repair-in-progress'), path);
      expect(existsSync(path)).toBe(true);
      projectFrozenRepairMarker(null, path);
      expect(existsSync(path)).toBe(false);
      expect(readFrozenRepairMarker(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws on an unwritable path — a fs fault must not fail a release write', () => {
    expect(() =>
      projectFrozenRepairMarker(queue('repair-in-progress'), unwritablePath('marker.json')),
    ).not.toThrow();
  });

  it('reads a corrupt marker as absent rather than crashing the hook', () => {
    expect(readFrozenRepairMarker('/definitely/not/a/marker.json')).toBeNull();
  });
});

describe('P-019 hook/module HUNK parity — the ledger writer and the replay reader agree on what an edit IS', () => {
  const CODEX_UPDATE_PATCH = [
    '*** Begin Patch',
    '*** Update File: /r/lib/codex.ts',
    '@@',
    '-old',
    '+new',
    '*** End Patch',
  ].join('\n');
  const CODEX_ADD_PATCH = [
    '*** Begin Patch',
    '*** Add File: /r/lib/added.ts',
    '+added',
    '*** End Patch',
  ].join('\n');
  const HUNK_CORPUS: Array<[string, unknown]> = [
    ['Edit', { file_path: '/r/lib/a.ts', old_string: 'o', new_string: 'n' }],
    ['Edit', { file_path: '/r/lib/a.ts', old_string: 'o', new_string: 'n', replace_all: true }],
    ['Write', { file_path: '/r/lib/a.ts', content: 'body\nbody' }],
    ['MultiEdit', { file_path: '/r/lib/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, 7, { old_string: 'c', new_string: 'd', replace_all: true }] }],
    ['mcp__papercusp-su__capability_edit', { file_path: 'lib/a.ts', old_string: 'o', new_string: 'n' }],
    ['mcp__papercusp-su__capability_write', { file_path: 'lib/a.ts', content: 'w' }],
    ['mcp__papercusp-su__capability_multi_edit', { file_path: 'lib/a.ts', edits: [{ old_string: 'x', new_string: 'y' }] }],
    ['write_file', { path: 'lib/a.ts', content: 'codex' }],
    ['edit_file', { path: 'lib/a.ts', old_string: 'o', new_string: 'n' }],
    ['apply_patch', CODEX_UPDATE_PATCH],
    ['apply_patch', { input: CODEX_ADD_PATCH }],
    ['apply_patch', 'diff --git a/x b/x'],
    ['apply_patch', { patch: '...' }],
    ['Edit', { file_path: '/r/lib/a.ts' }],
    ['Read', { file_path: '/r/lib/a.ts' }],
    ['Edit', null],
  ];
  it('extracts byte-identical hunks for every payload shape the matcher admits', () => {
    for (const [toolName, toolInput] of HUNK_CORPUS) {
      expect(hookHunksFrom({ tool_name: toolName, tool_input: toolInput }), `${toolName} ${JSON.stringify(toolInput)}`).toEqual(
        hunksFromToolCall(toolName, toolInput),
      );
    }
  });
  it('is a real check — a deliberately different extraction is caught', () => {
    const wrong = hunksFromToolCall('Edit', { file_path: 'a', old_string: 'o', new_string: 'n' }).map((h) => ({
      ...h,
      hunk: { ...h.hunk, replaceAll: true },
    }));
    expect(hookHunksFrom({ tool_name: 'Edit', tool_input: { file_path: 'a', old_string: 'o', new_string: 'n' } })).not.toEqual(wrong);
  });
  it("the hook's repair radius is the failing set ∪ every manifest leg's subject paths, normalized (a pre-P-022 marker: failing set only)", () => {
    const withLegs: FrozenRepairEditMarker = {
      ...marker,
      legs: [{ legId: 'lint:tsc', status: 'red', subjectPaths: ['./packages\\y\\src.ts', ''] }],
    };
    expect([...hookRepairRadius(withLegs)].sort()).toEqual(['packages/operator-core/lib/release/x.test.ts', 'packages/y/src.ts']);
    expect([...hookRepairRadius({ ...marker, legs: undefined as never })]).toEqual(['packages/operator-core/lib/release/x.test.ts']);
    // The nudge fires for a leg's subject path even though it is not a failing TEST path.
    expect(hookWarningFor(withLegs, 'packages/y/src.ts')).not.toBeNull();
    expect(hookWarningFor(withLegs, 'packages/y/other.ts')).toBeNull();
  });
  it('names the ledger outcome: recorded hunks, or an unrecorded edit that needs an explicit whole-blob exit', () => {
    const recorded = hookWarningFor(marker, 'packages/operator-core/lib/release/x.test.ts', { recorded: true }) ?? '';
    expect(recorded).toContain('RECORDED');
    expect(recorded).toContain("op:'admit'");
    const unrecorded = hookWarningFor(marker, 'packages/operator-core/lib/release/x.test.ts', { recorded: false, detail: 'HTTP 404' }) ?? '';
    expect(unrecorded).toContain('NOT recorded');
    expect(unrecorded).toContain('wholeBlob:true');
    expect(unrecorded.toLowerCase()).not.toContain("op:'converge'");
  });
});

describe('P-019 record-edit transport parsing and fallback', () => {
  const rpcResult = (inner: unknown) =>
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(inner) }] },
    });

  const recordArgs = {
    token: 'token',
    owner: 'owner-1',
    marker,
    path: 'packages/operator-core/lib/release/x.test.ts',
    hunk: { kind: 'edit' as const, old: 'old', new: 'new', replaceAll: false },
    toolUseId: 'tool-use-1',
    editIndex: 0,
    atMs: 7,
  };

  it('follows a reference output envelope to a spilled successful result', async () => {
    const parsed = await parseMcpToolResult(
      rpcResult({
        schemaVersion: 'papercusp.output-envelope/v1',
        state: 'incomplete',
        content: [{ kind: 'reference', uri: 'papercusp://scratch/result-door/result.json' }],
      }),
      {
        env: { PAPERCUSP_SCRATCH_ROOT: '/tmp/papercusp-scratch' },
        fileExists: (path: string) => path === '/tmp/papercusp-scratch/result-door/result.json',
        readSpill: async () => ({
          content: [
            { type: 'text', text: 'advisory text before payload' },
            { type: 'text', text: JSON.stringify({ ok: true, recorded: true, ledgerId: 22 }) },
          ],
        }),
      },
    );

    expect(parsed).toEqual({
      ok: true,
      inner: { ok: true, recorded: true, ledgerId: 22 },
    });
    expect(
      scratchUriToPath('papercusp://scratch/result-door/result.json', {
        PAPERCUSP_SCRATCH_ROOT: '/tmp/papercusp-scratch',
      }),
    ).toBe('/tmp/papercusp-scratch/result-door/result.json');
  });

  it('falls back from a release unknown-op response to staging and records the hunk', async () => {
    const calls: string[] = [];
    const result = await recordOneHunk({
      ...recordArgs,
      operatorUrl: 'http://127.0.0.1:3070',
      fetchImpl: async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        return new Response(
          calls.length === 1
            ? rpcResult({ ok: false, reason: 'unknown operation record-edit' })
            : rpcResult({ ok: true, recorded: true, ledgerId: 23 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    expect(result.recorded).toBe(true);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]).port).toBe('3070');
    expect(new URL(calls[1]).port).toBe('3170');
  });

  it('falls back from a release transport failure to staging and records the hunk', async () => {
    const calls: string[] = [];
    const result = await recordOneHunk({
      ...recordArgs,
      operatorUrl: 'http://127.0.0.1:3070',
      fetchImpl: async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        if (calls.length === 1) {
          throw new TypeError('fetch failed: ECONNREFUSED');
        }
        return new Response(rpcResult({ ok: true, recorded: true, ledgerId: 24 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(result.recorded).toBe(true);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]).port).toBe('3070');
    expect(new URL(calls[1]).port).toBe('3170');
  });

  it('does not retry a transport failure when the hook has no stable tool-use key', async () => {
    const calls: string[] = [];
    const result = await recordOneHunk({
      ...recordArgs,
      toolUseId: '',
      operatorUrl: 'http://127.0.0.1:3070',
      fetchImpl: async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        throw new TypeError('fetch failed: ECONNREFUSED');
      },
    });

    expect(result.recorded).toBe(false);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]).port).toBe('3070');
  });

  it('does not fall back for an ordinary refusal', async () => {
    const calls: string[] = [];
    const result = await recordOneHunk({
      ...recordArgs,
      operatorUrl: 'http://127.0.0.1:3070',
      fetchImpl: async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        return new Response(rpcResult({ ok: false, reason: 'unauthorized' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(result.recorded).toBe(false);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]).port).toBe('3070');
  });
});

describe('editedPathsFrom covers the payload shapes the matcher admits', () => {
  it('reads a single-file Edit/Write payload', () => {
    expect(editedPathsFrom({ tool_input: { file_path: 'a.ts' } })).toEqual(['a.ts']);
  });

  it('reads every path of a MultiEdit payload', () => {
    expect(
      editedPathsFrom({ tool_input: { edits: [{ file_path: 'a.ts' }, { file_path: 'b.ts' }] } }),
    ).toEqual(['a.ts', 'b.ts']);
  });

  it('reads Codex apply_patch paths from raw and wrapped patch input', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: /r/a.ts',
      '@@',
      '-old',
      '+new',
      '*** Add File: /r/b.ts',
      '+new',
      '*** End Patch',
    ].join('\n');
    expect(editedPathsFrom({ tool_name: 'apply_patch', tool_input: patch })).toEqual(['/r/a.ts', '/r/b.ts']);
    expect(editedPathsFrom({ tool_name: 'apply_patch', tool_input: { input: patch } })).toEqual(['/r/a.ts', '/r/b.ts']);
  });

  it('returns nothing for a malformed payload instead of throwing', () => {
    expect(editedPathsFrom(undefined)).toEqual([]);
    expect(editedPathsFrom({})).toEqual([]);
    expect(editedPathsFrom({ tool_input: { edits: 'nope' } })).toEqual([]);
  });
});
