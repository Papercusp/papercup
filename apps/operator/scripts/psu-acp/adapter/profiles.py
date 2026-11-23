"""Managed-host probes for registered work, worker routing, identity and isolation."""
import asyncio
import hashlib
import json
import time
from uuid import uuid4

from verify import file_digest

async def clocks(c):
    """Advance only the paired client's clock against real ACP notifications."""
    async def exercise():
        from contextlib import suppress
        async with c.connection() as a:
            await c.opened(a)
            initial=c.sid
            decisions=[]
            for limit in (360,600):
                prior=len(c.client.updates)
                pending=asyncio.create_task(c.prompt(a,c.caseprompt('cancel'),35))
                try:
                    for _ in range(240):
                        batch=[e['update'] for e in c.client.updates[prior:] if e['sessionId']==initial]
                        shell={u['toolCallId'] for u in batch if (u.get('rawInput') or {}).get('command')=='sleep 40'}
                        if shell and any(row[3]=='sleep' for row in c.tree()):break
                        await asyncio.sleep(.05)
                    else: raise AssertionError('No authorized shell for clock '+str(limit)+': '+str([(u.get('status'),u.get('rawInput'),u.get('toolCallId')) for u in batch if u.get('toolCallId')])[:450]+' answers '+str(c.client.permissions)[-180:])
                    agents=set()
                    for u in batch:
                        tool=u.get('_meta',{}).get('claudeCode',{}).get('toolName')
                        if tool=='Agent': agents.add(u['toolCallId'])
                        if u.get('status') in ('failed','completed'):agents.discard(u.get('toolCallId'))
                    assert not agents, 'An ordinary shell was presented as a blocking Agent'
                    last_event=c.client.received[-1]
                    # Replaying the last observed notification is independent of real elapsed time.
                    for advance in (limit-.01,limit):
                        due=not agents and last_event+advance>=last_event+limit
                        if advance<limit: assert not due
                        else: assert due
                    await a.cancel(initial)
                    response=await asyncio.wait_for(pending,5)
                    assert response.stop_reason=='cancelled'
                    if limit==360:
                        assert (await c.prompt(a,c.caseprompt('continued'))).stop_reason=='end_turn'
                    decisions.append({'clockSeconds':limit,'originalSession':initial,'stop':response.stop_reason})
                finally:
                    if not pending.done():
                        await a.cancel(initial)
                        with suppress(Exception): await pending
            await a.close_session(initial)
        async with c.connection() as fresh:
            await c.opened(fresh)
            assert c.sid!=initial and (await c.prompt(fresh,c.caseprompt('fresh'))).stop_reason=='end_turn'
            await fresh.close_session(c.sid)
        return {'boundaries':decisions,'replacementSession':c.sid}
    await c.case('R8-clocks',exercise)

