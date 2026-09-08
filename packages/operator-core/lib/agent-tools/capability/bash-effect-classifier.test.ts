/**
 * EI-22647418629976526 — capability:bash is a write-capability by default, but
 * code:run must not describe a fully observational diagnostic as a mutation.
 *
 * The classifier is intentionally conservative: unknown shell syntax remains a
 * write so dry-run safety is never weakened by an incomplete shell parser.
 */
import { describe, expect, it } from 'vitest';
import { lookupByMcpName } from '@papercusp/agent-mcp';
import { runToolOrchestration } from '@papercusp/tooldef';
import type { ProjectedTool, UnifiedToolContext } from '@papercusp/tooldef';
import bashTool, { classifyCapabilityBashEffect } from './bash';

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
