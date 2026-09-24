import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeClaudeResumeTranscript,
  analyzeClaudeResumeTranscriptFile,
  appendClaudeToolReferencesToSeed,
  CLAUDE_TOOL_REFERENCE_POISON_TURNS,
  __resetClaudeResumeTranscriptCacheForTests,
} from './claude-resume-tool-references.mjs';

const missing = (tool: string, colon = true) =>
  `API Error${colon ? ':' : ''} 400 Tool reference '${tool}' not found in available tools`;
const assistant = (text: string) => JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

afterEach(() => {
  __resetClaudeResumeTranscriptCacheForTests();
});

describe('Claude resume tool-reference recovery', () => {
  it('restores recent Papercusp tool references and excludes other MCP servers', () => {
    const transcript = [
      JSON.stringify({
        type: 'user',
        message: { content: [
          { type: 'tool_reference', tool_name: 'mcp__papercusp-su__plans_audit' },
          { type: 'tool_reference', tool_name: 'mcp__filesystem__read_file' },
        ] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_reference', tool_name: 'mcp__papercusp_su__docs_get' }] },
      }),
    ].join('\n');

    expect(analyzeClaudeResumeTranscript(transcript).toolReferences).toEqual([
      'mcp__papercusp_su__docs_get',
      'mcp__papercusp-su__plans_audit',
    ]);
  });

  it('bounds the restored set to the most recently referenced tools', () => {
    const transcript = Array.from({ length: 4 }, (_, i) => JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_reference', tool_name: `mcp__papercusp-su__tool_${i}` }] },
    })).join('\n');

    expect(analyzeClaudeResumeTranscript(transcript, { maxReferences: 2 }).toolReferences).toEqual([
      'mcp__papercusp-su__tool_3',
      'mcp__papercusp-su__tool_2',
    ]);
  });

  it('counts only a trailing streak of exact missing-tool-reference assistant turns', () => {
    const ref = 'mcp__papercusp-su__plans_audit';
    const transcript = [
      assistant('Previous valid turn.'),
      assistant(missing(ref)),
      assistant(missing(ref, false)),
      assistant(missing(ref)),
    ].join('\n');

    expect(analyzeClaudeResumeTranscript(transcript)).toMatchObject({
      trailingMissingToolReferenceTurns: CLAUDE_TOOL_REFERENCE_POISON_TURNS,
      poisoned: true,
    });
  });

  it('resets the poison streak on a normal assistant turn and ignores malformed JSONL', () => {
    const ref = 'mcp__papercusp-su__plans_audit';
    const transcript = [
      assistant(missing(ref)),
      '{partial JSON',
      assistant(missing(ref)),
      assistant('I can continue normally.'),
    ].join('\n');

    expect(analyzeClaudeResumeTranscript(transcript)).toMatchObject({
      trailingMissingToolReferenceTurns: 0,
      poisoned: false,
    });
  });

  it('appends Papercusp references without changing or duplicating the current seed', () => {
    expect(appendClaudeToolReferencesToSeed(
      'tools:find,coord:orient,mcp__papercusp-su__plans_audit',
      ['mcp__papercusp-su__plans_audit', 'mcp__papercusp_su__docs_get', 'mcp__filesystem__read_file'],
    )).toBe('tools:find,coord:orient,mcp__papercusp-su__plans_audit,mcp__papercusp_su__docs_get');
  });

  it('reuses diagnostics for an unchanged transcript and refreshes them after append', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-tool-reference-'));
    try {
      const file = join(root, 'session.jsonl');
      writeFileSync(file, assistant('Normal turn.'));
      expect(analyzeClaudeResumeTranscriptFile(file)?.trailingMissingToolReferenceTurns).toBe(0);
      writeFileSync(file, `${assistant('Normal turn.')}\n${assistant(missing('mcp__papercusp-su__plans_audit'))}`);
      expect(analyzeClaudeResumeTranscriptFile(file)?.trailingMissingToolReferenceTurns).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
