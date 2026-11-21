# /// script
# requires-python = ">=3.10"
# dependencies = ["agent-client-protocol==0.12.1"]
# ///
"""Acceptance observations from the same pinned Python connection on both adapters."""
import argparse
import asyncio
import hashlib
import json
import os
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

import acp
from acp import schema
from verify import Host, HERE, file_digest

sys.path.insert(0,str(HERE.parent))
from contract_client import Observations, options_by_id


class Client(Observations):
    def __init__(self):
        super().__init__()
        self.received=[]
        self.changed=asyncio.Event()
        self.mode=None

    async def session_update(self, session_id, update, **kwargs):
        await super().session_update(session_id,update,**kwargs)
        self.received.append(time.monotonic())
        self.changed.set()

    async def create_elicitation(self,message,mode,**kwargs):
        assert message=='Which fixture value should I record?' and isinstance(mode,schema.ElicitationFormSessionMode)
        session_id=mode.session_id
        assert session_id==self.active_session
        self.form_session=session_id
        return schema.AcceptElicitationResponse.model_validate({'action':'accept','content':{'question_0':'Indigo'}})

    async def request_permission(self,session_id,tool_call,options,**kwargs):
        raw=tool_call.raw_input or {}
        tool=next((e["update"].get("_meta",{}).get("claudeCode",{}).get("toolName") for e in reversed(self.updates)
                   if e["sessionId"]==session_id and e["update"].get("toolCallId")==tool_call.tool_call_id and
                   e["update"].get("_meta",{}).get("claudeCode",{}).get("toolName")),None)
        label=(tool_call.title or '').split(' · ')[0]
        expected=getattr(self,'member_effects',{}).get(label)
        external=False
        if self.mode=='external' and session_id==self.active_session and tool:
            target=tool.removeprefix('mcp__papercusp-su__').replace(':','_')
            params=raw
            if tool.startswith('mcp__papercusp-su__') and target=='tools_invoke':
                target=raw.get('name','').replace(':','_')
                params=raw.get('args',{})
            if tool.startswith('mcp__papercusp-su__') and isinstance(params,dict):
                fixture=params.get('harness')=='acp-fixture'
                external=(target=='harness_create' and params.get('slug')=='acp-fixture' and params.get('path')=='/work/project'
                    or fixture and target=='work_items_create' and len(params.get('items',[]))==3
                    or fixture and target=='fleet_launch-on-plan' and params.get('headless') is True and params.get('count')==2
                    or fixture and target=='work_items_list'
                    or fixture and target=='work_items_release' and len(params.get('ids',[]))==3
                       and set(params['ids'])==set(self.own_external_items())
                    or fixture and target in ('work_items_claim','work_items_complete') and '/' in tool_call.tool_call_id
                       and params.get('id') in self.own_external_items()
                    or target=='fleet_leave' and not params
                    or target=='loop_end' and params=={'reason':'Assigned fixture work is complete.','acknowledgeWakeLessAutonomy':True})
            elif tool=='Read' and '/' in tool_call.tool_call_id:
                external=params.get('file_path')=='/work/project/acp-fixture-receipt.txt'
        if external:
            opt=next(o for o in options if o.kind=='allow_once')
            self.permissions.append({'tool':tool,'id':tool_call.tool_call_id,'decision':'allow_once'})
            return schema.RequestPermissionResponse(outcome=schema.AllowedOutcome(outcome='selected',option_id=opt.option_id))
        if session_id==self.active_session and '/' in tool_call.tool_call_id and 'docs_outline' in tool_call.title and raw=={}:
            option=next(o for o in options if o.kind=='allow_once')
            return schema.RequestPermissionResponse(outcome=schema.AllowedOutcome(outcome='selected',option_id=option.option_id))
        if expected and session_id==self.active_session and raw==expected[0]:
            option=next(o for o in options if o.kind==expected[1])
            self.permissions.append({'label':label,'decision':option.kind,'id':tool_call.tool_call_id})
            return schema.RequestPermissionResponse(outcome=schema.AllowedOutcome(outcome='selected',option_id=option.option_id))
        exact=((raw.get("command") in ("sleep 40","sleep 420") or self.mode=='external' and raw.get('command')=='sleep 2') and tool=="Bash"
               or tool=="mcp__fixture-receipts__status" and raw=={}
               or tool=="Agent" and raw.get("subagent_type")=="fixture-reader") and tool_call.tool_call_id.startswith("toolu_")
        if exact and session_id==self.active_session:
            self.permissions.append({"id":tool_call.tool_call_id,"tool":tool})
            opt=next(o for o in options if o.kind=="allow_once")
            return schema.RequestPermissionResponse(outcome=schema.AllowedOutcome(outcome="selected",option_id=opt.option_id))
        return await super().request_permission(session_id,tool_call,options,**kwargs)


