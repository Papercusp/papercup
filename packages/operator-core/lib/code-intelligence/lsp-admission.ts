/** Daemon-side class admission. Transport and capability interpretation stay outside this module. */
import { createHash } from 'node:crypto';
import { pinModuleState } from '@papercusp/module-singleton';
import { CaplessAdaptiveController, type CaplessControllerOptions } from '../resource-governor/controller';
import type { HealthVerdict } from '../resource-governor/health-analysis';
import type { CodeIntelAnswer, CodeIntelIntent } from './contracts';

export interface LspAdmissionContext {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly language: string;
  readonly projectRoot: string;
  readonly op: string;
  readonly actor?: string;
  readonly priority?: number;
  readonly deadlineAtMs: number;
  readonly signal?: AbortSignal;
  /** Stable cursor/symbol identity, supplied at the resolved dispatch seam. */
  readonly queryKey?: string;
  /** Evidence-backed cost classification; unknown is never assumed cheap. */
  readonly symbolCost?: 'index-hit' | 'scan' | 'unknown';
}

export interface LspAdmissionReceipt {
  start(): Promise<void>;
  finish(): Promise<void>;
  cancel(reason: string): Promise<void>;
}

export interface LspAdmissionOptions {
  readonly now?: () => number;
  readonly controller?: CaplessControllerOptions;
  /** Persist pressure waiters before allowing them to execute. A failed write refuses the request. */
  readonly enqueue: (context: LspAdmissionContext, classKey: string) => Promise<LspAdmissionReceipt>;
  readonly agingIntervalMs?: number;
}

export class LspAdmissionError extends Error {
  constructor(readonly code: 'deadline' | 'cancelled' | 'persistence', message: string) {
    super(message);
    this.name = 'LspAdmissionError';
  }
}

interface Waiter {
  readonly context: LspAdmissionContext;
  readonly classKey: string;
  readonly enqueuedAt: number;
  readonly sequence: number;
  readonly abort: AbortController;
  readonly task: (signal: AbortSignal) => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  cleanup(): void;
  ready: boolean;
  started: boolean;
  abandoned: boolean;
  receipt?: LspAdmissionReceipt;
}

interface ClassLane {
  inFlight: number;
  readonly served: Map<string, number>;
}

export function lspAdmissionClass(context: LspAdmissionContext): string {
  // A server is shared; methods and measured symbol costs do not share a FIFO or window.
  return JSON.stringify([context.language, context.projectRoot, context.op, context.symbolCost ?? 'unknown']);
}

const HEALTH_VERSION: HealthVerdict['schemaVersion'] = 'resource-governor-health-analysis-v1';
function neutralVerdict(scopeId: string, atMs: number, healthy = false): HealthVerdict {
  return {
    schemaVersion: HEALTH_VERSION, scopeId, evaluatedAtMs: atMs,
    state: healthy ? 'healthy' : 'unknown', severity: 'none', actionable: false,
    evidence: [], attributions: [], actionableResources: [], ignoredCapacitySignals: [], reasons: [],
  };
}

export class LspAdmissionController {
  readonly #now: () => number;
  readonly #enqueue: LspAdmissionOptions['enqueue'];
  readonly #agingIntervalMs: number;
  readonly #controller: CaplessAdaptiveController;
  readonly #lanes = new Map<string, ClassLane>();
  readonly #waiters: Waiter[] = [];
  #sequence = 0;

  constructor(options: LspAdmissionOptions) {
    this.#now = options.now ?? Date.now;
    this.#enqueue = options.enqueue;
    // Ordering policy, not a queue or productive-capacity maximum.
    this.#agingIntervalMs = options.agingIntervalMs ?? 1_000;
    if (!Number.isFinite(this.#agingIntervalMs) || this.#agingIntervalMs <= 0) {
      throw new Error('agingIntervalMs must be positive');
    }
    this.#controller = new CaplessAdaptiveController(options.controller);
  }

  #lane(key: string): ClassLane {
    let lane = this.#lanes.get(key);
    if (!lane) {
      lane = { inFlight: 0, served: new Map() };
      this.#lanes.set(key, lane);
      this.#controller.step({ verdict: neutralVerdict(key, this.#now()), classes: [{ admissionClass: key, inFlight: 0 }] });
    }
    return lane;
  }

