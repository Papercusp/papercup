/**
 * Tests for the bash→tool substitution usage metric
 * (plan `bash-to-tool-substitution-2026-07-26`, P-002).
 *
 * The line fixtures below are shaped from REAL transcript records read off this
 * box, not invented: the `tool_result` cases in particular reproduce the two
 * distinct payload shapes the CLI actually writes (a bare string, and an array
 * of typed parts including a `tool_reference` part that carries no text at
 * all). The extractor was cross-checked against an independent Python
 * implementation over a real 18MB session transcript and agreed exactly — 133
 * Bash / 36 Read / 14 Edit / 5 ToolSearch calls, and 0.20MB of result bytes.
 */

import { describe, expect, it } from 'vitest';
import {
  BYTES_PER_TOKEN,
  RESULT_BYTES_TOOL,
  SHELL_TOOL_NAME,
  commandVerbs,
  dayOf,
  extractLineUsage,
  extractToolResultBytes,
  extractToolUses,
  ingestLine,
  mergeRollup,
  rollupRows,
  usageKeyOf,
  type UsageRollup,
} from './usage-rollup';

const TS = '2026-07-26T13:32:33.716Z';

function assistantLine(blocks: unknown[], ts: string | null = TS): string {
  return JSON.stringify({
    type: 'assistant',
    ...(ts ? { timestamp: ts } : {}),
    message: { role: 'assistant', content: blocks },
  });
}

function toolResultLine(content: unknown, ts: string | null = TS): string {
  return JSON.stringify({
    type: 'user',
    ...(ts ? { timestamp: ts } : {}),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }] },
  });
}

const bashBlock = (command: string) => ({ type: 'tool_use', name: 'Bash', input: { command } });

describe('extractToolUses', () => {
  it('names every tool_use block on an assistant line', () => {
    const line = assistantLine([
      { type: 'text', text: 'working on it' },
      bashBlock('ls -la'),
      { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x' } },
    ]);
    expect(extractToolUses(line).map((u) => u.toolName)).toEqual(['Bash', 'Read']);
  });

  it('records one verb per command ATOM, reusing the shared atomizer', () => {
    // A compound line is ONE call but THREE atoms — the distinction the audit's
    // "24,641 calls / 156,345 atoms" pair rests on.
    const [use] = extractToolUses(assistantLine([bashBlock("cd /repo && sed -n '1,80p' a.ts | head -5")]));
    expect(use.verbs).toEqual(['cd', 'sed', 'head']);
  });

  it('strips runner and env prefixes so the real verb is counted', () => {
    expect(commandVerbs('sudo -n PGPASSWORD=x psql -c "SELECT 1"')).toEqual(['psql']);
    expect(commandVerbs('/usr/bin/psql -c "SELECT 1"')).toEqual(['psql']);
  });

  it('collects verbs ONLY for the CLI shell tool', () => {
    // `capability:bash` is a DIFFERENT tool that is separately visible in
    // tool_invocations. Folding it in here would double-count it and imply the
    // Postgres source is a census of the CLI tool, which it is not.
    const line = assistantLine([
      { type: 'tool_use', name: 'capability:bash', input: { command: 'ls -la' } },
    ]);
    const [use] = extractToolUses(line);
    expect(use.toolName).toBe('capability:bash');
    expect(use.verbs).toEqual([]);
    expect(SHELL_TOOL_NAME).toBe('Bash');
  });

  it('ignores non-assistant records and unnamed blocks', () => {
    expect(extractToolUses(JSON.stringify({ type: 'system', message: {} }))).toEqual([]);
    expect(extractToolUses(assistantLine([{ type: 'tool_use', input: {} }]))).toEqual([]);
  });

  it('never throws on malformed input', () => {
    for (const bad of ['', '{', 'not json', '{"type":"assistant"}', JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'str' } })]) {
      expect(() => extractLineUsage(bad)).not.toThrow();
      expect(extractToolUses(bad)).toEqual([]);
    }
  });
});

describe('extractToolResultBytes', () => {
  it('measures a bare-string result payload', () => {
    expect(extractToolResultBytes(toolResultLine('hello'))).toBe(5);
  });

  it('measures an array payload and skips parts carrying no text', () => {
    // Real shape: a `tool_reference` part has no `text` key at all.
    const line = toolResultLine([
      { type: 'tool_reference', tool_name: 'mcp__papercusp-su__coord_orient' },
      { type: 'text', text: 'abcd' },
    ]);
    expect(extractToolResultBytes(line)).toBe(4);
  });

  it('counts UTF-8 BYTES, not characters', () => {
    expect(extractToolResultBytes(toolResultLine('é'))).toBe(2);
  });

  it('returns 0 for a line with no tool_result', () => {
    expect(extractToolResultBytes(assistantLine([bashBlock('ls')]))).toBe(0);
  });
});

