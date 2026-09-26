/** Unpaid end-to-end run of the P-005 cohort driver: the installed native Codex
 * app-server against a scripted loopback Responses provider. No provider
 * inference, no charge. Opt in with PUI_NATIVE_PROTOCOL=1 (same gate as the
 * installed-native protocol suite). */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const children = vi.hoisted(() => new Map<string, ChildProcess>());
vi.mock('../task-manager/managed-spawn', () => ({ managedSpawn: async (binary: string, args: string[], _spec: unknown,
  options: { spawnOptions: object }) => {
  const child = spawn(binary, args, options.spawnOptions); const taskId = randomUUID(); children.set(taskId, child);
  return { child, taskId };
} }));
vi.mock('../task-manager/control', () => ({ killTask: async (taskId: string) => { children.get(taskId)?.kill('SIGKILL'); return { ok: true }; } }));
vi.mock('../../../../apps/operator/scripts/psu-launcher.mjs', () => ({ startSupervisorBeat: vi.fn() }));

import { startSuStdioPeer } from '../su-session-stdio-peer';
import { processMonotonicClock } from '../process-monotonic-clock';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from '../inference-gateway/codex-cli-bridge';
import sourceReadTool from '../agent-tools/capability/read';
import { createCarryTrialRecipe } from './launch-cost-metrics';
import { runCarryCohortSource, type CohortDeps } from './carry-cohort-driver';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); children.clear(); });

