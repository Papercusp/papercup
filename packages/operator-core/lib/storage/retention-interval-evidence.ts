/**
 * Assess retained native storage receipts without probing or changing the host.
 * This is the assessor of the records, not the sampler that originally wrote
 * them. A passing byte-window assessment does not certify candidate admission,
 * inodes, continuous capacity, the frontend recorder, or final shipment.
 */
import { z } from 'zod';
import { criticalWriteHeadroomBytes, DEFAULT_DISK_POLICY } from './disk-space-alarm';

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = z.string().regex(/^v1-[a-f0-9]{64}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const policy = z.object({
  criticalFreePctMin: z.number().positive().max(1),
  criticalFreeBytesMin: bytes.positive(),
  criticalFreeBytesCap: bytes.positive(),
  freeInodesPctMin: z.number().positive().max(1),
}).passthrough();
const snapshot = z.object({
  path: z.string().min(1).max(512), dev: bytes,
  totalBytes: bytes.positive(), availableBytes: bytes, reservedBytes: bytes,
  usableAfterReservationsBytes: z.number().finite().optional(),
  criticalFloorBytes: z.number().finite().optional(),
  totalInodes: bytes.optional(), freeInodes: bytes.optional(),
}).passthrough();
const generation = z.object({
  device: bytes, inode: bytes.positive(), markerInode: bytes.positive(), markerSha256: sha256,
}).passthrough();
const pin = z.object({
  name: z.string().min(1).max(512), identity, checkout: z.string().min(1).max(2048),
}).passthrough();
const store = z.object({
  path: z.string().min(1).max(512), physical: z.string().min(1).max(512), device: bytes,
  generations: z.record(identity, generation).refine((x) => Object.keys(x).length <= 256),
  pins: z.array(pin).max(256), leases: z.array(z.unknown()).max(256),
}).passthrough();
const endpoint = z.object({
  at: z.string().datetime({ offset: true }), nativePid: bytes.positive(), scriptSha256: sha256,
  policy, snapshots: z.array(snapshot).min(1).max(32),
  stores: z.array(store).min(1).max(16).refine((xs) =>
    new Set(xs.map((x) => x.path)).size === xs.length && new Set(xs.map((x) => x.physical)).size === xs.length,
  'Captured stores must have unique path and physical identity.'),
  runtimeStableDuringRead: z.boolean().optional(),
}).passthrough();
const epoch = z.union([bytes.positive(), z.string().regex(/^[1-9][0-9]{0,15}$/).transform(Number)])
  .refine(Number.isSafeInteger, 'Native epoch milliseconds must be a safe integer.');
const step = z.object({
  workflow_uuid: z.string().min(1).max(512), function_name: z.literal('dependency-generation-retention'),
  started_at_epoch_ms: epoch, completed_at_epoch_ms: epoch,
  error: z.unknown().refine((x) => x !== undefined, 'An explicit native error or null receipt is required.'),
  receipt: z.object({
    status: z.enum(['complete', 'partial', 'unavailable']), errors: z.array(z.unknown()).max(256),
    stores: z.array(z.object({
      generationRoot: z.string().min(1).max(512), status: z.enum(['pruned', 'failed']),
      stdout: z.string().max(4096), stderr: z.string().max(4096),
      stdoutTruncated: z.boolean(), stderrTruncated: z.boolean(),
    }).passthrough()).max(16),
  }).passthrough(),
}).passthrough();
const artifactSchema = z.object({
  native0250Window: z.object({ pre: endpoint, registeredStep: step }).passthrough(),
  oneHourNativeEndpoint: z.object({ receipt: endpoint }).passthrough(),
}).passthrough();

export interface RetentionEvidenceCheck {
  id: string;
  status: 'pass' | 'fail' | 'unknown';
  detail: string;
}
export interface RetentionIntervalAssessment {
  schemaVersion: 1;
  kind: 'retained-storage-interval-assessment';
  intervalStatus: 'pass' | 'fail' | 'unknown';
  sampledSpanMs: number | null;
  checks: RetentionEvidenceCheck[];
  byteSnapshots: Array<{ endpoint: 'before' | 'after'; path: string; device: number; usableBytes: number; floorBytes: number }>;
  coverage: { population: string[]; checked: string[]; notChecked: string[]; notApplicable: string[]; residue: string[] };
  scope: string[];
}

const REQUIRED_PATHS = ['/', '/mnt/data', '/tmp/pcv'] as const;
const EXTERNAL_CHECKS = new Set(['inode-headroom', 'final-candidate-demand']);

/** Recompute conclusions from bounded records; never trust their authored pass booleans. */
export function assessRetainedStorageInterval(input: unknown): RetentionIntervalAssessment {
  const checks: RetentionEvidenceCheck[] = [];
  const byteSnapshots: RetentionIntervalAssessment['byteSnapshots'] = [];
  const add = (id: string, status: RetentionEvidenceCheck['status'], detail: string) => checks.push({ id, status, detail });
  const finish = (sampledSpanMs: number | null): RetentionIntervalAssessment => {
    const interval = checks.filter((x) => !EXTERNAL_CHECKS.has(x.id));
    return {
      schemaVersion: 1, kind: 'retained-storage-interval-assessment', sampledSpanMs,
      intervalStatus: interval.some((x) => x.status === 'fail') ? 'fail' : interval.some((x) => x.status === 'unknown') ? 'unknown' : 'pass',
      checks, byteSnapshots,
      coverage: {
        population: checks.map((x) => x.id),
        checked: checks.filter((x) => x.status !== 'unknown').map((x) => x.id),
        notChecked: checks.filter((x) => x.status === 'unknown').map((x) => x.id),
        notApplicable: [], residue: checks.filter((x) => x.status !== 'pass').map((x) => `${x.id}: ${x.detail}`),
      },
      scope: [
        'Assessment of retained endpoint and native retention records; no host measurement or mutation.',
        'Byte headroom and captured protected-pin custody only; no continuous-capacity claim.',
        'No certification of candidate admission, frontend recorder, native journal recovery, or final shipment.',
        'A native completion receipt establishes per-store execution, not exclusive removal causality.',
      ],
    };
  };
  const parsed = artifactSchema.safeParse(input);
  if (!parsed.success) {
    add('receipt-shape', 'unknown', parsed.error.issues.slice(0, 8).map((x) => x.path.join('.') + ': ' + x.message).join('; '));
    return finish(null);
  }
  const before = parsed.data.native0250Window.pre;
  const after = parsed.data.oneHourNativeEndpoint.receipt;
  const retainedStep = parsed.data.native0250Window.registeredStep;
  const beforeMs = Date.parse(before.at), afterMs = Date.parse(after.at), span = afterMs - beforeMs;
  add('runtime-custody', after.runtimeStableDuringRead === undefined ? 'unknown' :
    after.runtimeStableDuringRead && before.nativePid === after.nativePid && before.scriptSha256 === after.scriptSha256 ? 'pass' : 'fail',
  'Compare recorded PID/script fingerprints and the sampler’s explicit service-stability witness.');
  add('sampled-hour-span', span >= 3_600_000 ? 'pass' : 'fail', `${span}ms between the recorded endpoints; no interpolation between samples.`);
  const completeStep = retainedStep.error === null && retainedStep.receipt.status === 'complete' && retainedStep.receipt.errors.length === 0;
  const stepInWindow = retainedStep.started_at_epoch_ms >= beforeMs && retainedStep.completed_at_epoch_ms >= retainedStep.started_at_epoch_ms && retainedStep.completed_at_epoch_ms <= afterMs;
  add('registered-retention-completion', completeStep && stepInWindow ? 'pass' : 'fail',
    `${retainedStep.workflow_uuid}: completion and per-store receipt must fall inside the retained window.`);

  for (const path of REQUIRED_PATHS) {
    const b = before.snapshots.filter((x) => x.path === path), a = after.snapshots.filter((x) => x.path === path);
    if (b.length !== 1 || a.length !== 1) {
      add(`byte-headroom:${path}`, 'unknown', 'Exactly one before and after snapshot is required for this explicit path.');
      continue;
    }
    let valid = b[0]!.dev === a[0]!.dev && b[0]!.totalBytes === a[0]!.totalBytes;
    for (const [which, observation, nativePolicy] of [['before', b[0]!, before.policy], ['after', a[0]!, after.policy]] as const) {
      const usableBytes = observation.availableBytes - observation.reservedBytes;
      const floorBytes = criticalWriteHeadroomBytes(observation.totalBytes, { ...DEFAULT_DISK_POLICY, ...nativePolicy });
      byteSnapshots.push({ endpoint: which, path, device: observation.dev, usableBytes, floorBytes });
      valid &&= observation.availableBytes <= observation.totalBytes && usableBytes >= floorBytes;
      valid &&= observation.usableAfterReservationsBytes === undefined || observation.usableAfterReservationsBytes === usableBytes;
      valid &&= observation.criticalFloorBytes === undefined || Math.abs(observation.criticalFloorBytes - floorBytes) <= 0.000001;
    }
    add(`byte-headroom:${path}`, valid ? 'pass' : 'fail', 'Independently recomputed available-minus-reservations and current recorded native policy floor on the same device.');
  }
  for (const [which, observations] of [['before', before.snapshots], ['after', after.snapshots]] as const) {
    const data = observations.find((x) => x.path === '/mnt/data'), alias = observations.find((x) => x.path === '/tmp/pcv');
    add(`physical-alias-budget:${which}`, !data || !alias ? 'unknown' :
      data.dev === alias.dev && data.totalBytes === alias.totalBytes && data.reservedBytes === alias.reservedBytes ? 'pass' : 'fail',
    'The explicit data/tmp aliases must use one physical-device reservation budget; never add that budget twice.');
  }
  for (const b of before.stores) {
    const matches = after.stores.filter((x) => x.path === b.path);
    if (matches.length !== 1) {
      add(`protected-pins:${b.path}`, 'unknown', 'The captured baseline store needs exactly one after-store custody record.');
      continue;
    }
    const a = matches[0]!;
    const pinsUnique = new Set(b.pins.map((x) => x.name)).size === b.pins.length && new Set(a.pins.map((x) => x.name)).size === a.pins.length;
    const preserved = b.pins.every((p) => {
      const ap = a.pins.find((x) => x.name === p.name), bg = b.generations[p.identity], ag = a.generations[p.identity];
      return ap?.identity === p.identity && ap.checkout === p.checkout && bg && ag &&
        bg.device === b.device && ag.device === a.device && bg.device === ag.device &&
        bg.inode === ag.inode && bg.markerInode === ag.markerInode && bg.markerSha256 === ag.markerSha256;
    });
    add(`protected-pins:${b.path}`, pinsUnique && preserved && b.physical === a.physical && b.device === a.device ? 'pass' : 'fail',
      'Compare pin identity/checkout and referenced generation device/inode/marker; ignore refreshable pin-file hashes.');
    const receipts = retainedStep.receipt.stores.filter((x) => x.generationRoot === b.path || x.generationRoot === b.physical);
    add(`native-store-receipt:${b.path}`, receipts.length !== 1 ? 'fail' :
      receipts[0]!.status === 'pruned' && !receipts[0]!.stdoutTruncated && !receipts[0]!.stderrTruncated ? 'pass' : 'fail',
      'Exactly one successful, untruncated native execution receipt is required for each captured physical store.');
    if (b.leases.length > 0) add(`selector-lease-custody:${b.path}`, 'unknown', 'Nonempty baseline leases require a separate liveness/expiry-aware custody witness.');
  }
  const inodeSnapshots = [...before.snapshots, ...after.snapshots];
  add('inode-headroom', inodeSnapshots.some((x) => x.totalInodes === undefined || x.freeInodes === undefined) ? 'unknown' :
    [...before.snapshots.map((x) => ({ x, floor: before.policy.freeInodesPctMin })), ...after.snapshots.map((x) => ({ x, floor: after.policy.freeInodesPctMin }))]
      .every(({ x, floor }) => x.totalInodes === 0 || x.freeInodes! <= x.totalInodes! && x.freeInodes! / x.totalInodes! >= floor) ? 'pass' : 'fail',
    'Byte samples do not establish inode headroom when inode counts were not captured.');
  add('final-candidate-demand', 'unknown', 'No applicable final native candidate admission-demand receipt is consumed by this interval assessor.');
  return finish(span);
}
