import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeClaudeResumeTranscript,
  analyzeClaudeResumeTranscriptFile,
  appendClaudeToolReferencesToSeed,
  CLAUDE_TOOL_REFERENCE_POISON_TURNS,
  CLAUDE_TOOL_REFERENCE_RECOVERY_TURNS,
  neutralizeClaudeToolReferences,
  neutralizeForkSeedToolReferences,
  __resetClaudeResumeTranscriptCacheForTests,
} from './claude-resume-tool-references.mjs';

const missing = (tool: string, colon = true) =>
  `API Error${colon ? ':' : ''} 400 Tool reference '${tool}' not found in available tools`;
const assistant = (text: string) => JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
/** The real record shape of a provider rejection (WI-10003466): synthetic, not model prose. */
const apiError = (text: string) => JSON.stringify({
  type: 'assistant',
  error: 'unknown',
  isApiErrorMessage: true,
  apiErrorStatus: 400,
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
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
      apiError(missing(ref)),
      apiError(missing(ref, false)),
      apiError(missing(ref)),
    ].join('\n');

    expect(analyzeClaudeResumeTranscript(transcript)).toMatchObject({
      trailingMissingToolReferenceTurns: CLAUDE_TOOL_REFERENCE_POISON_TURNS,
      lastMissingToolReferenceName: ref,
      needsFreshContext: true,
      poisoned: true,
    });
  });

  it('flags a live session for fresh-context recovery at two consecutive rejections, before the quarantine threshold', () => {
    const ref = 'mcp__papercusp-su__capability_bash';
    const transcript = [assistant('Working.'), apiError(missing(ref)), apiError(missing(ref))].join('\n');

    expect(CLAUDE_TOOL_REFERENCE_RECOVERY_TURNS).toBeLessThan(CLAUDE_TOOL_REFERENCE_POISON_TURNS);
    expect(analyzeClaudeResumeTranscript(transcript)).toMatchObject({
      trailingMissingToolReferenceTurns: CLAUDE_TOOL_REFERENCE_RECOVERY_TURNS,
      needsFreshContext: true,
      poisoned: false,
    });
    expect(analyzeClaudeResumeTranscript([assistant('Working.'), apiError(missing(ref))].join('\n')))
      .toMatchObject({ trailingMissingToolReferenceTurns: 1, needsFreshContext: false });
  });

  it('never counts assistant PROSE that quotes the rejection (WI-10003466 false-death guard)', () => {
    // An agent diagnosing this very failure writes the error text into its own
    // reply. That is model output, not the provider's synthetic rejection record,
    // so it must reset the streak instead of quarantining/respawning a healthy session.
    const ref = 'mcp__papercusp-su__capability_bash';
    const quoted = `Root cause:\n${missing(ref)}\n— the MCP transport dropped.`;
    const transcript = [apiError(missing(ref)), assistant(quoted), assistant(missing(ref)), assistant(quoted)].join('\n');

    expect(analyzeClaudeResumeTranscript(transcript)).toMatchObject({
      trailingMissingToolReferenceTurns: 0,
      lastMissingToolReferenceName: null,
      needsFreshContext: false,
      poisoned: false,
    });
  });

  it('resets the poison streak on a normal assistant turn and ignores malformed JSONL', () => {
    const ref = 'mcp__papercusp-su__plans_audit';
    const transcript = [
      apiError(missing(ref)),
      '{partial JSON',
      apiError(missing(ref)),
      assistant('I can continue normally.'),
    ].join('\n');

    expect(analyzeClaudeResumeTranscript(transcript)).toMatchObject({
      trailingMissingToolReferenceTurns: 0,
      poisoned: false,
    });
  });

  // WI-10004645: a fork's file starts with the source's copied history, so the
  // consult dispatcher needs to know whether the fork's OWN first reply exists.
  describe('assistantTurnsSinceLastPrompt', () => {
    const prompt = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
    const toolResult = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    });
    const meta = JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'caveat' } });
    // The non-message rows a real fork transcript carries between its kickoff and its reply.
    const attachment = JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context' } });
    const system = JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 900 });

    it('is 0 for a fork whose kickoff is written but whose reply is not, despite copied assistant history', () => {
      const transcript = [
        prompt('source work'),
        assistant('source reply'),
        prompt('the consult kickoff'),
        attachment,
        meta,
      ].join('\n');
      expect(analyzeClaudeResumeTranscript(transcript)).toMatchObject({
        assistantTurnsSinceLastPrompt: 0,
        trailingMissingToolReferenceTurns: 0,
      });
    });

    it('counts the fork’s first reply once it lands, including the provider’s synthetic rejection', () => {
      const transcript = [
        prompt('source work'),
        assistant('source reply'),
        prompt('the consult kickoff'),
        attachment,
        apiError(missing('EndConversation')),
        system,
      ].join('\n');
      expect(analyzeClaudeResumeTranscript(transcript)).toMatchObject({
        assistantTurnsSinceLastPrompt: 1,
        trailingMissingToolReferenceTurns: 1,
        lastMissingToolReferenceName: 'EndConversation',
      });
    });

    it('a tool result or meta row continues the turn — it does not reset the count', () => {
      const transcript = [
        prompt('the consult kickoff'),
        assistant('calling a tool'),
        toolResult,
        meta,
        assistant('answered'),
      ].join('\n');
      expect(analyzeClaudeResumeTranscript(transcript).assistantTurnsSinceLastPrompt).toBe(2);
    });

    it('a copied rejection in the source history is not counted for the fork before it replies', () => {
      // The streak still reports the history's tail, which is why the
      // dispatcher must also require a reply after the prompt before judging.
      const transcript = [prompt('wake'), apiError(missing('WaitForMcpServers')), prompt('the consult kickoff')].join('\n');
      expect(analyzeClaudeResumeTranscript(transcript)).toMatchObject({
        assistantTurnsSinceLastPrompt: 0,
        trailingMissingToolReferenceTurns: 1,
      });
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
      writeFileSync(file, `${assistant('Normal turn.')}\n${apiError(missing('mcp__papercusp-su__plans_audit'))}`);
      expect(analyzeClaudeResumeTranscriptFile(file)?.trailingMissingToolReferenceTurns).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * WI-10005612: the exact record shape that made every acceptance-grading fork
 * die on its first request (conv-murg7tb6, 2026-10-02): a server tool-search
 * result in an ASSISTANT message whose `tool_references` named the native
 * `EndConversation`, which the headless fork does not advertise.
 */
const serverToolSearch = (...names: string[]) => JSON.stringify({
  type: 'assistant',
  uuid: 'u-1',
  message: {
    role: 'assistant',
    content: [{
      type: 'tool_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: {
        type: 'tool_search_tool_search_result',
        tool_references: names.map((tool_name) => ({ type: 'tool_reference', tool_name })),
      },
    }],
  },
});
/** A client ToolSearch result: references inside a tool_result content array. */
const clientToolSearch = (...names: string[]) => JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: names.map((tool_name) => ({ type: 'tool_reference', tool_name })),
    }],
  },
});