async def extended(c):
    host=c.host

    def control(op,**options):
        if c.args.reference: raise AssertionError('The reference does not register a Papercusp owner')
        if c.args.server: raise RuntimeError('The controlled scheduler is provided by the isolated bootstrap profile')
        js="""const f=require('fs');fetch('http://127.0.0.1:8912/fixture/control',{method:'POST',headers:{authorization:'Bearer '+f.readFileSync('/work/operator.token','utf8'),'content-type':'application/json'},body:process.argv[1]}).then(async r=>{const b=await r.text();if(!r.ok)throw Error(b);console.log(b)}).catch(e=>{console.error(e.message);process.exitCode=1})"""
        return host.execute('node','-e',js,json.dumps({'sessionId':c.sid,'op':op,**options}),timeout=38)

    async def held(a):
        control('hold')
        text=c.caseprompt('lead')
        task=asyncio.create_task(c.prompt(a,text,100))
        for _ in range(200):
            if any(e['sessionId']==c.sid and e['update'].get('title')=='Waiting for registered Papercusp work' for e in c.client.updates):break
            if task.done(): raise AssertionError('Prompt settled before the registered work')
            await asyncio.sleep(.05)
        else: raise AssertionError('No open Agent tool was visible during the hold')
        return task

    def launch(label,scenario):
        nonce=uuid4().hex
        message='PSU-CASE '+scenario+' '+nonce
        control('member',label=label,spec={'agent':'claude','fleetSlug':'fixture-fleet','ownerId':'su-'+str(uuid4()),'launchContext':message})
        return nonce

    async def hold_wake():
        async with c.connection() as a:
            await c.opened(a)
            task=await held(a)
            launch('fixture-worker','sequence')
            wake=c.caseprompt('workerfinished')
            control('wake',text=wake)
            result=await task
            rows=result.field_meta['psuAcp']['launched']
            assert c.seen(wake) and len(rows)==1 and rows[0]['model_usage'],rows
            await a.close_session(c.sid)
            return {'finalWake':True,'members':rows}
    await c.case(14,hold_wake)

    async def idle():
        async with c.connection() as a:
            await c.opened(a)
            await c.prompt(a,c.caseprompt('idlebegin'))
            before=len(host.execute('cat','/work/scenarios.jsonl').splitlines())
            message=c.caseprompt('idlewake')
            control('wake',text=message)
            await asyncio.sleep(.65)
            assert len(host.execute('cat','/work/scenarios.jsonl').splitlines())==before
            await c.prompt(a,c.caseprompt('idlenext'))
            assert c.seen(message)
            await a.close_session(c.sid)
            return {'requestsWhileIdle':0,'wakeDeliveredInsideNextPrompt':True}
    await c.case(15,idle)

    async def carry():
        async with c.connection() as a:
            await c.opened(a)
            sid=c.sid
            task=await held(a)
            before=json.loads(host.execute('cat','/work/acp-state/'+sid+'.json'))
            msg=c.caseprompt('carried')
            control('carry',nonce=str(uuid4()),text=msg,addendum='Retain the fixture task.')
            control('wake',text=c.caseprompt('carryfinal'))
            result=await task
            after=json.loads(host.execute('cat','/work/acp-state/'+sid+'.json'))
            assert after['native']!=before['native'] and after['id']==before['id']==sid and c.seen(msg)
            assert result.usage.total_tokens>=44
            await a.close_session(sid)
        async with c.connection() as a:
            await a.resume_session(sid,'/work',mcp_servers=[c.server()])
            await c.prompt(a,c.caseprompt('aftercarry'))
            assert c.seen(msg)
            await a.close_session(sid)
        return {'public':sid,'before':before['native'],'after':after['native'],'tokens':result.usage.total_tokens}
    await c.case(16,carry)

    async def environment():
        uid=host.execute('id','-u')
        cfg=json.loads(host.execute('cat','/etc/claude-code/managed-settings.json'))
        assert uid=='65534' and cfg['allowManagedPermissionRulesOnly'] and cfg['allowManagedHooksOnly']
        assert cfg['permissions']['disableBypassPermissionsMode']=='disable' and cfg['strictPluginOnlyCustomization']
        return {'uid':uid,'mode':cfg['permissions']['defaultMode'],'hooks':list(cfg['hooks']),'fixtureImage':host.image}
    await c.case('20-host',environment)

    async def workers(decisions=False):
        async with c.connection() as a:
            await c.opened(a)
            task=await held(a)
            c.client.member_effects={}
            # One member is given a folder of its own; the other starts in the leader's.
            host.execute('mkdir','-p','/work/member-beta')
            folders={'alpha':None,'beta':'/work/member-beta'}
            owners={}
            for label,scenario,decision in [('alpha','memberallow','allow_once'),('beta','memberreject','reject_once')]:
                nonce=uuid4().hex
                path='/work/'+scenario+'-'+nonce
                c.client.member_effects[label]=({'file_path':path,'content':'member receipt '+nonce+'\n'},decision)
                owners[label]='su-'+str(uuid4())
                # The launch tool joins the effort onto the model's name; the front must take both forms.
                control('member',label=label,spec={'agent':'claude','ownerId':owners[label],'fleetSlug':'fixture-fleet',
                    'model':'sonnet:high' if label=='alpha' else 'sonnet',
                    'launchContext':'PSU-CASE '+scenario+' '+nonce,**({'cwd':folders[label]} if folders[label] else {})})
            control('wake',text=c.caseprompt('final'))
            result=await task
            rows=result.field_meta['psuAcp']['launched']
            assert len(rows)==2 and len({r['sessionId'] for r in rows})==2 and {r['label'] for r in rows}=={'alpha','beta'},rows
            for label,(raw,decision) in c.client.member_effects.items():
                exists=host.execute('sh','-c','test ! -e "$1" || cat "$1"','check',raw['file_path'])
                assert exists==(raw['content'].strip() if decision=='allow_once' else ''),(label,exists)
            assert {x.get('label') for x in c.client.permissions}=={'alpha','beta'},c.client.permissions
            boots=[json.loads(l) for l in host.execute('cat','/work/operator-events.jsonl').splitlines()]
            opened_in={label:[b['cwd'] for b in boots if b.get('owner')==owner and b.get('cwd')] for label,owner in owners.items()}
            assert opened_in=={'alpha':['/work'],'beta':['/work/member-beta']},opened_in
            models={label:[a for b in boots if b.get('owner')==owner for a in (b.get('argv') or []) if a.startswith('--model=')] for label,owner in owners.items()}
            assert models=={'alpha':['--model=sonnet:high'],'beta':['--model=sonnet']},models
            await a.close_session(c.sid)
            return {'members':rows,'decisions':c.client.permissions,'leader':result.usage.total_tokens,'openedIn':opened_in}
    await c.case(22,workers)
    async def managed_tools():
        async with c.connection() as a:
            await c.opened(a)
            task=await held(a)
            for label in ('alpha','beta'): launch(label,'papercusp')
            control('wake',text=c.caseprompt('final'))
            result=await task
            rows=result.field_meta['psuAcp']['launched']
            assert len(rows)==2
            lines=[json.loads(l) for l in host.execute('cat','/work/agent-tools.jsonl').splitlines()]
            ids={r['sessionId'] for r in rows}
            assert ids <= {x['native'] for x in lines if x['name']=='docs_outline'},'Missing launch-injected Papercusp tool calls'
            await a.close_session(c.sid)
            return rows
    await c.case(21,managed_tools)

    async def collector():
        data=await workers()
        ids={c.sid,*(r['sessionId'] for r in data['members'])}
        for _ in range(20):
            receipt=host.execute('sh','-c','test ! -e /work/collector.jsonl || cat /work/collector.jsonl')
            samples=[json.loads(l) for l in receipt.splitlines()]
            observed={i for r in samples if r['resource'] for i in r['ids']}
            if ids <= observed: return {**data,'attributedIds':sorted(ids)}
            await asyncio.sleep(.2)
        raise AssertionError('Missing resource/UUID samples: '+str(sorted(ids-observed)))
    await c.case(23,collector)

    async def cleanup():
        results={}
        for event in ('cancel','SIGTERM'):
            async with c.connection() as a:
                await c.opened(a)
                task=await held(a)
                for label in ('one','two'):launch(label,'terminate')
                await asyncio.sleep(.7)
                tree=c.tree()
                leaders=[r for r in tree if 'supervise' in r[3]]
                assert len(leaders)>=3,tree
                start=time.monotonic()
                if event=='cancel': await a.cancel(c.sid)
                else: host.execute('sh','-c','kill -TERM "$1"','signal',host.execute('cat',c.wire+'.pid'))
                while time.monotonic()-start<=10:
                    live={(r[0],r[2]) for r in c.processes()}
                    if not any((r[0],r[2]) in live for r in leaders[1:]):break
                    await asyncio.sleep(.1)
                else: raise AssertionError('Member runtime remained after '+event)
                results[event]=time.monotonic()-start
                if event=='cancel':
                    assert (await asyncio.wait_for(task,5)).stop_reason=='cancelled'
                    await a.close_session(c.sid)
                else:
                    task.cancel()
                    await asyncio.gather(task,return_exceptions=True)
        return results
    await c.case(24,cleanup)

    async def identity():
        async with c.connection() as a:
            await c.opened(a,psuAcp={'role':'worker','unknown':'ignored','planRef':'tracker:ABC-123','compactionLimit':250000})
            old=c.sid
            # The session's outside plan item and context limit reach the operator's bootstrap.
            boots=[json.loads(l) for l in host.execute('cat','/work/operator-events.jsonl').splitlines()]
            boot=[b for b in boots if b['route'].endswith('/bootstrap-su') and b.get('role')=='worker'][-1]
            assert boot['planRef']=='tracker:ABC-123' and '--compaction-limit=250000' in boot['argv'],boot
            await c.prompt(a,c.caseprompt('identity'))
            await a.close_session(old)
        async with c.connection() as a:
            await a.resume_session(old,'/work',mcp_servers=[c.server()],psuAcp={'role':'reviewer'})
            await c.prompt(a,c.caseprompt('changedidentity'))
            state=json.loads(host.execute('cat','/work/acp-state/'+old+'.json'))
            assert state['identity']=={'role':'reviewer','stack':[]}
            await a.close_session(old)
        async with c.connection() as a:
            try: await c.opened(a,psuAcp={'role':'unresolved-fixture-role'})
            except Exception as e: assert 'unresolved-fixture-role' in str(e)
            else: raise AssertionError('Unresolved role accepted')
        async with c.connection() as a:
            try: await c.opened(a,psuAcp={'role':'worker','compactionLimit':'large'})
            except Exception as e: assert 'compactionLimit' in str(e)
            else: raise AssertionError('Invalid context limit accepted')
        return {'resumeIdentity':state['identity'],'invalidIDReported':True,'planRef':boot['planRef'],'limitArg':'--compaction-limit=250000'}
    await c.case('B',identity)

    async def gauge():
        # A session here runs no hook, so the front asks the operator for the context gauge and
        # puts it in front of the session: here into the turn in flight, at its limit.
        async with c.connection() as a:
            await c.opened(a,psuAcp={'compactionLimit':15})
            result=await c.prompt(a,c.caseprompt('gauge'),60)
            said=''.join(e['update']['content'].get('text','') for e in c.client.updates
                if e['sessionId']==c.sid and e['update'].get('sessionUpdate')=='agent_message_chunk')
            rows=[json.loads(l) for l in host.execute('cat','/work/operator-events.jsonl').splitlines()]
            asked=[r for r in rows if r.get('route')=='gauge' and r.get('limit')==15]
            assert asked and asked[-1]['band']=='critical',asked[-3:]
            assert 'Gauge shown: context: ' in said and 'fixture gauge critical' in said,said[-300:]
            await a.close_session(c.sid)
            return {'asked':asked[-1],'said':said[-160:],'stop':result.stop_reason}
    await c.case('G',gauge)

    async def nested():
        async with c.connection() as a:
            await c.opened(a)
            task=await held(a)
            root=c.sid
            owner='su-'+str(uuid4())
            control('member',label='direct-worker',spec={'agent':'claude','ownerId':owner,'fleetSlug':'fixture-fleet',
                'launchContext':c.caseprompt('holdmember')})
            script="const f=require('fs');for(const n of f.readdirSync('/work/acp-state')){const v=JSON.parse(f.readFileSync('/work/acp-state/'+n));if(v.owner===process.argv[1])console.log(v.id)}"
            direct=host.execute('node','-e',script,owner)
            assert direct
            control('member',sessionId=direct,label='nested-worker',spec={'agent':'claude','ownerId':'su-'+str(uuid4()),
                'fleetSlug':'nested-fixture','launchContext':c.caseprompt('sequence')})
            control('wake',sessionId=direct,text=c.caseprompt('childfinal'))
            control('wake',text=c.caseprompt('allworkersdone'))
            result=await task
            rows=result.field_meta['psuAcp']['launched']
            assert {x['label'] for x in rows}=={'direct-worker','nested-worker'} and len({x['sessionId'] for x in rows})==2
            assert all(x['model_usage'][0]['token_count']['inputTokens'] and x['model_usage'][0]['token_count']['outputTokens'] for x in rows)
            again=await c.prompt(a,c.caseprompt('nextunrelated'))
            assert again.field_meta['psuAcp']['launched']==[] and again.usage.total_tokens==22
            await a.close_session(root)
            return {'launched':rows,'followingTurn':[],'leaderTokens':result.usage.total_tokens,'nextLeaderTokens':again.usage.total_tokens}
    await c.case('C',nested)


