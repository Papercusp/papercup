import { withPlanLock, bumpUpdatedDate } from '@papercusp/operator-core/lib/agent-tools/plans/with-plan-lock';
import { allocateNextItemId, buildItemLine, appendItemToBody } from '@papercusp/operator-core/lib/agent-tools/plans/add-item';
import { allocateNextDecisionId, appendDecisionToBody } from '@papercusp/operator-core/lib/agent-tools/plans/add-decision';
import { flipStatusInBody } from '@papercusp/operator-core/lib/agent-tools/plans/set-status';
import { replaceNowBlock } from '@papercusp/operator-core/lib/agent-tools/plans/set-now';
import { readPlanBySlug } from '@papercusp/operator-core/lib/agent-tools/plans/source';
import { resolveEffectiveStatus } from '@papercusp/operator-core/lib/agent-tools/plans/effective-status';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const ctx = { isSuperuser: true, uiClientId: 'audit-smoke' };
const slug = '_audit-smoke-2026-05-20';

(async () => {
  const dir = path.join(process.cwd(), 'docs/plans');
  const fp = path.join(dir, slug + '.md');
  try { await fs.unlink(fp); } catch {}

  // 1. create
  const tmpl = `---\ntitle: Audit smoke\nslug: ${slug}\nstatus: draft\ncreated: 2026-05-20\nupdated: 2026-05-20\n---\n\n# Audit smoke\n\n## Now\n\n**State:** init.\n\n**Next:** test.\n\n## Phase 1 — Work\n\n## Decisions\n`;
  await fs.writeFile(fp, tmpl, 'utf8');

  // 2. add-item x2 via lock
  let r1 = await withPlanLock(ctx, { slug, intent: 'add' }, async (cur) => {
    const id = allocateNextItemId(cur!);
    const { newBody } = appendItemToBody(cur!, 'Phase 1 — Work', buildItemLine(id, 'first item', []));
    return { newBody: bumpUpdatedDate(newBody), value: id };
  });
  let r2 = await withPlanLock(ctx, { slug, intent: 'add' }, async (cur) => {
    const id = allocateNextItemId(cur!);
    const first = r1.kind==='applied'?r1.value:'';
    const { newBody } = appendItemToBody(cur!, 'Phase 1 — Work', buildItemLine(id, 'second item', [first]));
    return { newBody: bumpUpdatedDate(newBody), value: id };
  });
  const id1 = r1.kind==='applied'?r1.value:'ERR';
  const id2 = r2.kind==='applied'?r2.value:'ERR';
  console.log(`add-item: ${id1}, ${id2} (expect P-001, P-002)`);

  // 3. set-status P-001 -> done
  await withPlanLock(ctx, { slug, intent: 'flip' }, async (cur) => {
    const { newBody, found } = flipStatusInBody(cur!, id1, 'done');
    console.log(`set-status ${id1}->done: found=${found}`);
    return { newBody: bumpUpdatedDate(newBody), value: null };
  });

  // 4. add-decision
  let r3 = await withPlanLock(ctx, { slug, intent: 'dec' }, async (cur) => {
    const did = allocateNextDecisionId(cur!);
    const nb = appendDecisionToBody(cur!, did, 'Test decision', 'Body.', '2026-05-20', [id1]);
    return { newBody: bumpUpdatedDate(nb), value: did };
  });
  console.log(`add-decision: ${r3.kind==='applied'?r3.value:'ERR'} (expect D-001)`);

  // 5. set-now
  await withPlanLock(ctx, { slug, intent: 'now' }, async (cur) => {
    return { newBody: bumpUpdatedDate(replaceNowBlock(cur!, 'updated state', 'updated next')), value: null };
  });

  // 6. re-read + verify effective status
  const r = await readPlanBySlug(slug);
  const res = resolveEffectiveStatus(r!.parsed);
  const p2 = res.items.find(i => i.id === id2)!;
  console.log(`final: items=${res.items.length} decisions=${r!.parsed.decisions.length}`);
  console.log(`${id2} effectiveStatus=${p2.effectiveStatus} (expect todo — blocker ${id1} now done)`);
  console.log(`now.state="${r!.parsed.now?.state}" now.next="${r!.parsed.now?.next}"`);
  console.log(`updated bumped to: ${r!.parsed.frontmatter.updated}`);

  await fs.unlink(fp);
  console.log('cleanup OK');
})();
