// Isolated transport fixture. A real-operator run uses the packaged server instead.
import { createServer, request } from 'node:http';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';
const token = readFileSync('/work/operator.token','utf8').trim();
const persona = '/work/psu-persona.md';
writeFileSync(persona,'You are the local Papercusp test engineer. Use the tools requested by the client.');
const prefix = '/api/agent-mcp/console/bootstrap-su';
let serial = 0;
const live = new Map();
const queued=new Map();
const waiting=new Set();
const put=(owner,text)=>queued.set(owner,[...(queued.get(owner)||[]),{id:++serial,text}]);
createServer(async (req,res) => {
  const send = (n,v) => res.writeHead(n,{'content-type':'application/json'}).end(JSON.stringify(v));
  if (req.url === '/api/health') return send(200,{ok:true});
  if (req.headers.authorization !== 'Bearer ' + token) return send(401,{error:'Invalid fixture operator credential'});
  const parts=[];
  for await (const b of req) parts.push(b);
  try {
    const p=JSON.parse(Buffer.concat(parts).toString() || '{}');
    if (req.url.startsWith('/api/mcp?')) {
      const upstream=await fetch('http://127.0.0.1:8911/papercusp?'+req.url.split('?')[1],{method:'POST',
        headers:{authorization:req.headers.authorization,accept:'application/json, text/event-stream','content-type':'application/json'},
        body:JSON.stringify(p)});
      res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type') || 'application/json'}).end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    if (req.url==='/fixture/control') {
      const record=JSON.parse(readFileSync('/work/acp-state/'+p.sessionId+'.json','utf8'));
      if (p.op==='hold') { waiting.add(record.owner); return send(200,{ok:true}); }
      if (p.op==='wake') { waiting.delete(record.owner); put(record.owner,p.text); return send(200,{ok:true}); }
      const key=createHash('sha256').update(JSON.stringify([record.workspace,record.adv,record.owner,record.native])).digest('hex');
      const body=JSON.stringify({...p,id:randomUUID(),issued:Date.now(),owner:record.owner,native:record.native});
      const result=await new Promise((resolve,reject)=>{
        const client=request({socketPath:'/tmp/psu-acp-'+process.getuid()+'/'+key+'.sock',path:'/'+p.op,method:'POST',
          headers:{'x-psu-signature':createHmac('sha256',token).update(body).digest('hex')}},reply=>{
          const data=[];reply.on('data',chunk=>data.push(chunk));reply.on('end',()=>resolve([reply.statusCode,Buffer.concat(data).toString()]));
        });
        client.on('error',reject);client.end(body);
      });
      return send(result[0],{reply:result[1]});
    }
    appendFileSync('/work/operator-events.jsonl', JSON.stringify({route:req.url?.split('?')[0], adv:p.advSessionId, role:p.su_role,stack:p.stack,
      planRef:p.plan_ref,argv:p.launch_argv,cwd:p.cwd,owner:p.owner_id})+'\n');
    if (req.url === prefix) {
      if (p.su_role?.includes('unresolved') || p.stack?.some(s=>s.includes('unresolved'))) return send(400,{error:'Unresolved identity '+[p.su_role,...(p.stack||[])].join(' ')});
      const adv=++serial;
      live.set(adv,true);
      if (p.launch_context?.startsWith('PSU-CASE holdmember ')) waiting.add(p.owner_id);
      return send(200,{status:'ok', agent:'claude', sessionId:adv,nativeSessionId:randomUUID(),workspaceId:p.workspace,
        harnessSlug:p.harness_slug,cwd:p.cwd,promptFile:persona,kickoffPrompt:p.launch_context,
        envelopeEnv:{PAPERCUSP_SID:p.owner_id || 'su-'+randomUUID()}});
    }
    if (req.url === prefix+'/session-ended') live.set(p.advSessionId,false);
    if (req.url === prefix+'/acp-census') {
      const wakes=(queued.get(p.owner)||[]).filter(w=>!p.ack.includes(w.id));
      queued.set(p.owner,wakes);
      return send(200,{ok:true,waiting:waiting.has(p.owner),wakes});
    }
    if (req.url === prefix+'/session-resume-released') live.set(p.advSessionId,false);
    if (req.url === prefix+'/session-resumed') {
      const acquired=live.get(p.advSessionId)===false;
      if (acquired) live.set(p.advSessionId,true);
      return send(200,{ok:true,acquired});
    }
    if (req.url?.startsWith(prefix+'/')) return send(200,{ok:true});
    return send(404,{error:'Unknown fixture route'});
  } catch (e) { return send(400,{error:e.message}); }
}).listen(8912,'127.0.0.1');
