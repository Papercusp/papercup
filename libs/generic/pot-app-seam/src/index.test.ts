import { describe, expect, it } from 'vitest';
import {
  createPotAppSeam,
  operationDraftFromPlanRun,
  type BlueprintOperationHandle,
  type IngestEvent,
  type PotAppSeamHost,
} from './index';

function host(): PotAppSeamHost & {
  markers: Map<string, string>;
  pots: string[];
  runs: string[];
  operations: Map<string, BlueprintOperationHandle>;
} {
  const markers = new Map<string, string>();
  const pots: string[] = [];
  const runs: string[] = [];
  const operations = new Map<string, BlueprintOperationHandle>();
  return {
    markers,
    pots,
    runs,
    operations,
    readBootstrapMarker: (marker) => markers.get(marker) ?? null,
    writeBootstrapMarker: (marker, fingerprint) => {
      markers.set(marker, fingerprint);
    },
    ensurePot: (spec) => {
      pots.push(spec.slug);
      return { slug: spec.slug, created: true, ref: `pot:${spec.slug}` };
    },
    launchPlanRun: (draft) => {
      const n = runs.length + 1;
      runs.push(`${draft.templateSlug}:${draft.execution.agentName}`);
      return {
        runId: `RUN-${n}`,
        planSlug: `${draft.templateSlug}-run-${n}`,
        workItemIds: [`WI-${n}`],
        assignedAgentName: draft.execution.agentName,
        dedupeKey: draft.dedupeKey,
        dispatch: {
          status: 'delivered',
          assignedWorkItemIds: [`WI-${n}`],
          wakeAcknowledged: true,
        },
      };
    },
    submitBlueprintOperation: (draft) => {
      const key = `${draft.harnessSlug}:${draft.operationId}:${draft.requestKey}`;
      const prior = operations.get(key);
      if (prior) return prior;
      const handle: BlueprintOperationHandle = {
        workspaceId: 'workspace-fixture',
        harnessSlug: draft.harnessSlug,
        receiptId: operations.size + 1,
        operationId: draft.operationId,
        specificationRevision: 'a'.repeat(64),
        target: { kind: 'plan', runId: operations.size + 1, instanceSlug: `review@run-${operations.size + 1}` },
      };
      operations.set(key, handle);
      return handle;
    },
    readBlueprintOperationStatus: (handle) => ({
      handle,
      phase: 'terminal',
      outcome: 'succeeded',
      items: [],
      planRun: { status: 'done', outcome: 'success' },
      cancellationRequested: false,
      wait: null,
    }),
    readBlueprintOperationResult: (handle) => ({
      state: 'pending',
      status: {
        handle,
        phase: 'dispatched',
        outcome: null,
        items: [],
        planRun: { status: 'running', outcome: null },
        cancellationRequested: false,
        wait: null,
      },
    }),
  };
}

async function* events(items: IngestEvent[]): AsyncIterable<IngestEvent> {
  for (const item of items) yield item;
}

