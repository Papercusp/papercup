import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ClaudeAcpAgent } from '@agentclientprotocol/claude-agent-acp';
import { RequestError } from '@agentclientprotocol/sdk';
import { Members } from './members.mjs';
import { loadHooks, sdkHooks } from './hooks.mjs';

function identityFor(config, params) {
  const override = params._meta?.psuAcp || {};
  const stack = override.stack ?? config.stack ?? [];
  const role = override.role ?? config.role ?? null;
  if (!Array.isArray(stack) || stack.some(x => typeof x !== 'string' || !x.includes(':'))
    || (role !== null && typeof role !== 'string')) throw new Error('Invalid Papercusp stack or role');
  return { stack, role };
}

function selectedOptions(session) {
  const model = session.config.models.find(m => m.id === session.model);
  function select(id, currentValue, entries) {
    return { id, name: {model:'Model',effort:'Effort',mode:'Permission mode'}[id], type:'select', category:id === 'effort' ? 'thought_level' : id,
      currentValue, options:entries.map(m => typeof m === 'string' ? {value:m, name:m} : {value:m.id, name:m.name}) };
  }
  return [select('mode',session.config.mode,[session.config.mode]),select('model', model.id, session.config.models),
    select('effort', session.effort, ['default', ...model.efforts])];
}

function addCounts(a, b) {
  if (!a && !b) return undefined;
  const sum = {...a};
  for (const [key,value] of Object.entries(b || {})) {
    if (typeof value === 'number') sum[key] = (sum[key] || 0) + value;
  }
  return sum;
}

function foldTurn(previous,current) {
  if (!previous) return current;
  const quota = current._meta?.quota;
  const prior = previous._meta?.quota;
  const models = new Map();
  for (const row of [...(prior?.model_usage || []), ...(quota?.model_usage || [])]) {
    models.set(row.model,addCounts(models.get(row.model),row.token_count));
  }
  return {...current,usage:addCounts(previous.usage,current.usage),_meta:{...current._meta,
    quota:{...quota,token_count:addCounts(prior?.token_count,quota?.token_count),
      model_usage:Array.from(models, ([model,token_count])=>({model,token_count}))}}};
}

export class ManagedAgent {
  constructor(client, operator, onFatal) {
    this.operator = operator;
    this.hostClaudeHome=process.env.CLAUDE_CONFIG_DIR;
    this.client = client;
    this.config = operator.config;
    this.members = new Members(this);
    this.onFatal = onFatal;
    this.model = this.config.models[0].id;
    this.effort = 'default';
    const publicParams = p => {
      if (!this.record || this.record.native !== p.sessionId) throw new Error('Stale native session event');
      return {...p, sessionId:this.record.id};
    };
    const ask = async (method, params, signal) => {
      const turn = this.turn;
      if (!turn || turn.cancel || !this.record) return {outcome:{outcome:'cancelled'}};
      const signals = [turn.permissions.signal];
      if (signal) signals.push(signal);
      const response = await client.request(method, publicParams(params), {cancellationSignal:AbortSignal.any(signals)});
      if (turn !== this.turn || turn.cancel) throw new Error('The originating turn has ended');
      return response;
    };
    this.inner = new ClaudeAcpAgent({
      sessionUpdate: p => { this.noteContext(p); return client.sessionUpdate(publicParams(p)); },
      requestPermission: (p, signal) => ask('session/request_permission',p,signal),
      createElicitation: (p, signal) => ask('elicitation/create',p,signal),
      completeElicitation: p => client.notify('elicitation/complete',p),
      extNotification: (method,p) => client.notify(method,p),
    }, { log() {}, error: (...args) => console.error(...args) });
  }

  async initialize(p) {
    this.capabilities=p.clientCapabilities;
    const result = await this.inner.initialize({...p, clientCapabilities:{elicitation:p.clientCapabilities?.elicitation}});
    return {protocolVersion:result.protocolVersion, agentInfo:{name:'psu-acp',version:'0.1.0',title:'Papercusp Claude'},
      agentCapabilities:{loadSession:true, mcpCapabilities:{http:true,sse:true}, promptCapabilities:result.agentCapabilities.promptCapabilities,
        sessionCapabilities:{resume:{},fork:{},close:{},additionalDirectories:{}}}, _meta:{steering:{supported:true}}};
  }

  requireSession(p) {
    if (this.fenced || !this.record || this.record.id !== p.sessionId) throw new Error('Session unavailable: ' + p.sessionId);
    return this.record;
  }

