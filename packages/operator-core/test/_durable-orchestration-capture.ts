/** Replace a live child tape without exposing a truncated published snapshot. */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { GroundedCensus, GroundedMeasurementScope } from '../lib/grounded-evidence-measurement';

/** Compose independently admitted populations without completing an interrupted
 * producer or borrowing its recovery's scope/drain. Keep original censuses (and
 * their diagnostics/purpose registrations) beside the unmodified ids and rows. */
export function composeDurableCaptureCensus<T extends { id: string }>(
  scope: GroundedMeasurementScope, sourceRef: string, inputs: readonly (GroundedCensus<T> | undefined)[],
) {
  const sources = inputs.map(source => source ? structuredClone(source) : null);
  const gaps: string[] = [];
  const ids: string[] = [], rows: T[] = [];
  const validPopulation = (admitted: readonly string[], completed: readonly T[]) => {
    const admittedIds = new Set(admitted), completedIds = new Set(completed.map(row => row.id));
    return admittedIds.size === admitted.length && completedIds.size === completed.length
      && [...admittedIds, ...completedIds].every(id => typeof id === 'string' && id.trim().length > 0)
      && admittedIds.size === completedIds.size && [...admittedIds].every(id => completedIds.has(id));
  };
  if (!sourceRef.trim() || !sources.length) gaps.push('missing-composition-source');
  for (const [index, source] of sources.entries()) {
    if (!source) { gaps.push(`${index}:missing-source`); continue; }
    if (!isDeepStrictEqual(scope, source.scope)) gaps.push(`${index}:foreign-scope`);
    if (!source.sourceRef.trim()) gaps.push(`${index}:missing-source-ref`);
    if (!source.complete) gaps.push(`${index}:incomplete-source`);
    if (!validPopulation(source.ids, source.rows)) gaps.push(`${index}:population-mismatch`);
    ids.push(...source.ids); rows.push(...source.rows);
  }
  if (!validPopulation(ids, rows)) gaps.push('composed-population-mismatch');
  return { scope: { ...scope }, sourceRef, complete: gaps.length === 0, ids, rows, sources, gaps };
}

export function retainDurableCapture(path: string, capture: unknown): {
  serializationMs: number; publicationMs: number; bytes: number;
} {
  // Serialize before touching either file. Keep the sibling on the same
  // filesystem so readers see the previous snapshot or the complete replacement.
  const started = performance.now();
  const bytes = JSON.stringify(capture);
  const serialized = performance.now();
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { serializationMs: serialized - started, publicationMs: performance.now() - serialized,
    bytes: Buffer.byteLength(bytes) };
}

type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
type Patch = { path: string[]; value: Value; appendAt?: number };
const object = (value: Value | undefined): value is { [key: string]: Value } =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function changes(prior: Value | undefined, next: Value, path: string[] = [], out: Patch[] = []): Patch[] {
  if (isDeepStrictEqual(prior, next)) return out;
  if (Array.isArray(prior) && Array.isArray(next) && next.length >= prior.length
    && prior.every((value, index) => isDeepStrictEqual(value, next[index]))) {
    out.push({ path, value: next.slice(prior.length), appendAt: prior.length });
  } else if (object(prior) && object(next) && Object.keys(prior).every(key => Object.hasOwn(next, key))) {
    for (const key of Object.keys(next)) changes(Object.hasOwn(prior, key) ? prior[key] : undefined, next[key]!, [...path, key], out);
  } else out.push({ path, value: next });
  return out;
}

/** The existing child recorder's original snapshots, retained as synchronous
 * deltas. No sampling: array replacements (including final fragment exclusion)
 * and every scalar change survive. A failed append poisons this writer so a later
 * successful seal cannot conceal a missing admission or a partial tail. */
