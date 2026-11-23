import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const hash = val => createHash('sha256').update(val).digest('hex');

function toolResultRows(value) {
  if (typeof value==='string') {
    try { return toolResultRows(JSON.parse(value)); } catch { return []; }
  }
  if (!value || typeof value!=='object') return [];
  return [value,...Object.values(value).flatMap(toolResultRows)];
}

const wireNames={harness_create:'harness:create',work_items_create:'work_items:create',
  work_items_claim:'work_items:claim',work_items_complete:'work_items:complete',work_items_release:'work_items:release',
  work_items_list:'work_items:list','fleet_launch-on-plan':'fleet:launch-on-plan',fleet_leave:'fleet:leave',loop_end:'loop:end'};

function discoverTool(names,previous,id,name,args) {
  const server='mcp__papercusp-su__';
  const wire=wireNames[name];
  const aliases=[server+name,server+wire];
  const exact=names.find(n=>aliases.includes(n));
  if(exact)return {type:'tool_use',id,name:exact,input:args};
  const invoke=names.find(n=>[server+'tools_invoke',server+'tools:invoke'].includes(n));
  if(invoke)return {type:'tool_use',id,name:invoke,input:{name:wire,args}};
  const searches=[...aliases.map(n=>'select:'+n),'select:'+server+'tools_invoke','select:'+server+'tools:invoke',wire];
  if(names.includes('ToolSearch')){
    const index=searches.findIndex((_,i)=>!previous.some(b=>b.tool_use_id===id+'_s'+i));
    if(index>=0)return {type:'tool_use',id:id+'_s'+index,name:'ToolSearch',input:{query:searches[index]}};
  }
  return {type:'text',text:'Tool unavailable '+name};
}