  /** Only the measured, attributable class is contracted; expiry remains governor-owned. */
  observeHealth(classKey: string, verdict: HealthVerdict): void {
    const lane = this.#lane(classKey);
    this.#controller.step({ verdict, classes: [{
      admissionClass: classKey, inFlight: Math.max(1, lane.inFlight),
      resourceWeights: Object.fromEntries(verdict.actionableResources.map(resource => [resource, 1])),
    }] });
    this.#drain();
  }

  snapshot() {
    const atMs = this.#now();
    const windows = this.#controller.snapshot(atMs);
    return {
      generation: windows.generation, sampledAtMs: atMs,
      classes: windows.classes.map(item => {
        const queued = this.#waiters.filter(waiter => waiter.classKey === item.admissionClass && !waiter.started && !waiter.abandoned);
        return {
          classKey: item.admissionClass, desiredWindow: item.desiredWindow,
          effectiveWindow: item.effectiveWindow, inFlight: this.#lanes.get(item.admissionClass)?.inFlight ?? 0,
          queued: queued.length, oldestWaitMs: queued.length ? atMs - Math.min(...queued.map(w => w.enqueuedAt)) : 0,
          pendingPersistence: queued.filter(waiter => !waiter.ready).length,
          feedback: item.feedback,
        };
      }),
    };
  }

  run<T>(context: LspAdmissionContext, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!context.workspaceId || !context.requestId || !context.language || !context.projectRoot || !context.op ||
        !Number.isFinite(context.deadlineAtMs) || !Number.isFinite(context.priority ?? 0)) {
      return Promise.reject(new Error('LSP admission needs resolved identity, finite priority, and caller deadline'));
    }
    if (context.signal?.aborted) return Promise.reject(new LspAdmissionError('cancelled', 'LSP request cancelled before admission'));
    if (context.deadlineAtMs <= this.#now()) return Promise.reject(new LspAdmissionError('deadline', 'LSP request deadline elapsed before admission'));
    const classKey = lspAdmissionClass(context);
    this.#lane(classKey);
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        context, classKey, enqueuedAt: this.#now(), sequence: this.#sequence++, abort: new AbortController(),
        task, resolve: value => resolve(value as T), reject, ready: true, started: false, abandoned: false,
        cleanup: () => {},
      };
      const abandon = (code: 'deadline' | 'cancelled') => {
        if (waiter.abandoned) return;
        waiter.abandoned = true;
        const error = new LspAdmissionError(code, `LSP request ${code === 'deadline' ? 'deadline elapsed' : 'cancelled'}`);
        waiter.abort.abort(error);
        waiter.cleanup();
        reject(error);
        if (!waiter.started) {
          this.#remove(waiter);
          if (waiter.receipt) void waiter.receipt.cancel(error.message).catch(() => {});
          this.#drain();
        }
        // An ignored cancellation is still running on the wire. Do not release its slot/receipt early.
      };
      const onAbort = () => abandon('cancelled');
      const timer = setTimeout(() => abandon('deadline'), context.deadlineAtMs - this.#now());
      waiter.cleanup = () => { clearTimeout(timer); context.signal?.removeEventListener('abort', onAbort); };
      context.signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiters.push(waiter);
      // A synchronous reservation prevents two callers from spending the same class credit.
      this.#drain();
      if (waiter.started) return;
      waiter.ready = false;
      void this.#enqueue(context, classKey).then(async receipt => {
        waiter.receipt = receipt;
        if (waiter.abandoned) { await receipt.cancel('LSP caller abandoned during queue persistence'); return; }
        waiter.ready = true;
        this.#drain();
      }).catch(error => {
        this.#remove(waiter);
        waiter.cleanup();
        waiter.abandoned = true;
        reject(new LspAdmissionError('persistence', `LSP queue receipt failed: ${error instanceof Error ? error.message : String(error)}`));
      });
    });
  }

  #remove(waiter: Waiter): void {
    const index = this.#waiters.indexOf(waiter);
    if (index >= 0) this.#waiters.splice(index, 1);
  }

  #drain(): void {
    const atMs = this.#now();
    const windows = this.#controller.snapshot(atMs);
    for (const window of windows.classes) {
      const lane = this.#lane(window.admissionClass);
      while (lane.inFlight < (window.effectiveWindow ?? window.desiredWindow)) {
        const candidates = this.#waiters.filter(w => w.ready && !w.started && !w.abandoned && w.classKey === window.admissionClass);
        // Aging protects batch work. Least-served actor wins ties before arrival order.
        candidates.sort((a, b) => {
          const score = (w: Waiter) => (w.context.priority ?? 0) + Math.floor((atMs - w.enqueuedAt) / this.#agingIntervalMs);
          return score(b) - score(a) ||
            (lane.served.get(a.context.actor ?? 'anonymous') ?? 0) - (lane.served.get(b.context.actor ?? 'anonymous') ?? 0) ||
            a.sequence - b.sequence;
        });
        const waiter = candidates[0];
        if (!waiter) break;
        if (waiter.context.deadlineAtMs <= atMs) break; // Its deadline callback removes it; never execute it.
        waiter.started = true;
        this.#remove(waiter);
        lane.inFlight++;
        const actor = waiter.context.actor ?? 'anonymous';
        lane.served.set(actor, (lane.served.get(actor) ?? 0) + 1);
        void this.#execute(waiter, lane);
      }
    }
  }

  async #execute(waiter: Waiter, lane: ClassLane): Promise<void> {
    try {
      await waiter.receipt?.start();
      if (waiter.abandoned) { await waiter.receipt?.cancel('LSP caller abandoned before execution'); return; }
      const result = await waiter.task(waiter.abort.signal);
      if (waiter.abandoned) await waiter.receipt?.cancel('LSP caller abandoned during execution');
      else {
        await waiter.receipt?.finish();
        waiter.resolve(result);
        // Successful service is an upward probe, never a permanent fixed concurrency cap.
        this.#controller.step({ verdict: neutralVerdict(waiter.classKey, this.#now(), true), classes: [{ admissionClass: waiter.classKey, inFlight: lane.inFlight }] });
      }
    } catch (error) {
      try { await waiter.receipt?.cancel(`LSP execution failed: ${error instanceof Error ? error.message : String(error)}`); }
      catch (settlementError) { if (!waiter.abandoned) waiter.reject(settlementError); }
      if (!waiter.abandoned) waiter.reject(error);
    } finally {
      waiter.cleanup();
      lane.inFlight--;
      this.#drain();
    }
  }
}

