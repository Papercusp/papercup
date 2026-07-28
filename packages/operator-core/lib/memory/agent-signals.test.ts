/**
 * Tests for the ACTION-derived agent-signal resolver
 * (context-injection-audit-2026-07-28 P-043 / F-K).
 *
 * The load-bearing test in this file is the PROSE-LEAK TRIPWIRE. P-043's whole
 * design point is that signals come from actions, never from the agent's own
 * prose — because prose creates the self-confirmation loop (the agent asserts X,
 * retrieval returns X, the agent asserts more X). The agent's richest prose
 * reaches `tool_invocations` as ordinary tool arguments (`loop:checkpoint`'s
 * did/left/insight/next, `work_items:checkpoint`'s body, `coord:orient`'s
 * intent), so "no prose leaked" is a property that must be TESTED, not assumed
 * from an allowlist someone could later widen by one careless key.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildAgentSignals,
  extractTrajectory,
  effectiveCall,
  normalizeToolName,
  relativizeRepoPath,
  resolveAgentSignals,
  MAX_PATHS,
  MAX_IDS,
  MAX_BODY_CHARS,
  type RawInvocation,
  type AgentSignalsSource,
} from './agent-signals';

const REPO = '/home/agent/papercusp';

/** An `activity:report` row wrapping a real client-side call. */
const report = (tool: string, input: unknown): RawInvocation => ({
  toolName: 'activity:report',
  args: { tool_name: tool, tool_input: input, session_id: 's1', owner: 'su-1' },
});

describe('normalizeToolName', () => {
  it('strips the MCP client mangling and folds the colon form to match it', () => {
    expect(normalizeToolName('mcp__papercusp-su__work_items_get')).toBe('work_items_get');
    expect(normalizeToolName('work_items:get')).toBe('work_items_get');
    // The two forms of the same tool must compare equal — that is the point.
    expect(normalizeToolName('mcp__papercusp-su__work_items_get')).toBe(
      normalizeToolName('work_items:get'),
    );
    expect(normalizeToolName('mcp__claude-in-chrome__navigate')).toBe('navigate');
    expect(normalizeToolName('Edit')).toBe('edit');
  });
});

describe('effectiveCall', () => {
  it('unwraps activity:report to the REAL nested call', () => {
    // This is the measured trap: the agent's file-touching calls are nested
    // inside the telemetry wrapper, not top-level rows.
    expect(effectiveCall(report('Edit', { file_path: 'a.ts' }))).toEqual({
      tool: 'edit',
      input: { file_path: 'a.ts' },
    });
  });

  it('passes a non-wrapper row through unchanged', () => {
    expect(effectiveCall({ toolName: 'locks:acquire', args: { paths: ['a.ts'] } })).toEqual({
      tool: 'locks_acquire',
      input: { paths: ['a.ts'] },
    });
  });

  it('returns null for a wrapper with no inner tool', () => {
    expect(effectiveCall({ toolName: 'activity:report', args: { session_id: 's' } })).toBeNull();
    expect(effectiveCall({ toolName: 'activity:report', args: null })).toBeNull();
  });
});

describe('relativizeRepoPath', () => {
  it('makes a repo-absolute path repo-relative', () => {
    expect(relativizeRepoPath(`${REPO}/packages/operator-core/lib/memory/injection.ts`, REPO)).toBe(
      'packages/operator-core/lib/memory/injection.ts',
    );
  });

  it('drops paths outside the repo — they can never match the corpus', () => {
    expect(relativizeRepoPath('/tmp/papercup-green-checkpoint.log', REPO)).toBeNull();
    expect(relativizeRepoPath('/etc/hosts', REPO)).toBeNull();
    // An absolute path under no recognized system prefix is still not ours.
    expect(relativizeRepoPath('/srv/other-checkout/x.ts', REPO)).toBeNull();
  });

  it('drops dependency and build output', () => {
    expect(relativizeRepoPath(`${REPO}/node_modules/vitest/index.js`, REPO)).toBeNull();
    expect(relativizeRepoPath('libs/generic/memory/dist/index.js', REPO)).toBeNull();
  });

  it('keeps a repo dir literally named build (a false exclusion drops real signal)', () => {
    expect(relativizeRepoPath('scripts/build/gen.mjs', REPO)).toBe('scripts/build/gen.mjs');
  });

  it('normalizes ./ prefixes, quotes and file:// scheme', () => {
    expect(relativizeRepoPath('./packages/a.ts', REPO)).toBe('packages/a.ts');
    expect(relativizeRepoPath(`"${REPO}/packages/a.ts"`, REPO)).toBe('packages/a.ts');
    expect(relativizeRepoPath(`file://${REPO}/packages/a.ts`, REPO)).toBe('packages/a.ts');
  });

  it('rejects empty, dot and parent-escaping paths', () => {
    expect(relativizeRepoPath('', REPO)).toBeNull();
    expect(relativizeRepoPath('   ', REPO)).toBeNull();
    expect(relativizeRepoPath('.', REPO)).toBeNull();
    expect(relativizeRepoPath('../outside/x.ts', REPO)).toBeNull();
  });
});