function guidedTools(input,key,ops) {
  const prior=input.messages.flatMap(m=>Array.isArray(m.content)?m.content.filter(b=>b.type==='tool_result'):[]);
  const names=input.tools?.map(t=>t.name) || [];
  for (let i=0;i<ops.length;i++) {
    const [name,args]=ops[i];
    const id='toolu_'+hash(key+' '+i).slice(0,22);
    const receipt=prior.find(r=>r.tool_use_id===id);
    if (receipt) {
      if (receipt.is_error) return {type:'text',text:'Isolated work item operation refused: '+name};
      continue;
    }
    if (name==='Read') return {type:'tool_use',id,name,input:args};
    return discoverTool(names,prior,id,name,args);
  }
  return {type:'text',text:'External fixture worker finished.'};
}
export function nextBlock(input) {
  const messages = input.messages || [];
  const users = messages.filter(m=>m.role === 'user').flatMap(m=>typeof m.content==='string' ? [m.content] :
    m.content.filter(b=>b.type==='text').map(b=>b.text));
  const prompts = users.filter(t => t.startsWith('PSU-CASE '));
  const current = prompts.at(-1);
  if (!current) {
    const context=JSON.stringify([input.system,users]);
    let match=/ACP-FIXTURE-MEMBER-([12])-([0-9a-f]{32})/.exec(context);
    if(!match && input.tools?.length){
      const file=context.match(/\/work\/[a-zA-Z0-9_/ .-]*?fleet-acp-[0-9a-f]{8}-launch-context-member-[0-9]+\.md/);
      if(file && existsSync(file[0]))match=/ACP-FIXTURE-MEMBER-([12])-([0-9a-f]{32})/.exec(readFileSync(file[0],'utf8'));
    }
    if(input.tools?.length)appendFileSync('/work/external-model.jsonl',JSON.stringify({matched:match?.[0],
      kickoff:users.some(s=>s.includes('launch-context')),contextKind:typeof input.system,toolCount:input.tools.length})+'\n');
    if (!match || !input.tools?.length || !existsSync('/work/external-ids.json')) return;
    const refs=JSON.parse(readFileSync('/work/external-ids.json','utf8'));
    if (refs.nonce!==match[2]) return;
    const ids=refs.ids.filter((_,i)=>i%2===Number(match[1])-1);
    const reply=guidedTools(input,match[0],ids.flatMap(id=>[
      ['work_items_claim',{id,harness:'acp-fixture'}],
      ['Read',{file_path:'/work/project/acp-fixture-receipt.txt'}],
      ['work_items_complete',{id,harness:'acp-fixture',assumptions:'none',completion:{summary:'Read the external fixture receipt.',status:'done',
        verification:{workOutcome:'verified-existing'},
        tests:'Native Read tool returned the fixture receipt.',whatLanded:['Checked the assigned fixture receipt.']}}]
    ]).concat([['fleet_leave',{}],['loop_end',{reason:'Assigned fixture work is complete.',acknowledgeWakeLessAutonomy:true}]]));
    if(reply.type==='text')appendFileSync('/work/external-workers.jsonl',JSON.stringify({nonce:match[2],member:match[1],result:reply.text})+'\n');
    return reply;
  }
  const [scenario,nonce] = current.slice(9).split(' ');
  const tools = input.tools?.map(t=>t.name) || [];
  const id = 'toolu_' + hash(current).slice(0,20);
  const finished = messages.some(m=>Array.isArray(m.content) && m.content.some(b=>b.type==='tool_result' && b.tool_use_id===id));
  const seen = prompts.map(hash);
  appendFileSync('/work/scenarios.jsonl',JSON.stringify({scenario,nonce,seen,finished,hasAgent:tools.includes('Agent'),tools})+'\n');
  const text = text => ({type:'text',text});
  const tool = (name,args) => ({type:'tool_use',id,name,input:args});
  if (scenario==='external') {
    const ext='FixturePlanner/'+nonce;
    const receipts=existsSync('/work/external-ids.json') ? JSON.parse(readFileSync('/work/external-ids.json','utf8')) : {};
    const owned=receipts.nonce===nonce ? receipts.ids : [];
    const ops=[
      ['work_items_create',{harness:'acp-fixture',items:['Invoice audit','Calendar review','Inventory count'].map(title=>({kind:'task',title:title+' '+nonce,
        summary:'Inspect the isolated receipt and close the verified item.',assign_to:'self',external_plan_ref:ext}))}],
      ['work_items_release',{harness:'acp-fixture',ids:owned,reason:'Release the explicitly assigned fixture checks to the two fleet members.'}],
      ['fleet_launch-on-plan',{harness:'acp-fixture',name:'acp-'+nonce.slice(0,8),count:2,headless:true,agent:'claude',
        account:'default',model:'sonnet',leader:'caller',claimKinds:['task'],
        members:[1,2].map(i=>({agent:'claude',claimFilter:{field:'id',op:'in',value:owned.filter((_,index)=>index%2===i-1)},
          brief:'ACP-FIXTURE-MEMBER-'+i+'-'+nonce+' Read and close your assigned external fixture items.'}))}],
      ['work_items_list',{harness:'acp-fixture'}],
      ['fleet_leave',{}],
      ['loop_end',{reason:'Assigned fixture work is complete.',acknowledgeWakeLessAutonomy:true}],
    ];
    const prior=messages.flatMap(m=>Array.isArray(m.content)?m.content.filter(b=>b.type==='tool_result'):[]);
    for (let i=0;i<ops.length;i++) {
      const [suffix,args]=ops[i],toolId=id+'_'+i;
      const result=prior.find(b=>b.tool_use_id===toolId);
      if (result) {
        const content=JSON.stringify(result.content);
        const ids=[...new Set(toolResultRows(result.content)
          .filter(row=>row.externalPlanRef===ext && typeof row.id==='string').map(row=>row.id))];
        const done=new Set(toolResultRows(result.content).filter(r=>r.externalPlanRef===ext && ['done','completed','closed','resolved'].includes(r.state||r.status)).map(r=>r.id));
        if (suffix==='work_items_create' && ids.length===3) writeFileSync('/work/external-ids.json',JSON.stringify({ids,nonce}));
        appendFileSync('/work/external-receipts.jsonl',JSON.stringify({method:suffix,index:i,nonce,isError:!!result.is_error,
          ids,reference:content.includes(ext),completed:done.size,
          diagnostic:result.is_error ? content.slice(0,350) : undefined})+'\n');
        if (result.is_error) return text('Fixture operation refused: '+suffix);
        continue;
      }
      if (suffix==='work_items_list'){
        const workers=existsSync('/work/external-workers.jsonl')?readFileSync('/work/external-workers.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
        const finished=new Set(workers.filter(r=>r.nonce===nonce).map(r=>r.member));
        const waits=prior.filter(r=>r.tool_use_id.startsWith(id+'_wait')).length;
        if(finished.size<2 && waits<25)return {...tool('Bash',{command:'sleep 2',description:'Wait for the two fixture workers to finish'}),id:id+'_wait'+waits};
      }
      return discoverTool(tools,prior,toolId,suffix,args);
    }
    return text('External fixture submitted.\n/work/result.txt');
  }
  if (scenario==='form' && finished) {
    const result=messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).find(b=>b.type==='tool_result' && b.tool_use_id===id);
    return text(JSON.stringify(result?.content).includes('Indigo')?'Form answer: Indigo':'Form answer missing');
  }
  if (finished && scenario==='gauge') {
    const shown=users.find(t=>t.includes('fixture gauge'));
    return text((shown ? 'Gauge shown: '+shown : 'Gauge not shown')+'\n/work/result.txt');
  }
  if (finished) return text('Finished '+scenario+' '+nonce+'\n/work/result.txt');
  if (scenario==='form') return tool('AskUserQuestion',{questions:[{header:'Receipt',question:'Which fixture value should I record?',
    multiSelect:false,options:[{label:'Indigo',description:'First test value'},{label:'Green',description:'Second test value'}]}]});
  if (scenario==='gauge') {
    // The reply after the wait says whether the gauge was put in front of the session meanwhile.
    return tool('Bash',{command:'sleep 8',description:'Wait while the context gauge is delivered'});
  }
  if (scenario==='memberallow' || scenario==='memberreject') return tool('Write',{
    file_path:'/work/'+scenario+'-'+nonce,content:'member receipt '+nonce+'\n'});
  if (scenario === 'long' || scenario === 'cancel' || scenario === 'steer' || scenario==='terminate') {
    return tool('Bash',{command:'sleep '+(scenario==='long'?'420':'40'),timeout:480000,description:'Wait for the harmless timing probe'});
  }
  if (scenario==='agent' && tools.includes('Agent')) return tool('Agent',{subagent_type:'fixture-reader',
    description:'Read the isolated fixture status',prompt:'Return only the fixture status.'});
  if (scenario==='mcp' || scenario==='papercusp') {
    const target=scenario==='papercusp' ? 'mcp__papercusp-su__docs_outline' : 'mcp__fixture-receipts__status';
    const name=tools.find(t=>t===target);
    if (name) return tool(name,{});
    if (tools.includes('ToolSearch')) {
      const searchId=id+'_search';
      const searched=messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='tool_result'&&b.tool_use_id===searchId));
      if (!searched) return {...tool('ToolSearch',{query:'select:'+target}),id:searchId};
    }
  }
  return text('Seen '+seen.join(' ')+'\n/work/result.txt');
}
