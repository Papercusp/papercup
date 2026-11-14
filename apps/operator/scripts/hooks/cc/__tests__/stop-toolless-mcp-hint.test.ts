/**
 * stop-toolless-mcp-hint (WI-6554700010048155, layer C of WI-6554700010048116).
 *
 * The hook must block once when the transcript shows a TOOLLESS papercusp connection,
 * and must stay silent on the healthy-surface shapes that look similar: one unseeded or
 * invented tool name, a miss followed by a working papercusp call, a reconnect already run.
 * Fixture lines mirror the real Claude transcript shape (a string `<tool_use_error>` content
 * with is_error:true, captured from live session transcripts on 2026-11-14).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyEpisode,
  evaluateStop,
  readTranscriptTail,
  scanTranscript,
} from '../stop-toolless-mcp-hint.mjs';

const env = { PAPERCUSP_SID: 'su-abc' } as NodeJS.ProcessEnv;
const notNested = () => false;
let n = 0;

function call(name: string, input: Record<string, unknown> = {}) {
  const id = `toolu_${++n}`;
  return { id, line: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }) };
}
function miss(name: string) {
  const c = call(name);
  const content = `<tool_use_error>Error: No such tool available: ${name}. Its MCP server 'papercusp-su' is connected but does not offer this tool here. Continue without it.</tool_use_error>`;
  return [c.line, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: c.id, content, is_error: true }] } })];
}
function ok(name: string, text = '{"ok":true}') {
  const c = call(name);
  return [c.line, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: c.id, content: [{ type: 'text', text }] }] } })];
}
const P = (verb: string) => `mcp__papercusp-su__${verb}`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'toolless-hint-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stopOn(lines: string[], hook: Record<string, unknown> = {}) {
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, lines.join('\n') + '\n');
  return evaluateStop({ hook: { transcript_path: transcript, ...hook }, env, isNested: notNested, cacheDir: join(dir, 'cache') });
}

describe('stop-toolless-mcp-hint', () => {
  it('blocks when a reachability-floor tool is missing, with the reconnect recovery', () => {
    const reason = stopOn([...ok(P('coord_whoami')), ...miss(P('tools_invoke'))]);
    expect(reason).toMatch(/TOOLLESS/);
    expect(reason).toContain('node scripts/mcp-reconnect.mjs');
    expect(reason).toContain('select:Bash');
  });

  it('stays silent on one non-floor miss (an unseeded or invented name on a healthy surface)', () => {
    expect(stopOn(miss(P('capability_read')))).toBeNull();
  });

  it('blocks with the tools:invoke-first advice on two distinct misses', () => {
    const reason = stopOn([...miss(P('capability_read')), ...miss(P('coord_read'))]);
    expect(reason).toMatch(/2 distinct papercusp tools/);
    expect(reason).toContain('tools:invoke');
  });

  it('counts the same tool missing twice as one tool', () => {
    expect(stopOn([...miss(P('capability_read')), ...miss(P('capability_read'))])).toBeNull();
  });

  it('a later real papercusp result (even a server error) closes the episode', () => {
    expect(stopOn([...miss(P('tools_invoke')), ...ok(P('coord_inbox'))])).toBeNull();
    expect(stopOn([...miss(P('tools_find')), ...ok(P('coord_inbox'), '{"ok":false,"error":"invalid_args"}')])).toBeNull();
  });

  it('a non-papercusp success does not close the episode', () => {
    expect(stopOn([...miss(P('tools_invoke')), ...ok('Edit')])).toMatch(/TOOLLESS/);
  });

  it('a native Bash mcp-reconnect run closes the episode', () => {
    const reconnect = call('Bash', { command: 'node scripts/mcp-reconnect.mjs' });
    expect(stopOn([...miss(P('tools_invoke')), reconnect.line])).toBeNull();
  });

  it('never re-blocks the continuation its own block caused', () => {
    expect(stopOn(miss(P('tools_invoke')), { stop_hook_active: true })).toBeNull();
  });

  it('bounces one miss episode at most once (per-owner dedupe), and re-fires on a new miss', () => {
    const lines = miss(P('tools_invoke'));
    expect(stopOn(lines)).toMatch(/TOOLLESS/);
    expect(stopOn(lines)).toBeNull();
    expect(stopOn([...lines, ...miss(P('tools_find'))])).toMatch(/TOOLLESS/);
  });

  it('does nothing outside a psu session, in a nested CLI, or without a transcript', () => {
    const transcript = join(dir, 't.jsonl');
    writeFileSync(transcript, miss(P('tools_invoke')).join('\n'));
    const hook = { transcript_path: transcript };
    const cacheDir = join(dir, 'cache');
    expect(evaluateStop({ hook, env: {}, isNested: notNested, cacheDir })).toBeNull();
    expect(evaluateStop({ hook, env, isNested: () => true, cacheDir })).toBeNull();
    expect(evaluateStop({ hook: {}, env, isNested: notNested, cacheDir })).toBeNull();
    expect(evaluateStop({ hook: { transcript_path: join(dir, 'missing.jsonl') }, env, isNested: notNested, cacheDir })).toBeNull();
  });

  it('ignores the refusal text when it is only quoted inside a successful result', () => {
    const quoted = ok(P('work_items_get'), '{"summary":"got No such tool available: mcp__papercusp-su__tools_invoke yesterday"}');
    expect(scanTranscript(quoted.join('\n'))).toEqual([]);
  });

  it('reads only the tail and drops the torn first line', () => {
    const transcript = join(dir, 'big.jsonl');
    const head = 'x'.repeat(5000);
    const body = `${miss(P('tools_invoke')).join('\n')}\n`;
    writeFileSync(transcript, `${head}\n${body}`);
    // The window cuts INSIDE the head line, so its remnant is the torn first line.
    const tail = readTranscriptTail(transcript, Buffer.byteLength(body) + 50);
    expect(tail.startsWith('x')).toBe(false);
    expect(classifyEpisode(scanTranscript(tail))?.kind).toBe('floor');
  });
});