describe('ingestLine', () => {
  it('files result bytes under the RECORD\'s own day', () => {
    // REGRESSION PIN. ingestLine used to hand result bytes the caller's
    // `fallbackDay` instead of the record's timestamp. With no fallback that is
    // null, and addResultBytes drops undated rows — so a corpus full of results
    // reported a total cost of exactly ZERO while every other number looked
    // right. Caught only by printing the figure against a real transcript.
    const rollup: UsageRollup = new Map();
    ingestLine(rollup, toolResultLine('0123456789'), null);
    const row = rollup.get(usageKeyOf({ day: '2026-07-26', toolName: RESULT_BYTES_TOOL, verb: null }));
    expect(row?.resultBytes).toBe(10);
  });

  it('emits one per-call row plus one per-atom row per verb', () => {
    const rollup: UsageRollup = new Map();
    ingestLine(rollup, assistantLine([bashBlock('ls -la | wc -l')]), null);

    const call = rollup.get(usageKeyOf({ day: '2026-07-26', toolName: 'Bash', verb: null }));
    expect(call).toMatchObject({ calls: 1, atoms: 0 });
    for (const verb of ['ls', 'wc']) {
      expect(rollup.get(usageKeyOf({ day: '2026-07-26', toolName: 'Bash', verb }))).toMatchObject({ calls: 0, atoms: 1 });
    }
  });

  it('accumulates repeated calls onto one row', () => {
    const rollup: UsageRollup = new Map();
    for (let i = 0; i < 3; i += 1) ingestLine(rollup, assistantLine([bashBlock('git status')]), null);
    expect(rollup.get(usageKeyOf({ day: '2026-07-26', toolName: 'Bash', verb: null }))?.calls).toBe(3);
    expect(rollup.get(usageKeyOf({ day: '2026-07-26', toolName: 'Bash', verb: 'git' }))?.atoms).toBe(3);
  });

  it('drops a call it cannot date rather than filing it under today', () => {
    // An undateable call cannot be windowed; defaulting it to "now" would
    // inflate whichever window happens to be running.
    const rollup: UsageRollup = new Map();
    ingestLine(rollup, assistantLine([bashBlock('ls')], null), null);
    expect(rollup.size).toBe(0);
  });

  it('uses the fallback day when the record carries no timestamp', () => {
    const rollup: UsageRollup = new Map();
    ingestLine(rollup, assistantLine([bashBlock('ls')], null), '2026-07-01');
    expect(rollup.get(usageKeyOf({ day: '2026-07-01', toolName: 'Bash', verb: null }))?.calls).toBe(1);
  });
});

describe('dayOf', () => {
  it('buckets in UTC so the same call lands on one day for every reader', () => {
    expect(dayOf('2026-07-26T23:59:59.000Z')).toBe('2026-07-26');
    expect(dayOf('2026-07-27T00:00:01.000Z')).toBe('2026-07-27');
  });

  it('returns null for missing or unparseable input', () => {
    expect(dayOf(null)).toBeNull();
    expect(dayOf('not a date')).toBeNull();
  });
});

describe('rollup merge + ordering', () => {
  it('merges counts additively', () => {
    const a: UsageRollup = new Map();
    const b: UsageRollup = new Map();
    ingestLine(a, assistantLine([bashBlock('git status')]), null);
    ingestLine(b, assistantLine([bashBlock('git log')]), null);
    mergeRollup(a, b);
    expect(a.get(usageKeyOf({ day: '2026-07-26', toolName: 'Bash', verb: null }))?.calls).toBe(2);
    expect(a.get(usageKeyOf({ day: '2026-07-26', toolName: 'Bash', verb: 'git' }))?.atoms).toBe(2);
  });

  it('orders rows deterministically', () => {
    const rollup: UsageRollup = new Map();
    ingestLine(rollup, assistantLine([bashBlock('zsh'), bashBlock('awk 1')]), null);
    ingestLine(rollup, assistantLine([{ type: 'tool_use', name: 'Read', input: {} }]), null);
    const seen = rollupRows(rollup).map((r) => `${r.toolName}/${r.verb ?? ''}`);
    expect(seen).toEqual([...seen].sort());
  });
});

describe('BYTES_PER_TOKEN', () => {
  it('is the documented estimate the cost figure is derived with', () => {
    expect(BYTES_PER_TOKEN).toBe(4);
  });
});
