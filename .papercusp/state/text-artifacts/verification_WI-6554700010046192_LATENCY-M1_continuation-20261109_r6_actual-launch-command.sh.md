---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/continuation-20261109/r6/actual-launch-command.sh"
updated_at: 1794191344576
_body: "content"
---

mkdir /tmp/latency-original-source-seed-20261109-r6
PAPERCUSP_TEST_ARTIFACT_DIR=/tmp/latency-original-source-seed-20261109-r6 PAPERCUSP_TEST_RUN_WORKSPACE=latency-acceptance-fixture timeout --signal=TERM --kill-after=15s 360s node /tmp/latency-baseline-git-source-20261108-r1/scripts/with-test-pg.mjs --isolated-runtime=operator-api -- node --import /tmp/latency-baseline-git-source-20261108-r1/node_modules/tsx/dist/loader.mjs --input-type=module - >/tmp/latency-original-source-seed-20261109-r6/run.log 2>&1 <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createLatencyPgFixture } from '/tmp/latency-baseline-git-source-20261108-r1/packages/operator-core/test/_latency-pg-fixture.ts';
import { latencyFixtureDigest } from '/tmp/latency-baseline-git-source-20261108-r1/packages/operator-core/test/_latency-acceptance.ts';
const out='/tmp/latency-original-source-seed-20261109-r6';
const selectedPath='/tmp/latency-frozen-selected-historical-records.json', namedPath='/tmp/latency-frozen-named-card-rubric-records.json';
const selectedBytes=readFileSync(selectedPath), namedBytes=readFileSync(namedPath);
const selected=JSON.parse(selectedBytes), named=JSON.parse(namedBytes);
const cards=new Map();
for (const row of [...selected.cards,...named.cards]) {
 if(cards.has(row.issue_id)) assert.deepEqual(row,cards.get(row.issue_id),'Original card snapshots disagree');
 cards.set(row.issue_id,row);
}
const tables=[['harness_plans',named.rubricDefinitions],['engineer_issues',[...cards.values()]],
 ['plan_revisions',[...named.rubricHistory,selected.planRevision]],['plan_spec_clauses',selected.specClauses],
 ['plan_spec_clause_revisions',selected.specRevisions]];
const fkBytes=readFileSync('/tmp/latency-immutable-spec-fk-closure-20261109.json');
const closure=JSON.parse(fkBytes).records, originalRevisions=new Map(selected.specRevisions.map(row=>[row.spec_id+':'+row.revision,row]));
for(const row of closure){const original=originalRevisions.get(row.spec_id+':'+row.revision);if(original)for(const key of Object.keys(original))assert.deepEqual(row[key],original[key],'Immutable original revision changed: '+key);}
const supportingRevisions=closure.filter(row=>!originalRevisions.has(row.spec_id+':'+row.revision));
for(const row of supportingRevisions)assert.ok(Math.max(Date.parse(row.created_at),Date.parse(row.accepted_at||row.created_at))>selected.planRevision.created_at,'FK dependency overlaps frozen historical task window');
const needed=new Set(closure.map(row=>row.spec_id+':'+row.revision));
for(const row of selected.specClauses)assert.ok(needed.has(row.spec_id+':'+row.current_revision),'FK closure missing current pointer');
const fx=await createLatencyPgFixture();
const receipt={phase:'original-input-private-PG-preparation-only',actualProviderTaskAttempts:0,
 sourceCommit:'7986ba393eeb0471d8bca059b01332908e1f5805',workspace:fx.fixture.workspace,database:fx.db.dbName,
 scopeTransformation:'Only workspace_id is relocated to the predeclared private fixture workspace. Original IDs, payloads, historical selectors and references are retained.',
 sources:[{path:selectedPath,sha256:createHash('sha256').update(selectedBytes).digest('hex')},
 {path:namedPath,sha256:createHash('sha256').update(namedBytes).digest('hex')}],tables:[],cleanup:'pending'};