  async open(p, resume) {
    if (this.record || this.opening) throw new Error('This command already has an open session');
    this.opening = true;
    try {
      if ((p.mcpServers || []).some(s => s.name === 'papercusp-su')) throw new Error('papercusp-su is reserved for the local operator');
      const member=this.operator.member?.spec;
      const identity = member ? {stack:member.stack || [],role:member.role || null} : identityFor(this.config,p);
      let record;
      if (resume) {
        record = await this.operator.read(p.sessionId,p.cwd);
        this.resumeKey = await this.operator.resume(record);
        if (JSON.stringify(identity) !== JSON.stringify(record.identity)) {
          const prior=record;
          let successor;
          try {
            successor=await this.operator.open(p,identity);
            await this.operator.post('/session-respawned',{advSessionId:successor.adv,coordOwnerId:successor.owner,sessionId:prior.native});
            Object.assign(successor,{id:prior.id,native:prior.native,started:prior.started,model:prior.model,effort:prior.effort});
            await this.operator.save(successor);
          } catch (error) {
            if (successor) await this.operator.end(successor,true);
            await this.operator.transition(prior,this.resumeKey,'released');
            this.resumeKey=undefined;
            throw error;
          }
          record=successor;
          await this.operator.transition(prior,this.resumeKey,'released');
          this.resumeKey=undefined;
        }
      } else {
        try { record = await this.operator.open(p,identity); }
        catch (error) {
          if (error.message.includes('did not respond')) this.onFatal();
          throw error;
        }
      }
      this.record = record;
      this.params = p;
      // A client that hosts this session's members is handed each launch job (members.mjs).
      this.clientHostsMembers = !member && p._meta?.psuAcp?.hostMembers === true;
      const suppliedHome=p._meta?.claudeCode?.options?.env?.CLAUDE_CONFIG_DIR;
      if (resume && suppliedHome && record.claudeHome && suppliedHome!==record.claudeHome) throw new Error('Transcript home differs from the registered session');
      record.claudeHome=suppliedHome || record.claudeHome || this.hostClaudeHome;
      this.useClaudeHome(record.claudeHome);
      this.model = record.model || this.config.models[0].id;
      this.effort = record.effort || 'default';
      if (member?.model) {
        // The launch tool names a member's model with its effort joined on (`sonnet:medium`).
        const [,name,suffix]=member.model.match(/^(.*?)(?::(low|medium|high|xhigh|max))?$/i);
        const choice=this.config.models.find(m=>[m.id,m.model].includes(name));
        if (!choice) throw new Error('Unsupported member model '+member.model);
        this.model=choice.id;
        if (suffix) this.effort=suffix.toLowerCase();
      }
      if (member?.effort) this.effort=member.effort;
      this.nativeLive = false;
      this.fenced = false;
      await this.operator.save(record);
      await this.operator.beat(record);
      await this.members.listen(record);
      this.heartbeat = setInterval(() => this.operator.beat(record).then(reply => {
        if (reply.sessionTerminal && this.record === record) this.onFatal();
      }).catch(() => {}), 15000);
      this.heartbeat.unref();
      // The client is told the session's Papercusp owner id, which is how anything outside the
      // session addresses it (a message to a fleet's leader, say).
      return {sessionId:record.id, configOptions:selectedOptions(this),
        _meta:{psuAcp:{owner:record.owner, ...(member ? {kickoff:this.operator.kickoff} : {})}}};
    } catch (error) {
      if (this.record) await this.closeSession({sessionId:this.record.id}).catch(() => {});
      throw error;
    } finally { this.opening = false; }
  }

  newSession(p) { return this.open(p,false); }
  resumeSession(p) { return this.open(p,true); }
  loadSession(p) { return this.open(p,true); }

  useClaudeHome(path) {
    if (path) process.env.CLAUDE_CONFIG_DIR=path;
    else delete process.env.CLAUDE_CONFIG_DIR;
  }

  async setSessionConfigOption(p) {
    const record = this.requireSession(p);
    if (this.turn) throw new Error('A turn is running');
    if (p.configId==='mode' && p.value===this.config.mode) return {configOptions:selectedOptions(this)};
    const model = this.config.models.find(m => m.id === (p.configId === 'model' ? p.value : this.model));
    if (!model || !['effort','model'].includes(p.configId)
      || (p.configId === 'effort' && !['default', ...model.efforts].includes(p.value))) throw new Error('Unsupported configuration: ' + p.value);
    if (this.nativeLive) {
      // Reopen the UUID with its current transcript so launch-time flags and environment agree.
      await this.inner.closeSession({sessionId:record.native});
      this.nativeLive = false;
    }
    this.model = model.id;
    this.effort = p.configId === 'effort' ? p.value : model.efforts.includes(this.effort) ? this.effort : 'default';
    Object.assign(record,{model:this.model,effort:this.effort});
    await this.operator.save(record);
    return {configOptions:selectedOptions(this)};
  }

