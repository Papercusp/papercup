/**
 * The hook outcome channel (WI-6554700010042393). Every "emit nothing" exit of the
 * injection hook prints the same empty stdout, so an abort during local collection
 * on the mid-turn port looked exactly like an empty server answer. postInjection
 * now reports which branch produced its answer (onHookOutcome), and runInjection
 * writes one JSONL record per invocation when PAPERCUSP_HOOK_OUTCOME_FILE is set.
 *
 * Lives beside core.mjs on purpose: test selection is by workspace.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { postInjection, runInjection, hookOutcomeTracer } = await import(path.join(HERE, '..', 'core.mjs'));
const { PORTS } = (await import(path.join(HERE, '..', 'ports.mjs'))) as {
  PORTS: Record<string, { timeoutMs: number }>;
};

const answer = (text: string) => (async () => ({ ok: true, status: 200, json: async () => ({ text }) })) as unknown as typeof fetch;

const outcomeOf = async (port: string, fetchImpl: unknown, body: Record<string, unknown> = { owner: 'su-test' }) => {
  const seen: Array<Record<string, unknown>> = [];
  await postInjection(port, body, { env: {}, fetchImpl, now: () => 1_000, onHookOutcome: (o: Record<string, unknown>) => seen.push(o) });
  return seen;
};

afterEach(() => { vi.useRealTimers(); });

describe('postInjection reports which branch produced its answer', () => {
  it('a server answer is response-received with its text length', async () => {
    const seen = await outcomeOf('stop', answer('hello'));
    expect(seen).toEqual([expect.objectContaining({ port: 'stop', stage: 'response-received', textChars: 5, timeoutMs: PORTS.stop!.timeoutMs })]);
  });

  it('an HTTP failure carries its status', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await outcomeOf('stop', fetchImpl)).toEqual([expect.objectContaining({ stage: 'http-error', status: 503 })]);
  });

  it('separates header wait from response body decoding in a successful receipt', async () => {
    let time = 1_000;
    const seen: Array<Record<string, unknown>> = [];
    const fetchImpl = (async () => {
      time += 100;
      return { ok: true, json: async () => { time += 40; return { text: 'kept' }; } };
    }) as unknown as typeof fetch;
    const result = await postInjection('stop', { owner: 'su-test' }, {
      env: {}, fetchImpl, now: () => time, onHookOutcome: (o: Record<string, unknown>) => seen.push(o),
    });
    expect(result).toMatchObject({ text: 'kept' });
    expect(seen).toEqual([expect.objectContaining({
      stage: 'response-received', transportPhase: 'body-received', elapsedMs: 140,
      fetchMs: 100, headersElapsedMs: 100, responseBodyMs: 40,
    })]);
  });

  it('a refused connection is unreachable, distinct from a wall abort', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await outcomeOf('stop', fetchImpl)).toEqual([expect.objectContaining({ stage: 'unreachable' })]);
  });

  it('mid-turn: a wall that fires during local collection is wall-before-fetch, and no request leaves', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(answer('late'));
    const seen: Array<Record<string, unknown>> = [];
    const pending = postInjection('mid-turn', { owner: 'su-test', toolCalls: [] }, {
      env: {}, fetchImpl, now: () => 1_000, onHookOutcome: (o: Record<string, unknown>) => seen.push(o),
    });
    // Synchronously, before collection's microtasks settle: the hook's own wall fires.
    vi.advanceTimersByTime(PORTS['mid-turn']!.timeoutMs + 1);
    await pending;
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(seen).toEqual([expect.objectContaining({ port: 'mid-turn', stage: 'wall-before-fetch', collectMs: 0 })]);
  });

  it('mid-turn: collection time is reported beside a normal answer', async () => {
    const seen = await outcomeOf('mid-turn', answer('ctx'), { owner: 'su-test', toolCalls: [] });
    expect(seen).toEqual([expect.objectContaining({ stage: 'response-received', collectMs: 0, textChars: 3 })]);
  });

  it('a throwing callback never changes delivery', async () => {
    const result = await postInjection('stop', { owner: 'su-test' }, {
      env: {}, fetchImpl: answer('kept'), onHookOutcome: () => { throw new Error('boom'); },
    });
    expect(result).toMatchObject({ text: 'kept' });
  });

  it('retains each guard header wait when fallback returns an empty verdict', async () => {
    vi.useFakeTimers();
    const seen: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (input: unknown, init: RequestInit) => {
      if (new URL(String(input)).port === '9071') return new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('private proxy error')), { once: true });
      });
      return new Promise(resolve => setTimeout(() => resolve({
        ok: true, status: 200, json: async () => ({ text: '' }),
      }), 100));
    }) as unknown as typeof fetch;
    const pending = postInjection('pre-tool', { owner: 'su-test' }, {
      env: { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071' }, fetchImpl,
      onHookOutcome: (outcome: Record<string, unknown>) => seen.push(outcome),
    });
    const firstBudget = Math.floor(PORTS['pre-tool']!.timeoutMs / 2);
    await vi.advanceTimersByTimeAsync(firstBudget + 100);
    await expect(pending).resolves.toBeNull();
    expect(seen).toEqual([expect.objectContaining({
      stage: 'response-received', textChars: 0,
      guardAttempts: [
        { origin: 'http://127.0.0.1:9071', startElapsedMs: 0, headerBudgetMs: PORTS['pre-tool']!.timeoutMs,
          headerWaitMs: firstBudget + 100, outcome: 'superseded', status: null },
        { origin: 'http://localhost:3070', startElapsedMs: firstBudget,
          headerBudgetMs: PORTS['pre-tool']!.timeoutMs - firstBudget,
          headerWaitMs: 100, outcome: 'headers-received', status: 200 },
      ],
    })]);
  });

  // EI-27691198286861651 / WI-6554700010047644: the old policy discarded
  // this within-wall verdict at750ms. Keep it alive while fallback runs.
  it.each(['stalled', 'unreachable'] as const)(
    'keeps a 940ms primary when fallback is %s', async fallback => {
      vi.useFakeTimers();
      const seen: Array<Record<string, unknown>> = [];
      const calls: string[] = [];
      const primaryAborts: number[] = [];
      const startedAt = Date.now();
      const fetchImpl = ((input: unknown, init: RequestInit) => {
        const origin = new URL(String(input)).origin;
        calls.push(origin);
        if (origin === 'http://127.0.0.1:9071') return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({
            ok: true, status: 200, json: async () => ({ text: 'primary-verdict' }),
          }), 940);
          init.signal!.addEventListener('abort', () => {
            clearTimeout(timer);
            primaryAborts.push(Date.now() - startedAt);
            reject(new Error('primary aborted'));
          }, { once: true });
        });
        if (fallback === 'unreachable') return Promise.reject(new Error('ECONNREFUSED'));
        return new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new Error('fallback aborted')), { once: true });
        });
      }) as unknown as typeof fetch;
      const pending = postInjection('pre-tool', { owner: 'su-test' }, {
        env: { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071', PAPERCUSP_MCP_PROXY_PORT: '9071' },
        fetchImpl, now: Date.now, onHookOutcome: (outcome: Record<string, unknown>) => seen.push(outcome),
      });
      const wall = PORTS['pre-tool']!.timeoutMs;
      expect(wall).toBe(1500);
      await vi.advanceTimersByTimeAsync(wall);
      await expect(pending).resolves.toMatchObject({ text: 'primary-verdict' });
      expect(calls).toEqual(['http://127.0.0.1:9071', 'http://localhost:3070']);
      expect(primaryAborts).toEqual([]);
      expect(seen).toEqual([expect.objectContaining({
        stage: 'response-received', elapsedMs: 940,
        guardAttempts: [
          expect.objectContaining({ headerWaitMs: 940, outcome: 'headers-received', status: 200 }),
          expect.objectContaining({ headerWaitMs: fallback === 'stalled' ? 190 : 0,
            outcome: fallback === 'stalled' ? 'superseded' : 'request-failed', status: null }),
        ],
      })]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([200, 403, 503])('keeps the first HTTP refusal (%i) instead of a later permissive fallback', async status => {
    vi.useFakeTimers();
    const seen: Array<Record<string, unknown>> = [];
    const origins: string[] = [];
    const cancelled: string[] = [];
    const fetchImpl = ((input: unknown, init: RequestInit) => {
      const origin = new URL(String(input)).origin;
      const primary = new URL(String(input)).port === '9071';
      origins.push(origin);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({
          ok: primary ? status === 200 : true, status: primary ? status : 200,
          json: async () => ({ text: primary ? 'authoritative-denial' : '' }),
        }), primary ? 900 : 400);
        init.signal!.addEventListener('abort', () => {
          clearTimeout(timer);
          cancelled.push(origin);
          reject(new Error('losing route cancelled'));
        }, { once: true });
      });
    }) as unknown as typeof fetch;
    const pending = postInjection('pre-tool', { owner: 'su-test' }, {
      env: { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071' }, fetchImpl,
      onHookOutcome: (outcome: Record<string, unknown>) => seen.push(outcome),
    });
    await vi.advanceTimersByTimeAsync(PORTS['pre-tool']!.timeoutMs);
    if (status === 200) await expect(pending).resolves.toMatchObject({ text: 'authoritative-denial' });
    else await expect(pending).resolves.toBeNull();
    expect(origins).toEqual(['http://127.0.0.1:9071', 'http://localhost:3070']);
    expect(cancelled).toEqual(['http://localhost:3070']);
    expect(seen).toEqual([expect.objectContaining({
      stage: status === 200 ? 'response-received' : 'http-error', elapsedMs: 900,
    })]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a fallback after an immediate HTTP error', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }));
    await expect(postInjection('pre-tool', { owner: 'su-test' }, { env: {}, fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([940, 1508])('single-origin control gives a %ims primary only the absolute 1500ms wall', async delayMs => {
    vi.useFakeTimers();
    const seen: Array<Record<string, unknown>> = [];
    const fetchImpl = ((_input: unknown, init: RequestInit) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({
        ok: true, status: 200, json: async () => ({ text: 'primary-verdict' }),
      }), delayMs);
      init.signal!.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('absolute wall expired'));
      }, { once: true });
    })) as unknown as typeof fetch;
    const pending = postInjection('pre-tool', { owner: 'su-test' }, {
      // A non-loopback pin has no fallback under the existing contract. This is
      // a single-origin control, not an implementation of overlapping routes.
      env: { PAPERCUSP_OPERATOR_URL: 'http://guard.example:3123' }, fetchImpl, now: Date.now,
      onHookOutcome: (outcome: Record<string, unknown>) => seen.push(outcome),
    });
    await vi.advanceTimersByTimeAsync(PORTS['pre-tool']!.timeoutMs);
    const result = await pending;
    if (delayMs === 940) expect(result).toMatchObject({ text: 'primary-verdict' });
    else expect(result).toBeNull();
    expect(seen).toEqual([expect.objectContaining({
      stage: delayMs === 940 ? 'response-received' : 'wall-during-fetch',
      elapsedMs: delayMs === 940 ? 940 : 1500,
    })]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('runInjection writes one outcome record per invocation when opted in', () => {
  const adapter = { client: 'test', portForEvent: () => 'stop', parse: () => ({}), render: (_port: string, text: string) => text };

  const run = async (env: Record<string, string>, fetchImpl: unknown) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hook-outcome-'));
    const file = path.join(dir, 'outcome.jsonl');
    try {
      const out = await runInjection({ adapter, nativeEvent: 'Stop', event: {}, env: { ...env, PAPERCUSP_HOOK_OUTCOME_FILE: file }, fetchImpl });
      const records = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
      return { out, records };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('an empty server answer is no-text, carrying the post-level outcome', async () => {
    const { out, records } = await run({ PAPERCUSP_SID: 'su-test' }, answer(''));
    expect(out).toBeNull();
    expect(records).toEqual([expect.objectContaining({
      client: 'test', nativeEvent: 'Stop', stage: 'no-text', port: 'stop',
      post: expect.objectContaining({ stage: 'response-received', textChars: 0 }),
    })]);
  });

  it('a delivered answer is emitted', async () => {
    const { out, records } = await run({ PAPERCUSP_SID: 'su-test' }, answer('hello'));
    expect(out).toBe('hello');
    expect(records).toEqual([expect.objectContaining({ stage: 'emitted', payloadChars: 5 })]);
  });

  it('a missing session id is no-owner and sends nothing', async () => {
    const fetchImpl = vi.fn(answer('x'));
    const { out, records } = await run({}, fetchImpl);
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records).toEqual([expect.objectContaining({ stage: 'no-owner' })]);
  });

  it('is off unless an absolute path is named (no I/O by default)', () => {
    expect(hookOutcomeTracer({}, {})).toBeNull();
    expect(hookOutcomeTracer({ PAPERCUSP_HOOK_OUTCOME_FILE: 'relative.jsonl' }, {})).toBeNull();
    expect(typeof hookOutcomeTracer({ PAPERCUSP_HOOK_OUTCOME_FILE: '/tmp/x.jsonl' }, {})).toBe('function');
  });
});

describe('spec-quality reads preserve the authority boundary (EI-28269500162831951)', () => {
  const command = (detail: 'full' | 'summary', wrapped = false) => {
    const args = { slug: 'review-plan', harness: 'papercusp', detail };
    return [
      `ptool ${wrapped ? 'tools:invoke' : 'plans:evaluate-spec-quality'} --json - --workspace="$PAPERCUSP_WORKSPACE" --harness=papercusp <<'JSON'`,
      JSON.stringify(wrapped ? { name: 'plans:evaluate-spec-quality', args } : args),
      'JSON',
    ].join('\n');
  };
  const runCommand = (cmd: string, fetchImpl: typeof fetch) => runInjection({
    adapter: { client: 'test', portForEvent: () => 'pre-tool',
      parse: () => ({ tool: 'exec_command', input: { cmd } }), render: (_port: string, text: string) => text },
    nativeEvent: 'PreToolUse', event: {},
    env: { PAPERCUSP_SID: 'su-test', PAPERCUSP_WORKSPACE: 'papercusp-workspace' }, fetchImpl,
  });
  const unavailable = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;

  it.each(['full', 'summary'] as const)('allows canonical %s reads when authority cannot be reached', async detail => {
    for (const wrapped of [false, true]) expect(await runCommand(command(detail, wrapped), unavailable)).toBeNull();
  });

  it('allows discarded CLI diagnostics during an outage while retaining redirection controls', async () => {
    const withRedirect = (redirect: string) => command('full').replace(" <<'JSON'", ' ' + redirect + " <<'JSON'");
    expect(await runCommand(withRedirect('2>/dev/null'), unavailable)).toBeNull();
    expect(await runCommand(withRedirect('2>/dev/null'), answer('server-denial'))).toBe('server-denial');
    for (const redirect of ['2>/tmp/output', '2>/dev/null 2>/dev/null', '2>/dev/null; touch output']) {
      expect(await runCommand(withRedirect(redirect), unavailable)).toContain('execution-authority lookup failed');
    }
  });

  const ptoolReadCommand = (tool: 'facts:list' | 'tools:find' | 'work_items:get',
    args: Record<string, unknown>, wrapped = false) => [
    'ptool ' + (wrapped ? 'tools:invoke' : tool) +
      ' --json - --workspace="$PAPERCUSP_WORKSPACE" --harness=papercusp <<\'JSON\'',
    JSON.stringify(wrapped ? { name: tool, args } : args),
    'JSON',
  ].join('\n');

  it.each([
    ['facts:list', { scope: 'workspace', limit: 1 }],
    ['tools:find', { query: 'capability:read' }],
    ['work_items:get', { id: 'EI-27973140509206554', harness: 'papercusp', threadLimit: 0 }],
  ] as const)('allows canonical %s reads during authority outage', async (tool, args) => {
    for (const wrapped of [false, true]) {
      expect(await runCommand(ptoolReadCommand(tool, args, wrapped), unavailable)).toBeNull();
    }
  });

  it('permits narrow local reads but keeps generic Python file reads fail-closed', async () => {
    const file = 'apps/operator/scripts/hooks/inject/core.mjs';
    const reads = [
      'cat ' + file,
      "sed -n '1035,1038p' " + file,
      "rg --no-config -n -F 'isSafeWithoutExecutionAuthority' " + file,
    ];
    for (const cmd of reads) expect(await runCommand(cmd, unavailable)).toBeNull();

    const pythonRead = 'python3 -c ' + '"' +
      "import pathlib; print(pathlib.Path('/tmp/facts.json').read_text())" + '"';
    expect(await runCommand(pythonRead, unavailable)).toContain('execution-authority lookup failed');
  });

  it('never replaces an actual server refusal with the read-only fallback', async () => {
    expect(await runCommand(command('full'), answer('server-refused'))).toBe('server-refused');
  });

  it('keeps writes, substitutions and redirections fail-closed', async () => {
    const valid = command('full');
    for (const cmd of [valid + '\ntouch output', valid.replace(" <<'JSON'", " > output <<'JSON'"),
      valid.replace('plans:evaluate-spec-quality', 'work_items:set_state'),
      valid.replace('$PAPERCUSP_WORKSPACE', '$(touch output)'),
      valid.replace('$PAPERCUSP_WORKSPACE', '$OTHER_WORKSPACE')]) {
      expect(await runCommand(cmd, unavailable), cmd).toContain('execution-authority lookup failed');
    }
  });
});

describe('unavailable mutation authority reports its transport branch', () => {
  const adapter = { client: 'test', portForEvent: () => 'pre-tool',
    parse: () => ({ tool: 'exec_command', input: { cmd: 'read-only probe' } }),
    render: (_port: string, text: string) => text };
  const run = (fetchImpl: typeof fetch) => runInjection({
    adapter, nativeEvent: 'PreToolUse', event: {}, env: { PAPERCUSP_SID: 'su-test' }, fetchImpl,
  });
  const runPinnedToProxy = (fetchImpl: typeof fetch) => runInjection({
    adapter, nativeEvent: 'PreToolUse', event: {},
    env: { PAPERCUSP_SID: 'su-test', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9071' }, fetchImpl,
  });

  it('names HTTP status without exposing response bodies', async () => {
    const out = await run((async () => ({ ok: false, status: 503,
      json: async () => ({ secret: 'must-not-appear' }) })) as unknown as typeof fetch);
    expect(out).toContain('execution-authority lookup failed');
    expect(out).toContain('no server verdict was received');
    expect(out).toContain('stage=http-error');
    expect(out).toContain('httpStatus=503');
    expect(out).not.toContain('must-not-appear');
  });

  it('distinguishes an unreachable operator from a timeout', async () => {
    const out = await run((async () => { throw new Error('sensitive-route'); }) as unknown as typeof fetch);
    expect(out).toContain('stage=unreachable');
    expect(out).not.toContain('sensitive-route');
  });

  it('names a wall abort while retaining the hard deadline', async () => {
    vi.useFakeTimers();
    let guardRequestId: string | undefined;
    const pending = run(((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      guardRequestId = JSON.parse(String(init.body)).guardRequestId;
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(PORTS['pre-tool']!.timeoutMs);
    const out = await pending;
    expect(guardRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out).toContain(`requestId=${guardRequestId}`);
    expect(out).toContain('stage=wall-during-fetch');
    expect(out).toContain('transportPhase=waiting-for-headers');
    expect(out).toContain('headersElapsedMs=null');
    expect(out).toContain('responseBodyMs=null');
    expect(out).toContain(`timeoutMs=${PORTS['pre-tool']!.timeoutMs}`);
  });

  it('uses the proxy fallback when the default direct origin stalls', async () => {
    vi.useFakeTimers();
    const origins: string[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      origins.push(url.origin);
      if (url.port === '3070') return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('direct attempt expired')), { once: true });
      });
      return { ok: true, status: 200, json: async () => ({ text: 'proxy-verdict' }) } as Response;
    }) as typeof fetch;
    const pending = run(fetchImpl);
    await vi.advanceTimersByTimeAsync(PORTS['pre-tool']!.timeoutMs);
    const out = await pending;
    expect(out).toContain('proxy-verdict');
    expect(origins).toEqual(['http://localhost:3070', 'http://127.0.0.1:9071']);
  });

  it('uses the direct operator when pinned proxy headers exhaust their bounded share', async () => {
    vi.useFakeTimers();
    const origins: string[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      origins.push(url.origin);
      if (url.port === '9071') return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('proxy attempt expired')), { once: true });
      });
      return { ok: true, status: 200, json: async () => ({ text: 'server-verdict' }) } as Response;
    }) as typeof fetch;
    const pending = runPinnedToProxy(fetchImpl);
    await vi.advanceTimersByTimeAsync(Math.floor(PORTS['pre-tool']!.timeoutMs / 2));
    await expect(pending).resolves.toBe('server-verdict');
    expect(origins).toEqual(['http://127.0.0.1:9071', 'http://localhost:3070']);
  });

  it('keeps the same hard wall and fails closed when both guard origins stall', async () => {
    vi.useFakeTimers();
    const origins: string[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      origins.push(new URL(String(input)).origin);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('attempt expired')), { once: true });
      });
    }) as typeof fetch;
    const pending = runPinnedToProxy(fetchImpl);
    await vi.advanceTimersByTimeAsync(PORTS['pre-tool']!.timeoutMs);
    const out = await pending;
    expect(origins).toEqual(['http://127.0.0.1:9071', 'http://localhost:3070']);
    expect(out).toContain('execution-authority lookup failed');
    expect(out).toContain('stage=wall-during-fetch');
    const firstBudget = Math.floor(PORTS['pre-tool']!.timeoutMs / 2);
    expect(out).toContain(`guardAttempts=${JSON.stringify([
      { origin: 'http://127.0.0.1:9071', startElapsedMs: 0, headerBudgetMs: PORTS['pre-tool']!.timeoutMs,
        headerWaitMs: PORTS['pre-tool']!.timeoutMs, outcome: 'wall-expired', status: null },
      { origin: 'http://localhost:3070', startElapsedMs: firstBudget,
        headerBudgetMs: PORTS['pre-tool']!.timeoutMs - firstBudget,
        headerWaitMs: PORTS['pre-tool']!.timeoutMs - firstBudget, outcome: 'wall-expired', status: null },
    ])}`);
  });

  it('identifies a body-read timeout after headers while keeping the same fail-closed wall', async () => {
    vi.useFakeTimers();
    const fetchImpl = (async (_url: unknown, init: RequestInit) => ({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('private-body-error')));
      }),
    })) as unknown as typeof fetch;
    const pending = run(fetchImpl);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PORTS['pre-tool']!.timeoutMs);
    const out = await pending;
    expect(out).toContain('execution-authority lookup failed');
    expect(out).toContain('no server verdict was received');
    expect(out).toContain('stage=wall-during-fetch');
    expect(out).toContain('transportPhase=reading-body');
    expect(out).toContain('headersElapsedMs=0');
    expect(out).toContain(`responseBodyMs=${PORTS['pre-tool']!.timeoutMs}`);
    expect(out).toContain(`timeoutMs=${PORTS['pre-tool']!.timeoutMs}`);
    expect(out).not.toContain('private-body-error');
    expect(out).toContain(`guardAttempts=${JSON.stringify([
      { origin: 'http://localhost:3070', startElapsedMs: 0,
        headerBudgetMs: PORTS['pre-tool']!.timeoutMs,
        headerWaitMs: 0, outcome: 'headers-received', status: 200 },
    ])}`);
  });

  it('uses a fresh opaque id per lookup and preserves it across fallback origins', async () => {
    const ids: string[] = [];
    const headerIds: Array<string | null> = [];
    for (let call = 0; call < 2; call++) {
      let attempts = 0;
      await runInjection({ adapter, nativeEvent: 'PreToolUse', event: {},
        env: { PAPERCUSP_SID: 'su-test', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070' },
        fetchImpl: (async (_url: unknown, init: RequestInit) => {
          ids.push(JSON.parse(String(init.body)).guardRequestId);
          headerIds.push(new Headers(init.headers).get('X-Papercusp-Guard-Request-Id'));
          if (++attempts === 1) throw new Error('unreachable');
          return { ok: false, status: 503 };
        }) as unknown as typeof fetch,
      });
    }
    expect(ids).toHaveLength(4);
    expect(ids.every(id => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).toBe(ids[3]);
    expect(ids[0]).not.toBe(ids[2]);
    expect(headerIds).toEqual(ids);
  });

  it('reports the attempted origin without leaking URL credentials or request details', async () => {
    const out = await runInjection({ adapter, nativeEvent: 'PreToolUse', event: {},
      env: { PAPERCUSP_SID: 'su-test', PAPERCUSP_OPERATOR_URL: 'http://user:secret@remote.example:3123/private?token=hidden' },
      fetchImpl: (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch,
    });
    expect(out).toContain('operatorOrigin=http://remote.example:3123');
    expect(out).toContain('guardAttempts=[{"origin":"http://remote.example:3123",');
    for (const secret of ['user', 'secret', '/private', 'token', 'hidden']) expect(out).not.toContain(secret);
  });

  it('names the fallback origin when the pinned operator cannot be reached', async () => {
    let attempts = 0;
    const out = await runInjection({ adapter, nativeEvent: 'PreToolUse', event: {},
      env: { PAPERCUSP_SID: 'su-test', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070', PAPERCUSP_MCP_PROXY_PORT: '9079' },
      fetchImpl: (async () => {
        if (++attempts === 1) throw new Error('unreachable');
        return { ok: false, status: 503 };
      }) as unknown as typeof fetch,
    });
    expect(attempts).toBe(2);
    expect(out).toContain('operatorOrigin=http://127.0.0.1:9079');
    expect(out).not.toContain('operatorOrigin=http://127.0.0.1:3070');
  });

  it('keeps a successful empty verdict distinct from unavailable authority', async () => {
    expect(await run(answer(''))).toBeNull();
    expect(await run(answer('named-rule refusal'))).toBe('named-rule refusal');
  });
});
