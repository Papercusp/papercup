/** P008 live acceptance. Run only inside the existing disposable desktop rig:
 * VERIFY_TAURI_ISOLATED_DB=1 VERIFY_TAURI_ISOLATED_SEED=ready
 * VERIFY_TAURI_ASSERT_SNAPSHOT_SCOPE=host
 * VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS=identity_model_default_denied
 * scripts/verify-tauri-headless.sh -- npm --prefix apps/operator test --
 *   lib/endpoint-route/__tests__/selected-identity-native.integration.test.ts
 *
 * Uses a real installed source, HTTP bootstrap, generated native home, Codex
 * process and MCP response. No manually authored Applied acknowledgment.
 * A native turn-context model is requested-model evidence, not provider-model
 * attestation. This case does not establish deployed/rollback acceptance.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stringify as yaml } from 'yaml';
import { layerContentHash } from '@papercusp/orchestrator/blueprint';
import { getOrgPg } from '@papercusp/db-org';
import { parseBridgeModel, runCodexCliCompletion } from '../../inference-gateway/codex-cli-bridge';
import type { BootstrapSuResult } from '../routes/agent-mcp/bootstrap-su';
import { createTextCollector } from '../../child-output';

const enabled = process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED === '1';
const fixtureId = 'p008-native-selected-domain';
const marker = 'P008_SELECTED_NATIVE_DOMAIN_20260927';
let fixtureDir: string | undefined;
afterAll(async () => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  if (enabled) await getOrgPg().sql.end({ timeout: 5 });
});

describe.runIf(enabled)('isolated selected identity native launch', () => {
  it('delivers a pinned generic component and its model default to an actual native turn', async () => {
    const origin = process.env.VERIFY_TAURI_DEV_URL!;
    const url = new URL(origin);
    expect(url.hostname).toBe('127.0.0.1');
    expect(['3070', '3170', '3271', '9071']).not.toContain(url.port);
    const home = realpathSync(process.env.PAPERCUSP_HOME!);
    const homes = realpathSync(process.env.PAPERCUSP_SU_CODEX_HOMES_DIR!);
    const workspace = process.env.PAPERCUSP_WORKSPACE!;
    expect(workspace).toMatch(/^verify-tauri-isolated-/);
    const token = readFileSync(join(home, 'superuser-token'), 'utf8').trim();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const api = async (path: string, body?: unknown) => {
      const response = await fetch(new URL(path, origin), {
        method: body === undefined ? 'GET' : 'POST', headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(120_000),
      });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      return result;
    };

    fixtureDir = join(home, 'blueprints', fixtureId);
    mkdirSync(join(fixtureDir, 'prompts'), { recursive: true });
    const identity = { id: fixtureId, extends: 'base', version: '1.0.0',
      slots: [{ slot: 'domain' }],
      knobs: { aiBackend: { default: { model: 'gpt-5.6-sol:low' } } },
    };
    writeFileSync(join(fixtureDir, 'blueprint.yaml'), yaml({ ...identity,
      attestation: { contentHash: layerContentHash(identity), signedBy: 'p008-isolated-fixture' },
    }));
    writeFileSync(join(fixtureDir, 'prompts', 'domain.md'),
      `The native acceptance marker for this selected domain is ${marker}.\n`);

    let selected: { id: string; sourceRevision: string } | undefined;
    let after = '';
    for (let page = 0; page < 30 && !selected; page++) {
      const query = new URLSearchParams({ workspace, identities: '1', limit: '100', ...(after ? { after } : {}) });
      const catalog = await api(`/api/agent-mcp/console/bootstrap-su/options?${query}`);
      selected = catalog.identities.find((entry: { id: string }) => entry.id === fixtureId);
      if (!catalog.nextAfter) break;
      after = catalog.nextAfter;
    }
    expect(selected, 'installed identity must be discovered through the native catalog').toBeDefined();
    expect(selected!.sourceRevision).toMatch(/^[a-f0-9]{64}$/);
    const boot = await api('/api/agent-mcp/console/bootstrap-su', {
      workspace, agent: 'codex', stack: [`domain:${fixtureId}`],
      selected_identity_revision: selected!.sourceRevision,
      model: 'gpt-5.6-terra:xhigh', model_source: 'configured-default',
      account: 'default', headless: true, profile: 'generic',
    }) as BootstrapSuResult;
    expect(boot.model).toBe('gpt-5.6-sol:low');
    expect(boot.modelSource).toBe('inherited');
    expect(boot.codexHome).toBeTruthy();
    expect(relative(homes, realpathSync(boot.codexHome!))).not.toMatch(/^\.\./);
    expect(readFileSync(boot.promptFile, 'utf8')).toContain(marker);
    const config = readFileSync(join(boot.codexHome!, 'config.toml'), 'utf8');
    expect(config).toContain(url.port);
    expect(config).not.toContain(':9071/');

    const sql = getOrgPg().sql;
    const [row] = await sql`SELECT launch_spec FROM harness_shared.adv_sessions WHERE id = ${boot.sessionId!}`;
    const spec = row.launch_spec.specificationArtifact;
    expect(row.launch_spec.specificationRevision).toBe(boot.specificationRevision);
    expect(spec.configuration).not.toHaveProperty('workItem');
    expect(spec.configuration).not.toHaveProperty('spine');
    expect(spec.configuration).not.toHaveProperty('fleet');
    expect(spec.inputs).toContainEqual(expect.objectContaining({ kind: 'blueprint-layer', ref: fixtureId }));
    const [control] = await sql`SELECT control_state FROM harness_shared.session_briefs
      WHERE owner_id = ${boot.envelopeEnv.PAPERCUSP_SID} AND workspace_id = ${workspace}`;
    expect(control?.control_state?.activation?.desired?.specificationRevision).toBe(boot.specificationRevision);
    expect(control.control_state.activation.status).not.toBe('applied');
    console.log(JSON.stringify({ kind: 'p008-native-selected-bootstrap', phase: 'before-native-process',
      ownerId: boot.envelopeEnv.PAPERCUSP_SID, specificationRevision: boot.specificationRevision,
      stateRevision: boot.stateRevision, selectedSource: selected!.sourceRevision,
      requestedModel: boot.model, activationStatus: control.control_state.activation.status,
    }));

    let nativeOutput = '';
    const selectedModel = parseBridgeModel(boot.model ?? undefined);
    const result = await runCodexCliCompletion({
      home: boot.codexHome!, model: selectedModel.id, effort: selectedModel.effort, timeoutMs: 180_000,
      prompt: 'This is an isolated acceptance check. Call coord:whoami exactly once using the native MCP tools (tools:invoke if needed). Then answer with the native acceptance marker from your selected domain and the ownerId returned by the tool. Do no other work.',
      spawnFn: new Proxy(spawn, { apply(target, _thisArg, [bin, args, options]) {
        // Retain this real native transcript for inspection; the gateway bridge
        // ordinarily requests ephemeral one-shot completion. Its timeout still
        // owns and kills the entire native process group.
        if (typeof bin !== 'string' || !Array.isArray(args)) throw new Error('native runner must pass an argv array');
        const child = target(bin, args.filter((arg: string) => arg !== '--ephemeral'), {
          ...options, cwd: boot.cwd, env: { ...options?.env, ...boot.envelopeEnv,
            PAPERCUSP_HOME: home, PAPERCUSP_OPERATOR_URL: origin, CODEX_HOME: boot.codexHome!,
          },
        });
        child.stdout?.on('data', (chunk) => { nativeOutput += String(chunk); });
        return child;
      } }),
    });
    expect(result.text).toContain(marker);
    expect(result.text).toContain(boot.envelopeEnv.PAPERCUSP_SID);
    const events = nativeOutput.trim().split('\n').map((line) => JSON.parse(line));
    const calls = events.filter((event) => event.type === 'item.completed' && event.item?.type === 'mcp_tool_call');
    expect(calls.some((event) => JSON.stringify(event).includes('coord:whoami') &&
      JSON.stringify(event).includes(boot.envelopeEnv.PAPERCUSP_SID))).toBe(true);
    console.log(JSON.stringify({ kind: 'p008-native-selected-identity', ownerId: boot.envelopeEnv.PAPERCUSP_SID,
      nativeThread: events.find((event) => event.type === 'thread.started')?.thread_id,
      specificationRevision: boot.specificationRevision, stateRevision: boot.stateRevision,
      selectedSource: selected!.sourceRevision, modelSelection: boot.model,
      nativeOutputSha256: createHash('sha256').update(nativeOutput).digest('hex'),
      limitations: ['selected model is request evidence, not provider attestation', 'current build only',
        'SU host with generic component; role-scoped generic launch and Applied ordering remain separate'],
    }));
  }, 300_000);
});
