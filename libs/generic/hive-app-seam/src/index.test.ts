import { describe, expect, it } from 'vitest';
import { createHiveAppSeam, type HiveAppSeamHost, type IngestEvent } from './index';

function host(): HiveAppSeamHost & {
  markers: Map<string, string>;
  hives: string[];
  work: string[];
} {
  const markers = new Map<string, string>();
  const hives: string[] = [];
  const work: string[] = [];
  return {
    markers,
    hives,
    work,
    readBootstrapMarker: (marker) => markers.get(marker) ?? null,
    writeBootstrapMarker: (marker, fingerprint) => {
      markers.set(marker, fingerprint);
    },
    ensureHive: (spec) => {
      hives.push(spec.slug);
      return { slug: spec.slug, created: true, ref: `hive:${spec.slug}` };
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

describe('createHiveAppSeam', () => {
  it('bootstraps hives once per stable fingerprint marker', async () => {
    const h = host();
    const seam = createHiveAppSeam(h);

    const first = await seam.bootstrapHives({
      hives: [
        { slug: 'shop', title: 'Shop' },
        { slug: 'shop-ops', blueprint: 'generic-hive' },
      ],
    });
    expect(first.skipped).toBe(false);
    expect(first.hives.map((x) => x.slug)).toEqual(['shop', 'shop-ops']);
    expect(h.hives).toEqual(['shop', 'shop-ops']);

    const second = await seam.bootstrapHives({
      hives: [
        { slug: 'shop-ops', blueprint: 'generic-hive' },
        { slug: 'shop', title: 'Shop' },
      ],
    });
    expect(second.skipped).toBe(true);
    expect(second.hives).toEqual([]);
    expect(h.hives).toEqual(['shop', 'shop-ops']);
  });

  it('enqueues work item drafts through the host adapter', async () => {
    const h = host();
    const seam = createHiveAppSeam(h);
    const out = await seam.enqueueWorkItems([
      { kind: 'candidate-review', title: 'Judge candidate A', payload: { candidateId: 'a' }, dedupeKey: 'candidate:a' },
    ]);
    expect(out).toEqual([{ id: 'WI-1', kind: 'candidate-review', dedupeKey: 'candidate:a' }]);
    expect(h.work).toEqual(['candidate-review:Judge candidate A']);
  });

  it('parses and stores ingest events with resumable cursors', async () => {
    const seam = createHiveAppSeam(host());
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

  it('fails fast on invalid hive and work-item boundaries', async () => {
    const seam = createHiveAppSeam(host());
    await expect(seam.bootstrapHives({ hives: [] })).rejects.toThrow(/at least one/);
    await expect(seam.bootstrapHives({ hives: [{ slug: '' }] })).rejects.toThrow(/hive.slug/);
    await expect(seam.enqueueWorkItems([{ kind: '', title: 'x', payload: {} }])).rejects.toThrow(/kind/);
  });
});
