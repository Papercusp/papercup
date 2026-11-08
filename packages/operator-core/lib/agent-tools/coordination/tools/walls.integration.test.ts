/** EI-28142336654347264: indexed candidate selection must preserve canonical
 * wall parsing and the complete census while avoiding unrelated loop bodies. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setupBaselineCoordFixture,
  disposeBaselineCoordFixture,
  type BaselineCoordFixture,
} from '../../../_baseline-coord-fixture';
import { splitCarryNoteWalls } from '../../../carry-note';

vi.mock('../liveness-oracle', async orig => ({
  ...(await orig<typeof import('../liveness-oracle')>()),
  resolveSessionStates: vi.fn(async () => new Map()),
}));

const { listOwnerWalls } = await import('./walls');
const WS = 'walls-gin-ei-28142336654347264';
const FOREIGN_WS = `${WS}-foreign`;
const OWNER = 'su-walls-gin-fixture';
let fx: BaselineCoordFixture | undefined;

async function clean() {
  await fx!.admin`DELETE FROM harness_shared.carry_notes WHERE workspace_id IN (${WS}, ${FOREIGN_WS})`;
}

async function seed(scope: string, note: string, workspaceId = WS) {
  await fx!.admin`INSERT INTO harness_shared.carry_notes (workspace_id, scope, note, updated_ts)
    VALUES (${workspaceId}, ${scope}, ${note}, ${Date.now()})`;
}

beforeAll(async () => { fx = await setupBaselineCoordFixture(); }, 60_000);
beforeEach(clean);
afterAll(async () => { await disposeBaselineCoordFixture(fx, clean); });

describe('coord:walls indexed carry-note candidates', () => {
  it('keeps canonical heading variants and the full census while rejecting lexical false positives and other scopes', async () => {
    const notes = [
      '## Walls\n- canonical heading',
      '## walls\n- lowercase heading',
      '##\tWaLlS  \n- mixed case and tabs',
      '## Walls\r\n- carriage return heading\r\n',
      '  ## Walls\n- trimmed first heading',
      '## Did\nContext\n\n##\u2003Walls\n- unicode whitespace heading',
      '## Walls\n- first section\n## Did\nContext\n## WALLS\n- repeated section',
    ];
    for (const [i, note] of notes.entries()) await seed(`loop:variant-${i}:${OWNER}`, note);
    await seed(`loop:false-positive:${OWNER}`, '## Did\nWe painted the walls.\n- this is ordinary narrative');
    await seed(`loop:empty-section:${OWNER}`, '## Walls\n\n## Did\n- this is not a wall');
    await seed(`workitem:not-a-loop:${OWNER}`, '## Walls\n- wrong carrier');
    await seed(`loop:foreign:${OWNER}`, '## Walls\n- wrong workspace', FOREIGN_WS);
    await seed(`loop:other-owner:su-someone-else`, '## Walls\n- wrong owner');
    for (let i = 0; i < 20; i++) {
      await seed(`loop:large-history-${i}:${OWNER}`, `## Did\n${'historical context '.repeat(2_000)}`);
    }

    const expected = notes.flatMap(note => splitCarryNoteWalls(note).walls.map(wall => wall.claim)).sort();
    expect(expected).toHaveLength(8); // positive control for the independent parser
    const result = await listOwnerWalls({ workspaceId: WS, ownerId: OWNER, limit: 200 });
    expect(result.walls.map(wall => wall.claim).sort()).toEqual(expected);
    const page = await listOwnerWalls({ workspaceId: WS, ownerId: OWNER, limit: 2 });
    expect(page).toMatchObject({ total: 8, returned: 2, truncatedByLimit: true });
  });

  it('sees additions and removals through the generated index after a note changes', async () => {
    const scope = `loop:changed:${OWNER}`;
    await seed(scope, '## Did\nNo pending decision.');
    expect((await listOwnerWalls({ workspaceId: WS, ownerId: OWNER })).walls).toEqual([]);
    await fx!.admin`UPDATE harness_shared.carry_notes SET note = '## WALLS\n- fresh decision'
      WHERE workspace_id = ${WS} AND scope = ${scope}`;
    expect((await listOwnerWalls({ workspaceId: WS, ownerId: OWNER })).walls)
      .toMatchObject([{ claim: 'fresh decision' }]);
    await fx!.admin`UPDATE harness_shared.carry_notes SET note = '## Did\nDecision resolved.'
      WHERE workspace_id = ${WS} AND scope = ${scope}`;
    expect((await listOwnerWalls({ workspaceId: WS, ownerId: OWNER })).walls).toEqual([]);
  });
});