export function createDurableCaptureRecorder(path: string) {
  const journalPath = path + '.journal';
  let prior: Value | undefined, sequence = 0, previous: string | null = null, failed = false;
  return { retain(capture: unknown) {
    if (failed) throw new Error('Durable capture recorder failed; original journal must be inspected');
    const started = performance.now();
    try {
      // Normalize exactly once through the original JSON serialization contract;
      // retain a private postimage because source arrays keep growing in place.
      const next: Value = JSON.parse(JSON.stringify(capture));
      const payload = JSON.stringify({ version: 1, sequence, previous, patches: changes(prior, next) });
      const sha256 = digest(payload);
      const bytes = JSON.stringify({ payload, sha256 }) + '\n';
      const serialized = performance.now();
      if (sequence === 0) writeFileSync(journalPath, bytes, { flag: 'wx', mode: 0o600 });
      else appendFileSync(journalPath, bytes);
      const published = performance.now();
      prior = next; previous = sha256; sequence++;
      return { serializationMs: serialized - started, publicationMs: published - serialized,
        bytes: Buffer.byteLength(bytes) };
    } catch (error) { failed = true; throw error; }
  } };
}

function apply(prior: Value | undefined, patches: Patch[]): Value {
  let next = structuredClone(prior);
  for (const patch of patches) {
    if (!Array.isArray(patch.path) || patch.path.some(key => typeof key !== 'string') || !Object.hasOwn(patch, 'value'))
      throw new Error('invalid-patch');
    let parent: { [key: string]: Value } | undefined;
    let target = next;
    for (const key of patch.path) {
      if (!object(target)) throw new Error('invalid-patch-path');
      parent = target;
      target = Object.hasOwn(target, key) ? target[key] : undefined;
    }
    let value = patch.value;
    if (Object.hasOwn(patch, 'appendAt')) {
      if (!Array.isArray(target) || !Array.isArray(value) || patch.appendAt !== target.length)
        throw new Error('invalid-append-offset');
      value = target.concat(value);
    }
    if (parent) Object.defineProperty(parent, patch.path.at(-1)!, { value, enumerable: true, writable: true, configurable: true });
    else next = value;
  }
  if (next === undefined) throw new Error('missing-root');
  return next;
}

/** Reconstruct only verified contiguous frames. Preserve the original bytes and
 * explicitly invalidate all qualifying censuses after any malformed/partial tail.
 * A complete journal says nothing about a drain: crash snapshots stay unsealed. */
export function reconstructDurableCapture(path: string) {
  const sourceRef = path + '.journal', original = readFileSync(sourceRef);
  // Buffer boundaries matter: decoding a truncated UTF-8 character must not turn
  // into a replacement character that can accidentally qualify a valid record.
  const lines = original.toString('utf8').split('\n');
  let capture: Value | undefined, frames = 0, previous: string | null = null, error: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    if (index === lines.length - 1 && lines[index] === '') break;
    try {
      if (index === lines.length - 1) throw new Error('partial-tail');
      const envelope = JSON.parse(lines[index]!);
      if (typeof envelope.payload !== 'string' || digest(envelope.payload) !== envelope.sha256)
        throw new Error('frame-hash-mismatch');
      const frame = JSON.parse(envelope.payload);
      if (frame.version !== 1 || frame.sequence !== frames || frame.previous !== previous || !Array.isArray(frame.patches))
        throw new Error('frame-chain-mismatch');
      const next = apply(capture, frame.patches);
      if (!object(next)) throw new Error('invalid-capture-root');
      capture = next; previous = envelope.sha256; frames++;
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); break; }
  }
  if (!object(capture)) throw new Error('No verified durable capture frame: ' + (error ?? 'empty-journal'));
  if (error) {
    capture.boundary = null;
    for (const key of ['census', 'invocations', 'storage']) if (object(capture[key])) capture[key].complete = false;
  }
  const retentionJournal = { sourceRef, sha256: digest(original), bytes: original.byteLength,
    frames, complete: error === null, error };
  return Object.assign(capture, { retentionJournal });
}

/** The parent publishes one familiar JSON postimage after child death/exit. The
 * append-only journal remains beside it as the original, independently hashable tape. */
export function materializeDurableCapture(path: string) {
  const capture = reconstructDurableCapture(path);
  retainDurableCapture(path, capture);
  return capture;
}