describe('extractTrajectory', () => {
  it('collects paths from Read/Edit/Write nested in activity:report', () => {
    const out = extractTrajectory(
      [
        report('Edit', { file_path: `${REPO}/packages/operator-core/lib/memory/injection.ts` }),
        report('Read', { file_path: `${REPO}/packages/operator-core/lib/memory/recall-query.ts` }),
      ],
      { repoRoot: REPO },
    );
    expect(out.trajectory?.paths).toEqual([
      'packages/operator-core/lib/memory/injection.ts',
      'packages/operator-core/lib/memory/recall-query.ts',
    ]);
  });

  it('prefers the most recent WRITE for activeFile, over a newer read', () => {
    // Rows arrive newest-first: a Read is browsing, an Edit is working.
    const out = extractTrajectory(
      [
        report('Read', { file_path: 'docs/some-doc.md' }),
        report('Edit', { file_path: 'packages/operator-core/lib/memory/agent-signals.ts' }),
        report('Edit', { file_path: 'packages/operator-core/lib/memory/older.ts' }),
      ],
      { repoRoot: REPO },
    );
    expect(out.activeFile).toBe('packages/operator-core/lib/memory/agent-signals.ts');
  });

  it('falls back to the most recent read when nothing was written', () => {
    const out = extractTrajectory(
      [report('Read', { file_path: 'a/newer.ts' }), report('Read', { file_path: 'a/older.ts' })],
      { repoRoot: REPO },
    );
    expect(out.activeFile).toBe('a/newer.ts');
  });

  it('extracts work-item ids from id-bearing args', () => {
    const out = extractTrajectory([
      { toolName: 'work_items:get', args: { id: 'WI-6635' } },
      { toolName: 'work_items:complete', args: { id: 'EI-18881202063786528' } },
      { toolName: 'plans:set-status', args: { item: 'P-043' } },
    ]);
    expect(out.trajectory?.ids).toEqual(['WI-6635', 'EI-18881202063786528', 'P-043']);
  });

  it('token-scans a Bash command for paths and ids without carrying the text', () => {
    const out = extractTrajectory(
      [
        report('Bash', {
          command: 'npm run test:file -- packages/operator-core/lib/memory/injection.test.ts # WI-6640',
          description: 'run the memory tests',
        }),
      ],
      { repoRoot: REPO },
    );
    expect(out.trajectory?.paths).toEqual(['packages/operator-core/lib/memory/injection.test.ts']);
    expect(out.trajectory?.ids).toEqual(['WI-6640']);
    // The command text itself, and the free-text description, never appear.
    const blob = JSON.stringify(out);
    expect(blob).not.toContain('npm run');
    expect(blob).not.toContain('run the memory tests');
  });

  it('does not treat a command-line path as the active file', () => {
    // A grep or a test run mentions a file; it does not make it the file the
    // agent is working in.
    const out = extractTrajectory(
      [report('Bash', { command: 'rg -n foo packages/operator-core/lib/x.ts' })],
      { repoRoot: REPO },
    );
    expect(out.trajectory?.paths).toEqual(['packages/operator-core/lib/x.ts']);
    expect(out.activeFile).toBeUndefined();
  });

  it('accepts only strictly identifier-shaped symbols', () => {
    const out = extractTrajectory([
      { toolName: 'gitnexus.context', args: { name: 'managedSetInterval' } },
      // A colon-form tool name is not a code symbol.
      { toolName: 'tools:invoke', args: { name: 'curation:state-of-pot' } },
      // A regex pattern is not a symbol.
      { toolName: 'Grep', args: { pattern: 'export (async )?function' } },
    ]);
    expect(out.trajectory?.symbols).toEqual(['managedSetInterval']);
  });

  it('reads an allowlisted key nested one level down', () => {
    const out = extractTrajectory([{ toolName: 'tools:invoke', args: { args: { id: 'WI-42' } } }], {
      repoRoot: REPO,
    });
    expect(out.trajectory?.ids).toEqual(['WI-42']);
  });

  it('dedupes and caps, keeping the most recent end', () => {
    const rows = Array.from({ length: MAX_PATHS + 8 }, (_, i) =>
      report('Read', { file_path: `packages/f${i}.ts` }),
    );
    // A duplicate of the newest path, older in the list.
    rows.push(report('Read', { file_path: 'packages/f0.ts' }));
    const out = extractTrajectory(rows, { repoRoot: REPO });
    expect(out.trajectory?.paths).toHaveLength(MAX_PATHS);
    expect(out.trajectory?.paths?.[0]).toBe('packages/f0.ts');
    expect(out.trajectory?.paths?.filter((p) => p === 'packages/f0.ts')).toHaveLength(1);
  });

  it('caps ids too', () => {
    const rows = Array.from({ length: MAX_IDS + 5 }, (_, i) => ({
      toolName: 'work_items:get',
      args: { id: `WI-${i}` },
    }));
    expect(extractTrajectory(rows).trajectory?.ids).toHaveLength(MAX_IDS);
  });

  it('returns nothing for rows with no extractable signal', () => {
    const out = extractTrajectory([
      { toolName: 'coord:glance', args: { audience: 'all', activity_limit: 5 } },
      { toolName: 'loop:status', args: {} },
    ]);
    expect(out.trajectory).toBeUndefined();
    expect(out.activeFile).toBeUndefined();
  });

  it('survives malformed rows without throwing', () => {
    const out = extractTrajectory([
      { toolName: 'x', args: null },
      { toolName: 'y', args: 'a string' },
      { toolName: 'z', args: [1, 2, 3] },
      { toolName: 'w' },
    ]);
    expect(out.trajectory).toBeUndefined();
  });
});