describe('createPotAppSeam', () => {
  it('bootstraps pots once per stable fingerprint marker', async () => {
    const h = host();
    const seam = createPotAppSeam(h);

    const first = await seam.bootstrapPots({
      pots: [
        { slug: 'shop', title: 'Shop' },
        { slug: 'shop-ops', blueprint: 'generic-pot' },
      ],
    });
    expect(first.skipped).toBe(false);
    expect(first.pots.map((x) => x.slug)).toEqual(['shop', 'shop-ops']);
    expect(h.pots).toEqual(['shop', 'shop-ops']);

    const second = await seam.bootstrapPots({
      pots: [
        { slug: 'shop-ops', blueprint: 'generic-pot' },
        { slug: 'shop', title: 'Shop' },
      ],
    });
    expect(second.skipped).toBe(true);
    expect(second.pots).toEqual([]);
    expect(h.pots).toEqual(['shop', 'shop-ops']);
  });

  it('launches an app-owned plan run through the canonical host adapter', async () => {
    const h = host();
    const seam = createPotAppSeam(h);
    const out = await seam.launchPlanRuns([
      {
        templateSlug: 'candidate-review',
        input: { candidateId: 'a' },
        provenance: { eventId: 'evt-a' },
        execution: { appHarnessSlug: 'shop', agentName: 'shop-reviewer' },
        dedupeKey: 'candidate:a',
      },
    ]);
    expect(out[0]).toMatchObject({
      runId: 'RUN-1',
      workItemIds: ['WI-1'],
      assignedAgentName: 'shop-reviewer',
      dedupeKey: 'candidate:a',
      dispatch: { status: 'delivered', wakeAcknowledged: true },
    });
    expect(h.runs).toEqual(['candidate-review:shop-reviewer']);
  });

  it('maps a legacy plan draft to one operation request without changing replay identity or input', () => {
    const request = operationDraftFromPlanRun({
      templateSlug: 'candidate-review',
      input: { candidateId: 'a' },
      provenance: { eventId: 'evt-a' },
      execution: { appHarnessSlug: 'shop', agentName: 'shop-reviewer' },
      dedupeKey: 'candidate:a',
    }, 'review-candidate');
    expect(request).toEqual({
      harnessSlug: "shop",
      operationId: "review-candidate",
      requestKey: "candidate:a",
      input: { candidateId: "a", provenance: { eventId: "evt-a" } },
    });
    expect(() => operationDraftFromPlanRun({
      templateSlug: 'candidate-review',
      input: { candidateId: 'a' },
      provenance: { eventId: 'evt-a' },
      execution: { appHarnessSlug: 'shop', agentName: 'shop-reviewer' },
    }, 'review-candidate')).toThrow(/requires dedupeKey/);
    expect(() =>
      operationDraftFromPlanRun(
        {
          templateSlug: "candidate-review",
          input: { provenance: "caller-owned" },
          provenance: { eventId: "evt-a" },
          execution: { appHarnessSlug: "shop", agentName: "shop-reviewer" },
          dedupeKey: "candidate:a",
        },
        "review-candidate",
      ),
    ).toThrow(/reserved provenance/);
  });

  it('submits one durable operation handle on replay and returns payload only when ready', async () => {
    const h = host();
    const seam = createPotAppSeam(h);
    const request = {
      harnessSlug: 'shop',
      operationId: 'review-candidate',
      requestKey: 'candidate:a',
      input: { candidateId: 'a' },
    } as const;
    const first = await seam.submitOperations([request]);
    const replay = await seam.submitOperations([request]);
    expect(replay[0]).toEqual(first[0]);
    expect(h.operations).toHaveLength(1);

    h.readBlueprintOperationResult = (handle) => ({
      state: 'ready',
      status: {
        handle,
        phase: 'terminal',
        outcome: 'succeeded',
        items: [],
        planRun: { status: 'done', outcome: 'success' },
        cancellationRequested: false,
        wait: null,
      },
      output: { candidateId: 'a', verdict: 'accepted' },
      evidenceRef: 'plan-run:1',
    });
    await expect(seam.operationResult<{ candidateId: string; verdict: string }>(first[0]!)).resolves.toMatchObject({
      state: 'ready',
      output: { candidateId: 'a', verdict: 'accepted' },
    });
  });

  it('refuses a non-ready result that smuggles an output payload', async () => {
    const h = host();
    const seam = createPotAppSeam(h);
    const [handle] = await seam.submitOperations([{
      harnessSlug: 'shop', operationId: 'review-candidate', requestKey: 'candidate:a', input: {},
    }]);
    h.readBlueprintOperationResult = (sameHandle) => ({
      state: 'failed',
      reason: 'plan failed',
      output: { shouldNotExist: true },
      status: {
        handle: sameHandle,
        phase: 'terminal',
        outcome: 'failed',
        items: [],
        planRun: { status: 'failed', outcome: 'failed' },
        cancellationRequested: false,
        wait: null,
      },
    } as never);
    await expect(seam.operationResult(handle!)).rejects.toThrow(/must not carry output/);
  });

  it('parses and stores ingest events with resumable cursors', async () => {
    const seam = createPotAppSeam(host());
    const stored: Array<{ text: string; cursor: string }> = [];
    const sub = seam.startIngestLoop({
      source: events([{ id: 'evt-1', payload: { text: 'accepted' } }]),
      parse: (event) => {
        const payload = event.payload as { text: string };
        return payload.text.toUpperCase();
      },
      store: (text, cursor) => {
        stored.push({ text, cursor: cursor.eventId });
      },
    });
    await sub.done;
    expect(stored).toEqual([{ text: 'ACCEPTED', cursor: 'evt-1' }]);
  });

  it('fails fast on invalid pot and work-item boundaries', async () => {
    const seam = createPotAppSeam(host());
    await expect(seam.bootstrapPots({ pots: [] })).rejects.toThrow(/at least one/);
    await expect(seam.bootstrapPots({ pots: [{ slug: '' }] })).rejects.toThrow(/pot.slug/);
    await expect(seam.launchPlanRuns([{
      templateSlug: '',
      input: {},
      provenance: {},
      execution: { appHarnessSlug: 'shop', agentName: 'shop-reviewer' },
    }])).rejects.toThrow(/plan template slug/);
  });

  it('fails loudly when the stable execution target was not dispatched and woken', async () => {
    const h = host();
    h.launchPlanRun = (draft) => ({
      runId: 'RUN-1',
      planSlug: 'candidate-review-run-1',
      workItemIds: ['WI-1'],
      assignedAgentName: draft.execution.agentName,
      dispatch: {
        status: 'retryable-failure',
        assignedWorkItemIds: ['WI-1'],
        wakeAcknowledged: false,
        reason: 'stable agent is absent',
      },
    });
    const seam = createPotAppSeam(h);
    await expect(seam.launchPlanRuns([{
      templateSlug: 'candidate-review',
      input: {},
      provenance: { eventId: 'evt-a' },
      execution: { appHarnessSlug: 'shop', agentName: 'shop-reviewer' },
    }])).rejects.toThrow(/failed retryably.*stable agent is absent/);
  });
});