class Cases:
    def __init__(self,host,args):
        self.host,self.args=host,args
        self.client=Client()
        self.rows=[]
        self.sequence=0

    @asynccontextmanager
    async def connection(self, *, dead=False):
        self.sequence+=1
        token=str(self.sequence)
        self.wire='/work/wire-'+token
        if self.args.reference:
            native='/oracle/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'
            cmd=['node',native]
        else:
            cmd=['/opt/adapter/node_modules/.bin/psu-acp','--config','/work/dead.json' if dead else '/work/acp.json']
        # Record only synthetic fixture traffic, inside the disposable container.
        command=self.host.docker+['exec','-i',self.host.cid,'sh','-c',
            'path=$1; shift; tee "$path.in" | (sh -c \'path=$1; shift; echo $$ > "$path.pid"; exec "$@"\' exec "$path" "$@"; echo $? > "$path.exit") | tee "$path.out"', 'wire',self.wire,*cmd]
        async with acp.spawn_agent_process(self.client,*command,use_unstable_protocol=True,env=dict(os.environ),
                transport_kwargs={'stderr':None}) as (agent,proc):
            self.init=await asyncio.wait_for(agent.initialize(1,client_capabilities=schema.ClientCapabilities.model_validate(
                {"elicitation":{"form":{}}})),20)
            self.process=proc
            yield agent

    def server(self):
        return schema.HttpMcpServer.model_validate({"type":"http","name":getattr(self,'client_name','fixture-receipts'),
            "url":getattr(self,'client_url','http://127.0.0.1:8911/mcp'),
            "headers":[{"name":"Authorization","value":"Bearer "+getattr(self,'client_token',self.host.token)}]})

    async def opened(self,a,cwd='/work',**meta):
        response=await asyncio.wait_for(a.new_session(cwd,mcp_servers=[self.server()],**meta),35)
        self.sid=response.session_id
        self.client.active_session=self.sid
        self.client.permissions=[]
        return response

    async def prompt(self,a,text,timeout=65):
        return await asyncio.wait_for(a.prompt(self.sid,[acp.text_block(text)]),timeout)

    def caseprompt(self,name):
        return "PSU-CASE "+name+" "+uuid4().hex

    def packets(self,name):
        raw=self.host.execute('cat',self.wire+'.'+name)
        return [json.loads(l) for l in raw.splitlines()]

    async def wait_tool(self,text='Bash',timeout=45):
        async def wait():
            while True:
                self.client.changed.clear()
                if any(e["sessionId"]==self.sid and e["update"].get("_meta",{}).get("claudeCode",{}).get("toolName")==text
                    for e in self.client.updates): return
                await self.client.changed.wait()
        await asyncio.wait_for(wait(),timeout)

    async def case(self,n,fn):
        start=time.monotonic()
        try:
            observation=await fn()
            row={'case':n,'verdict':'passed','observed':observation}
        except Exception as e:
            row={'case':n,'verdict':'failed','error':(type(e).__name__+' '+str(e)).replace(self.host.token,'[redacted]')[:1700]}
        row['seconds']=round(time.monotonic()-start,3)
        row.update(profile=self.args.profile,adapter='reference' if self.args.reference else 'psu-acp',
                   fixture='packaged operator' if self.args.server else 'built sidecar' if getattr(self.args,'sidecar',None) else 'isolated bootstrap',
                   packageSha256=self.host.sha)
        self.rows.append(row)
        (self.args.out/'cases.json').write_text(json.dumps(self.rows,indent=2)+'\n')
        print(json.dumps(row),flush=True)

    async def long(self):
        async with self.connection() as a:
            await self.opened(a)
            text=self.caseprompt('long')
            start=time.monotonic()
            result=await self.prompt(a,text,520)
            elapsed=time.monotonic()-start
            updates=[e['update'] for e in self.client.updates if e['sessionId']==self.sid]
            calls=[u for u in updates if (u.get('rawInput') or {}).get('command')=='sleep 420']
            assert calls,'No real seven-minute shell call'
            ids={c['toolCallId'] for c in calls}
            states=[u.get('status') for u in updates if u.get('toolCallId') in ids]
            assert elapsed>=420 and result.stop_reason=='end_turn' and 'in_progress' in states and 'completed' in states, (elapsed,states)
            times=[start]+[t for t in self.client.received if start<=t<=start+elapsed]+[start+elapsed]
            max_gap=max(right-left for left,right in zip(times,times[1:]))
            assert max_gap<360, f'Ordinary shell tool crossed the six-minute client silence clock: {max_gap:.3f}s'
            await a.close_session(self.sid)
            return {'elapsed':elapsed,'states':states,'longestSilenceSeconds':max_gap,'sessionUpdates':len(times)-2}

    async def basics(self):
        async with self.connection() as a:
            self.open_result=await self.opened(a)
            async def initialize():
                assert self.init.protocol_version==1 and self.init.agent_capabilities.mcp_capabilities.http
                packets=self.packets('out')
                assert all(p.get('jsonrpc')=='2.0' for p in packets)
                return {'protocolVersion':1,'agent':self.init.agent_info.name}
            await self.case(1,initialize)
            async def config():
                for k,v in [('model','sonnet'),('effort','low')]:
                    assert options_by_id(await a.set_config_option(k,self.sid,v))[k]==v
                await self.prompt(a,'Return the managed fixture receipt.')
                packets=[json.loads(line) for line in self.host.execute('cat','/work/provider-requests.jsonl').splitlines()]
                assert packets[0]['model']=='us.anthropic.claude-sonnet-4-6' and packets[0]['effort']=='low',packets[0]
                return packets[0]
            await self.case(3,config)
            async def final():
                res=await self.prompt(a,'Return the managed fixture receipt.')
                text=''.join(e['update']['content']['text'] for e in self.client.updates if e['sessionId']==self.sid and
                    e['update']['sessionUpdate']=='agent_message_chunk' and e['update'].get('_meta',{}).get('claudeCode',{}).get('kind')!='informational')
                assert text.endswith('Native managed fixture completed.\n/work/result.txt') and res.usage.total_tokens==22
                return {'lastLine':text.splitlines()[-1],'tokens':res.usage.total_tokens}
            await self.case(4,final)
            async def mcp():
                await self.prompt(a,self.caseprompt('mcp'))
                receipt=[json.loads(l) for l in self.host.execute('cat','/work/mcp-requests.jsonl').splitlines()]
                digest=hashlib.sha256(self.host.token.encode()).hexdigest()
                methods=[r.get('method') for r in receipt if r.get('digest')==digest]
                assert 'tools/call' in methods,methods
                return {'methods':methods}
            await self.case(2,mcp)
            async def fidelity():
                head=self.caseprompt('fidelity')+'\n'
                unit='\r\n```sh\n"résumé" 路徑\n```\n'
                text=head+unit*((40000-len(head))//len(unit.encode()))
                text+=' '*(40000-len(text.encode()))
                await self.prompt(a,text)
                digest=hashlib.sha256(text.encode()).hexdigest()
                rows=[json.loads(l) for l in self.host.execute('cat','/work/scenarios.jsonl').splitlines()]
                assert any(digest in r['seen'] for r in rows),'The provider did not receive the exact 40,000-byte prompt'
                return {'bytes':40000,'sha256':digest}
            await self.case(5,fidelity)
            async def multiple():
                prompts=[self.caseprompt('sequence') for _ in range(3)]
                for p in prompts: assert (await self.prompt(a,p)).stop_reason=='end_turn'
                rows=[json.loads(l) for l in self.host.execute('cat','/work/scenarios.jsonl').splitlines()]
                last=rows[-1]['seen']
                assert all(hashlib.sha256(p.encode()).hexdigest() in last for p in prompts)
                return {'turns':3,'sessionId':self.sid}
            await self.case(6,multiple)
            await a.close_session(self.sid)

    async def cancel(self):
        async with self.connection() as a:
            await self.opened(a)
            text=self.caseprompt('cancel')
            task=asyncio.create_task(self.prompt(a,text))
            await self.wait_tool()
            start=time.monotonic()
            await a.cancel(self.sid)
            result=await asyncio.wait_for(task,5)
            elapsed=time.monotonic()-start
            assert result.stop_reason=='cancelled' and result.usage is not None
            next_result=await self.prompt(a,self.caseprompt('after'))
            assert next_result.stop_reason=='end_turn'
            incoming=self.packets('in')
            prompt_id=next(p['id'] for p in incoming if p.get('method')=='session/prompt')
            count=sum(p.get('id')==prompt_id and ('result' in p or 'error' in p) for p in self.packets('out'))
            assert count==1
            await a.close_session(self.sid)
            return {'seconds':elapsed,'responses':count,'tokens':result.usage.total_tokens}

    async def run(self):
        if self.args.only=='long': await self.case(7,self.long)
        elif self.args.only=='clocks':
            from profiles import clocks
            await clocks(self)
        elif self.args.only=='elicitation':
            async def form():
                async with self.connection() as a:
                    await self.opened(a)
                    await self.prompt(a,self.caseprompt('form'))
                    messages=[u['update'].get('content',{}).get('text','') for u in self.client.updates
                              if u['sessionId']==self.sid and u['update'].get('sessionUpdate')=='agent_message_chunk']
                    assert self.client.form_session==self.sid and 'Form answer: Indigo' in ''.join(messages)
                    await a.close_session(self.sid)
                    return {'mode':'form','session':self.sid,'providerObservedAnswer':'Indigo'}
            await self.case('R12',form)
        elif self.args.only=='profiles':
            from profiles import extended
            await extended(self)
        elif self.args.only=='faults':
            from profiles import faults
            await faults(self)
        elif self.args.only=='operator':
            from profiles import operator_journey
            await operator_journey(self)
        elif self.args.only=='history':
            await self.case(10,self.resume)
            await self.case(11,self.fork)
        else:
            await self.basics()
            await self.case(8,self.cancel)
            for number, fn in [(9,self.steer),(10,self.resume),(11,self.fork),(12,self.permission),
                               (13,self.agent_call),(17,self.teardown),(18,self.native_loss),(19,self.unavailable)]:
                await self.case(number,fn)

    def seen(self,prompt):
        digest=hashlib.sha256(prompt.encode()).hexdigest()
        rows=[json.loads(l) for l in self.host.execute('cat','/work/scenarios.jsonl').splitlines()]
        return digest in rows[-1]['seen']

    async def steer(self):
        async with self.connection() as a:
            await self.opened(a)
            task=asyncio.create_task(self.prompt(a,self.caseprompt('steer'),80))
            await self.wait_tool()
            message=self.caseprompt('steered')
            receipt=await asyncio.wait_for(a.ext_method('session/steering',{'sessionId':self.sid,'prompt':[{'type':'text','text':message}]}),12)
            result=await task
            assert result.stop_reason=='end_turn' and self.seen(message),receipt
            await a.close_session(self.sid)
            return receipt

    async def resume(self):
        original=self.caseprompt('original')
        async with self.connection() as a:
            await self.opened(a)
            await self.prompt(a,original)
            await a.close_session(self.sid)
        self.host.rotate()
        async with self.connection() as a:
            await a.resume_session(self.sid,'/work',mcp_servers=[self.server()])
            follow=self.caseprompt('retained')
            await self.prompt(a,follow)
            assert self.seen(original) and self.seen(follow),'Conversation history was lost'
            digest=hashlib.sha256(self.host.token.encode()).hexdigest()
            events=[json.loads(l) for l in self.host.execute('cat','/work/mcp-requests.jsonl').splitlines()]
            assert any(r['digest']==digest and r['method']=='tools/list' for r in events),'No authenticated discovery after rotation'
            await a.close_session(self.sid)
            return {'nativeHistory':True,'freshCredentialDigest':digest}

    async def fork(self):
        start=self.caseprompt('common')
        left,right=self.caseprompt('left'),self.caseprompt('right')
        async with self.connection() as a:
            await self.opened(a)
            parent=self.sid
            await self.prompt(a,start)
            await a.close_session(parent)
        async with self.connection() as a:
            child=(await a.fork_session(parent,'/work',mcp_servers=[self.server()])).session_id
            assert child!=parent
        for sid,msg,other in [(child,right,left),(parent,left,right),(child,self.caseprompt('continued'),left)]:
            async with self.connection() as a:
                self.sid=sid
                self.client.active_session=sid
                await a.resume_session(sid,'/work',mcp_servers=[self.server()])
                await self.prompt(a,msg)
                assert self.seen(start) and self.seen(msg) and not self.seen(other)
                await a.close_session(sid)
        return {'parent':parent,'fork':child}

    async def permission(self):
        effects={}
        for decision in ('allow_once','reject_once',None):
            self.host.execute('rm','-f','/work/permission-receipt.txt')
            async with self.connection() as a:
                await self.opened(a)
                self.client.fixture_decision=decision
                await self.prompt(a,'Please exercise the fixture Write')
                probe=self.host.execute('sh','-c','if test -e /work/permission-receipt.txt; then cat /work/permission-receipt.txt; else echo absent; fi')
                assert self.client.permissions and self.client.permissions[-1]['decision']==(decision or 'cancelled'), self.client.permissions
                assert probe==('approved fixture receipt' if decision=='allow_once' else 'absent'),probe
                effects[decision or 'cancelled']=probe
                await a.close_session(self.sid)
        return effects

    async def agent_call(self):
        async with self.connection() as a:
            await self.opened(a,claudeCode={'options':{'agents':{'fixture-reader':{'description':'Read the fixture status','prompt':'Return only the status.','tools':[]}}}})
            await self.prompt(a,self.caseprompt('agent'))
            updates=[e['update'] for e in self.client.updates if e['sessionId']==self.sid]
            ids={u['toolCallId'] for u in updates if u.get('_meta',{}).get('claudeCode',{}).get('toolName')=='Agent'}
            states=[u.get('status') for u in updates if u.get('toolCallId') in ids]
            assert ids and ('pending' in states or 'in_progress' in states) and 'completed' in states,states
            await a.close_session(self.sid)
            return {'calls':sorted(ids),'states':states}

    def processes(self):
        script="const f=require('fs'), r=[]; for(const p of f.readdirSync('/proc').filter(x=>/^\\d+$/.test(x)))try{const s=f.readFileSync('/proc/'+p+'/stat','utf8'),v=s.slice(s.lastIndexOf(')')+2).split(' ');r.push([+p,+v[1],v[19],f.readFileSync('/proc/'+p+'/comm','utf8').trim()]);}catch{} console.log(JSON.stringify(r));"
        return json.loads(self.host.execute('node','-e',script))

    def tree(self):
        root=int(self.host.execute('cat',self.wire+'.pid'))
        rows=self.processes()
        owned={root}
        for _ in rows:
            owned.update(pid for pid,ppid,_,_ in rows if ppid in owned)
        return [r for r in rows if r[0] in owned]

    async def teardown(self):
        async with self.connection() as a:
            await self.opened(a)
            task=asyncio.create_task(self.prompt(a,self.caseprompt('terminate')))
            await self.wait_tool()
            await asyncio.sleep(0.4)
            tree=self.tree()
            assert len(tree)>=3,tree
            self.host.execute('sh','-c','kill -TERM "$1"','signal',self.host.execute('cat',self.wire+'.pid'))
            start=time.monotonic()
            while time.monotonic()-start<10:
                alive={(pid,t) for pid,_,t,_ in self.processes()}
                if not any((pid,t) in alive for pid,_,t,_ in tree): break
                await asyncio.sleep(.1)
            else: raise AssertionError('Owned identities survived: '+str([r for r in tree if (r[0],r[2]) in alive]))
            elapsed=time.monotonic()-start
            if not task.done(): task.cancel()
            await asyncio.gather(task,return_exceptions=True)
            assert elapsed<=10
            return {'elapsed':elapsed,'processes':tree}

    async def native_loss(self):
        async with self.connection() as a:
            await self.opened(a)
            task=asyncio.create_task(self.prompt(a,self.caseprompt('terminate')))
            await self.wait_tool()
            tree=self.tree()
            native=next((r for r in tree if r[3]=='claude'),None)
            assert native,tree
            self.host.execute('sh','-c','kill -KILL "$1"','signal',str(native[0]))
            try: await asyncio.wait_for(task,10)
            except Exception as error:
                if (getattr(error,'data',None) and error.data.get('errorKind')=='transport_lost'
                    or 'The Claude Agent process exited unexpectedly' in str(error)
                    or 'The Claude Agent session has ended' in str(error)):
                    return {'process':native,'kind':'transport_lost'}
                raise AssertionError('Wrong loss response: '+repr(error)+' '+str(getattr(error,'data',None)))
            raise AssertionError('Prompt succeeded after native model process died')

    async def unavailable(self):
        cfg=json.loads(self.host.execute('cat','/work/acp.json'))
        cfg['operatorUrl']='http://127.0.0.1:18912'
        self.host.write('/work/dead.json',json.dumps(cfg))
        async with self.connection(dead=True) as a:
            try: await self.opened(a)
            except Exception as error:
                assert 'operator' in str(error).lower(),str(error)
                for _ in range(25):
                    if not self.tree(): break
                    await asyncio.sleep(.1)
                else: raise AssertionError('Command stayed alive after session/new')
                code=int(self.host.execute('cat',self.wire+'.exit'))
                assert code!=0
                return {'message':str(error),'exitCode':code}
            raise AssertionError('session/new accepted an unavailable operator')


if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--package',type=Path,required=True)
    p.add_argument('--node',type=Path,default=Path('/usr/lib/Papercusp Server/sidecar/bin/node'))
    p.add_argument('--profile',choices=['hooks','core'],default='core')
    p.add_argument('--server',type=Path)
    p.add_argument('--sidecar',type=Path)
    p.add_argument('--reference',action='store_true')
    p.add_argument('--out',type=Path,required=True)
    p.add_argument('--only',choices=['long','matrix','profiles','faults','operator','history','elicitation','clocks'],default='matrix')
    args=p.parse_args()
    args.out.mkdir(parents=True,exist_ok=True)
    with Host(args) as host:
        runner=Cases(host,args)
        asyncio.run(runner.run())
    sys.exit(int(any(r['verdict']=='failed' for r in runner.rows)))
