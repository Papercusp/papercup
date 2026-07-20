/**
 * pack-sync — the builtin packs' shared item files stay byte-identical to
 * their canonical source (EI-18121649240446176).
 *
 * `knowledge-packs/sync-map.json` (colocated with the packs) declares what is
 * shared: papercusp-default mirrors ALL of coding; work mirrors six named
 * discipline items. Hand-editing a mirror copy silently strands the other
 * side — this test turns that drift into a red. To fix a red: edit the
 * CANONICAL file (coding/) and run `npm run gen:knowledge-packs`; to
 * deliberately diverge a synced work item, remove it from sync-map.json and
 * edit the work copy.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinKnowledgePacksRoot } from './load-packs';

const root = builtinKnowledgePacksRoot();
const map = JSON.parse(readFileSync(join(root, 'sync-map.json'), 'utf8')) as {
  canonical: string;
  mirrors: Record<string, 'all' | string[]>;
};
const items = (pack: string) =>
  readdirSync(join(root, pack)).filter((f) => f.endsWith('.md')).sort();

describe('builtin pack sync (sync-map.json)', () => {
  it('every "all" mirror has exactly the canonical item set', () => {
    for (const [mirror, spec] of Object.entries(map.mirrors)) {
      if (spec !== 'all') continue;
      expect(items(mirror), `${mirror} item set`).toEqual(items(map.canonical));
    }
  });

  it('every synced file is byte-identical to its canonical source', () => {
    for (const [mirror, spec] of Object.entries(map.mirrors)) {
      const files = spec === 'all' ? items(map.canonical) : spec.map((id) => `${id}.md`);
      for (const file of files) {
        const canonical = readFileSync(join(root, map.canonical, file), 'utf8');
        const mirrored = readFileSync(join(root, mirror, file), 'utf8');
        expect(mirrored, `${mirror}/${file} drifted from ${map.canonical}/${file} — edit the canonical copy and run npm run gen:knowledge-packs`).toBe(canonical);
      }
    }
  });
});