describe('the prose-leak tripwire (P-043 design invariant)', () => {
  it('extracts NOTHING from the agent-prose tool arguments', () => {
    // Every one of these is real agent prose that genuinely lands in
    // tool_invocations.args_json. Under a denylist, each is one forgotten key
    // away from leaking into the retrieval query and closing the
    // self-confirmation loop. Under the allowlist, none is ever read.
    const prose = [
      {
        toolName: 'loop:checkpoint',
        args: {
          did: 'Deployed the fix and verified it on both axes.',
          left: 'The baseline still needs hours of accumulation.',
          insight: 'THE DEPLOY IS NO LONGER THE BLOCKER — DATA VOLUME IS.',
          next: 'Build the pure resolver with unit tests.',
        },
      },
      {
        toolName: 'work_items:checkpoint',
        args: { checkpoint: 'I believe the retrieval floor is the root cause here.' },
      },
      { toolName: 'coord:orient', args: { intent: 'Resume Phase 11 and build the resolver' } },
      { toolName: 'coord:send', args: { body: 'The gate is red because of my change.' } },
      { toolName: 'memory:remember', args: { text: 'The injector ignores agentSignals.' } },
      { toolName: 'facts:assert', args: { value: 'P-041 is blocked on data volume.' } },
    ] satisfies RawInvocation[];

    const out = extractTrajectory(prose, { repoRoot: REPO });
    expect(out.trajectory).toBeUndefined();
    expect(out.activeFile).toBeUndefined();
  });

  it('extracts only the identifiers from an Edit, never the code it wrote', () => {
    const out = extractTrajectory(
      [
        report('Edit', {
          file_path: `${REPO}/packages/operator-core/lib/memory/injection.ts`,
          old_string: 'const minScore = 0.2; // the old floor',
          new_string: 'const minScore = COSINE_FLOOR; // WI-6640 raised this',
          replace_all: false,
        }),
      ],
      { repoRoot: REPO },
    );
    expect(out.trajectory?.paths).toEqual(['packages/operator-core/lib/memory/injection.ts']);
    const blob = JSON.stringify(out);
    expect(blob).not.toContain('minScore');
    expect(blob).not.toContain('COSINE_FLOOR');
    // The id inside the edited CODE is not harvested either — old_string /
    // new_string are not scanned at all.
    expect(out.trajectory?.ids).toBeUndefined();
  });

  it('extracts nothing from a Write payload however large', () => {
    const out = extractTrajectory(
      [
        report('Write', {
          file_path: 'packages/operator-core/lib/memory/new.ts',
          content: `/** WI-9999 a very long authored body ${'x'.repeat(50_000)} */`,
        }),
      ],
      { repoRoot: REPO },
    );
    expect(out.trajectory?.paths).toEqual(['packages/operator-core/lib/memory/new.ts']);
    expect(out.trajectory?.ids).toBeUndefined();
    expect(JSON.stringify(out).length).toBeLessThan(500);
  });
});

