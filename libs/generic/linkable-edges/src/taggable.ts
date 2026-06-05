/**
 * linkable-edges/taggable.ts — Taggable rides Linkable. A topic tag on an
 * object IS a typed edge `object →tagged→ {kind:'topic', ref:<slug>}`. Modelling
 * tags as edges keeps the graph DRY (one edge store) and makes "what is tagged
 * with X" a plain reverse-edge lookup. This generic implementation works over
 * ANY LinkableStore, so every backend gets Taggable for free.
 */

import { type LinkableStore, type ObjectRef, type TaggableStore, TAG_REL } from './types';

const TOPIC_KIND = 'topic';

export class LinkBackedTaggable implements TaggableStore {
  constructor(
    private readonly links: LinkableStore,
    /** Host clock — a thunk so the construction site stays clock-free like the
     *  store seam. Defaults to wall-clock ISO. */
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async addTag(object: ObjectRef, topicSlug: string, opts: { created_by?: string; created_ts: string }): Promise<void> {
    await this.links.link(object, { kind: TOPIC_KIND, ref: topicSlug }, TAG_REL, {
      created_by: opts.created_by,
      created_ts: opts.created_ts,
    });
  }

  async removeTag(object: ObjectRef, topicSlug: string): Promise<void> {
    await this.links.unlink(object, { kind: TOPIC_KIND, ref: topicSlug }, TAG_REL);
  }

  async listTags(object: ObjectRef): Promise<string[]> {
    const out = await this.links.listOut(object, { rel: TAG_REL });
    return out.filter((l) => l.dst.kind === TOPIC_KIND).map((l) => l.dst.ref);
  }

  async listTagged(topicSlug: string): Promise<ObjectRef[]> {
    const into = await this.links.listIn({ kind: TOPIC_KIND, ref: topicSlug }, { rel: TAG_REL });
    return into.map((l) => l.src);
  }
}