  // A session here runs no hook, so nothing else tells it how full its context is. Each time
  // its native session reports the figure, the operator is asked for the gauge it would show
  // (its thresholds and its words), and a gauge that has reached a louder band is put in front
  // of the session: into the turn in flight, or at the head of its next prompt.
  noteContext(p) {
    const used = p?.update?.sessionUpdate === 'usage_update' ? p.update.used : undefined;
    const record = this.record;
    if (!Number.isSafeInteger(used) || !record || record.native !== p.sessionId) return;
    const gauge = this.gauge;
    if (!gauge || gauge.asking || used === gauge.asked) return;
    gauge.asking = true;
    gauge.asked = used;
    this.operator.census(record, [], used).then(async state => {
      const rank = {loud:1, critical:2}[state.context?.band] || 0;
      if (gauge !== this.gauge || !state.context?.line || rank <= gauge.rank) return;
      gauge.rank = rank;
      const turn = this.turn;
      // Where hooks run, the line is enrolled like a client's prompt: it is the system's, and a
      // session's provenance hook would otherwise take it for the owner's own words.
      const envelope = this.config.hooks ? await this.operator.turnOrigin(record,state.context.line).catch(() => null) : null;
      const line = envelope ? envelope+'\n'+state.context.line : state.context.line;
      if (turn?.nativeBusy && !turn.cancel && this.nativeLive) {
        const reply = await this.inner.steer({sessionId:record.native, prompt:[{type:'text', text:line}]})
          .catch(() => null);
        if (reply?.outcome === 'injected') return;
      }
      gauge.line = line;
    }).catch(() => {}).finally(() => { gauge.asking = false; });
  }

  async startNative(record) {
    const p = this.params;
    // A fresh native context starts its gauge over.
    this.gauge = {asked:-1, rank:0, line:null, asking:false};
    const clientOptions = p._meta?.claudeCode?.options || {};
    const model = this.config.models.find(m => m.id === this.model);
    const env = {...clientOptions.env};
    for (const key of Object.keys(env)) {
      if (key.startsWith('PAPERCUSP_') || key === 'CLAUDE_CODE_EXECUTABLE') throw new Error('Reserved launch environment: ' + key);
    }
    Object.assign(env,this.operator.envelope,{PAPERCUSP_SID:record.owner, PAPERCUSP_ADV_SESSION_ID:String(record.adv),
      PAPERCUSP_NATIVE_SESSION_ID:record.native, PAPERCUSP_WORKSPACE:record.workspace,
      PAPERCUSP_OPERATOR_URL:this.config.operatorUrl, PAPERCUSP_TOOLS:this.operator.tools().join(','),
      PAPERCUSP_CLAUDE_SYSTEM_PROMPT_MANAGED:'1', PSU_ACP_SESSION_ID:record.id});
    if (this.operator.member) env.PAPERCUSP_ADMISSION_CONTEXT=JSON.stringify(this.operator.member.admission);
    if (this.effort !== 'default') env.CLAUDE_CODE_EFFORT_LEVEL = this.effort;
    const options = {env, model:model.model, allowDangerouslySkipPermissions:false,
      ...(this.effort === 'default' ? {} : {effort:this.effort})};
    // Papercusp's own hooks, registered as this host's (hooks.mjs), where the config names their file.
    // Read at each native start, so a reinstall of the hooks reaches the next one.
    if (this.config.hooks) options.hooks = sdkHooks(await loadHooks(this.config.hooks),() => env);
    for (const key of ['betas','debug','agents','plugins']) if (clientOptions[key] !== undefined) options[key] = clientOptions[key];
    const prompts = [await readFile(record.promptFile,'utf8')];
    // The supervised Claude launcher layers its governed fleet brief as a second
    // system-prompt file. The bootstrap's base prompt contains only the persona.
    const brief = this.operator.member?.spec?.launchContext;
    if (brief && isAbsolute(brief)) prompts.push(await readFile(brief,'utf8'));
    if (record.carryAddendum) prompts.push(record.carryAddendum);
    const nativeParams = {cwd:record.cwd, additionalDirectories:p.additionalDirectories,
      mcpServers:[...(p.mcpServers || []), await this.operator.server(record)],
      _meta:{systemPrompt:prompts.join('\n\n'), claudeCode:{options}}};
    const creation = record.started ? {resume:record.native} : {reuseSessionId:record.native};
    await this.inner.createSession(nativeParams, creation);
    this.nativeLive = true;
    if (this.resumeKey) {
      await this.operator.transition(record,this.resumeKey,'finalized');
      this.resumeKey = undefined;
    }
  }

