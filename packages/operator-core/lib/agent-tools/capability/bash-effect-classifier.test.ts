/**
 * EI-22647418629976526 — capability:bash is a write-capability by default, but
 * code:run must not describe a fully observational diagnostic as a mutation.
 *
 * The classifier is intentionally conservative: unknown shell syntax remains a
 * write so dry-run safety is never weakened by an incomplete shell parser.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookupByMcpName } from '@papercusp/agent-mcp';
import { runToolOrchestration } from '@papercusp/tooldef';
import type { ProjectedTool, UnifiedToolContext } from '@papercusp/tooldef';
import bashTool, { classifyCapabilityBashEffect } from './bash';
import { normalizeExpectedSigpipeResult, runForeground } from './bash-jobs';

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});

const context = (): UnifiedToolContext =>
  ({
    log: () => {},
    signal: new AbortController().signal,
    progress: () => {},
    emit: () => {},
    workspaceId: 'test-workspace',
    harnessSlug: 'papercusp',
    role: 'worker',
    runId: 'ei-226474-test',
  }) as unknown as UnifiedToolContext;

describe('capability:bash per-call effect classifier (EI-22647418629976526)', () => {
  it('classifies the reported systemctl/ss/bounded-strace diagnostic as read-only', () => {
    expect(
      classifyCapabilityBashEffect({
        command: 'systemctl show papercusp-staging-api.service && ss -ltnp && timeout 5s strace -f -p 123',
      }),
    ).toBe('read');

    const registered = lookupByMcpName('capability:bash');
    expect(registered?.effect).toBe('write');
    expect(registered?.effectForCall?.({ command: 'ss -ltnp' })).toBe('read');
  });

  it('classifies the df/findmnt filesystem diagnostic as read-only', async () => {
    const command = 'df -P . && findmnt -T .';
    expect(classifyCapabilityBashEffect({ command })).toBe('read');

    const bash = {
      pluginName: 'agent-mcp',
      description: 'capability:bash',
      inputSchema: { type: 'object' },
      capabilities: ['capability:bash'],
      effect: 'write' as const,
      effectForCall: classifyCapabilityBashEffect,
      expose: { mcp: { name: 'capability:bash' } },
      fn: vi.fn(async () => json({ ok: true, status: 'completed', output: 'filesystem diagnostic' })),
    } as unknown as ProjectedTool;

    const result = await runToolOrchestration(
      `const probe = await tools.capability.bash({ command: '${command}' });
       return { ok: probe.ok, status: probe.status };`,
      { ctx: context(), deps: {}, tools: [bash], dryRun: true },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toEqual({ ok: true, status: 'completed' });
    expect(result.plannedMutations).toEqual([]);
    expect(result.callRecords).toEqual([
      expect.objectContaining({ tool: 'capability:bash', effect: 'read', disposition: 'settled' }),
    ]);
  });

  it.each([
    ['unknown command', 'custom-diagnostic --json'],
    ['redirection', 'ss -ltnp > /tmp/ports.txt'],
    ['substitution', 'echo "$(ss -ltnp)"'],
    ['file mutation', 'printf x > report.txt'],
    ['service mutation', 'systemctl restart papercusp-staging-api.service'],
    ['network mutation', 'ip route add 10.0.0.0/8 via 127.0.0.1'],
    ['git mutation', 'git branch -D old-branch'],
  ])('keeps %s classified as write', (_label, command) => {
    expect(classifyCapabilityBashEffect({ command })).toBe('write');
  });

  it('treats a bounded find/sort/head listing as read-only and normalizes producer SIGPIPE', () => {
    const command = 'find /tmp/artifacts -type f -printf "%s %p\\n" | sort -nr | head -80';

    expect(classifyCapabilityBashEffect({ command })).toBe('read');
    expect(normalizeExpectedSigpipeResult(command, 'failed', 141)).toEqual({
      status: 'completed',
      exitCode: 0,
    });
  });

  it('classifies a bounded lsof/awk/sort/head diagnostic as read-only and normalizes producer SIGPIPE', () => {
    const command = "lsof -nP | awk '{print $1}' | sort -u | head -n 1";

    expect(classifyCapabilityBashEffect({ command })).toBe('read');
    expect(normalizeExpectedSigpipeResult(command, 'failed', 141)).toEqual({
      status: 'completed',
      exitCode: 0,
    });
  });

  it('classifies a bounded head/strings/head diagnostic as read-only and normalizes producer SIGPIPE', () => {
    const command =
      'head -c 16000 packages/operator-core/lib/cell-transcription-detector.test.ts | strings -a | head -n 120';

    expect(classifyCapabilityBashEffect({ command })).toBe('read');
    expect(normalizeExpectedSigpipeResult(command, 'failed', 141)).toEqual({
      status: 'completed',
      exitCode: 0,
    });
  });

  it('classifies an rg-to-wc no-match count probe as read-only', () => {
    const command = 'rg -l -F absent fixture.txt | wc -l';
    expect(classifyCapabilityBashEffect({ command })).toBe('read');
  });

  it('classifies only numeric-parent ps --ppid field probes as read-only', () => {
    expect(classifyCapabilityBashEffect({ command: "ps --ppid 12345 -o pid=,cmd= | awk '{print $1}'" })).toBe('read');
    expect(classifyCapabilityBashEffect({ command: 'ps --ppid 12345 -o pid=' })).toBe('read');
    expect(classifyCapabilityBashEffect({ command: "ps --ppid '$PPID' -o pid= | awk '{print $1}'" })).toBe('write');
    expect(classifyCapabilityBashEffect({ command: "ps --ppid 12345 -o pid= | awk '{system(\"touch x\")}'" })).toBe('write');
    expect(classifyCapabilityBashEffect({ command: "ps --ppid 12345 -o pid= | awk '{print $1}' && echo done" })).toBe('write');
  });

  it('completes a real bounded find/sort/head listing', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'cap-bash-find-'));
    const nested = join(fixture, 'nested');
    mkdirSync(nested);
    for (let i = 0; i < 2_000; i += 1) {
      writeFileSync(join(nested, `artifact-${String(i).padStart(4, '0')}-${'x'.repeat(48)}`), 'x');
    }
    const command = `find ${JSON.stringify(fixture)} -type f -printf "%s %p\\n" | sort -nr | head -80`;

    const result = await runForeground(
      { command, cwd: fixture, stateDir: fixture },
      new AbortController().signal,
      10_000,
    );

    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.output.split('\n').filter(Boolean)).toHaveLength(80);
  });

  it.each([
    ['command execution', 'find /tmp -type f -exec sh -c "echo {}" \\; | head -1'],
    ['directory command execution', 'find /tmp -type f -execdir printf "%s\\n" {} \\; | head -1'],
    ['delete action', 'find /tmp -type f -delete | head -1'],
    ['file print action', 'find /tmp -type f -fprint /tmp/paths.txt | head -1'],
    ['interactive command', 'find /tmp -type f -ok rm {} \\; | head -1'],
  ])('keeps find %s classified as write', (_label, command) => {
    expect(classifyCapabilityBashEffect({ command })).toBe('write');
    expect(normalizeExpectedSigpipeResult(command, 'failed', 141)).toEqual({
      status: 'failed',
      exitCode: 141,
    });
  });

  it('preserves a failed read probe without recording a planned mutation', async () => {
    const bash = {
      pluginName: 'agent-mcp',
      description: 'capability:bash',
      inputSchema: { type: 'object' },
      capabilities: ['capability:bash'],
      effect: 'write' as const,
      effectForCall: classifyCapabilityBashEffect,
      expose: { mcp: { name: 'capability:bash' } },
      fn: async () => json({ ok: false, status: 'completed', exit_code: 1, output: 'trace failed' }),
    } as unknown as ProjectedTool;

    const result = await runToolOrchestration(
      `const probe = await tools.capability.bash({ command: 'strace -f -p 123' });
       return { ok: probe.ok, exit: probe.exit_code };`,
      { ctx: context(), deps: {}, tools: [bash] },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toEqual({ ok: false, exit: 1 });
    expect(result.plannedMutations).toEqual([]);
    expect(result.writeAttempts).toBeUndefined();
    expect(result.callRecords).toEqual([
      expect.objectContaining({
        tool: 'capability:bash',
        effect: 'read',
        disposition: 'semantic_rejected',
      }),
    ]);
    expect(result.childFailures).toEqual([
      expect.objectContaining({ tool: 'capability:bash', kind: 'semantic' }),
    ]);
  });
});

void bashTool;