describe.skipIf(process.env.PUI_NATIVE_PROTOCOL !== '1')('P-005 carry cohort driver against the installed native runtime', () => {
  it('prepares one source, forks control, delivers fresh carry to candidate, and checks every arm', async () => {
    const recipe = createCarryTrialRecipe();
    const home = mkdtempSync(join(tmpdir(), 'p005-cohort-driver-')); homes.push(home);
    const { mintCarryRespawnArgs } = await vi.importActual<{ mintCarryRespawnArgs: (args: string[], o: Record<string, unknown>) =>
      { carryText: string; launchContextPath: string } }>('../../../../apps/operator/scripts/psu-launcher.mjs');
    const requests: Array<{ kind: string; model: string; input: string; text: string;
      nativePrefix: { developerMessage: boolean; additionalTools: boolean; topLevelInstructions: boolean } }> = [];
    const textOf = (item: Record<string, unknown> | undefined) =>
      ((item?.content as Array<{ text?: string }> | undefined) ?? []).map(part => part.text ?? '').join('');
    const provider = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; input: Array<Record<string, unknown>> };
      const lastUser = [...body.input].reverse().find(item => item.type === 'message' && item.role === 'user');
      const text = textOf(lastUser), toolResult = body.input.at(-1)?.type === 'function_call_output';
      const task = recipe.tasks.find(t => text.includes(t.prompt.split('\n')[0]));
      const kind = text.includes('Acknowledgement JSON') ? 'preparation' : task ? `${task.id}${toolResult ? ':after-read' : ''}` : 'carry';
      const prefix = body.input.slice(0, body.input.findIndex(item => item.role === 'user'));
      requests.push({ kind, model: body.model, input: JSON.stringify(body.input), text,
        nativePrefix: { developerMessage: prefix.some(item => item.type === 'message' && item.role === 'developer'),
          additionalTools: prefix.some(item => item.type === 'additional_tools' && item.role === 'developer'),
          topLevelInstructions: Object.hasOwn(body, 'instructions') } });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (task?.id === 'T2' && !toolResult) {
        const readArgs = text.slice(text.indexOf('Byte window: ') + 'Byte window: '.length).trim();
        const item = { id: 'fc_read', type: 'function_call', call_id: `read-${requests.length}`, namespace: 'mcp__cache_receipts',
          name: 'capability_read', arguments: readArgs, status: 'completed' };
        const event = (type: string, payload: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
        const done = { ...codexCliResponsesBody({ model: body.model, text: '', inputTokens: 3_000, outputTokens: 20 }), output: [item] };
        res.end(event('response.output_item.added', { output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } }) +
          event('response.output_item.done', { output_index: 0, item }) + event('response.completed', { response: done }));
        return;
      }
      const sourceRef = /Recovery reference: (\S+)/.exec(text)?.[1];
      const answer = kind === 'preparation' ? recipe.sourcePreparation.expectedAcknowledgement
        : task ? { ...task.expected, ...(task.id === 'T2' ? { sourceRef } : {}) } : { carryReceived: true };
      // The predecessor reports an in-band S history; arms report small inputs.
      res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({ model: body.model, text: JSON.stringify(answer),
        inputTokens: kind === 'preparation' ? 40_000 : 3_000, outputTokens: 30 })));
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const port = (provider.address() as { port: number }).port;
    let pilotAtRequestCount = -1;
    const prepared: Array<{ sourceId: string; threadId: string; turnId: string }> = [];
    const bound: string[] = [];
    const deps: CohortDeps = {
      openPeer: ({ home: peerHome, onMessage, onReceipt }) => startSuStdioPeer({ binary: 'codex', args: ['app-server'], cwd: peerHome,
        env: { PATH: process.env.PATH, CODEX_HOME: peerHome }, workspaceId: 'p005-driver-test', ownerId: 'su-p005-driver-test',
        spec: { class: 'test', title: 'P-005 driver loopback', launchedBy: 'vitest', argv: ['codex', 'app-server'] }, onMessage, onReceipt }),
      mintCarry: ({ home: carryHome, seedText }) => mintCarryRespawnArgs([], { agent: 'codex', home: carryHome, codexHome: carryHome,
        ownerId: 'su-p005-driver-test', systemPromptAddendum: seedText }),
      readTool: async (args, root) => await sourceReadTool.handler(args as never, { projectDir: root } as never) as never,
      now: () => processMonotonicClock.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), log: () => {},
      admit: async () => ({ ok: true }),
      afterPreparation: async input => { prepared.push(input); },
      afterSourceBound: async ({ source }) => {
        expect(source.sourceRef).toMatch(/^codex:[^/]+\/[^@]+@[a-f0-9]{64}$/);
        expect(source.carry?.carrySha256).toMatch(/^[a-f0-9]{64}$/);
        expect(source.history).toMatchObject({ inputTokens: 40_000, inBand: true });
        bound.push(source.sourceId);
        return { ok: true };
      },
      afterPilot: async ({ sourceId, taskId, arms }) => {
        expect({ sourceId, taskId }).toEqual({ sourceId: 'S-I0', taskId: 'T1' });
        expect(arms.map(arm => [arm.armId, arm.quality])).toEqual([
          ['S-I0-T1:control', 'pass'], ['S-I0-T1:candidate', 'pass'],
        ]);
        pilotAtRequestCount = requests.length;
        return { ok: true };
      },
    };
    try {
      const result = await runCarryCohortSource(deps, { recipe, sourceId: 'S-I0', taskIds: ['T1', 'T2'], homeDir: join(home, 'S-I0'),
        provider: { providerId: 'loopback', rootLines: ['model_provider = "loopback"'], tableLines: ['[model_providers.loopback]',
          'name = "Unpaid loopback"', `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"',
          'requires_openai_auth = false', 'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0'] },
        transport: 'loopback-responses', authorizationScope: 'unpaid-fixture', fillerTokens: 1_500, windowMarginMs: 0, staggerMs: 50,
        turnTimeoutMs: 60_000, modelContextWindow: 872_000, autoCompactTokenLimit: 850_000,
        sourceBindingRequired: true, pilotTaskId: 'T1' });
      expect(result.source.errors).toEqual([]);
      expect(result.stop).toBeNull();
      if (result.arms.some(arm => arm.quality !== 'pass')) console.log('P005_ARM_EVIDENCE', JSON.stringify(result.arms.map(arm =>
        ({ armId: arm.armId, evidence: arm.qualityEvidence, response: arm.response }))));
      expect(result.source.preparation).toMatchObject({ matches: true, trace: 'verified' });
      expect(prepared).toEqual([{ sourceId: 'S-I0', threadId: result.source.threadId, turnId: result.source.turnId }]);
      expect(bound).toEqual(['S-I0']);
      expect(result.source.history).toMatchObject({ inputTokens: 40_000, inBand: true });
      expect(result.arms.map(arm => [arm.armId, arm.quality, arm.completed, arm.errors])).toEqual([
        ['S-I0-T1:control', 'pass', true, []], ['S-I0-T1:candidate', 'pass', true, []],
        ['S-I0-T2:candidate', 'pass', true, []], ['S-I0-T2:control', 'pass', true, []]]);
      expect(pilotAtRequestCount).toBeGreaterThan(0);
      expect(requests.slice(0, pilotAtRequestCount).some(request => request.kind.startsWith('T2'))).toBe(false);
      expect(requests.slice(pilotAtRequestCount).some(request => request.kind.startsWith('T2'))).toBe(true);
      expect(result.arms.find(arm => arm.armId === 'S-I0-T2:control')!.qualityEvidence).toMatchObject({ sourceRead: { status: 'verified' } });
      for (const arm of result.arms) {
        expect(arm.observedIdleMs).toBeGreaterThanOrEqual(0);
        expect(arm.observedIdleMs).toBeLessThan(60_000);
        expect(arm.firstUsefulResponseMs).toBeGreaterThan(0);
        expect(arm.turnIds).toHaveLength(1);
      }
      // Control inherits the predecessor's full history; the candidate starts
      // fresh and receives the seed only through the managed carry turn.
      const filler = 'reference-appendix';
      const controlT1 = requests.find(r => r.kind === 'T1' && r.input.includes(filler));
      const candidateT1 = requests.filter(r => r.kind === 'T1' && !r.input.includes(filler));
      expect(controlT1).toBeDefined();
      expect(candidateT1).toHaveLength(1);
      expect(candidateT1[0].input).toContain(JSON.stringify(recipe.seedText).slice(1, 40));
      // The first candidate request must carry the task itself. A standalone
      // carry request would let the agent act on nextAction before T1 arrives.
      expect(candidateT1[0].text.endsWith(recipe.tasks[0].prompt)).toBe(true);
      expect(requests.filter(r => r.kind === 'carry')).toHaveLength(0);
      expect(requests[0].nativePrefix).toEqual({ developerMessage: true, additionalTools: true, topLevelInstructions: false });
      expect(requests.every(r => r.model === 'gpt-6-sol')).toBe(true);

      const requestsBeforeRefusal = requests.length;
      const { afterPreparation: _afterPreparation, afterSourceBound: _afterSourceBound, afterPilot: _afterPilot,
        ...unboundDeps } = deps;
      const refused = await runCarryCohortSource(unboundDeps, { recipe, sourceId: 'S-I0', taskIds: ['T1'],
        homeDir: join(home, 'missing-binding'), provider: { providerId: 'loopback',
          rootLines: ['model_provider = "loopback"'], tableLines: ['[model_providers.loopback]',
            'name = "Unpaid loopback"', `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"',
            'requires_openai_auth = false', 'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0'] },
        transport: 'loopback-responses', authorizationScope: 'unpaid-fixture', fillerTokens: 1_500,
        windowMarginMs: 0, staggerMs: 50, turnTimeoutMs: 60_000, modelContextWindow: 872_000,
        autoCompactTokenLimit: 850_000, sourceBindingRequired: true });
      expect(refused.stop).toBe('source-binding-refused:afterSourceBound hook is required');
      expect(refused.arms).toEqual([]);
      expect(requests.slice(requestsBeforeRefusal).map(request => request.kind)).toEqual(['preparation']);
    } finally {
      await new Promise<void>(resolve => provider.close(() => resolve()));
    }
  }, 180_000);
});