  async queueCarry(record,job) {
    record.pendingCarry={native:randomUUID(),nonce:job.nonce,text:job.text,addendum:job.addendum};
    await this.operator.save(record);
  }

  async cutover(record) {
    const next=record.pendingCarry;
    if (!next) return null;
    if (this.nativeLive) await this.inner.closeSession({sessionId:record.native});
    this.nativeLive=false;
    await this.members.close();
    await this.operator.post('/session-respawned',{advSessionId:record.adv,coordOwnerId:record.owner,sessionId:next.native});
    Object.assign(record,{native:next.native,started:false,carryAddendum:next.addendum,carryPrompt:next.text});
    delete record.pendingCarry;
    await this.operator.save(record);
    await this.members.listen(record);
    return next.text;
  }

  async prompt(p) {
    const record = this.requireSession(p);
    if (this.turn) throw new Error('An ACP prompt is already active');
    const gate = Promise.withResolvers();
    const turn = {permissions:new AbortController(), gate,launched:[]};
    this.turn = turn;
    const run = async () => {
      if (record.pendingCarry) await this.cutover(record);
      if (!this.nativeLive) await this.startNative(record);
      if (turn.cancel) return {stopReason:'cancelled'};
      record.started = true;
      await this.operator.save(record);
      if (turn.cancel) return {stopReason:'cancelled'};
      turn.running = true;
      let census = await this.operator.census(record);
      let result;
      const nativePrompt = async blocks => {
        if (turn.cancel) return;
        turn.nativeBusy = true;
        // A gauge reached while no turn was running goes with this prompt, after its own blocks: an
        // enrolled prompt's envelope has to stay at its head.
        const tail = this.gauge?.line ? [{type:'text', text:this.gauge.line}] : [];
        if (this.gauge) this.gauge.line = null;
        try { result = foldTurn(result,await this.inner.prompt({sessionId:record.native,prompt:[...blocks,...tail]})); }
        finally { turn.nativeBusy = false; }
      };
      const continueCarry = async () => {
        if (!record.carryPrompt || turn.cancel) return;
        await nativePrompt([{type:'text',text:record.carryPrompt}]);
        if (!turn.cancel) {
          delete record.carryPrompt;
          await this.operator.save(record);
        }
      };
      await continueCarry();
      // Wakes held while idle execute inside this prompt's admission boundary.
      for (const wake of census.wakes) {
        await nativePrompt([{type:'text',text:wake.text}]);
        if (!turn.cancel) await this.operator.census(record,[wake.id]);
      }
      // A member its client hosts is given its governed kickoff ahead of the client's first prompt,
      // as a member this front starts is prompted with it.
      const kickoff = this.operator.member?.clientHosted && !record.kickedOff ? this.operator.kickoff : null;
      const blocks = kickoff ? [{type:'text',text:kickoff},...p.prompt] : p.prompt;
      // With Papercusp's hooks registered, the prompt is enrolled as the client's: a program sent
      // it, not the owner. Unenrolled it still goes, and the hook then says it could not verify it.
      const enrolled = async sending => {
        if (!this.config.hooks) return sending;
        const text = sending.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
        const envelope = text ? await this.operator.turnOrigin(record,text).catch(error => {
          console.error('Papercusp prompt enrollment failed:',error.message);
          return null;
        }) : null;
        return envelope ? [{type:'text',text:envelope},...sending] : sending;
      };
      await nativePrompt(await enrolled(blocks));
      if (kickoff && !turn.cancel) {
        record.kickedOff = true;
        await this.operator.save(record);
      }
      let hold;
      try {
        while (!turn.cancel) {
          if (record.pendingCarry) {
            await this.cutover(record);
            if (turn.cancel) break;
            await this.startNative(record);
            record.started=true;
            await this.operator.save(record);
            await continueCarry();
            // A carried prompt can end with a carry of its own queued: a member that closed the item
            // it was carried over with and was handed its next. That context is about to be replaced
            // too, so nothing more is said to it, and the turn does not end with work handed and no
            // context to do it in.
            if (record.pendingCarry) continue;
            // The fresh context holds Papercusp's carry and nothing of what this turn was asked: the
            // client's prompt went to the context that was just replaced. It is said again, so the
            // session still knows what its client is waiting for.
            if (!turn.cancel) await nativePrompt(await enrolled([{type:'text',text:
              'Your context was carried over to a fresh one during this turn. What follows is what this turn was asked, '+
              'unchanged. Carry on with it from where the work stands; do not start it over.'},...p.prompt]));
            if (record.pendingCarry) continue;
          }
          census = await this.operator.census(record);
          if (turn.memberError) throw turn.memberError;
          if (!census.waiting && !census.wakes.length && !this.members.children.size) break;
          if (!hold) {
            hold = randomUUID();
            await this.client.sessionUpdate({sessionId:record.id,update:{sessionUpdate:'tool_call',toolCallId:hold,
              title:'Waiting for registered Papercusp work',kind:'other',status:'in_progress',_meta:{claudeCode:{toolName:'Agent'}}}});
          }
          if (this.members.children.size) {
            await delay(100);
            continue;
          }
          for (const wake of census.wakes) {
            await nativePrompt([{type:'text',text:wake.text}]);
            if (!turn.cancel) await this.operator.census(record,[wake.id]);
          }
          if (!census.wakes.length) await delay(250);
        }
      } finally {
        if (hold) await this.client.sessionUpdate({sessionId:record.id,update:{sessionUpdate:'tool_call_update',
          toolCallId:hold,status:turn.cancel?'failed':'completed'}});
      }
      if (turn.cancel) await turn.cancel;
      return {...result, ...(turn.cancel ? {stopReason:'cancelled'} : {}), _meta:{...result?._meta, psuAcp:{launched:turn.launched}}};
    };
    try { return await Promise.race([gate.promise,run()]); }
    finally {
      turn.permissions.abort();
      clearTimeout(turn.deadline);
      if (this.turn === turn) this.turn = null;
    }
  }

