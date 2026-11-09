/** Measurement apparatus only. Injected dependency schedules run through the
 * maintained search engine; observed defects are retained, never repaired here. */
/** T10 deterministic dependency schedules, expressed relative to monotonic
 * task entry. These are injected test inputs, never measured latency samples.
 * The caller must separately pin the actual unchanged runtime budget. */
export function latencyRetrievalFixtures(budgetMs: number) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 4) {
    throw new Error('LATENCY-M1 retrieval fixture requires an explicit integer budget >=4ms');
  }
  const common = { callEntryMs: 0, embedderEntryMs: 0, budgetMs, deadlineMs: budgetMs,
    lexicalFallbackId: 'latency-lexical-001' };
  const half = Math.floor(budgetMs / 2);
  return { seed: 'LATENCY-M1-retrieval-v1', budgetMs, measured: false,
    budgetProvenance: 'caller-supplied; actual loaded runtime configuration must be pinned separately',
    cases: [
      { id: 'on-time', ...common, synchronousReturnMs: 0, queuedAtMs: 0, networkAtMs: 1,
        resultAtMs: budgetMs - 1, timerCallbackMs: null,
        expected: { embeddingAccepted: true, fallback: null, cancellation: null } },
      { id: 'synchronous-entry-block', ...common, synchronousReturnMs: budgetMs + 1,
        queuedAtMs: null, networkAtMs: null, resultAtMs: budgetMs + 1, timerCallbackMs: budgetMs + 2,
        expected: { embeddingAccepted: false, fallback: 'latency-lexical-001', cancellation: 'non-preemptible-entry-explicit' } },
      { id: 'queue-delay', ...common, synchronousReturnMs: 0, queuedAtMs: 0, networkAtMs: null,
        resultAtMs: null, timerCallbackMs: budgetMs,
        expected: { embeddingAccepted: false, fallback: 'latency-lexical-001', cancellation: 'queued' } },
      { id: 'late-timer', ...common, synchronousReturnMs: 0, queuedAtMs: 0, networkAtMs: 1,
        resultAtMs: budgetMs + 1, timerCallbackMs: budgetMs + 2,
        expected: { embeddingAccepted: false, fallback: 'latency-lexical-001', cancellation: 'network' } },
      { id: 'late-success', ...common, synchronousReturnMs: 0, queuedAtMs: 0, networkAtMs: 1,
        resultAtMs: budgetMs + 2, timerCallbackMs: budgetMs,
        expected: { embeddingAccepted: false, fallback: 'latency-lexical-001', cancellation: 'network' } },
      { id: 'abort-network', ...common, synchronousReturnMs: 0, queuedAtMs: 0, networkAtMs: 1,
        abortAtMs: half, resultAtMs: null, timerCallbackMs: null,
        expected: { embeddingAccepted: false, fallback: null, cancellation: 'network', callerAborted: true } },
      { id: 'abort-queued', ...common, synchronousReturnMs: 0, queuedAtMs: 0, networkAtMs: null,
        abortAtMs: half, resultAtMs: null, timerCallbackMs: null,
        expected: { embeddingAccepted: false, fallback: null, cancellation: 'queued', callerAborted: true } },
      { id: 'lexical-fallback', ...common, synchronousReturnMs: 0, queuedAtMs: null, networkAtMs: null,
        resultAtMs: 0, timerCallbackMs: null,
        expected: { embeddingAccepted: false, fallback: 'latency-lexical-001', cancellation: null } },
    ],
  };
}

/** Execute a frozen injected provider schedule through the real search engine.
 * Real monotonic clocks and timers are retained, including late acceptance.
 * This is preparation/calibration; a caller must separately register a task attempt. */
