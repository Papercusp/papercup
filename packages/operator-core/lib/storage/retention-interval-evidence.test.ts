import { describe, expect, it } from 'vitest';
import { assessRetainedStorageInterval } from './retention-interval-evidence';

const GIB = 1024 ** 3;
const generationId = 'v1-' + 'a'.repeat(64);
function fixture() {
  const snapshot = (path: string, dev: number) => ({ path, dev, totalBytes: 500 * GIB, availableBytes: 50 * GIB, reservedBytes: 12 * GIB });
  const store = {
    path: '/store', physical: '/store', device: 2,
    generations: { [generationId]: { device: 2, inode: 11, markerInode: 12, markerSha256: 'b'.repeat(64) } },
    pins: [{ name: 'checkout-1', identity: generationId, checkout: '/protected-checkout', sha256: 'c'.repeat(64) }], leases: [] as unknown[],
  };
  const endpoint = {
    at: '2026-10-11T02:43:18.599Z', nativePid: 123, scriptSha256: 'd'.repeat(64),
    policy: { criticalFreePctMin: 0.02, criticalFreeBytesMin: 2 * GIB, criticalFreeBytesCap: 64 * GIB, freeInodesPctMin: 0.05 },
    snapshots: [snapshot('/', 1), snapshot('/mnt/data', 2), snapshot('/tmp/pcv', 2)], stores: [store],
  };
  return {
    native0250Window: {
      pre: endpoint,
      registeredStep: {
        workflow_uuid: 'sched-.sessionDirGc-fixture', function_name: 'dependency-generation-retention',
        started_at_epoch_ms: String(Date.parse('2026-10-11T02:50:00Z')),
        completed_at_epoch_ms: String(Date.parse('2026-10-11T02:50:10Z')), error: null as unknown,
        receipt: { status: 'complete' as const, errors: [] as unknown[], stores: [
          { generationRoot: '/store', status: 'pruned' as const, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false },
        ] },
      },
    },
    oneHourNativeEndpoint: { receipt: { ...structuredClone(endpoint), at: '2026-10-11T03:43:49.059Z', runtimeStableDuringRead: true } },
  };
}
const check = (input: unknown, id: string) => assessRetainedStorageInterval(input).checks.find((x) => x.id === id);

