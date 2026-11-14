/**
 * Growth alarm for retention classes that NOTHING can shrink.
 *
 * The retention policy registers some classes as protected data with no
 * enforcer at all (`enforcers: [{ kind: 'none' }]`), for example the workspace
 * Hyperbee store. Registration hides them from the undeclared-growth detector,
 * and the whole-device warnings in `storage-growth-alarm.ts` only speak when a
 * volume is already below its floor or will be completely FULL within a week.
 * So such a class can grow a volume all the way to its floor without a single
 * warning that names it.
 *
 * This detector closes that gap. For each census device it maps consumers to
 * policy classes with the existing `mapCensusConsumers`, sums the 24h growth of
 * every class that has no enforcer, and warns when that growth alone would take
 * the volume below its headroom floor inside the horizon. It deletes nothing:
 * the classes it reports are protected, so the remedy is to reduce the growth
 * at its source.
 *
 * A stale, missing or incomplete census is UNKNOWN and raises nothing.
 */
import { homedir } from 'node:os';
import type { CensusDeviceView } from './disk-consumer-census';
import {
  compilePolicy,
  mapCensusConsumers,
  RETENTION_POLICY,
  type KeepRule,
  type RetentionClass,
} from './retention-policy';

/** Warn when an unenforced class would take a volume below its floor within this many days. */
export const UNENFORCED_CLASS_HORIZON_DAYS = 30;

/** Structural twin of `DISK_HEADROOM_FLOORS`, injected so this module does not import the alarm. */
export interface HeadroomFloors {
  rootBytes: number;
  dataBytes: number;
  coldFreePct: number;
}

type CensusConsumer = NonNullable<CensusDeviceView['consumers']>[number];

export interface UnenforcedClassGrowthWarning {
  device: string;
  classId: string;
  title: string;
  keepKind: KeepRule['kind'];
  /** Why the policy keeps this class, when the keep rule states a reason. */
  keepReason: string | null;
  /** Bytes the class holds on this device, from the outermost census rows only. */
  bytes: number;
  growthBytesPerDay: number;
  availableBytes: number;
  /** Headroom floor for the device; 0 when the device has no declared floor. */
  floorBytes: number;
  daysToFloor: number;
  /** The census rows that were counted (outermost, never a nested child). */
  consumers: string[];
  /** True when the census row list was capped, so `bytes` and the growth rate are lower bounds. */
  lowerBound: boolean;
}

export interface UnenforcedClassGrowthOptions {
  floors: HeadroomFloors;
  horizonDays?: number;
  policy?: readonly RetentionClass[];
  home?: string;
}

/** True when no retention job, native manager or reclaim pass can ever shrink the class. */
export function isUnenforcedClass(cls: Pick<RetentionClass, 'enforcers'>): boolean {
  return cls.enforcers.every((e) => e.kind === 'none');
}

/** Headroom floor in bytes for a census device, or null when the device has no declared floor. */
export function headroomFloorBytes(
  d: Pick<CensusDeviceView, 'device' | 'sizeBytes'>,
  floors: HeadroomFloors,
): number | null {
  if (d.device === '/') return floors.rootBytes;
  if (d.device === '/mnt/data') return floors.dataBytes;
  if (/^\/mnt\/cold(?:[-/]|$)/.test(d.device) && Number.isFinite(d.sizeBytes) && d.sizeBytes! > 0) {
    return floors.coldFreePct * d.sizeBytes!;
  }
  return null;
}

/**
 * Length in days of the census baseline window, or null when the device view
 * cannot support a growth projection. Same comparability rules the alarm's
 * whole-device projection uses: current, complete, same filesystem size, and a
 * baseline between 0.75 and 1.25 days old.
 */
export function comparableCensusWindowDays(d: CensusDeviceView): number | null {
  if (d.missing || d.stale || d.complete !== true) return null;
  if (!Number.isFinite(d.availBytes) || d.availBytes! < 0) return null;
  if (!Number.isFinite(d.sizeBytes) || d.sizeBytes! <= 0 || d.baselineSizeBytes !== d.sizeBytes) return null;
  const elapsedDays = (Date.parse(d.sampledAt ?? '') - Date.parse(d.baselineAt ?? '')) / 86400_000;
  return elapsedDays >= 0.75 && elapsedDays <= 1.25 ? elapsedDays : null;
}

/**
 * The census keeps overlapping rows (a directory and its children). Summing
 * them would count the same bytes twice, so keep only rows that are not inside
 * another kept row. A `files` row stands for the direct files of a directory
 * and therefore never contains another row.
 */
