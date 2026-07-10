import { describe, expect, it } from 'vitest';
import { createPotAppSeam, type PotAppSeamHost, type IngestEvent } from './index';

function host(): PotAppSeamHost & {
  markers: Map<string, string>;
  pots: string[];
  work: string[];
} {
  const markers = new Map<string, string>();
  const pots: string[] = [];
  const work: string[] = [];
  return {
    markers,
    pots,
    work,
    readBootstrapMarker: (marker) => markers.get(marker) ?? null,
    writeBootstrapMarker: (marker, fingerprint) => {
      markers.set(marker, fingerprint);
    },
    ensurePot: (spec) => {
      pots.push(spec.slug);
      return { slug: spec.slug, created: true, ref: `pot:${spec.slug}` };
    },
    enqueueWorkItem: (draft) => {
      const id = `WI-${work.length + 1}`;
      work.push(`${draft.kind}:${draft.title}`);
      return { id, kind: draft.kind, dedupeKey: draft.dedupeKey };
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

  it('enqueues work item drafts through the host adapter', async () => {
    const h = host();
    const seam = createPotAppSeam(h);
    const out = await seam.enqueueWorkItems([
      { kind: 'candidate-review', title: 'Judge candidate A', payload: { candidateId: 'a' }, dedupeKey: 'candidate:a' },
    ]);
    expect(out).toEqual([{ id: 'WI-1', kind: 'candidate-review', dedupeKey: 'candidate:a' }]);
    expect(h.work).toEqual(['candidate-review:Judge candidate A']);
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
    await expect(seam.enqueueWorkItems([{ kind: '', title: 'x', payload: {} }])).rejects.toThrow(/kind/);
  });
});
