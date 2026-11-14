---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/external-entry-activation-preparation-20261109-r1/source-analysis-command.txt"
updated_at: 1794265036331
_body: "content"
---

node --experimental-import-meta-resolve --input-type=module - <<'JS'
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
const require=createRequire(process.cwd()+'/package.json'),{parse}=require('@babel/parser'),traverse=require('@babel/traverse').default;
const root='/tmp/latency-baseline-git-source-20261108-r1/node_modules/';
const inputs=[['mem0ai/oss','mem0ai/dist/oss/index.mjs','0344af33887153828c572e7e74c59081976b6f769e516fbb66ef3ebdd8a8bbd7'],['@huggingface/transformers','@huggingface/transformers/dist/transformers.node.mjs','4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d']];
const sha=b=>createHash('sha256').update(b).digest('hex'),entries=[];
for(const [pkg,rel,pin] of inputs){
 const path=root+rel,b=readFileSync(path),s=b.toString('utf8');if(sha(b)!==pin)throw Error('pin mismatch '+pkg);
 const ast=parse(s,{sourceType:'unambiguous',createImportExpressions:true,plugins:['importAttributes']});
 const snippet=n=>n?s.slice(n.start,n.end).slice(0,240):null;
 const site=n=>({type:n.type,start:n.start,end:n.end,line:n.loc?.start.line,source:snippet(n)});
 const ancestry=p=>p.getAncestry().slice(1).filter(q=>q.isFunction()||q.isIfStatement()||q.isConditionalExpression()||q.isTryStatement()||q.isSwitchCase()||q.isClass()).map(q=>({type:q.node.type,start:q.node.start,end:q.node.end,name:q.node.id?.name||q.node.key?.name||q.parentPath?.node.id?.name||q.parentPath?.node.left?.name||null,test:snippet(q.node.test),branch:q.isIfStatement()?(p.node.start>=q.node.consequent.start&&p.node.end<=q.node.consequent.end?'consequent':'alternate'):null}));
 const imports=[],dynamics=[],constructors=[],dangerous=[],bindings=new Map();
 function bind(p,name){if(!name)return;const bd=p.scope.getBinding(name);if(!bd)return;const key=name+':'+bd.identifier.start;if(bindings.has(key))return;bindings.set(key,{name,identifier:site(bd.identifier),kind:bd.kind,constant:bd.constant,violations:bd.constantViolations.map(q=>site(q.node)),definition:site(bd.path.node),references:bd.referencePaths.map(q=>({site:site(q.node),use:site(q.parentPath.node),ancestry:ancestry(q)}))});}
 function resolveSpec(spec,mode){try{const u=mode==='import'?import.meta.resolve(spec,pathToFileURL(path).href):pathToFileURL(createRequire(path).resolve(spec)).href;if(u.startsWith('node:'))return{url:u,builtin:true};const v=readFileSync(fileURLToPath(u));return{url:u,byteLength:v.length,sha256:sha(v)}}catch(e){return{unresolved:true,errorCode:e.code||e.name}}}
 function staticImport(p){if(p.node.source){const spec=p.node.source.value;imports.push({...site(p.node),spec,mode:'import',resolution:resolveSpec(spec,'import')});}}
 traverse(ast,{ImportDeclaration:staticImport,ExportNamedDeclaration:staticImport,ExportAllDeclaration:staticImport,ImportExpression(p){const n=p.node,x=n.source;dynamics.push({...site(n),spec:x.type==='StringLiteral'?x.value:null,mode:'import',resolution:x.type==='StringLiteral'?resolveSpec(x.value,'import'):null,ancestry:ancestry(p)});const f=p.findParent(q=>q.isFunction());if(f){const q=f.parentPath;if(q.isVariableDeclarator()&&q.node.id.type==='Identifier')bind(q,q.node.id.name);if(q.isAssignmentExpression()&&q.node.left.type==='Identifier')bind(q,q.node.left.name);if(f.isFunctionDeclaration())bind(f,f.node.id?.name);}},CallExpression(p){const n=p.node;if(n.callee.type==='Identifier'&&n.callee.name==='require'){const x=n.arguments[0];dynamics.push({...site(n),spec:x?.type==='StringLiteral'?x.value:null,mode:'require',resolution:x?.type==='StringLiteral'?resolveSpec(x.value,'require'):null,ancestry:ancestry(p)});}if(n.callee.type==='Identifier'&&['eval','Function','createRequire','Worker'].includes(n.callee.name))dangerous.push({...site(n),ancestry:ancestry(p)});},NewExpression(p){const n=p.node;if(n.callee.type==='Identifier'&&['Worker','Function','SharedWorker','WebAssembly'].includes(n.callee.name)){constructors.push({...site(n),ancestry:ancestry(p)});}}});
 entries.push({pkg,path,byteLength:b.length,sha256:sha(b),parseErrors:ast.errors.length,imports,dynamics,constructors,dangerous,activationBindings:[...bindings.values()],proofLimits:['Only two exact entry ASTs; lexical binding references do not cover external aliases or native execution.','Conditional resolution is actual Node import-mode resolution for this filesystem, not an actual load.','No runtime non-entry or full transitive closure.']});
}
const d={schemaVersion:'external-entry-activation-preparation-v1',workItem:'WI-6554700010046192',scope:'PREPARATION ONLY: two entry ASTs and dynamic loader bindings',offsetUnit:'UTF-16 code units',entries,baselineAttempts:0,productBehaviorEdits:0,completeRuntimeClosure:'UNKNOWN'};
const out=JSON.stringify(d),archive=gzipSync(out);
console.log(JSON.stringify({byteLength:Buffer.byteLength(out),sha256:sha(out),gzipBytes:archive.length,entries:entries.map(e=>({pkg:e.pkg,imports:e.imports.length,dynamics:e.dynamics.length,constructors:e.constructors.length,dangerous:e.dangerous.length,bindings:e.activationBindings.map(b=>({name:b.name,refs:b.references.length,violations:b.violations.length})),unresolved:[...e.imports,...e.dynamics].filter(v=>v.resolution?.unresolved).map(v=>({spec:v.spec,errorCode:v.resolution.errorCode}))}))}));
console.log(archive.toString('base64'));
JS