function outermostRows(rows: readonly CensusConsumer[]): CensusConsumer[] {
  const kept: CensusConsumer[] = [];
  const ordered = [...rows].sort(
    (a, b) => a.consumer.length - b.consumer.length || a.consumer.localeCompare(b.consumer),
  );
  for (const row of ordered) {
    const nested = kept.some(
      (k) =>
        k.consumer === row.consumer ||
        ((k.kind as string) !== 'files' && row.consumer.startsWith(`${k.consumer}/`)),
    );
    if (!nested) kept.push(row);
  }
  return kept;
}

/** Pure detector over the persisted census view. */
export function detectUnenforcedClassGrowth(
  devices: readonly CensusDeviceView[],
  opts: UnenforcedClassGrowthOptions,
): UnenforcedClassGrowthWarning[] {
  const horizonDays = opts.horizonDays ?? UNENFORCED_CLASS_HORIZON_DAYS;
  const policy = opts.policy ?? RETENTION_POLICY;
  const unenforced = new Map(policy.filter(isUnenforcedClass).map((c) => [c.id, c] as const));
  if (!unenforced.size) return [];
  const compiled = compilePolicy(policy, opts.home ?? homedir());
  const out: UnenforcedClassGrowthWarning[] = [];
  for (const d of devices) {
    const windowDays = comparableCensusWindowDays(d);
    if (windowDays === null) continue;
    const rows = d.consumers ?? [];
    const byConsumer = new Map(rows.map((r) => [r.consumer, r] as const));
    const byClass = new Map<string, CensusConsumer[]>();
    for (const m of mapCensusConsumers(rows, compiled).mapped) {
      const row = byConsumer.get(m.consumer);
      if (!row || !unenforced.has(m.classId)) continue;
      byClass.set(m.classId, [...(byClass.get(m.classId) ?? []), row]);
    }
    const floorBytes = headroomFloorBytes(d, opts.floors) ?? 0;
    for (const [classId, classRows] of byClass) {
      const outer = outermostRows(classRows);
      const growth = outer.reduce(
        (n, r) => n + (Number.isFinite(r.growth24hBytes) ? (r.growth24hBytes as number) : 0),
        0,
      );
      const growthBytesPerDay = growth / windowDays;
      if (!(growthBytesPerDay > 0)) continue;
      const daysToFloor = Math.max(0, d.availBytes! - floorBytes) / growthBytesPerDay;
      if (!(daysToFloor < horizonDays)) continue;
      const cls = unenforced.get(classId)!;
      out.push({
        device: d.device,
        classId,
        title: cls.title,
        keepKind: cls.keep.kind,
        keepReason: 'reason' in cls.keep ? cls.keep.reason : null,
        bytes: outer.reduce((n, r) => n + (Number.isFinite(r.bytes) ? r.bytes : 0), 0),
        growthBytesPerDay,
        availableBytes: d.availBytes!,
        floorBytes,
        daysToFloor,
        consumers: outer.map((r) => r.consumer),
        lowerBound: d.truncatedByLimit === true,
      });
    }
  }
  return out.sort(
    (a, b) => a.daysToFloor - b.daysToFloor || a.device.localeCompare(b.device) || a.classId.localeCompare(b.classId),
  );
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export function formatUnenforcedClassGrowthToast(
  warnings: readonly UnenforcedClassGrowthWarning[],
  horizonDays: number = UNENFORCED_CLASS_HORIZON_DAYS,
): { level: string; message: string; description: string } {
  const lines = warnings.slice(0, 10).map(
    (w) =>
      `• ${w.classId} on ${w.device}: ${gib(w.bytes)}, growing ${gib(w.growthBytesPerDay)} per day` +
      `${w.lowerBound ? ' (lower bound: the census row list was capped)' : ''}; ` +
      `${gib(w.availableBytes)} free reaches the ${gib(w.floorBytes)} floor in ${w.daysToFloor.toFixed(1)}d` +
      (w.keepReason ? `\n  Kept because: ${w.keepReason}` : ''),
  );
  return {
    level: 'warning',
    message:
      `Protected storage growth — ${warnings.length} class(es) with no retention enforcer ` +
      `will take a volume below its floor in <${horizonDays} days`,
    description: [
      lines.join('\n'),
      'No retention job can shrink these classes, so deleting files is not the fix: reduce the growth at its source.',
      'Projected from the existing 24h census; stale, missing or incomplete runs remain UNKNOWN and raise nothing.',
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}