describe('neutralizeClaudeToolReferences (fork seed)', () => {
  it('empties a server tool-search result instead of leaving an unresolvable reference', () => {
    const out = neutralizeClaudeToolReferences(serverToolSearch('Bash', 'EndConversation'));
    expect(out.rewritten).toBe(2);
    expect(out.toolNames).toEqual(['Bash', 'EndConversation']);
    const record = JSON.parse(out.text);
    expect(record.uuid).toBe('u-1');
    expect(record.message.content[0].type).toBe('tool_search_tool_result');
    // An empty match list is a valid search result; a text block in this array is not.
    expect(record.message.content[0].content.tool_references).toEqual([]);
    expect(out.text).not.toContain('tool_reference"');
  });

  it('turns a reference inside tool_result content into a text marker', () => {
    const out = neutralizeClaudeToolReferences(clientToolSearch('mcp__papercusp-su__plans_audit'));
    expect(out.rewritten).toBe(1);
    const block = JSON.parse(out.text).message.content[0];
    expect(block.type).toBe('tool_result');
    expect(block.content).toEqual([
      { type: 'text', text: '[tool reference mcp__papercusp-su__plans_audit was loaded here before this session was forked]' },
    ]);
  });

  it('leaves lines without references, and unparseable lines, byte-identical', () => {
    const plain = assistant('No references here.');
    const broken = '{"type":"assistant","message":{"content":[{"type":"tool_reference"';
    const jsonl = [plain, broken, serverToolSearch('EndConversation'), ''].join('\n');
    const out = neutralizeClaudeToolReferences(jsonl);
    const lines = out.text.split('\n');
    expect(lines[0]).toBe(plain);
    expect(lines[1]).toBe(broken);
    expect(lines[3]).toBe('');
    expect(out.rewritten).toBe(1);
  });
});

describe('neutralizeForkSeedToolReferences', () => {
  it("rewrites only the source session's seeded transcripts, in every encoded-cwd dir, idempotently", () => {
    const projects = mkdtempSync(join(tmpdir(), 'fork-seed-'));
    try {
      const a = join(projects, '-home-a');
      const b = join(projects, '-home-b');
      mkdirSync(a);
      mkdirSync(b);
      const source = `${assistant('hello')}\n${serverToolSearch('EndConversation', 'WaitForMcpServers')}\n`;
      writeFileSync(join(a, 'orig.jsonl'), source);
      writeFileSync(join(b, 'orig.jsonl'), clientToolSearch('Monitor'));
      writeFileSync(join(a, 'other.jsonl'), source);

      const first = neutralizeForkSeedToolReferences(projects, 'orig');
      expect(first).toMatchObject({ files: 2, rewritten: 3 });
      expect(first.toolNames.sort()).toEqual(['EndConversation', 'Monitor', 'WaitForMcpServers']);
      expect(readFileSync(join(a, 'orig.jsonl'), 'utf8')).not.toContain('"tool_reference"');
      expect(readFileSync(join(b, 'orig.jsonl'), 'utf8')).not.toContain('"tool_reference"');
      // Another session's transcript in the same dir is not the fork's source.
      expect(readFileSync(join(a, 'other.jsonl'), 'utf8')).toBe(source);

      expect(neutralizeForkSeedToolReferences(projects, 'orig')).toMatchObject({ files: 0, rewritten: 0 });
    } finally {
      rmSync(projects, { recursive: true, force: true });
    }
  });

  it('is a no-op for a missing dir or id', () => {
    expect(neutralizeForkSeedToolReferences(join(tmpdir(), 'no-such-fork-seed-dir'), 'x')).toEqual({ files: 0, rewritten: 0, toolNames: [] });
    expect(neutralizeForkSeedToolReferences(null, 'x')).toEqual({ files: 0, rewritten: 0, toolNames: [] });
  });
});