export async function observeLatencyRetrievalSchedule(
  schedule: ReturnType<typeof latencyRetrievalFixtures>['cases'][number],
) {
  const { runHybridSearch } = await import('@papercusp/search');
  const anchor = performance.now();
  const at = () => performance.now() - anchor;
  const marks: Record<string, number | null> = { callEntryMs: 0, embedderEntryMs: null,
    synchronousReturnMs: null, queuedAtMs: null, networkAtMs: null, resultAtMs: null,
    timerCallbackMs: null, cancellationAtMs: null, terminalMs: null };
  const timers: ReturnType<typeof setTimeout>[] = [];
  const caller = new AbortController();
  let cancellation: 'queued' | 'network' | null = null;
  let safetyDeadlineFired = false;
  const later = (relativeMs: number, fn: () => void) => {
    const timer = setTimeout(fn, Math.max(0, anchor + relativeMs - performance.now()));
    timers.push(timer);
  };
  const blockUntil = (relativeMs: number) => {
    const remaining = anchor + relativeMs - performance.now();
    if (remaining > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, remaining);
  };
  const hit = (id: string) => ({ source: 'latency-fixture', source_id: id,
    excerpt: id, highlight: id, score: 1, rankers: ['latency-fixture'] });
  const listing = (id: string) => [{ key: id, score: 1, row: hit(id) }];
  const source = { name: 'latency-fixture', lexical: async () => listing(schedule.lexicalFallbackId),
    embedding: async () => listing('latency-vector-001') };
  const embedder = schedule.id === 'lexical-fallback' ? null : (_query: string, signal?: AbortSignal) => {
    marks.embedderEntryMs = at();
    if (schedule.queuedAtMs !== null) marks.queuedAtMs = at();
    signal?.addEventListener('abort', () => {
      marks.cancellationAtMs = at();
      cancellation = marks.networkAtMs === null ? 'queued' : 'network';
      if (!caller.signal.aborted) marks.timerCallbackMs = at();
    }, { once: true });
    if (schedule.id === 'synchronous-entry-block') {
      blockUntil(schedule.synchronousReturnMs);
      marks.synchronousReturnMs = at();
      marks.resultAtMs = at();
      return Promise.resolve([1, 0]);
    }
    const promise = new Promise<number[]>((resolve, reject) => {
      if (schedule.networkAtMs !== null) later(schedule.networkAtMs, () => { marks.networkAtMs = at(); });
      if (schedule.id === 'late-timer') {
        // Complete in the callback that blocks the deadline's timer. Its promise
        // continuation can run before the overdue timer, exposing a late accept.
        later(schedule.budgetMs - 1, () => {
          blockUntil(schedule.budgetMs + 2);
          marks.resultAtMs = at();
          resolve([1, 0]);
        });
      } else if (schedule.resultAtMs !== null) later(schedule.resultAtMs, () => {
        marks.resultAtMs = at();
        resolve([1, 0]);
      });
      // Late-success deliberately models a provider that ignores cancellation;
      // retain its late completion instead of mistaking a signal for pickup.
      if (schedule.id !== 'late-success') signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    marks.synchronousReturnMs = at();
    return promise;
  };
  const abortAt = 'abortAtMs' in schedule ? schedule.abortAtMs : null;
  if (abortAt !== null) later(abortAt, () => caller.abort(new Error('latency-fixture-caller-abort')));
  later(schedule.budgetMs + 1_000, () => {
    safetyDeadlineFired = true;
    caller.abort(new Error('latency-fixture-safety-deadline'));
  });
  let result: Awaited<ReturnType<typeof runHybridSearch>> | undefined;
  let error: string | null = null;
  try {
    result = await runHybridSearch([source], { sql: {} as never, query: 'latency-fixture',
      workspaceId: 'latency-acceptance-fixture', scopeFilter: null, limit: 4, mode: 'hybrid',
      embedder, embedTimeoutMs: schedule.budgetMs, signal: caller.signal,
      caller: 'LATENCY-M1-calibration', minScore: false, recency: false, lexicalCascade: false });
  } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  finally { marks.terminalMs = at(); }
  // Observe a provider's original scheduled terminal even if the engine already
  // returned, so an uncancelled request cannot disappear from the receipt.
  if (schedule.id === 'late-success') await new Promise<void>(resolve => later(schedule.resultAtMs! + 5, resolve));
  for (const timer of timers) clearTimeout(timer);
  const embeddingAccepted = result?.embedderAvailable ?? false;
  const ids = result?.results.map(row => row.source_id) ?? [];
  const lateAccepted = embeddingAccepted && marks.resultAtMs !== null && marks.resultAtMs > schedule.deadlineMs;
  return { id: schedule.id, budgetMs: schedule.budgetMs, deadlineMs: schedule.deadlineMs,
    clock: 'performance.now', marks, embeddingAccepted, ids,
    fallback: !embeddingAccepted && ids.includes(schedule.lexicalFallbackId) ? schedule.lexicalFallbackId : null,
    cancellation, callerAborted: caller.signal.aborted && abortAt !== null, error,
    safetyDeadlineFired, violations: { lateAccepted,
      requestCompletedAfterCancellation: marks.resultAtMs !== null && marks.cancellationAtMs !== null
        && marks.resultAtMs > marks.cancellationAtMs } };
}

