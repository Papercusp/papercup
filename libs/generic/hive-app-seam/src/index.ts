/**
 * @papercusp/hive-app-seam
 *
 * A Tier-B host seam for agentic apps: deterministic app code can bootstrap
 * required hives, enqueue requests to the judgment plane, and ingest judged
 * outputs without importing a concrete operator, database, or queue.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface HiveSpec {
  readonly slug: string;
  readonly title?: string;
  readonly blueprint?: string;
  readonly templateId?: string;
  readonly metadata?: JsonObject;
}

export interface BootstrapHivesInput {
  readonly hives: readonly HiveSpec[];
  /** Idempotency marker name in the host store. Defaults to a stable hash. */
  readonly marker?: string;
}

export interface BootstrapHiveResult {
  readonly slug: string;
  readonly created: boolean;
  readonly ref?: string;
}

export interface BootstrapHivesResult {
  readonly marker: string;
  readonly fingerprint: string;
  readonly skipped: boolean;
  readonly hives: readonly BootstrapHiveResult[];
}

export interface WorkItemDraft<TPayload extends JsonObject = JsonObject> {
  readonly kind: string;
  readonly title: string;
  readonly payload: TPayload;
  readonly dedupeKey?: string;
}

export interface EnqueuedWorkItem {
  readonly id: string;
  readonly kind: string;
  readonly dedupeKey?: string;
}

export interface IngestEvent {
  readonly id: string;
  readonly payload: unknown;
}

export interface IngestCursor {
  readonly eventId: string;
}

export interface IngestSubscription {
  /** Resolves when the source drains or rejects if the loop fails without an onError handler. */
  readonly done: Promise<void>;
  stop(): Promise<void> | void;
}

export interface StartIngestLoopInput<TParsed> {
  readonly source: AsyncIterable<IngestEvent>;
  readonly parse: (event: IngestEvent) => Promise<TParsed> | TParsed;
  readonly store: (parsed: TParsed, cursor: IngestCursor) => Promise<void> | void;
  readonly onError?: (error: unknown, event: IngestEvent) => Promise<void> | void;
  readonly signal?: AbortSignal;
}

export interface HiveAppSeamHost {
  readBootstrapMarker(marker: string): Promise<string | null> | string | null;
  writeBootstrapMarker(marker: string, fingerprint: string): Promise<void> | void;
  ensureHive(spec: HiveSpec): Promise<BootstrapHiveResult> | BootstrapHiveResult;
  enqueueWorkItem(draft: WorkItemDraft): Promise<EnqueuedWorkItem> | EnqueuedWorkItem;
}

export interface HiveAppSeam {
  bootstrapHives(input: BootstrapHivesInput): Promise<BootstrapHivesResult>;
  enqueueWorkItems(items: readonly WorkItemDraft[]): Promise<readonly EnqueuedWorkItem[]>;
  startIngestLoop<TParsed>(input: StartIngestLoopInput<TParsed>): IngestSubscription;
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must be non-empty`);
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

function fingerprintHives(hives: readonly HiveSpec[]): string {
  const normalized = hives
    .map((h) => ({
      slug: h.slug,
      title: h.title ?? '',
      blueprint: h.blueprint ?? '',
      templateId: h.templateId ?? '',
      metadata: h.metadata ?? {},
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  return stableJson(normalized);
}

function defaultMarker(hives: readonly HiveSpec[]): string {
  return `hive-app-seam:${hives.map((h) => h.slug).sort().join('+')}`;
}

export function createHiveAppSeam(host: HiveAppSeamHost): HiveAppSeam {
  return {
    async bootstrapHives(input) {
      if (input.hives.length === 0) throw new Error('bootstrapHives requires at least one hive');
      for (const hive of input.hives) assertNonEmpty(hive.slug, 'hive.slug');

      const fingerprint = fingerprintHives(input.hives);
      const marker = input.marker ?? defaultMarker(input.hives);
      const existing = await host.readBootstrapMarker(marker);
      if (existing === fingerprint) {
        return { marker, fingerprint, skipped: true, hives: [] };
      }

      const hives: BootstrapHiveResult[] = [];
      for (const hive of input.hives) hives.push(await host.ensureHive(hive));
      await host.writeBootstrapMarker(marker, fingerprint);
      return { marker, fingerprint, skipped: false, hives };
    },

    async enqueueWorkItems(items) {
      if (items.length === 0) return [];
      const out: EnqueuedWorkItem[] = [];
      for (const item of items) {
        assertNonEmpty(item.kind, 'work item kind');
        assertNonEmpty(item.title, 'work item title');
        out.push(await host.enqueueWorkItem(item));
      }
      return out;
    },

    startIngestLoop(input) {
      let stopped = false;
      const stop = () => {
        stopped = true;
      };
      const run = async () => {
        for await (const event of input.source) {
          if (stopped || input.signal?.aborted) break;
          try {
            const parsed = await input.parse(event);
            await input.store(parsed, { eventId: event.id });
          } catch (error) {
            if (input.onError) await input.onError(error, event);
            else throw error;
          }
        }
      };
      const running = run();
      return {
        done: running,
        async stop() {
          stop();
          await running.catch(() => {});
        },
      };
    },
  };
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
