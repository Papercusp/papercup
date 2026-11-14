---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/transformers-activation-path-preparation-20261109-r1/source-analysis-command.txt"
updated_at: 1794266358727
_body: "content"
---

node --experimental-import-meta-resolve --input-type=module - <<'JS' > /home/marsh-office/.papercusp/scratch/latency-24790-transformers-activation-20261109-r1.json
import {readFileSync,realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {fileURLToPath,pathToFileURL} from 'node:url';
const require=createRequire(process.cwd()+'/package.json');
const {parse}=require('@babel/parser'),traverse=require('@babel/traverse').default;
const path='/tmp/latency-baseline-git-source-20261108-r1/node_modules/@huggingface/transformers/dist/transformers.node.mjs';
const bytes=readFileSync(path),s=bytes.toString('utf8'),sha=b=>createHash('sha256').update(b).digest('hex');
if(sha(bytes)!=='4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d')throw Error('pinned Transformers source changed');
const ast=parse(s,{sourceType:'module',createImportExpressions:true,plugins:['importAttributes']});
const source=n=>n?s.slice(n.start,n.end):null;
const at=n=>n?{type:n.type,start:n.start,end:n.end,line:n.loc.start.line,sha256:sha(source(n)),source:source(n)}:null;
const functionName=p=>p.node.id?.name||(p.parentPath?.isVariableDeclarator()?p.parentPath.node.id.name:null)||(p.parentPath?.isAssignmentExpression()?source(p.parentPath.node.left):null)||'<anonymous>';
function context(p){return p.getAncestry().slice(1).filter(q=>q.isFunction()||q.isIfStatement()||q.isConditionalExpression()||q.isLogicalExpression()||q.isSwitchCase()||q.isForStatement()).map(q=>({type:q.node.type,start:q.node.start,end:q.node.end,line:q.node.loc.start.line,name:q.isFunction()?functionName(q):null,test:source(q.node.test),left:q.isLogicalExpression()?source(q.node.left):null,operator:q.node.operator??null,branch:q.isIfStatement()||q.isConditionalExpression()?(p.node.start>=q.node.test.start&&p.node.end<=q.node.test.end?'test':p.node.start>=q.node.consequent.start&&p.node.end<=q.node.consequent.end?'consequent':q.node.alternate&&p.node.start>=q.node.alternate.start&&p.node.end<=q.node.alternate.end?'alternate':'outside'):q.isLogicalExpression()?(p.node.start>=q.node.left.start&&p.node.end<=q.node.left.end?'left':'right'):null}));}
const targetNames=new Set(['k','ORT_SYMBOL','ONNX_NODE','ONNX','InferenceSession','apis','IS_NODE_ENV','IS_DENO_WEB_RUNTIME','IS_WEBGPU_AVAILABLE','ort_webgpu_bundle_min_exports','gl','Ve','Ka','Jf','Qa','gn','es','Ui','Pi','Bi','ve','Yt','ns','us','os','fs4','tc','qt','ut','Ms','rs','Qf','Xf','K','supportedDevices','defaultDevices','createInferenceSession','ensureWasmLoaded','loadWasmFactory']);
const bindings=new Map(),sites=[],moduleCalls=[];
traverse(ast,{
 Identifier(p){if(!targetNames.has(p.node.name))return;const b=p.scope.getBinding(p.node.name);if(!b)return;if(!b.scope.path.isProgram()&&!(['gn','Ui','Pi','Bi','ve'].includes(b.identifier.name)&&b.scope.path.isFunctionDeclaration()&&b.scope.path.node.id?.name==='es'))return;const key=b.identifier.name+':'+b.identifier.start;if(bindings.has(key))return;bindings.set(key,{name:b.identifier.name,identifier:at(b.identifier),kind:b.kind,constant:b.constant,definition:at(b.path.node),writes:b.constantViolations.map(q=>at(q.node)),references:b.referencePaths.map(q=>({at:at(q.node),use:at(q.parentPath.node),context:context(q)}))});},
 NewExpression(p){if(p.node.callee.type==='Identifier'&&['Worker','Function'].includes(p.node.callee.name))sites.push({site:at(p.node),lexicalBinding:!!p.scope.getBinding(p.node.callee.name),context:context(p)});},
 CallExpression(p){if(!p.getFunctionParent()&&p.node.start>=253000&&p.node.start<=418000)moduleCalls.push({site:at(p.node),context:context(p)});}
});
const transitive=[];
for(const spec of ['onnxruntime-node','onnxruntime-common']){
 const url=import.meta.resolve(spec,pathToFileURL(path).href),p=fileURLToPath(url),b=readFileSync(p);
 const record={specifier:spec,url,realpath:realpathSync(p),byteLength:b.length,sha256:sha(b),source:b.toString('utf8')};
 if(spec==='onnxruntime-node'){
  const bp=fileURLToPath(new URL('./binding.js',url)),bb=readFileSync(bp);record.binding={path:bp,realpath:realpathSync(bp),byteLength:bb.length,sha256:sha(bb),source:bb.toString('utf8')};
 }
 transitive.push(record);
}
const selected=['ORT_SYMBOL','ONNX','IS_NODE_ENV','IS_DENO_WEB_RUNTIME','IS_WEBGPU_AVAILABLE','k','Ka','Jf','gn','Ui','Pi','Yt','tc','fs4','qt','ut','Ms','rs','Qf','Xf','gl'];
const selectedSummary=[...bindings.values()].filter(b=>selected.includes(b.name)).map(b=>({name:b.name,start:b.identifier.start,definitionSpan:[b.definition.start,b.definition.end],definitionChars:b.definition.source.length,writes:b.writes.map(w=>({start:w.start,source:w.source.length<2300?w.source:'[full source in compressed audit]'})),references:b.references.map(r=>({at:r.at.start,use:r.use.source.length<600?r.use.source:'[full source in compressed audit]',functions:r.context.filter(c=>c.type.endsWith('FunctionExpression')||c.type==='FunctionDeclaration'||c.type==='ArrowFunctionExpression').map(c=>c.name),controls:r.context.filter(c=>!c.type.endsWith('FunctionExpression')&&c.type!=='FunctionDeclaration'&&c.type!=='ArrowFunctionExpression')}))}));
const report={schemaVersion:'transformers-activation-path-preparation-v1',workItem:'WI-6554700010046192',scope:'PREPARATION ONLY: bounded exact-source binding/call/control attribution for Transformers entry and two immediate ONNX entry sources plus ONNX native loader; not a whole transitive graph, executed-code proof or native-addon audit',prior:'external-entry-activation-preparation-20261109-r1',source:{path,realpath:realpathSync(path),byteLength:bytes.length,sha256:sha(bytes),offsetUnits:'JavaScript UTF-16 code units'},parser:{version:require('@babel/parser/package.json').version,traverseVersion:require('@babel/traverse/package.json').version},bindings:[...bindings.values()],constructorSites:sites,moduleRegionCalls:moduleCalls,transitiveEntrySources:transitive,unknown:['Actual attempt environment/global symbol descriptors and selected backend','Actual entry and exact engine coverage for all relevant branches and generated function body','Actual WASM import target, source bytes, configuration and native dependency closure','Native addon C/C++ thread behavior and constructor join','Original host parent-K, complete task clock and immutable baseline60 acceptance'],baselineAttempts:0,productBehaviorEdits:0};
const text=JSON.stringify(report),z=gzipSync(text);
const summary={schemaVersion:'transformers-activation-path-preparation-summary-v1',source:report.source,scope:report.scope,bindings:bindings.size,constructorSites:sites.map(x=>({start:x.site.start,type:x.site.source.slice(0,140),lexicalBinding:x.lexicalBinding,context:x.context})),moduleCalls:moduleCalls.map(x=>({start:x.site.start,source:x.site.source.slice(0,220)})),selectedBindings:selectedSummary,transitive:transitive.map(x=>({specifier:x.specifier,url:x.url,byteLength:x.byteLength,sha256:x.sha256,binding:x.binding?{path:x.binding.path,byteLength:x.binding.byteLength,sha256:x.binding.sha256}:null})),unknown:report.unknown,encoded:{jsonBytes:Buffer.byteLength(text),jsonSha256:sha(text),gzipBytes:z.length,base64Chars:z.toString('base64').length}};
console.log(JSON.stringify({summary,auditGzipBase64:z.toString('base64')}));

JS
