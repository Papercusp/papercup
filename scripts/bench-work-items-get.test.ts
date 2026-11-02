import { describe, expect, it } from 'vitest';
import { judgeSamples, runSummaryCohort, validateSummary, mcpIdentityFixture, identityPreparation, identityPreparationProbe, IdentityPreparationError, type Sample, type McpIdentityFixture } from './bench-work-items-get';
import { AgentMcpConnectionError } from '../packages/operator-core/lib/agent-mcp-client';
import type { PerfWorkloadManifest } from '../packages/operator-core/lib/system-health/perf-workload-run';
import { createHash } from 'node:crypto';

const identity: McpIdentityFixture = { ownerId: 'su-fixture', ownerLabel: 'Fixture', source: 'test', workspaceId: 'test-workspace',
  userId: null, fleetSlug: null, fleetRole: null, inbox_wake_key: 'coord:inbox-wake:su-fixture' };
const identityFixture = () => mcpIdentityFixture(identity, 'superuser=1&client=su-fixture&workspace=test-workspace&format=json');

describe('attributed current-build identity workload preparation', () => {
  it('pins exact complete SSE bytes independently of the response and rejects foreign attribution', () => {
    const fixture = identityFixture();
    const wire = JSON.parse(fixture.expectedBody.split('data: ')[1].trim());
    expect(JSON.parse(wire.result.content[0].text)).toEqual(identity);
    expect(fixture.request.expectedBodySha256).toBe(createHash('sha256').update(fixture.expectedBody).digest('hex'));
    expect(fixture.expectedBody.startsWith(':stream-open\n\nevent: message\n')).toBe(true);
    expect(fixture.expectedBody.endsWith('\n\n')).toBe(true);
    const call = JSON.parse(fixture.request.body);
    expect(call.params).toMatchObject({ name: 'coord:whoami', arguments: {} });
    expect(call.params._meta.outputGroupId).toMatch(/^[a-f0-9-]{36}$/);
    expect(() => mcpIdentityFixture(identity, 'superuser=1&client=other&workspace=test-workspace&format=json')).toThrow('attribution');
    expect(() => mcpIdentityFixture({ ...identity, inbox_wake_key: 'other' }, '')).toThrow('verified identity');
  });
  it('retains three independently validated warmup replies and closes its session', async () => {
    let calls = 0; let closed = 0;
    const groups: string[] = [];
    const fixture = identityFixture();
    const prepare = identityPreparation(fixture, async () => {
      fixture.identity.ownerId = 'mutated-after-registration';
      return { callTool: async params => { calls++; groups.push(params._meta!.outputGroupId); return { content: [{ type: 'text', text: JSON.stringify(identity) }] }; },
        close: async () => { closed++; } };
    });
    const receipt = await prepare({ arm: 'a', journey: 'identity', stratum: 'warm', requestId: null });
    expect(calls).toBe(3); expect(closed).toBe(1);
    expect(new Set(groups).size).toBe(3);
    expect(receipt).toMatchObject({ applicationColdResetQualified: false, observations: [
      { matched: true }, { matched: true }, { matched: true },
    ] });
  });
  it.each(['foreign', 'malformed', 'tool-error'])('rejects %s warmup and closes its session', async mode => {
    let closed = 0;
    const prepare = identityPreparation(identityFixture(), async () => ({
      callTool: async () => mode === 'tool-error' ? { isError: true } : { content: [{ type: 'text',
        text: mode === 'malformed' ? 'not JSON' : JSON.stringify({ ...identity, ownerId: 'foreign' }) }] },
      close: async () => { closed++; },
    }));
    await expect(prepare({ arm: 'a', journey: 'identity', stratum: 'burst', requestId: null })).rejects.toThrow();
    expect(closed).toBe(1);
  });
  it('refuses unsupported cold reset before opening a session', async () => {
    let connects = 0;
    const prepare = identityPreparation(identityFixture(), async () => { connects++; throw new Error('must not connect'); });
    await expect(prepare({ arm: 'b', journey: 'identity', stratum: 'cold', requestId: 'pair' })).rejects.toThrow('cold reset');
    expect(connects).toBe(0);
  });
  it('retains both the primary validation failure and cleanup failure without leaking opaque errors', async () => {
    const prepare = identityPreparation(identityFixture(), async () => ({
      callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ...identity, ownerId: 'foreign' }) }] }),
      close: async () => { throw new Error('Bearer secret-token'); },
    }));
    const error = await prepare({ arm: 'a', journey: 'identity', stratum: 'warm', requestId: null }).catch(error => error);
    expect(error).toBeInstanceOf(IdentityPreparationError);
    expect(error.failures).toEqual([
      { stage: 'validate', diagnostic: { code: 'warmup attribution differs' } },
      { stage: 'close', diagnostic: { code: 'unclassified-failure' } },
    ]);
    expect(JSON.stringify(error)).not.toContain('secret-token');
  });
  it('retains safe connection failure diagnostics even when the final census also fails', async () => {
    const manifest: PerfWorkloadManifest = { source: { sha: 'pinned' }, configuration: {}, runtime: {}, host: {}, workload: {}, fixture: {} };
    let captures = 0;
    const prepare = identityPreparation(identityFixture(), async () => {
      throw new AgentMcpConnectionError('http', Object.assign(new Error('Bearer secret-token'), { code: 'ECONNREFUSED' }));
    });
    const probe = await identityPreparationProbe(async () => {
      if (++captures > 1) throw new Error('staging census changed during snapshot');
      return manifest;
    }, () => prepare({ arm: 'a', journey: 'identity', stratum: 'warm', requestId: null }));
    expect(probe.initial.manifest).toEqual(manifest);
    expect(probe.initial.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(probe.failures).toEqual([{ stage: 'connect', diagnostic: { code: 'http_connection_failed',
      connection: { category: 'network', systemCode: 'ECONNREFUSED' } } }]);
    expect(probe.final).toEqual({ manifest: null, hash: null, failure: { code: 'staging census changed during snapshot' } });
    expect(probe.preparation).toBeNull();
    expect(probe.manifestStable).toBe(false);
    expect(JSON.stringify(probe)).not.toContain('secret-token');
  });
  it('retains preparation evidence when the initial census is unavailable, without claiming a stable manifest', async () => {
    const probe = await identityPreparationProbe(async () => { throw new Error('staging census changed during snapshot'); },
      async () => ({ observations: [{ matched: true }] }));
    expect(probe.preparation).toEqual({ observations: [{ matched: true }] });
    expect(probe.initial.failure).toEqual({ code: 'staging census changed during snapshot' });
    expect(probe.final.failure).toEqual(probe.initial.failure);
    expect(probe.manifestStable).toBe(false);
  });
});

