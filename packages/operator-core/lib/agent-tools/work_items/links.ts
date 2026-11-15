/**
 * work_items:links — read the typed relations recorded by work_items:link.
 *
 * Reads one or many work-items in either direction. The limit is applied to
 * each item independently, and topic-tag edges are omitted because tags are
 * not work-item references (work_items:tag / work_items:get expose those).
 *
 * The two work-item families do not share one coord workspace implementation:
 * issue links use the dynamically scoped issue store, while feature links use
 * the canonical blocking reader. Keeping that dispatch here prevents an issue
 * read from silently querying the legacy DEFAULT_COORD_WORKSPACE partition.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { PgLinkStore, type LinkRow, type ObjectRef } from '@papercusp/coordination/capabilities';
import { getOrgPg } from '@papercusp/db-org';
import { coordScopeWorkspace } from '../coordination/log';
import { COORD_ROLES } from '../coordination/roles';
import { blockingEdgeReader, createBlockingEdgeReader, type BlockingEdgeReader } from '../../work-item-blocking';
import { getWorkItem, workItemObjectRef } from '../../work-items';
import { mergeIds, runBulk, bulkContent } from '../_bulk';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const cursorSchema = z.object({
  v: z.literal(1),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot: z.string().regex(/^[a-f0-9]{64}$/),
  offset: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function decodeCursor(token: string): z.infer<typeof cursorSchema> | null {
  try {
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.toString('base64url') !== token) return null;
    return cursorSchema.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    return null;
  }
}

function linkKey(link: WorkItemLink): string {
  const endpoint = link.src ?? link.dst!;
  return JSON.stringify([link.rel, endpoint.kind, endpoint.ref, link.satisfaction ?? null]);
}

/** The compact relation shape returned by this read surface. */
export interface WorkItemLink {
  rel: string;
  src?: ObjectRef;
  dst?: ObjectRef;
  satisfaction?: 'settled' | 'success';
}

/** Keep the endpoint relevant to the requested direction, matching get(detail:true)'s compact shape. */
export function projectWorkItemLink(row: LinkRow, direction: 'out' | 'in'): WorkItemLink {
  const satisfaction = 'satisfaction' in row ? (row.satisfaction as 'settled' | 'success') : undefined;
  return direction === 'out'
    ? { rel: row.rel, dst: row.dst, ...(satisfaction ? { satisfaction } : {}) }
    : { rel: row.rel, src: row.src, ...(satisfaction ? { satisfaction } : {}) };
}

/**
 * Issues have a per-workspace coord partition when COORD_PER_WORKSPACE is on.
 * This resolver is intentionally dynamic: PgLinkStore calls it at read time,
 * so a long-lived tool module never pins issue links to the workspace at import.
 */
const issueCoordStore = new PgLinkStore({
  getSql: () => getOrgPg().sql,
  ensureSchema: async () => {},
  getWorkspaceId: () => coordScopeWorkspace(),
});
const issueBlockingLinks: BlockingEdgeReader = createBlockingEdgeReader(issueCoordStore);

function readLinks(reader: BlockingEdgeReader, ref: ObjectRef, direction: 'out' | 'in'): Promise<LinkRow[]> {
  return direction === 'out' ? reader.listOut(ref) : reader.listIn(ref);
}

