import { describe, expect, it } from 'vitest';
import { createPotAppSeam, type PotAppSeamHost, type IngestEvent } from './index';

function host(): PotAppSeamHost & {
  markers: Map<string, string>;
  pots: string[];
  runs: string[];
} {
  const markers = new Map<string, string>();
  const pots: string[] = [];
  const runs: string[] = [];
  return {
    markers,
    pots,
    runs,
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
