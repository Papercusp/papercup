import { describe, expect, it } from 'vitest';
import { admitArm, ARM_ADMISSIONS, type ArmAdmission } from './fair-comparison-admission';
import { astGrepSyntaxIndex } from './ast-grep-facade';
import { LspDaemonAnswerCache, type MeasuredLspInputs } from './lsp-daemon-cache';
import type { LspDaemonAnswer } from './lsp-daemon-protocol';
import { unmeasuredSourceEvidence } from './contracts';

describe('native managed cache current-source contract', () => {
  it('invalidates source generations and removes deleted relationships at an unchanged cursor', async () => {
    let fingerprint = 'generation-one';
    let present = true;
    const scope = (): MeasuredLspInputs => ({ measured: true, root: '/fixture', fingerprint,
      entries: present ? 1 : 0, bytes: present ? 20 : 0, files: present ? ['target.ts'] : [],
      externalReferenceCandidates: [] });
    const revision = { measured: true as const, identity: 'fixture-service' };
    const cache = new LspDaemonAnswerCache({ prepare: async () => revision, current: () => revision }, async () => scope());
    const producer = async (): Promise<LspDaemonAnswer> => {
      const answer: LspDaemonAnswer = { backend: 'lsp-adapter', intent: 'definition', query: '/fixture/consumer.ts',
        sites: present ? [{ path: 'target.ts', line1: fingerprint === 'generation-one' ? 1 : 2, kind: 'function' }] : [],
        truncation: { truncated: false, totalAvailable: present ? 1 : 0, continuation: null },
        freshness: { health: 'healthy', indexedAt: null, indexedCommit: null, staleVsDisk: false }, latencyMs: 0, error: null };
      const evidence = unmeasuredSourceEvidence(answer,
        { repositoryId: 'fixture', identityKind: 'registry', paths: ['.'], basis: 'compiler-project' }, []);
      return { ...answer, evidence: { ...evidence, sourceScope: { ...evidence.sourceScope, sourceFingerprint: fingerprint } } };
    };
    const request = { workspaceId: 'native-contract', op: 'symbol' as const,
      args: { file: '/fixture/consumer.ts', rootPath: '/fixture', line1: 1, character: 5 } };
    const query = () => cache.query(request, 'typescript', '/fixture', new AbortController().signal, producer);
    expect((await query()).sites[0]?.line1).toBe(1);
    expect((await query()).daemonCache?.state).toBe('hit');
    fingerprint = 'generation-two';
    const edited = await query();
    expect(edited.daemonCache?.state).toBe('miss');
    expect(edited.sites).toEqual((await producer()).sites);
    expect(edited.sites[0]?.line1).toBe(2);
    present = false; fingerprint = 'generation-deleted';
    const deleted = await query();
    expect(deleted.daemonCache?.state).toBe('miss');
    expect(deleted.sites).toEqual([]);
    expect((await query()).sites).toEqual([]);
  });
});

// Production integration must not inherit the comparison's incumbent exemption.
const permissive: ArmAdmission = {
  armId: 'reviewed-engine', upstream: 'example/engine', spdx: 'MIT', licence: 'permissive',
  licenceSha256Prefix: '0123456789abcdef', telemetryDefault: 'none', telemetryOffEnv: {},
};

describe('native syntax intent admission', () => {
  it('refuses an unadmitted grammar instead of reporting a trustworthy empty', async () => {
    // Persisted or untyped callers still reach this producer guard, even when
    // the public tool's closed language enum rejects the request earlier.
    const answer = await astGrepSyntaxIndex({ language: 'cpp' as never, rootPath: '.', paths: ['unsupported.cpp'] });
    expect(answer.error).toContain('unsupported syntax-index language');
    expect(answer.sites).toEqual([]);
    expect(answer.freshness.health).toBe('unknown');
  });
});

describe('native ecosystem distribution admission', () => {
  it('retains the recorded incumbent comparison while refusing its distribution', () => {
    expect(admitArm('gitnexus@1.6.9').admission.licence).toBe('noncommercial');
    expect(() => admitArm('gitnexus@1.6.9', ARM_ADMISSIONS, 'distribution')).toThrow(/excluded from product distribution/);
  });

  it('refuses distribution even if a noncommercial incumbent is labelled approved', () => {
    const incumbent = ARM_ADMISSIONS.find(a => a.armId === 'gitnexus')!;
    expect(() => admitArm('gitnexus', [{ ...incumbent, distribution: {
      decision: 'approved', evidenceRef: 'misclassified-decision',
    } }], 'distribution')).toThrow(/comparison-only/);
  });

  it('requires a separate distribution decision for an otherwise admitted engine', () => {
    expect(admitArm(permissive.armId, [permissive]).admission.spdx).toBe('MIT');
    expect(() => admitArm(permissive.armId, [permissive], 'distribution')).toThrow(/no explicit approved decision/);
    const reviewed: ArmAdmission = { ...permissive, distribution: {
      decision: 'approved', evidenceRef: 'plan#D-001',
    } };
    expect(admitArm(reviewed.armId, [reviewed], 'distribution').admission).toEqual(reviewed);
  });

  it.each(['excluded', 'unreviewed'] as const)('refuses a %s distribution decision', decision => {
    expect(() => admitArm(permissive.armId, [{ ...permissive, distribution: {
      decision, evidenceRef: 'plan#D-001',
    } }], 'distribution')).toThrow(/no explicit approved decision/);
  });

  it('refuses an approval with an empty evidence reference', () => {
    expect(() => admitArm(permissive.armId, [{ ...permissive, distribution: {
      decision: 'approved', evidenceRef: ' ',
    } }], 'distribution')).toThrow(/no explicit approved decision/);
  });

  it('keeps the pinned licence and telemetry guards for approved distribution', () => {
    const reviewed = { ...permissive, distribution: { decision: 'approved' as const, evidenceRef: 'plan#D-001' } };
    expect(() => admitArm(permissive.armId, [{ ...reviewed, licenceSha256Prefix: null }], 'distribution')).toThrow(/without a pinned LICENSE hash/);
    expect(() => admitArm(permissive.armId, [{ ...reviewed, telemetryDefault: 'ON: usage events' }], 'distribution')).toThrow(/no opt-out env/);
    expect(admitArm(permissive.armId, [{ ...reviewed, telemetryDefault: 'ON: usage events',
      telemetryOffEnv: { DO_NOT_TRACK: '1' },
    }], 'distribution').env).toEqual({ DO_NOT_TRACK: '1' });
  });
});