export default defineTool({
  name: 'work_items:links',
  profile: 'engineer',
  capability: 'work_items:read',
  requirePrincipal: false,
  // This handler uses getWorkItem plus the family-specific link readers, each
  // of which owns its own database access; do not retain an ambient tx across
  // the await-heavy per-item reads.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  description:
    'Read typed links for one OR many work-items, in either direction (limit per item: default 20, max 100). Pages report total, offset, returned, omitted (remaining after this page) and executable next; follow until truncated:false. Cursors survive restarts; source changes return stale_cursor with restart. Tags are excluded; emptyIds names checked zero-link items. coverage measures selected IDs separately. Failures stay in results.',
  guidance: {
    when: 'You need the structured relations recorded by work_items:link, including blockers, duplicates, fixes, and descriptive edges. Use direction:"out" for the item’s targets or direction:"in" for references to the item; pass ids:[…] for several items.',
    notWhen: 'For topic tags use work_items:tag or work_items:get { detail:true }; tags are intentionally omitted from this relation read.',
    chaining: 'work_items:get → work_items:links { id, direction:"out" | "in" } → follow each result.next.tool/args until truncated:false (or restart after stale_cursor) → work_items:get for the recovered linked items. Recover any outer result-door spill before treating a page as complete.',
  },
  args: z
    .object({
      id: z.string().min(1).optional().describe('a single work-item id (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().min(1)).max(100).optional().describe('work-item ids to read (1–100)'),
      direction: z
        .enum(['out', 'in'])
        .default('out')
        .describe('out = links from each item; in = links pointing to each item'),
      limit: z
        .number()
        .int()
        .positive()
        .max(MAX_LIMIT)
        .default(DEFAULT_LIMIT)
        .describe(`maximum links returned for EACH item (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
      harness: z.string().max(80).optional().describe('caller harness scope for resolving feature-family ids'),
      cursor: z.string().min(1).optional().describe('Opaque nextCursor from this item/direction. Resume one item per call using its next handle; source changes require the returned restart handle.'),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, {
      message: 'pass `id` (one) or `ids` (many)',
    })
    .refine((a) => !a.cursor || mergeIds(a.id, a.ids).length === 1, {
      message: 'a cursor resumes exactly one item; follow each item\'s next handle separately',
    }),
  async handler(args) {
    const ids = mergeIds(args.id, args.ids);
    const direction = args.direction ?? 'out';
    const limit = args.limit ?? DEFAULT_LIMIT;
    const env = await runBulk(
      ids,
      async (id) => {
        const item = await getWorkItem(id, args.harness);
        if (!item) return { ok: false as const, id, error: `work_item '${id}' not found` };

        const ref = workItemObjectRef(item);
        // The production blockingEdgeReader is the canonical feature-family
        // reader. Issue-family reads need the dynamically scoped store above;
        // both readers still merge canonical work_item_deps for `blocks`.
        const reader = ref.kind === 'issue' ? issueBlockingLinks : blockingEdgeReader;
        const rows = await readLinks(reader, ref, direction);
        // Order complete projected records, not the store's incidental row order.
        // The fingerprint binds an offset to this exact source, so insertions,
        // deletions and changed satisfaction never silently skip an edge.
        const matching = rows
          .filter((row) => row.rel !== 'tagged')
          .map((row) => projectWorkItemLink(row, direction))
          .map((link) => ({ link, key: linkKey(link) }))
          .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
          .map(({ link }) => link);
        const scope = fingerprint([coordScopeWorkspace(), ref.kind, ref.ref, direction]);
        const snapshot = fingerprint(matching.map(linkKey));
        const restart = {
          tool: 'work_items:links' as const,
          args: { id, direction, limit, ...(args.harness ? { harness: args.harness } : {}) },
        };
        const cursor = args.cursor ? decodeCursor(args.cursor) : null;
        if (args.cursor && (!cursor || cursor.scope !== scope)) {
          return { ok: false as const, id, error: 'invalid_cursor',
            message: 'Use this item, direction and workspace\'s exact nextCursor.', restart };
        }
        if (cursor && cursor.snapshot !== snapshot) {
          return { ok: false as const, id, error: 'stale_cursor',
            message: 'The matching links changed. Restart and replace the prior partial source.', restart };
        }
        if (cursor && cursor.offset >= matching.length) {
          return { ok: false as const, id, error: 'invalid_cursor',
            message: 'The cursor is outside this source. Restart the read.', restart };
        }
        const offset = cursor?.offset ?? 0;
        const links = matching.slice(offset, offset + limit);
        const end = offset + links.length;
        const omitted = matching.length - end;
        const nextCursor = omitted > 0
          ? Buffer.from(JSON.stringify({ v: 1, scope, snapshot, offset: end })).toString('base64url')
          : null;
        return { ok: true as const, id, direction, links,
          total: matching.length, offset, returned: links.length, omitted, truncated: omitted > 0,
          nextCursor, next: nextCursor ? { ...restart, args: { ...restart.args, cursor: nextCursor } } : null };
      },
      { keyOf: (id) => ({ id }) },
    );
    // Empty success rows carry no relation evidence and make a large selected
    // set consume the result door's fixed array allowance. The compact result
    // keeps every failure and every item with links, while `coverage` proves
    // how much of the selected set was checked, independently of how many
    // non-empty detail rows the result door can retain.
    const linkedIds = env.results.flatMap((result) =>
      result.ok && 'links' in result && result.links.length > 0 ? [result.id] : [],
    );
    const results = env.results.filter(
      (result) => !result.ok || ('links' in result && result.links.length > 0),
    );
    return bulkContent({
      ...env,
      results,
      // Empty successes stay compact without making them indistinguishable
      // from failed or unmeasured IDs. These are exact, complete identities.
      emptyIds: env.results.flatMap((result) => result.ok && 'total' in result && result.total === 0 ? [result.id] : []),
      coverage: {
        selectedCount: ids.length,
        checkedCount: env.results.length,
        complete: env.results.length === ids.length,
        linkedCount: linkedIds.length,
      },
    });
  },
});