async def faults(c):
    """Perturb real child processes within the disposable PID namespace."""
    from contextlib import AsyncExitStack
    from secrets import token_hex
    host=c.host

    async def withheld():
        async with c.connection() as a:
            await c.opened(a)
            task=asyncio.create_task(c.prompt(a,c.caseprompt('cancel'),20))
            await c.wait_tool()
            native=next(r for r in c.tree() if r[3]=='claude')
            host.execute('sh','-c','kill -STOP "$1"','stop',str(native[0]))
            start=time.monotonic()
            try:
                await a.cancel(c.sid)
                try: result=await asyncio.wait_for(asyncio.shield(task),4.98)
                except Exception as e:
                    elapsed=time.monotonic()-start
                    assert elapsed<=5 and ('fenced' in str(e).lower() or 'interrupt' in str(e).lower()),(elapsed,str(e))
                    records=c.packets('out')
                    incoming=c.packets('in')
                    pid=next(row['id'] for row in incoming if row.get('method')=='session/prompt')
                    assert sum(row.get('id')==pid and 'error' in row for row in records)==1
                    return {'seconds':elapsed,'error':str(e),'responses':1}
                raise AssertionError('Unacknowledged stop returned '+str(result.stop_reason))
            finally:
                host.execute('sh','-c','kill -CONT "$1" 2>/dev/null || true','resume',str(native[0]))
                if not task.done(): task.cancel()
                await asyncio.gather(task,return_exceptions=True)
    await c.case('8-withheld',withheld)

    async def eof():
        control=type(c)(host,c.args)
        control.sequence=500
        host.execute('mkdir','-p','/work/control')
        async with control.connection() as b:
            await control.opened(b,'/work/control')
            control_prompt=c.caseprompt('control')
            await control.prompt(b,control_prompt)
            async with c.connection() as a:
                await c.opened(a)
                task=asyncio.create_task(c.prompt(a,c.caseprompt('terminate'),30))
                await c.wait_tool()
                tree=c.tree()
                start=time.monotonic()
                c.process.stdin.write_eof()
                for _ in range(90):
                    live={(r[0],r[2]) for r in c.processes()}
                    if not any((r[0],r[2]) in live for r in tree): break
                    assert time.monotonic()-start<10,'Owned processes survived EOF'
                    await asyncio.sleep(.1)
                elapsed=time.monotonic()-start
                assert elapsed<10
                if not task.done(): task.cancel()
                await asyncio.gather(task,return_exceptions=True)
            await control.prompt(b,c.caseprompt('alive'))
            assert control.seen(control_prompt)
            await b.close_session(control.sid)
            return {'seconds':elapsed,'ownedIdentities':tree,'controlSurvived':True}
    await c.case('EOF',eof)

    async def isolation():
        runners=[type(c)(host,c.args),type(c)(host,c.args)]
        async with AsyncExitStack() as scope:
            agents=[]
            prompts=[]
            for i,(client,tag) in enumerate(zip(runners,('a','b'))):
                client.sequence=600+10*i
                client.client_name='caller-'+tag
                client.client_url='http://127.0.0.1:8911/mcp/'+tag
                client.client_token=token_hex(24)
                host.write('/work/tenant-'+tag+'.sha256',hashlib.sha256(client.client_token.encode()).hexdigest())
                host.execute('mkdir','-p','/work/'+tag)
                a=await scope.enter_async_context(client.connection())
                await client.opened(a,'/work/'+tag)
                agents.append(a)
                prompts.append(c.caseprompt('tenant'+tag))
            await asyncio.gather(*(r.prompt(a,msg) for r,a,msg in zip(runners,agents,prompts)))
            events=[json.loads(l) for l in host.execute('cat','/work/mcp-requests.jsonl').splitlines()]
            receipts=[]
            for i,r in enumerate(runners):
                assert all(x['sessionId']==r.sid for x in r.client.updates)
                texts=''.join(x['update'].get('content',{}).get('text','') for x in r.client.updates if isinstance(x['update'].get('content'),dict))
                assert hashlib.sha256(prompts[i].encode()).hexdigest() in texts and hashlib.sha256(prompts[1-i].encode()).hexdigest() not in texts
                ids={e['digest'] for e in events if e.get('route')==r.client_url.split('8911')[-1] and e.get('method')=='tools/list'}
                assert ids=={hashlib.sha256(r.client_token.encode()).hexdigest()},ids
                receipts.append({'session':r.sid,'route':r.client_url,'credentialDigest':next(iter(ids))})
            for r,a in zip(runners,agents): await a.close_session(r.sid)
            return receipts
    await c.case('isolation',isolation)

    async def memory():
        # Count RSS by live PID, including terminal supervisor, native model and tools.
        async with AsyncExitStack() as scope:
            runners=[]
            agents=[]
            for i in range(20):
                r=type(c)(host,c.args)
                r.sequence=1000+10*i
                a=await scope.enter_async_context(r.connection())
                await r.opened(a)
                runners.append(r)
                agents.append(a)
            paths=[r.wire+'.pid' for r in runners]
            query="""const f=require('fs');const rows=[];for(const p of f.readdirSync('/proc').filter(s=>/^\\d+$/.test(s)))try{const stat=f.readFileSync('/proc/'+p+'/stat','utf8');const v=stat.slice(stat.lastIndexOf(')')+2).split(' ');rows.push([+p,+v[1],v[19],+v[21]*4096])}catch{};const roots=process.argv.slice(1).map(p=>+f.readFileSync(p,'utf8'));console.log(JSON.stringify(roots.map(root=>{const ids=new Set([root]);for(let i=0;i<rows.length;i++){let n=ids.size;for(const r of rows)if(ids.has(r[1]))ids.add(r[0]);if(n===ids.size)break}return rows.filter(r=>ids.has(r[0]))})))"""
            peaks=[0]*len(runners)
            samples=0
            async def sample():
                nonlocal samples
                trees=json.loads(await asyncio.to_thread(host.execute,'node','-e',query,*paths))
                for i,tree in enumerate(trees): peaks[i]=max(peaks[i],sum(r[3] for r in tree))
                samples+=1
                return trees
            trees=await sample()
            tasks=[asyncio.create_task(r.prompt(a,c.caseprompt('memory'),90)) for r,a in zip(runners,agents)]
            while not all(t.done() for t in tasks):
                trees=await sample()
                await asyncio.sleep(.25)
            await asyncio.gather(*tasks)
            await sample()
            await asyncio.gather(*(a.close_session(r.sid) for r,a in zip(runners,agents)))
            return {'concurrency':len(runners),'samples':samples,'intervalTargetMs':250,'pageBytes':4096,
                    'peaksMiB':[round(b/2**20,1) for b in peaks],'processIdentities':trees}
    await c.case('RSS',memory)