async function persistWaiter(context: LspAdmissionContext, classKey: string): Promise<LspAdmissionReceipt> {
  const { governedExecutionRuntime, beginGovernedExecution } = await import('../resource-governor/execution');
  const deps = governedExecutionRuntime(context.workspaceId, 'lsp-query');
  const request = {
    idempotencyKey: `lsp:${createHash('sha256').update(JSON.stringify([context.workspaceId, context.requestId])).digest('hex')}`,
    admissionClass: classKey, priority: context.priority, deadlineAtMs: context.deadlineAtMs,
    metadata: { actor: context.actor ?? 'anonymous', language: context.language, projectRoot: context.projectRoot, op: context.op },
    payloadRef: context.queryKey,
  };
  const outcome = await deps.governor.admit(request);
  if (outcome.kind !== 'queued') throw new Error('LSP pressure wait requires a durable queued receipt');
  let execution: Awaited<ReturnType<typeof beginGovernedExecution>> | undefined;
  return {
    async start() { execution = await beginGovernedExecution(request, { owner: context.actor ?? 'system:lsp-daemon' }, deps); },
    async finish() { if (execution) await execution.finish(); },
    async cancel(reason) { if (execution) await execution.cancel(reason); else await deps.governor.cancel(request.idempotencyKey, reason); },
  };
}

const shared = pinModuleState('papercusp.lsp-admission', () => ({ controllers: new Map<string, LspAdmissionController>() }));
export function lspAdmissionController(workspaceId: string): LspAdmissionController {
  let controller = shared.controllers.get(workspaceId);
  if (!controller) { controller = new LspAdmissionController({ enqueue: persistWaiter }); shared.controllers.set(workspaceId, controller); }
  return controller;
}

const INTENTS: Readonly<Record<string, CodeIntelIntent>> = {
  symbol: 'definition', references: 'references', implementations: 'implementations', diagnostics: 'diagnostics',
  workspace_symbols: 'symbol-search', refactor_preview: 'rename-preview', health: 'diagnostics',
};
export async function runLspAdmission(context: LspAdmissionContext, task: (signal: AbortSignal) => Promise<CodeIntelAnswer>): Promise<CodeIntelAnswer> {
  const startedAt = Date.now();
  try { return await lspAdmissionController(context.workspaceId).run(context, task); }
  catch (error) {
    return {
      backend: 'lsp-adapter', intent: INTENTS[context.op] ?? 'diagnostics', query: context.queryKey ?? context.op,
      sites: [], truncation: { truncated: false, totalAvailable: null, continuation: null },
      freshness: { health: 'degraded', indexedAt: null, staleVsDisk: null, indexedCommit: null },
      latencyMs: Date.now() - startedAt,
      error: `LSP admission ${error instanceof LspAdmissionError ? error.code : 'failed'}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
