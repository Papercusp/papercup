---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/external-source-closure-preparation-20261109-r2/capture-commands.txt"
updated_at: 1794262143737
_body: "content"
---

node --experimental-import-meta-resolve --input-type=module - <<'JS'
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {builtinModules,createRequire} from 'node:module';
import ts from '/tmp/latency-baseline-git-source-20261108-r1/node_modules/typescript/lib/typescript.js';
const parent='file:///tmp/latency-baseline-runtime-20261108-r4/hono-host.mjs';
const seeds=['onnxruntime-node','sharp','better-sqlite3'];
const queue=seeds.map(specifier=>({specifier,parent,kind:'import'})), modules=new Map(), resolutions=[], unresolved=[];
const builtin=new Set(builtinModules.flatMap(x=>[x,x.replace(/^node:/,''),'node:'+x.replace(/^node:/,'')]));
while(queue.length&&modules.size<512){
 const edge=queue.shift();let url;
 try{const result=edge.kind==='require'?createRequire(edge.parent).resolve(edge.specifier):import.meta.resolve(edge.specifier,edge.parent);url=builtin.has(result)?'node:'+result.replace(/^node:/,''):result.startsWith('/')?pathToFileURL(result).href:result;}catch(e){unresolved.push({...edge,code:e.code??'unknown'});continue;}
 resolutions.push({...edge,url});
 if(builtin.has(edge.specifier)||url.startsWith('node:')||modules.has(url))continue;
 if(!url.startsWith('file:')){unresolved.push({...edge,url,code:'non-file'});continue;}
 const path=fileURLToPath(url);let bytes;try{bytes=fs.readFileSync(path);}catch(e){unresolved.push({...edge,url,code:e.code});continue;}
 const row={url,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),native:path.endsWith('.node'),parseErrors:0,loads:[],unsupportedSyntax:[]};modules.set(url,row);
 if(row.native||path.endsWith('.json'))continue;
 const source=bytes.toString('utf8'),ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);row.parseErrors=ast.parseDiagnostics.length;
 const loc=node=>({offset:node.getStart(ast),end:node.end,line:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1,text:node.getText(ast).slice(0,260)});
 const visit=node=>{
  if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)){
   if(node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)){const specifier=node.moduleSpecifier.text;row.loads.push({...loc(node),kind:'import',specifier});queue.push({specifier,parent:url,kind:'import'});}
  }else if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(node.expression)&&node.expression.text==='require'))){
   const arg=node.arguments[0],kind=node.expression.kind===ts.SyntaxKind.ImportKeyword?'import':'require';
   if(arg&&(ts.isStringLiteral(arg)||ts.isNoSubstitutionTemplateLiteral(arg))){row.loads.push({...loc(node),kind,specifier:arg.text});queue.push({specifier:arg.text,parent:url,kind});}
   else row.unsupportedSyntax.push({...loc(node),kind:'computed-'+kind});
  }else if((ts.isNewExpression(node)||ts.isCallExpression(node))&&ts.isIdentifier(node.expression)&&['Function','eval','Worker'].includes(node.expression.text))row.unsupportedSyntax.push({...loc(node),kind:node.expression.text});
  ts.forEachChild(node,visit);
 };visit(ast);
}
const audit={schemaVersion:'external-native-static-dependency-audit-v2',scope:'Literal import edges use ESM resolver; literal require edges use createRequire(parent).resolve. Static resolution only; no target module execution, native/alias completeness, or task qualification.',parent,seeds,nodeVersion:process.version,platform:process.platform,arch:process.arch,modules:[...modules.values()],resolutions,unresolved,pending:queue,completeStaticQueue:queue.length===0,completeRuntimeClosure:'unknown'};
const text=JSON.stringify(audit);process.stdout.write(JSON.stringify({audit,sha256:createHash('sha256').update(text).digest('hex'),byteLength:Buffer.byteLength(text)}));
JS

node --input-type=module - <<'JS'
import fs from 'node:fs';import {createHash} from 'node:crypto';import ts from '/tmp/latency-baseline-git-source-20261108-r1/node_modules/typescript/lib/typescript.js';
const path='/tmp/latency-baseline-runtime-20261108-r4/hono-host.mjs',bytes=fs.readFileSync(path),source=bytes.toString('utf8');
const targets=['parseReuseSourceSymbols','dynamicImport','newFunctionImport'];
const definitions=[];for(const name of ['parseReuseSourceSymbols','dynamicImport']){
 const re=new RegExp('(?:async )?function '+name+'\\('),m=re.exec(source);if(!m)throw Error('Missing definition '+name);
 const offset=m.index,part=source.slice(offset,offset+1000000),ast=ts.createSourceFile(path,part,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),node=ast.statements[0];
 if(!ts.isFunctionDeclaration(node)||node.name?.text!==name||!node.body||node.end>=part.length)throw Error('Unbounded definition '+name);
 definitions.push({name,startOffset:offset,endOffset:offset+node.end,bodyStartOffset:offset+node.body.getStart(ast),bodyEndOffset:offset+node.body.end,sha256:createHash('sha256').update(source.slice(offset,offset+node.end)).digest('hex')});
}
const references=Array.from(source.matchAll(/\b(?:parseReuseSourceSymbols|dynamicImport|newFunctionImport)\b/g),m=>({name:m[0],startOffset:m.index,endOffset:m.index+m[0].length,context:source.slice(Math.max(0,m.index-80),m.index+200)}));
const nativeFiles=['/tmp/latency-baseline-git-source-20261108-r1/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node','/tmp/latency-baseline-git-source-20261108-r1/node_modules/better-sqlite3/build/Release/better_sqlite3.node','/tmp/latency-baseline-git-source-20261108-r1/node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.5.node'];
const nativePins=nativeFiles.map(path=>{try{const b=fs.readFileSync(path);return{path,byteLength:b.length,sha256:createHash('sha256').update(b).digest('hex'),audit:'unknown; hashed opaque native bytes only'};}catch(e){return{path,error:e.code};}});
const result={schemaVersion:'frozen-source-activation-map-v1',scope:'Exact frozen source raw text occurrences and AST definition ranges for a future independent engine join. No binding/alias completeness, non-entry, runtime or task qualification.',offsetUnit:'UTF-16 code units, matching V8 precise coverage offsets',bundle:{path,byteLength:bytes.length,utf16Length:source.length,sha256:createHash('sha256').update(bytes).digest('hex')},definitions,references,nativePins,completeRuntimeClosure:'unknown',baselineAttempts:0};process.stdout.write(JSON.stringify(result));
JS
