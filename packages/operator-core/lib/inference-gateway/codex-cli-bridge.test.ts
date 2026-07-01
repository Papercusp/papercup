/**
 * Codex-CLI bridge (ChatGPT-subscription → /v1/responses) — the pure pieces +
 * the runner against a fake spawn. Event shapes mirror the live capture on
 * codex 0.142.2 (2026-07-01); see codex-cli-bridge.ts header.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import {
  CODEX_CLI_REF_PREFIX,
  codexCliResponsesBody,
  extractResponsesInputText,
  parseBridgeModel,
  parseCodexCliEvents,
  parseCodexCliRef,
  runCodexCliCompletion,
} from './codex-cli-bridge';

describe('parseCodexCliRef', () => {
  it('parses the codex-cli scheme and expands ~', () => {
    expect(parseCodexCliRef('codex-cli:/home/u/.codex')).toBe('/home/u/.codex');
    expect(parseCodexCliRef('codex-cli:~/.codex')).toBe(`${os.homedir()}/.codex`);
    expect(parseCodexCliRef('codex-cli:~')).toBe(os.homedir());
  });
  it('returns null for bearer refs and empty paths (they stay on the HTTP path)', () => {
    expect(parseCodexCliRef('token:/path/to/key')).toBeNull();
    expect(parseCodexCliRef('env:OPENAI_API_KEY')).toBeNull();
    expect(parseCodexCliRef(CODEX_CLI_REF_PREFIX)).toBeNull();
    expect(parseCodexCliRef('codex-cli:   ')).toBeNull();
  });
});

describe('parseBridgeModel', () => {
  it('bare id → medium effort (codex default)', () => {
    expect(parseBridgeModel('gpt-5.4')).toEqual({ id: 'gpt-5.4', effort: 'medium' });
  });
  it('strips a recognised :effort suffix', () => {
    expect(parseBridgeModel('gpt-5.4:high')).toEqual({ id: 'gpt-5.4', effort: 'high' });
    expect(parseBridgeModel('gpt-5.4:xhigh')).toEqual({ id: 'gpt-5.4', effort: 'xhigh' });
  });
  it('maps the Papercusp `max` tier to codex xhigh', () => {
    expect(parseBridgeModel('gpt-5.4:max')).toEqual({ id: 'gpt-5.4', effort: 'xhigh' });
  });
  it('maps the chatgpt:<n> alias (with and without effort)', () => {
    expect(parseBridgeModel('chatgpt:5.4')).toEqual({ id: 'gpt-5.4', effort: 'medium' });
    expect(parseBridgeModel('chatgpt:5.4:high')).toEqual({ id: 'gpt-5.4', effort: 'high' });
  });
  it('strips a provider prefix (openai-codex/…)', () => {
    expect(parseBridgeModel('openai-codex/gpt-5.4:low')).toEqual({ id: 'gpt-5.4', effort: 'low' });
  });
  it('an unrecognised suffix stays in the id (never silently dropped)', () => {
    expect(parseBridgeModel('gpt-5.4:turbo')).toEqual({ id: 'gpt-5.4:turbo', effort: 'medium' });
  });
  it('empty/undefined falls back to gpt-5.5 (the wire default)', () => {
    expect(parseBridgeModel(undefined).id).toBe('gpt-5.5');
    expect(parseBridgeModel('  ').id).toBe('gpt-5.5');
  });
});

describe('parseCodexCliEvents (live-captured JSONL contract)', () => {
  const LIVE = [
    '{"type":"thread.started","thread_id":"019f1f87-d892-7140-bf4e-61cdb12bb17a"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}',
    '{"type":"turn.completed","usage":{"input_tokens":14714,"cached_input_tokens":4480,"output_tokens":5,"reasoning_output_tokens":0}}',
  ].join('\n');
  it('extracts the agent_message text + turn usage', () => {
    expect(parseCodexCliEvents(LIVE)).toEqual({ text: 'OK', inputTokens: 14714, outputTokens: 5 });
  });
  it('concatenates multiple agent_message items and skips noise lines', () => {
    const s = [
      'some non-json banner',
      '{"type":"item.completed","item":{"type":"agent_message","text":"part1 "}}',
      '{"type":"item.completed","item":{"type":"reasoning"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"part2"}}',
    ].join('\n');
    expect(parseCodexCliEvents(s).text).toBe('part1 part2');
  });
  it('empty stream → empty text + zero usage', () => {
    expect(parseCodexCliEvents('')).toEqual({ text: '', inputTokens: 0, outputTokens: 0 });
  });
});

describe('codexCliResponsesBody', () => {
  it('emits the /v1/responses shapes extractResponsesText walks', () => {
    const b = codexCliResponsesBody({ model: 'gpt-5.4', text: 'hi', inputTokens: 3, outputTokens: 1 }) as {
      object: string;
      status: string;
      output_text: string;
      output: Array<{ type: string; content: Array<{ type: string; text: string }> }>;
      usage: { input_tokens: number; output_tokens: number };
      gateway_codex_cli: boolean;
    };
    expect(b.object).toBe('response');
    expect(b.status).toBe('completed');
    expect(b.output_text).toBe('hi');
    expect(b.output[0].content[0]).toEqual({ type: 'output_text', text: 'hi' });
    expect(b.usage).toEqual({ input_tokens: 3, output_tokens: 1 });
    expect(b.gateway_codex_cli).toBe(true);
  });
});

describe('extractResponsesInputText', () => {
  it('passes a string input through', () => {
    expect(extractResponsesInputText('hello')).toBe('hello');
  });
  it('flattens structured Responses-API input items', () => {
    expect(
      extractResponsesInputText([
        { role: 'user', content: [{ type: 'input_text', text: 'a' }] },
        { role: 'user', content: [{ type: 'text', text: 'b' }] },
        { text: 'c' },
      ]),
    ).toBe('a\nb\nc');
  });
  it('junk → empty string', () => {
    expect(extractResponsesInputText(undefined)).toBe('');
    expect(extractResponsesInputText(42)).toBe('');
  });
});

/** A spawn() fake for the runner: scripted stdout/stderr + exit code. */
type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: (s?: string) => void };
  pid: number | undefined;
};
function fakeSpawn(script: { stdout?: string; stderr?: string; code?: number | null; neverClose?: boolean }) {
  const calls: { bin: string; argv: string[]; opts: Record<string, unknown>; stdinBody?: string }[] = [];
  const spawnFn = ((bin: string, argv: string[], opts: Record<string, unknown>) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = undefined; // killGroup no-ops on a pid-less fake
    const call: (typeof calls)[number] = { bin, argv, opts };
    child.stdin = {
      end: (s?: string) => {
        call.stdinBody = s;
      },
    };
    calls.push(call);
    if (!script.neverClose) {
      process.nextTick(() => {
        if (script.stdout) child.stdout.emit('data', Buffer.from(script.stdout));
        if (script.stderr) child.stderr.emit('data', Buffer.from(script.stderr));
        child.emit('close', script.code ?? 0);
      });
    }
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawnFn, calls };
}