describe('retained storage interval assessment', () => {
  it('assesses the captured byte/pin window while retaining unmeasured candidate and inode facts', () => {
    const result = assessRetainedStorageInterval(fixture());
    expect(result.intervalStatus).toBe('pass');
    expect(result.sampledSpanMs).toBe(3_630_460);
    expect(result.coverage.notChecked).toEqual(['inode-headroom', 'final-candidate-demand']);
    expect(result.scope.join(' ')).toContain('no continuous-capacity claim');
    expect([...result.coverage.checked, ...result.coverage.notChecked, ...result.coverage.notApplicable].sort()).toEqual([...result.coverage.population].sort());
  });

  it.each(['nativePid', 'scriptSha256', 'runtimeStableDuringRead'] as const)('rejects a changed %s even if authored comparison booleans claim success', (field) => {
    const input = fixture();
    Object.assign(input.oneHourNativeEndpoint.receipt, { [field]: field === 'nativePid' ? 999 : field === 'scriptSha256' ? 'e'.repeat(64) : false, sameNativePidAsBaseline: true });
    expect(check(input, 'runtime-custody')?.status).toBe('fail');
  });

  it('refuses to turn a short endpoint span into a one-hour observation', () => {
    const input = fixture(); input.oneHourNativeEndpoint.receipt.at = '2026-10-11T03:00:00Z';
    expect(check(input, 'sampled-hour-span')?.status).toBe('fail');
  });

  it('uses available bytes after reservations, despite an authored positive floor verdict', () => {
    const input = fixture();
    Object.assign(input.oneHourNativeEndpoint.receipt.snapshots[0]!, { reservedBytes: 45 * GIB, meetsCriticalFloor: true });
    expect(check(input, 'byte-headroom:/')?.status).toBe('fail');
  });

  it('rejects a wrong device and contradictory derived byte totals', () => {
    const input = fixture();
    Object.assign(input.oneHourNativeEndpoint.receipt.snapshots[0]!, { dev: 3, usableAfterReservationsBytes: 50 * GIB });
    expect(check(input, 'byte-headroom:/')?.status).toBe('fail');
  });

  it('keeps a missing filesystem endpoint unknown rather than dropping it from the population', () => {
    const input = fixture(); input.oneHourNativeEndpoint.receipt.snapshots.pop();
    expect(check(input, 'byte-headroom:/tmp/pcv')?.status).toBe('unknown');
    expect(assessRetainedStorageInterval(input).intervalStatus).toBe('unknown');
  });

  it('detects split alias reservation budgets without double-counting a shared budget', () => {
    const input = fixture(); input.oneHourNativeEndpoint.receipt.snapshots[2]!.reservedBytes = 0;
    expect(check(input, 'physical-alias-budget:after')?.status).toBe('fail');
    const control = assessRetainedStorageInterval(fixture());
    expect(control.byteSnapshots.find((x) => x.endpoint === 'after' && x.path === '/mnt/data')?.usableBytes).toBe(38 * GIB);
  });

  it.each(['inode', 'markerInode', 'markerSha256'] as const)('detects protected generation %s drift while its name survives', (field) => {
    const input = fixture(); const g = input.oneHourNativeEndpoint.receipt.stores[0]!.generations[generationId]!;
    Object.assign(g, { [field]: field === 'markerSha256' ? 'f'.repeat(64) : 99 });
    expect(check(input, 'protected-pins:/store')?.status).toBe('fail');
  });

  it('rejects a missing protected generation or redirected checkout, but permits pin timestamp hash refresh', () => {
    const input = fixture(); input.oneHourNativeEndpoint.receipt.stores[0]!.pins[0]!.sha256 = 'e'.repeat(64);
    expect(check(input, 'protected-pins:/store')?.status).toBe('pass');
    input.oneHourNativeEndpoint.receipt.stores[0]!.pins[0]!.checkout = '/different-checkout';
    expect(check(input, 'protected-pins:/store')?.status).toBe('fail');
    delete input.oneHourNativeEndpoint.receipt.stores[0]!.generations[generationId];
    expect(check(input, 'protected-pins:/store')?.status).toBe('fail');
  });

  it('requires per-store execution receipts instead of trusting the outer success state', () => {
    const input = fixture(); input.native0250Window.registeredStep.receipt.stores = [];
    expect(check(input, 'native-store-receipt:/store')?.status).toBe('fail');
  });

  it('rejects a repeated physical-store sweep or truncated native receipt', () => {
    const input = fixture(); input.native0250Window.registeredStep.receipt.stores.push(structuredClone(input.native0250Window.registeredStep.receipt.stores[0]!));
    expect(check(input, 'native-store-receipt:/store')?.status).toBe('fail');
    input.native0250Window.registeredStep.receipt.stores.pop();
    input.native0250Window.registeredStep.receipt.stores[0]!.stdoutTruncated = true;
    expect(check(input, 'native-store-receipt:/store')?.status).toBe('fail');
  });

  it('rejects native failures and a retention step outside the captured time window', () => {
    const input = fixture(); input.native0250Window.registeredStep.error = 'prune failed';
    expect(check(input, 'registered-retention-completion')?.status).toBe('fail');
    input.native0250Window.registeredStep.error = null;
    input.native0250Window.registeredStep.completed_at_epoch_ms = String(Date.parse('2026-10-11T04:00:00Z'));
    expect(check(input, 'registered-retention-completion')?.status).toBe('fail');
  });

  it('keeps nonempty baseline leases unknown without a liveness/expiry witness', () => {
    const input = fixture(); input.native0250Window.pre.stores[0]!.leases.push({ identity: generationId });
    expect(check(input, 'selector-lease-custody:/store')?.status).toBe('unknown');
  });

  it('rejects malformed counters without treating missing or negative reservations as zero', () => {
    const input = fixture(); input.oneHourNativeEndpoint.receipt.snapshots[0]!.reservedBytes = -1;
    const result = assessRetainedStorageInterval(input);
    expect(result.intervalStatus).toBe('unknown');
    expect(result.byteSnapshots).toEqual([]);
    expect(result.checks[0]?.id).toBe('receipt-shape');
  });

  it('keeps missing native completion metadata and unsafe epoch strings unknown', () => {
    const missing = fixture(); Reflect.deleteProperty(missing.native0250Window.registeredStep, 'error');
    expect(assessRetainedStorageInterval(missing).intervalStatus).toBe('unknown');
    const unsafe = fixture(); unsafe.native0250Window.registeredStep.completed_at_epoch_ms = String(Number.MAX_SAFE_INTEGER + 1);
    expect(check(unsafe, 'receipt-shape')?.status).toBe('unknown');
  });

  it('rejects duplicate baseline store identity before it can create duplicate coverage ids', () => {
    const input = fixture(); input.native0250Window.pre.stores.push(structuredClone(input.native0250Window.pre.stores[0]!));
    const result = assessRetainedStorageInterval(input);
    expect(result.intervalStatus).toBe('unknown');
    expect(new Set(result.coverage.population).size).toBe(result.coverage.population.length);
  });
});