try {
 const [identity]=await fx.db.adminSql`SELECT current_database() AS name`;
 assert.equal(identity.name,fx.db.dbName);assert.ok(fx.db.dbName.startsWith('org_'));
 await fx.db.adminSql.begin(async tx=>{
  const revision=selected.planRevision;
  assert.equal(typeof revision.content_snapshot,'string');assert.equal(revision.seq,16);
  assert.equal(createHash('sha256').update(revision.content_snapshot).digest('hex'),revision.content_hash);
  const title=revision.content_snapshot.match(/^#\s+(.+)$/m)?.[1]||revision.plan_slug;
  await tx`INSERT INTO harness_shared.harness_plans(workspace_id,harness_slug,plan_slug,title,content,content_hash,version,status) VALUES(${fx.fixture.workspace},${revision.harness_slug},${revision.plan_slug},${title},${revision.content_snapshot},${revision.content_hash},${revision.seq},'draft')`;
  const [parent]=await tx`SELECT content,content_hash,version,status FROM harness_shared.harness_plans WHERE workspace_id=${fx.fixture.workspace} AND harness_slug=${revision.harness_slug} AND plan_slug=${revision.plan_slug}`;
  assert.equal(parent.content,revision.content_snapshot);assert.equal(parent.content_hash,revision.content_hash);assert.equal(parent.version,16);
  receipt.historicalParent={harness:revision.harness_slug,plan:revision.plan_slug,version:16,contentSha256:revision.content_hash,source:'unchanged frozen planRevision.content_snapshot; draft private FK parent only; no current plan substituted'};

  for(const [table,originals] of tables){
   const rows=originals.map(row=>({...row,workspace_id:fx.fixture.workspace}));
   const metadata=await tx`SELECT column_name FROM information_schema.columns
     WHERE table_schema='harness_shared' AND table_name=${table} AND is_generated='NEVER' ORDER BY ordinal_position`;
   const columns=metadata.map(row=>row.column_name).filter(key=>rows.every(row=>Object.hasOwn(row,key)));
   assert.ok(columns.includes('workspace_id')&&columns.length>4,'No usable original source columns');
   const names=columns.map(key=>'"'+key.replaceAll('"','""')+'"').join(',');
   const relation='harness_shared."'+table+'"', json=JSON.stringify(rows);
   await tx.unsafe('INSERT INTO '+relation+' ('+names+') SELECT '+names+' FROM jsonb_populate_recordset(NULL::'+relation+',$1::jsonb)',[json]);
   let derivedSearch;
   if(table==='engineer_issues'){
    const [meta]=await tx`SELECT is_generated,generation_expression FROM information_schema.columns WHERE table_schema='harness_shared' AND table_name='work_items' AND column_name='_search'`;
    assert.equal(meta.is_generated,'ALWAYS','Cannot exempt a writable source column');
    derivedSearch=meta;
    await tx.unsafe('UPDATE harness_shared.work_items w SET embedding=r.embedding,embedding_mode=r.embedding_mode,embedding_profile=r.embedding_profile FROM jsonb_populate_recordset(NULL::harness_shared.engineer_issues,$1::jsonb) r WHERE w.workspace_id=r.workspace_id AND w.harness_slug=r.base_harness_slug AND w.feature_id=r.issue_id AND w.item_kind=r.kind',[json]);
   }
   const scope=table==='engineer_issues'?{key:'issue_id',ids:rows.map(row=>row.issue_id)}:table==='harness_plans'?{key:'plan_slug',ids:rows.map(row=>row.plan_slug)}:null;
   const actual=await tx.unsafe('SELECT '+names+' FROM '+relation+' WHERE workspace_id=$1'+(scope?' AND '+scope.key+'=ANY($2::text[])':''),scope?[fx.fixture.workspace,scope.ids]:[fx.fixture.workspace]);
   assert.equal(actual.length,rows.length,'Readback population differs: '+table);
   const expected=await tx.unsafe('SELECT '+names+' FROM jsonb_populate_recordset(NULL::'+relation+',$1::jsonb)',[json]);
   const normalize=values=>values.map(row=>{const normalized=JSON.parse(JSON.stringify(row));if(derivedSearch)delete normalized._search;return latencyFixtureDigest(normalized);}).sort();
   if(JSON.stringify(normalize(actual))!==JSON.stringify(normalize(expected))){
    writeFileSync(out+'/mismatch.json',JSON.stringify({table,actual:JSON.parse(JSON.stringify(actual)),expected:JSON.parse(JSON.stringify(expected))},null,2));
    const mismatches=actual.flatMap((row,i)=>columns.filter(key=>JSON.stringify(row[key])!==JSON.stringify(expected[i]?.[key])).map(key=>({row:i,key})));
    console.log(JSON.stringify({phase:'typed-roundtrip-differences',table,population:actual.length,mismatches:mismatches.slice(0,24)}));
    throw new Error('Original typed source roundtrip differs: '+table+'; full bounded source rows retained separately');
   }
   receipt.tables.push({table,rows:rows.length,columns,sourceInputColumnsRoundtripExact:true,sha256:latencyFixtureDigest(normalize(actual)),...(derivedSearch?{generatedColumnDisposition:{column:'_search',reason:'Postgres GENERATED ALWAYS column; original source bytes retained, vector regenerated by pinned private PostgreSQL; not read by T01/T02 card source snapshot',definition:derivedSearch,original:expected.map(row=>({issue_id:row.issue_id,value:row._search})),observed:actual.map(row=>({issue_id:row.issue_id,value:row._search}))}}:{})});
   console.log(JSON.stringify({phase:'original-source-table-verified',table,rows:rows.length}));
  }
  const supportRows=supportingRevisions.map(row=>({...row,workspace_id:fx.fixture.workspace}));
  const metadata=await tx`SELECT column_name FROM information_schema.columns WHERE table_schema='harness_shared' AND table_name='plan_spec_clause_revisions' AND is_generated='NEVER' ORDER BY ordinal_position`;
  const columns=metadata.map(row=>row.column_name).filter(key=>supportRows.every(row=>Object.hasOwn(row,key)));
  const names=columns.map(key=>'"'+key.replaceAll('"','""')+'"').join(',');
  const json=JSON.stringify(supportRows);
  await tx.unsafe('INSERT INTO harness_shared.plan_spec_clause_revisions ('+names+') SELECT '+names+' FROM jsonb_populate_recordset(NULL::harness_shared.plan_spec_clause_revisions,$1::jsonb)',[json]);
  await tx.unsafe('SET CONSTRAINTS ALL IMMEDIATE');
  const count=await tx`SELECT count(*)::int AS n FROM harness_shared.plan_spec_clause_revisions WHERE workspace_id=${fx.fixture.workspace}`;
  assert.equal(count[0].n,closure.length);
  receipt.foreignKeyClosure={sourcePath:'/tmp/latency-immutable-spec-fk-closure-20261109.json',sha256:createHash('sha256').update(fkBytes).digest('hex'),originalRows:originalRevisions.size,supportRows:supportRows.length,totalRows:closure.length,allOriginalRowsUnchanged:true,allSupportRowsAfterFrozenHistoricalPlanTime:true,allConstraintsChecked:true};
 });
 assert.deepEqual(readFileSync(selectedPath),selectedBytes);assert.deepEqual(readFileSync(namedPath),namedBytes);
 receipt.sourceFilesUnchanged=true;receipt.seeded=true;
} finally {
 receipt.cleanup=await fx.cleanup();
 writeFileSync(out+'/receipt.json',JSON.stringify(receipt,null,2)+'\n');
 assert.equal(receipt.cleanup,'dropped');
}
console.log(JSON.stringify({phase:'original-source-seeding-complete',seeded:receipt.seeded,cleanup:receipt.cleanup,actualProviderTaskAttempts:0}));
JS