async def operator_journey(c):
    if not (c.args.server or c.args.sidecar): raise ValueError('The external journey requires a real Papercusp operator')
    host=c.host
    async def external():
        host.execute('mkdir','-p','/work/project')
        host.write('/work/project/acp-fixture-receipt.txt','External fixture acceptance observation.\n')
        # A leader begins inside an existing, ordinary project. Register this
        # disposable checkout through the installation's loopback setup route.
        host.execute('node','--input-type=module','-e',"""
const root='http://127.0.0.1:8912/api/harness/projects', workspace='papercusp-workspace';
const headers={'content-type':'application/json','x-papercusp-workspace':workspace};
const r=await fetch(root+'?workspace='+workspace,{method:'POST',headers,body:JSON.stringify({slug:'acp-fixture',path:'/work/project'})});
const reply=await r.json();
if(!r.ok && r.status!==409)throw Error('Fixture project registration: '+JSON.stringify(reply).slice(0,300));""")
        cfg=json.loads(host.execute('cat','/work/acp.json'))
        cfg['harness']='acp-fixture'
        cfg['tools']=['tools:find','tools:invoke','harness:create','work_items:create','work_items:list','work_items:release','work_items:claim','work_items:complete',
                      'scheduler:get_next','fleet:launch-on-plan','fleet:status','fleet:leave','loop:status','loop:end','docs:outline']
        host.write('/work/acp.json',json.dumps(cfg))
        c.client.mode='external'
        c.client.own_external_items=lambda:json.loads(host.execute('cat','/work/external-ids.json'))['ids']
        async with c.connection() as a:
            await c.opened(a,'/work/project')
            msg=c.caseprompt('external')
            task=asyncio.create_task(c.prompt(a,msg,130))
            try:
                result=await task
                raw=host.execute('sh','-c','test ! -e /work/external-receipts.jsonl || cat /work/external-receipts.jsonl')
                unique={r['method']:r for r in (json.loads(line) for line in raw.splitlines()) if r['nonce']==msg.split()[-1]}
                diagnostic=[(name,r.get('diagnostic')) for name,r in unique.items() if r.get('isError')]
                if diagnostic: raise AssertionError(str(diagnostic)[:600])
                expected={'work_items_create','fleet_launch-on-plan','work_items_list'}
                if not expected <= set(unique):
                    updates=[e['update'] for e in c.client.updates if e['sessionId']==c.sid and e['update'].get('sessionUpdate')=='agent_message_chunk']
                    final_text=''.join(u['content'].get('text','') for u in updates)
                    searches=[u['update'].get('rawOutput') for u in c.client.updates if u['sessionId']==c.sid and u['update'].get('rawOutput')]
                    state=json.loads(host.execute('cat','/work/acp-state/'+c.sid+'.json'))
                    catalog=host.execute('node','--input-type=module','-e',"""
import f from 'node:fs';
const row=JSON.parse(process.argv[1]),cfg=JSON.parse(f.readFileSync('/work/acp.json'));
const url=new URL('/api/mcp',cfg.operatorUrl);
url.search=new URLSearchParams({superuser:'1',workspace:row.workspace,client:row.owner,native_session:row.native,profile:row.profile,tools:cfg.tools.join(',')});
const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+f.readFileSync(cfg.tokenFile,'utf8').trim(),'x-papercusp-native-session':row.native,accept:'application/json, text/event-stream','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});
let raw='';
const decoder=new TextDecoder();
for await(const chunk of response.body){raw+=decoder.decode(chunk,{stream:true});const d=raw.split('\\n').find(x=>x.startsWith('data: ') && x.endsWith('}'));let m;try{m=JSON.parse(d?d.slice(6):raw)}catch{continue}
console.log(JSON.stringify(m.result?.tools?.map(t=>t.name) || m.error?.message));break}
""",json.dumps({k:state.get(k) for k in ('workspace','owner','native','profile')}),timeout=15)
                    raise AssertionError('Missing '+str(sorted(expected-set(unique)))+'; '+final_text[-200:]
                        +'; catalog '+catalog[:450]+'; search results '+str(searches)[-300:])
                assert len(unique['work_items_create']['ids'])==3 and unique['work_items_create']['reference'],unique['work_items_create']
                launched=result.field_meta['psuAcp']['launched']
                # Read back the sandbox database independently of compact tool projections.
                state=host.execute('node','--input-type=module','-e',"""
import f from 'node:fs';import path from 'node:path';import{spawnSync}from'node:child_process';
const cfg=JSON.parse(f.readFileSync('/work/acp.json')),home=path.dirname(cfg.tokenFile);
const u=new URL(JSON.parse(f.readFileSync(path.join(home,'embedded-pg.json'))).appUrl);
if (!['localhost','127.0.0.1'].includes(u.hostname)||u.port!=='5491')throw Error('Expected local fixture database');
const ref=process.argv[1];if(!/^FixturePlanner\\/[0-9a-f]{32}$/.test(ref))throw Error('Expected fixture reference');
const where="workspace_id='papercusp-workspace'";
const query="select json_build_object('items',(select json_agg(json_build_object('id',issue_id,'state',state,'reference',payload->>'externalPlanRef') order by issue_id) from harness_shared.engineer_issues where "+where+" and payload->>'externalPlanRef'='"+ref+"'),'localPlans',(select count(*) from harness_shared.harness_plans where "+where+" and harness_slug='acp-fixture'))";
const bin=home.includes('/relocated server/')?path.join(home,'../sidecar/bin/psql'):'/opt/boot/sidecar/bin/psql';
const r=spawnSync(bin,['-XAtq','-v','ON_ERROR_STOP=1','-c',query],{encoding:'utf8',env:{...process.env,PGOPTIONS:'-c app.workspace_id=papercusp-workspace',PGHOST:u.hostname,PGPORT:u.port,PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:u.pathname.slice(1)}});
if(r.status!==0)throw Error('Fixture readback failed: '+r.stderr.slice(0,230));console.log(r.stdout.trim());""",'FixturePlanner/'+msg.split()[-1])
                store=json.loads(state)
                clean=len(launched)==2 and store['localPlans']==0 and len(store['items'] or [])==3 and all(
                    item['state'] in ('closed','resolved','done','completed') for item in store['items'])
                if not clean: raise AssertionError('Launched '+str(len(launched))+' members; database '+json.dumps(store))
                return {'receipts':unique,'leaderUsage':result.usage.total_tokens,'launched':launched,'store':store}
            finally:
                if not task.done(): await a.cancel(c.sid)
                await a.close_session(c.sid)
    await c.case('E',external)