describe('runCodexCliCompletion', () => {
  const OK_STDOUT = [
    '{"type":"item.completed","item":{"type":"agent_message","text":"BRIDGED"}}',
    '{"type":"turn.completed","usage":{"input_tokens":9,"output_tokens":2}}',
  ].join('\n');

  it('spawns codex exec with the proven flag set, prompt on stdin, CODEX_HOME set', async () => {
    const { spawnFn, calls } = fakeSpawn({ stdout: OK_STDOUT, code: 0 });
    const r = await runCodexCliCompletion({
      home: '/tmp/sub-home',
      model: 'gpt-5.4',
      effort: 'medium',
      prompt: 'say hi',
      timeoutMs: 5_000,
      spawnFn,
    });
    expect(r).toEqual({ text: 'BRIDGED', inputTokens: 9, outputTokens: 2 });
    const c = calls[0];
    expect(c.bin).toBe('codex');
    expect(c.argv).toContain('exec');
    expect(c.argv).toContain('--json');
    expect(c.argv).toContain('--ephemeral');
    expect(c.argv.join(' ')).toContain('-s read-only'); // LLM call needs no writes
    expect(c.argv.join(' ')).toContain('-m gpt-5.4');
    expect(c.argv.join(' ')).toContain('model_reasoning_effort="medium"');
    expect(c.argv[c.argv.length - 1]).toBe('-'); // prompt via stdin
    expect(c.stdinBody).toBe('say hi');
    expect((c.opts.env as Record<string, string>).CODEX_HOME).toBe('/tmp/sub-home');
  });

  it('rejects on a non-zero exit with stderr context', async () => {
    const { spawnFn } = fakeSpawn({ stderr: 'stream error: auth expired', code: 1 });
    await expect(
      runCodexCliCompletion({ home: '/x', model: 'gpt-5.4', effort: 'low', prompt: 'p', timeoutMs: 5_000, spawnFn }),
    ).rejects.toThrow(/exited 1.*auth expired/s);
  });

  it('rejects when the stream carries no agent_message', async () => {
    const { spawnFn } = fakeSpawn({ stdout: '{"type":"turn.started"}', code: 0 });
    await expect(
      runCodexCliCompletion({ home: '/x', model: 'gpt-5.4', effort: 'low', prompt: 'p', timeoutMs: 5_000, spawnFn }),
    ).rejects.toThrow(/no agent_message/);
  });

  it('rejects on timeout when codex never exits', async () => {
    const { spawnFn } = fakeSpawn({ neverClose: true });
    await expect(
      runCodexCliCompletion({ home: '/x', model: 'gpt-5.4', effort: 'low', prompt: 'p', timeoutMs: 60, spawnFn }),
    ).rejects.toThrow(/timed out after 60ms/);
  });

  it('rejects on abort (downstream hung up)', async () => {
    const { spawnFn } = fakeSpawn({ neverClose: true });
    const ac = new AbortController();
    const p = runCodexCliCompletion({
      home: '/x',
      model: 'gpt-5.4',
      effort: 'low',
      prompt: 'p',
      timeoutMs: 10_000,
      signal: ac.signal,
      spawnFn,
    });
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/);
  });
});