function response(ids: string[]) {
  return { ok: true, results: ids.map(id => ({ id, ok: true, availability: 'available',
    workItem: { id, state: 'open' } })), counts: { ok: ids.length, failed: 0 },
    read: { schemaVersion: 'work-items-get-read-v1', mode: 'projected', requested: ids.length,
      available: ids.length, absent: 0, unavailable: 0, elapsedMs: 10,
      outerStageAttribution: 'dispatch/projection/serialization time' } };
}

describe('live work-item summary cohort oracle', () => {
  it('refuses duplicate identities, missing state, unavailable rows and lost top-level disclosure', () => {
    expect(validateSummary(response(['WI-A', 'WI-B']), ['WI-A', 'WI-B'])).toEqual([]);
    const duplicate = response(['WI-A', 'WI-A']);
    expect(validateSummary(duplicate, ['WI-A', 'WI-B'])).not.toEqual([]);
    const missingState = response(['WI-A']);
    missingState.results[0]!.workItem.state = '';
    expect(validateSummary(missingState, ['WI-A'])).not.toEqual([]);
    const unavailable = response(['WI-A']);
    unavailable.results[0]!.availability = 'unavailable';
    expect(validateSummary(unavailable, ['WI-A'])).not.toEqual([]);
    expect(validateSummary({ ...response(['WI-A']), read: undefined }, ['WI-A'])).not.toEqual([]);
  });

  it('refuses an incomplete or duplicated matrix and non-finite latency', () => {
    const sample: Sample = { size: 1, repeat: 1, wallMs: 10, valid: true, failures: [], read: {} };
    expect(judgeSamples([sample], 1, 1).passed).toBe(true);
    expect(judgeSamples([sample], 1, 2).passed).toBe(false);
    expect(judgeSamples([sample, sample], 1, 2).passed).toBe(false);
    expect(judgeSamples([{ ...sample, wallMs: NaN }], 1, 1).passed).toBe(false);
    expect(judgeSamples([{ ...sample, wallMs: 2_001 }], 1, 1).passed).toBe(false);
  });

  it('retains failed calls instead of dropping them from the p95 denominator', async () => {
    let ticks = 0;
    let calls = 0;
    const out = await runSummaryCohort({ ids: ['WI-A', 'WI-B'], repeats: 2,
      now: () => ticks++ * 10, call: async ids => {
        if (++calls === 2) throw new Error('opaque private transport detail');
        return response(ids);
      } });
    expect(out.samples).toHaveLength(4);
    expect(out.samples.map(sample => [sample.size, sample.repeat])).toEqual([[1, 1], [2, 1], [1, 2], [2, 2]]);
    expect(out.samples[1]!.valid).toBe(false);
    expect(JSON.stringify(out)).not.toContain('opaque private transport detail');
    expect(out.verdict.complete).toBe(true);
    expect(out.verdict.passed).toBe(false);
  });

  it('validates matrix inputs before making an MCP call', async () => {
    let calls = 0;
    const call = async () => { calls += 1; return {}; };
    await expect(runSummaryCohort({ ids: ['WI-A', 'WI-A'], repeats: 1, call })).rejects.toThrow('distinct');
    await expect(runSummaryCohort({ ids: ['WI-A'], repeats: 0, call })).rejects.toThrow('repeats');
    expect(calls).toBe(0);
  });
});