describe('buildAgentSignals', () => {
  it('assembles all three v1 sources', () => {
    const signals = buildAgentSignals({
      claimedItem: { id: 'WI-6640', title: 'Widen the injection seam', body: 'Seam only.' },
      invocations: [report('Edit', { file_path: 'packages/operator-core/lib/memory/x.ts' })],
      repoRoot: REPO,
    });
    expect(signals).toEqual({
      workItem: { id: 'WI-6640', title: 'Widen the injection seam', body: 'Seam only.' },
      trajectory: { paths: ['packages/operator-core/lib/memory/x.ts'] },
      activeFile: 'packages/operator-core/lib/memory/x.ts',
    });
  });

  it('returns undefined — not an empty object — when nothing resolves', () => {
    // So a caller can carry `agentSignals` as genuinely ABSENT, which is what
    // P-046's guard and P-044's routing both branch on.
    expect(buildAgentSignals({})).toBeUndefined();
    expect(buildAgentSignals({ claimedItem: null, invocations: [] })).toBeUndefined();
    expect(buildAgentSignals({ claimedItem: { id: '  ', title: '' } })).toBeUndefined();
  });

  it('clamps an oversized work-item body', () => {
    const signals = buildAgentSignals({
      claimedItem: { id: 'WI-1', title: 't', body: 'y'.repeat(MAX_BODY_CHARS + 500) },
    });
    expect(signals?.workItem?.body).toHaveLength(MAX_BODY_CHARS);
  });

  it('carries the item alone when there is no trajectory', () => {
    expect(buildAgentSignals({ claimedItem: { id: 'WI-1', title: 'Only this' } })).toEqual({
      workItem: { id: 'WI-1', title: 'Only this' },
    });
  });
});

describe('resolveAgentSignals', () => {
  const source = (over: Partial<AgentSignalsSource> = {}): AgentSignalsSource => ({
    claimedItem: async () => ({ id: 'WI-1', title: 'Task' }),
    recentInvocations: async () => [report('Edit', { file_path: 'packages/a.ts' })],
    ...over,
  });

  it('resolves both reads', async () => {
    const out = await resolveAgentSignals(source(), { repoRoot: REPO });
    expect(out?.workItem?.id).toBe('WI-1');
    expect(out?.activeFile).toBe('packages/a.ts');
  });

  it('degrades to a PARTIAL result when one read fails', async () => {
    const out = await resolveAgentSignals(
      source({
        recentInvocations: async () => {
          throw new Error('pg down');
        },
      }),
      { repoRoot: REPO },
    );
    // The item alone still beats no signals at all.
    expect(out).toEqual({ workItem: { id: 'WI-1', title: 'Task' } });
  });

  it('never throws when both reads fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await resolveAgentSignals(
      source({
        claimedItem: async () => {
          throw new Error('boom');
        },
        recentInvocations: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(out).toBeUndefined();
    warn.mockRestore();
  });

  it('returns undefined rather than delaying the turn past the deadline', async () => {
    const never = new Promise<never>(() => {});
    const out = await resolveAgentSignals(
      source({ claimedItem: () => never, recentInvocations: () => never }),
      { deadlineMs: 20 },
    );
    expect(out).toBeUndefined();
  });
});
