import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

const executable = fileURLToPath(new URL('./psu-acp',import.meta.url));

export class Members {
  constructor(agent) {
    this.agent = agent;
    this.children = new Set();
    this.requests = new Set();
  }

  async listen(record) {
    const startedAt=Date.now();
    const uid = process.getuid();
    const directory = '/tmp/psu-acp-'+uid;
    await mkdir(directory,{recursive:true,mode:0o700});
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077)) throw new Error('Insecure ACP socket directory');
    const key = createHash('sha256').update(JSON.stringify([record.workspace,record.adv,record.owner,record.native])).digest('hex');
    this.path = join(directory,key+'.sock');
    // Operator bootstrap/resume exclusively claimed this incarnation before this listener opens.
    await unlink(this.path).catch(e => { if (e.code!=='ENOENT') throw e; });
    this.server = createServer(async (req,res) => {
      try {
        if (req.method!=='POST' || !['/probe','/carry','/member'].includes(req.url)) throw new Error('Unknown host route');
        const chunks=[];
        let size=0;
        for await (const chunk of req) {
          size+=chunk.length;
          if (size>1048576) throw new Error('Launch envelope is too large');
          chunks.push(chunk);
        }
        const body=Buffer.concat(chunks);
        const expected=createHmac('sha256',await this.agent.operator.token()).update(body).digest();
        const supplied=Buffer.from(String(req.headers['x-psu-signature'] || ''),'hex');
        if (expected.length!==supplied.length || !timingSafeEqual(expected,supplied)) throw new Error('Invalid operator launch signature');
        const job=JSON.parse(body);
        if (job.native!==record.native || job.owner!==record.owner || !Number.isFinite(job.issued)
          || Math.abs(Date.now()-job.issued)>30000 || this.requests.has(job.id)) throw new Error('Stale launch');
        if (this.agent.fenced) throw new Error('Session fenced');
        this.requests.add(job.id);
        if (req.url==='/probe') {
          res.writeHead(201).end(JSON.stringify({pid:process.pid,startedAt,socket:this.path}));
          return;
        }
        if (!this.agent.turn || this.agent.turn.cancel) throw new Error('Originating turn ended');
        if (req.url==='/carry') {
          if (!job.nonce || !job.text || record.pendingCarry || this.children.size) throw new Error('Carry is unavailable');
          await this.agent.queueCarry(record,job);
        } else await this.launch(record,job,this.agent.turn);
        res.writeHead(201).end();
      } catch (error) { res.writeHead(409).end(error.message); }
    });
    await new Promise((resolve,reject)=>this.server.once('error',reject).listen(this.path,resolve));
    await chmod(this.path,0o600);
  }

  async launch(record,job,turn) {
    const agent=this.agent;
    const child=spawn(executable,['--config',agent.config.path,'--member'],{stdio:['pipe','pipe','inherit','pipe']});
    const member={child};
    const closed=new Promise((resolve,reject)=>{child.once('close',resolve); child.once('error',reject);});
    this.children.add(member);
    const check=() => {
      if (turn!==agent.turn || turn.cancel || agent.fenced) throw new Error('Originating member turn ended');
    };
    const bind=params => {
      check();
      if (!member.id || params.sessionId!==member.id) throw new Error('Unknown member incarnation');
      return {...params,sessionId:record.id};
    };
    const connection=new ClientSideConnection(()=>({
      sessionUpdate: async p => {
        const params=bind(p);
        if (params.update.toolCallId) params.update={...params.update,toolCallId:member.id+'/'+params.update.toolCallId};
        if (typeof params.update.title==='string') params.update={...params.update,title:job.label+' · '+params.update.title};
        await agent.client.sessionUpdate(params);
      },
      requestPermission: async p => {
        const params=bind(p);
        const response=await agent.client.request('session/request_permission',{...params,
          toolCall:{...params.toolCall,toolCallId:member.id+'/'+params.toolCall.toolCallId,title:job.label+' · '+params.toolCall.title}},
          {cancellationSignal:turn.permissions.signal});
        check();
        return response;
      },
      createElicitation: p => agent.client.request('elicitation/create',bind(p),{cancellationSignal:turn.permissions.signal})
    }),ndJsonStream(Writable.toWeb(child.stdin),Readable.toWeb(child.stdout)));
    member.connection=connection;
    child.stdio[3].end(JSON.stringify(job));
    try {
      await connection.initialize({protocolVersion:1,clientCapabilities:agent.capabilities || {}});
      const opened=await connection.newSession({...agent.params,cwd:record.cwd});
      member.id=opened.sessionId;
      check();
      const msg=opened._meta?.psuAcp?.kickoff;
      if (!msg) throw new Error('Missing governed member kickoff');
      member.done=(async () => {
        try {
          const result=await connection.prompt({sessionId:member.id,prompt:[{type:'text',text:msg}]});
          const usage=result._meta?.quota?.model_usage || [];
          if (usage.length) turn.launched.push({sessionId:member.id,label:job.label,model_usage:usage});
          turn.launched.push(...(result._meta?.psuAcp?.launched || []));
          await connection.closeSession({sessionId:member.id});
        } catch (error) {
          if (!turn.cancel) turn.memberError=error;
        } finally {
          child.stdin.end();
          await closed;
          this.children.delete(member);
        }
      })();
    } catch (error) {
      child.kill('SIGTERM');
      await closed;
      this.children.delete(member);
      throw error;
    }
  }

  stop() { for (const member of this.children) member.child.kill('SIGTERM'); }

  async close() {
    this.stop();
    this.server?.close();
    if (this.path) await unlink(this.path).catch(error=>{if(error.code!=='ENOENT') throw error;});
    this.path=null;
  }
}
