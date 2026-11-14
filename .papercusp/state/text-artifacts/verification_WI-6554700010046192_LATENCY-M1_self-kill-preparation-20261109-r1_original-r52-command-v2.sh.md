---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/self-kill-preparation-20261109-r1/original-r52-command-v2.sh"
updated_at: 1794239527429
_body: "content"
---

mkdir /tmp/latency-r4-host-observation-20261109-r52
PAPERCUSP_TEST_ARTIFACT_DIR=/tmp/latency-r4-host-observation-20261109-r52 timeout --signal=TERM --kill-after=15s 600s node /tmp/latency-baseline-git-source-20261108-r1/scripts/with-test-pg.mjs --isolated-runtime=operator-api -- node --import /tmp/latency-baseline-git-source-20261108-r1/node_modules/tsx/dist/loader.mjs --input-type=module - >/tmp/latency-r4-host-observation-20261109-r52/run.log 2>&1 <<'JS'
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync,writeFileSync,createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { privateBundleRuntimeEnv,waitForPrivateOperator,stopPrivateOperatorHost,observeCommittedReaderLoadedSources } from '/tmp/latency-baseline-git-source-20261108-r1/packages/operator-core/test/private-http-workspace-preflight.ts';
import { readProcessIdentity } from '/tmp/latency-baseline-git-source-20261108-r1/packages/operator-core/lib/process-identity.ts';
import { captureConfigurationSnapshot } from '/tmp/latency-baseline-git-source-20261108-r1/libs/test-config/src/configuration-snapshot.ts';
import postgres from '/tmp/latency-baseline-git-source-20261108-r1/node_modules/postgres/src/index.js';
const root='/tmp/latency-baseline-git-source-20261108-r1', dir='/tmp/latency-r4-host-observation-20261109-r52';
const bundle='/tmp/latency-baseline-runtime-20261108-r4/hono-host.mjs',receiptPath='/tmp/latency-baseline-runtime-20261108-r4/operator-api-preflight.json',sourceReceiptPath=root+'.receipt.json';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const receiptBytes=readFileSync(receiptPath), sourceReceiptBytes=readFileSync(sourceReceiptPath), build=JSON.parse(receiptBytes), bundleBytes=readFileSync(bundle);
assert.equal(sha(receiptBytes),'79e1b64e33403f2bb8c461cfff725464925d86d5869bca5b2e10847fb028b9c2');
assert.equal(sha(sourceReceiptBytes),'8aefb1405f182cd70e68468cba622c459fba68165b57dddd67430584ed78af50');
assert.equal(sha(bundleBytes),build.sha256);assert.equal(build.qualification.status,'pending');
const traceOut=dir+'/host-source.json';
const env=privateBundleRuntimeEnv(process.env,{traceOut,pinnedSources:[{path:bundle,sha256:build.sha256,byteLength:bundleBytes.length}]});
env.PAPERCUSP_PSU_LAUNCHER=root+'/apps/operator/scripts/psu-launcher.mjs';
const observerPath="/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/vitest-startup-trace.mjs";
const observerSha256=sha(readFileSync(observerPath));assert.equal(observerSha256,'3af87ae0d05a8cf87f006e5b6f545bc153ad17934af022be4193eb1cd57e59df');
env.NODE_OPTIONS=env.NODE_OPTIONS.replaceAll(root+'/scripts/lib/vitest-startup-trace.mjs',observerPath);
const loaderCensus={batches:128,bytes:16*1024*1024};env.PC_NATIVE_LOADER_CENSUS=JSON.stringify(loaderCensus);
const configuration=captureConfigurationSnapshot(env);writeFileSync(dir+'/prelaunch-configuration.json',JSON.stringify(configuration));
const startedAtMs=Date.now(), host=spawn(process.execPath,[bundle],{cwd:root,env,stdio:['ignore','pipe','pipe']});
const log=createWriteStream(dir+'/host.log',{flags:'wx'});host.stdout.pipe(log,{end:false});host.stderr.pipe(log,{end:false});
const kernelProcessIdentity=readProcessIdentity(host.pid);assert.ok(kernelProcessIdentity);
const result={phase:'actual-retained-private-host-observation',actualProviderTaskAttempts:0,compilerInvoked:false,hostPid:host.pid,kernelProcessIdentity,sourceCommit:build.sourceCommit,bundleSha256:build.sha256,configurationFingerprint:configuration.fingerprint,startedAtMs,health:null,privatePg:null,cleanup:'pending'};
try{
 result.health=await waitForPrivateOperator({host,base:env.PAPERCUSP_OPERATOR_URL,evidenceDir:dir,hostIdentity:kernelProcessIdentity,environment:env,requireBuildIdentity:true});
 assert.equal(result.health.sha,build.sourceCommit.slice(0,12));
 const sql=postgres(env.HARNESS_ADMIN_DATABASE_URL,{max:1,prepare:false,onnotice:()=>{}});
 try{
  const [identity]=await sql`SELECT current_database() AS database,inet_server_port() AS port,version() AS version`;
  assert.notEqual(identity.port,5432);assert.equal(identity.port,Number(env.PAPERCUSP_PG_PORT));
  const schema=await sql`SELECT table_schema,table_name,column_name,data_type,udt_name,is_nullable,column_default,is_generated,generation_expression FROM information_schema.columns WHERE table_schema='harness_shared' ORDER BY table_name,ordinal_position`;
  const value={identity,schema:JSON.parse(JSON.stringify(schema))};writeFileSync(dir+'/private-pg.json',JSON.stringify(value));
  result.privatePg={...identity,schemaSha256:sha(JSON.stringify(value.schema)),columns:schema.length};
 }finally{await sql.end({timeout:5});}
 console.log(JSON.stringify({phase:'actual-private-host-ready',pid:host.pid,sha:result.health.sha,privatePg:result.privatePg}));
}finally{
 await stopPrivateOperatorHost(host,undefined,10_000,observation=>writeFileSync(dir+'/parent-stop.json',JSON.stringify(observation)));result.cleanup='host-stopped';log.end();
 const finishedAtMs=Date.now();
 result.finishedAtMs=finishedAtMs;
 writeFileSync(dir+'/runtime-receipt.json',JSON.stringify(result,null,2));

 const { readNativeProcessTraceArtifacts,hashNativeArtifactBytes }=await import("/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/budgeted-task-scheduler.mjs");
 const parentTermination={pid:host.pid,kernelProcessIdentity,code:host.exitCode,signal:host.signalCode};
 const trace=readNativeProcessTraceArtifacts(traceOut,startedAtMs,finishedAtMs,{terminations:[parentTermination]});
 const hostRows=trace.rows.filter(({row})=>row.pid===host.pid),own=hostRows.filter(({row})=>row.threadId===0);
 const entries=own.filter(({row})=>row.event==='node-entry');
 assert.equal(entries.length,1);assert.deepEqual(entries[0].row.loaderCensus,loaderCensus);assert.deepEqual(entries[0].row.configuration,configuration);
 assert.equal(entries[0].row.kernelProcessIdentity,kernelProcessIdentity);
 const loads=own.filter(({row})=>row.event==='module-load-return'&&row.url==='file://'+bundle);
 assert.equal(loads.length,1);const source=loads[0].row.source;
 assert.equal(source.sha256,build.sha256);assert.equal(source.byteLength,bundleBytes.length);
 assert.equal(hashNativeArtifactBytes(trace.sourceRoot+'/'+source.ref,source.byteLength,128*1024*1024,()=>{}),build.sha256);
 const selfKillRequests=own.filter(({row})=>row.event==='node-self-kill-request').map(({row})=>row);
 const snapshots=own.filter(({row})=>row.event==='engine-script-execution');
 const scripts=snapshots.flatMap(({row})=>(row.observation?.scripts??[]).filter(script=>script.path===bundle).map(script=>({termination:row.termination,observationArtifact:row.observationArtifact??null,...script})));
 const engineObserved=scripts.some(script=>script.execution==='observed'&&script.sourceTextSha256===build.sha256);
 const completeRanges=scripts.some(script=>script.coverageRangesComplete&&script.coverageRanges.length>128);
 const observation={phase:'retained-main-thread-loader-census-and-complete-engine-ranges',qualification:'pending',actualProviderTaskAttempts:0,compilerInvoked:false,sourceCommit:build.sourceCommit,bundleSha256:build.sha256,runtimeReceiptPath:dir+'/runtime-receipt.json',observerPath,observerSha256,observerUnchanged:sha(readFileSync(observerPath))===observerSha256,traceOut,hostPid:host.pid,kernelProcessIdentity,configurationMatched:true,loaderReturnedBundleMatched:true,retainedLoaderBytes:source.byteLength,engineObserved,completeRanges,scripts,tracePopulation:trace.population,loaderCensus,loaderStarts:own.filter(({row})=>row.event==='module-load-start').length,loaderReturns:own.filter(({row})=>row.event==='module-load-return').length,resolverStarts:own.filter(({row})=>row.event==='module-resolve-start').length,resolverReturns:own.filter(({row})=>row.event==='module-resolve-return').length,gaps:hostRows.filter(({row})=>row.event.endsWith('-limit')||row.event==='trace-event-too-large').map(({row})=>({threadId:row.threadId,event:row.event,scope:row.observationScope??null})),enginePopulation:'unknown',completeRuntimeClosure:'unknown',privatePg:result.privatePg,privatePgScope:'observer direct query to assigned database; host query unverified',hostExitCode:host.exitCode,hostSignalCode:host.signalCode,parentTermination,selfKillRequests,originalR49Preserved:true};
 writeFileSync(dir+'/scoped-loaded-source.json',JSON.stringify(observation,null,2));
 assert.ok(trace.population.complete);assert.deepEqual(observation.gaps,[]);assert.equal(observation.loaderStarts,observation.loaderReturns);assert.equal(observation.resolverStarts,observation.resolverReturns);assert.ok(observation.resolverReturns>128);assert.equal(readProcessIdentity(host.pid),null);assert.ok(observation.observerUnchanged);assert.ok(engineObserved);assert.ok(completeRanges,'complete pinned engine ranges missing');
 console.log(JSON.stringify({phase:'actual-private-host-complete-engine-ranges-observed',configurationMatched:true,loaderReturnedBundleMatched:true,engineObserved,completeRanges,rangeCounts:scripts.map(script=>script.coverageRanges.length),observerSha256,privatePg:result.privatePg,completeRuntimeClosure:'unknown'}));
}
JS