  async cancel(p) {
    const record = this.requireSession(p);
    const turn = this.turn;
    if (!turn || turn.cancel) return;
    const uncertain = () => {
      this.fenced = true;
      turn.gate.reject(new RequestError(-32603,'Native interruption was not confirmed; session fenced',{errorKind:'transport_lost'}));
      this.onFatal();
    };
    turn.cancel = turn.nativeBusy ? this.inner.cancel({sessionId:record.native}) : Promise.resolve();
    turn.permissions.abort();
    this.members.stop();
    turn.deadline = setTimeout(uncertain,4000);
    await turn.cancel.catch(uncertain);
  }

  async extMethod(method,p) {
    const record = this.requireSession(p);
    if (!['_session/steering','session/steering'].includes(method)) throw new RequestError(-32601,'Unknown extension');
    if (!this.turn?.running || this.turn.cancel) return {outcome:'failed'};
    return this.inner.steer({...p,sessionId:record.native});
  }

  async unstable_forkSession(p) {
    const parent = await this.operator.read(p.sessionId,p.cwd);
    if (this.turn || !parent.started) throw new Error('Fork requires an idle session with history');
    if (this.record && this.record.id!==p.sessionId) throw new Error('A different session is open');
    this.useClaudeHome(parent.claudeHome || this.hostClaudeHome);
    const fork = await this.inner.unstable_forkSession({...p,sessionId:parent.native});
    const record = await this.operator.open(p,parent.identity);
    // The SDK copied history to its own native UUID. Re-anchor before admitting any native work.
    try {
      await this.operator.post('/session-respawned',{advSessionId:record.adv,coordOwnerId:record.owner,
        sessionId:fork.sessionId,agent:'claude'});
      Object.assign(record,{native:fork.sessionId,id:fork.sessionId,started:true,model:parent.model,effort:parent.effort,claudeHome:parent.claudeHome});
      await this.operator.save(record);
    } finally { await this.operator.end(record); }
    return {sessionId:record.id};
  }

  async closeSession(p) {
    const record = this.record;
    if (!record || record.id !== p.sessionId) throw new Error('Unknown session');
    clearInterval(this.heartbeat);
    this.fenced = true;
    this.turn?.permissions.abort();
    try {
      await this.members.close();
      if (this.nativeLive) await this.inner.closeSession({sessionId:record.native});
    } finally {
      try {
        if (this.resumeKey) await this.operator.transition(record,this.resumeKey,'released');
        else await this.operator.end(record);
      } finally {
        this.resumeKey = undefined;
        this.nativeLive = false;
        this.record = null;
        this.useClaudeHome(this.hostClaudeHome);
      }
    }
    return {};
  }

  async dispose() {
    if (this.record) await this.closeSession({sessionId:this.record.id});
    await this.inner.dispose();
  }
}
