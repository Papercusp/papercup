import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireUuid(id) {
  if (typeof id !== 'string' || !uuid.test(id)) throw new Error('Invalid session UUID');
  return id;
}

export async function loadConfig(path) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  const url = new URL(config.operatorUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('operatorUrl must be a loopback HTTP origin');
  }
  if (!config.workspace || !Array.isArray(config.tools) || !config.tools.length
    || config.tools.some(x => typeof x !== 'string' || !/^[\w.-]+:[\w.-]+$/.test(x))) {
    throw new Error('Configure a workspace and a non-empty seed of named Papercusp tools');
  }
  if (config.memberTools !== undefined && (!Array.isArray(config.memberTools) || !config.memberTools.length
    || config.memberTools.some(x => typeof x !== 'string' || !/^[\w.-]+:[\w.-]+$/.test(x)))) {
    throw new Error('memberTools must be a non-empty seed of named Papercusp tools');
  }
  if (!Array.isArray(config.models) || !config.models.length
    || config.models.some(m => !m.id || !m.model || !m.name || !Array.isArray(m.efforts)
      || m.efforts.some(e => !['low','medium','high','xhigh','max'].includes(e))
      || (m.window !== undefined && !(Number.isSafeInteger(m.window) && m.window > 0)))
    || new Set(config.models.map(m => m.id)).size !== config.models.length) {
    throw new Error('Configure distinct model ids with native models, their supported effort values and, where given, a context window in tokens');
  }
  if (config.hooks !== undefined && (typeof config.hooks !== 'string' || !isAbsolute(config.hooks))) {
    throw new Error('hooks must be the absolute path of a Papercusp hooks file');
  }
  const root = dirname(resolve(path));
  const {effective}=await resolveSettings({settingSources:[]});
  // Keep operator aliases while allowing clients to match full inference-profile IDs.
  const models=[...config.models];
  for (const choice of config.models) {
    if (!models.some(m=>m.id===choice.model)) models.push({...choice,id:choice.model});
  }
  for (const id of effective.availableModels || []) {
    if (typeof id==='string' && !models.some(m=>m.id===id)) models.push({id,model:id,name:id,efforts:[]});
  }
  if (!models.some(m=>m.id==='default')) models.push({...config.models[0],id:'default',name:'Configured default'});
  return { ...config, models, mode:effective.permissions?.defaultMode || 'default', path:resolve(path), operatorUrl: url.origin,
    tokenFile: resolve(root, config.tokenFile || join(process.env.PAPERCUSP_HOME || join(homedir(), '.papercusp'), 'superuser-token')),
    stateDir: resolve(root, config.stateDir || join(homedir(), '.local', 'state', 'psu-acp')) };
}

// The operator's capability-only terms for a session (`capabilityOnly` in its launch answer): the
// tools of Claude Code to withdraw and the Papercusp tools that stand in for them. Checked here
// because both lists go straight into the native launch: one into its withdrawn tools, the other
// into the session's tool server.
export function capabilityOnlyTerms(value) {
  if (value === undefined || value === null) return undefined;
  const named = (list, pattern) => Array.isArray(list) && list.length > 0
    && list.every(name => typeof name === 'string' && pattern.test(name));
  if (!named(value.withdrawnNativeTools, /^[A-Za-z]\w*$/) || !named(value.tools, /^[\w.-]+:[\w.-]+$/)) {
    throw new Error('Invalid capability-only launch terms');
  }
  return {withdrawnNativeTools:[...value.withdrawnNativeTools], tools:[...value.tools]};
}

export class Operator {
  constructor(config,member) { this.config = config; this.member=member; }

  // The Papercusp tools this process's session is given. A fleet member a launch started is
  // given the member's own (`memberTools`) where the config names them: a member pulls, builds
  // and closes work-items, and has no use for the tools that file work, launch a fleet or
  // search the catalog. Every other session, and a member with no list of its own, gets `tools`.
  // A session the operator launched capability-only is given the tools that stand in for the
  // ones it loses as well, whatever the config lists: a tool is never withdrawn with nothing in
  // its place.
  tools(record) {
    const seed = (this.member && this.config.memberTools) || this.config.tools;
    const standIns = record?.capabilityOnly?.tools;
    return standIns ? [...new Set([...seed, ...standIns])] : seed;
  }

  async token() {
    const token = (await readFile(this.config.tokenFile, 'utf8')).trim();
    if (!token) throw new Error('The operator token file is empty');
    return token;
  }

  async post(suffix, data, timeout = 15000) {
    const url = this.config.operatorUrl + '/api/agent-mcp/console/bootstrap-su' + suffix;
    const token = await this.token();
    let response;
    try {
      response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(data) });
    } catch (error) {
      throw new Error('Papercusp operator at ' + this.config.operatorUrl + ' did not respond: ' + error.message);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false || body.status === 'error') {
      throw new Error('Papercusp '+(suffix || 'bootstrap')+' returned '+response.status+' — '+
        String(body.error || body.reason || response.statusText).replaceAll(token,'[redacted]'));
    }
    return body;
  }

  async open(params, identity) {
    if (!isAbsolute(params.cwd)) throw new Error('session cwd must be absolute');
    const cwd = await realpath(params.cwd);
    const member=this.member?.spec;
    // Fleet supervision correlates a member's real first turn to its signed launcher
    // and checks the requested model, carry, account and visibility in this ledger.
    // Papercusp reads a model's context window off its name: `[1m]` is a 1M window, anything else
    // the small one. A client session's model is named here by its native id, which carries no
    // such mark, so a session on a 1M model was held to the small window's limit and told to
    // compact far too early. A config model that says `window` of a million or more is named
    // with the mark.
    const first = this.config.models[0];
    const model = member?.model || (first.window >= 1000000 && !first.model.includes('[1m]') ? first.model+'[1m]' : first.model);
    const modelSpec = member?.effort ? model.replace(/:(low|medium|high|xhigh|max)$/i, '') + ':' + member.effort : model;
    const launchArgv = ['psu-acp'];
    if (member) launchArgv.push('--headless', '--launched-by=' + this.member.owner,
      '--model=' + modelSpec, '--carry=' + (member.carry || 'warm'), '--account=' + (member.account || 'default'));
    // A client names its outside plan item and context limit per session; a member carries
    // the ones its launch was given. The operator validates the reference and clamps the limit.
    const supplied = member || params._meta?.psuAcp || {};
    const planRef = supplied.planRef ?? null;
    if (planRef !== null && typeof planRef !== 'string') throw new Error('planRef must be a string');
    const limit = supplied.compactionLimit ?? null;
    if (limit !== null) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('compactionLimit must be a positive integer');
      launchArgv.push('--compaction-limit=' + limit);
    }
    const boot = await this.post('', { workspace: this.config.workspace, harness_slug: member?.harness || this.config.harness || null,
      agent: 'claude', cwd, cwd_policy: 'caller', su_role: identity.role, stack: identity.stack,
      bootstrap_idempotency_key: randomUUID(), launch_argv: launchArgv,
      model: modelSpec, ...(planRef !== null ? {plan_ref: planRef} : {}),
      ...(member ? {headless:true,owner_id:member.ownerId,launched_by:this.member.owner,fleet:member.fleetSlug,
        fleet_role:member.fleetRole || 'member',launch_context:member.launchContext,carry:member.carry,
        plan:member.plan,profile:member.profile,account:member.account,feature:member.feature} : {}) });
    if (boot.status !== 'ok' || boot.agent !== 'claude' || boot.workspaceId !== this.config.workspace
      || !Number.isSafeInteger(boot.sessionId) || !boot.envelopeEnv?.PAPERCUSP_SID) throw new Error('Invalid Claude launch envelope');
    try {
      requireUuid(boot.nativeSessionId);
      if (await realpath(boot.cwd) !== cwd) throw new Error('Operator resolved a different working directory');
      if (member && boot.envelopeEnv.PAPERCUSP_SID!==member.ownerId) throw new Error('Wrong member owner');
      // The operator owns Papercusp identity. The client owns its Claude home, credentials and telemetry.
      this.envelope=Object.fromEntries(Object.entries(boot.envelopeEnv).filter(([key])=>key.startsWith('PAPERCUSP_')));
      this.kickoff=boot.kickoffPrompt;
      // Kept on the session's record, so a carry and a resume start the session on the same terms.
      const capabilityOnly=capabilityOnlyTerms(boot.capabilityOnly);
      return { adv: boot.sessionId, native: boot.nativeSessionId, owner: boot.envelopeEnv.PAPERCUSP_SID,
        workspace: boot.workspaceId, harness: boot.harnessSlug, cwd, identity, promptFile: boot.promptFile,
        profile: boot.envelopeEnv.PAPERCUSP_PROFILE || '', id: boot.nativeSessionId, started: false,
        ...(capabilityOnly ? {capabilityOnly} : {}) };
    } catch (error) {
      await this.end({ adv: boot.sessionId }, true);
      throw error;
    }
  }

  async end(record, failed = false) {
    await this.post('/session-ended', {advSessionId: record.adv, launchFailed: failed, exitCode: failed ? 1 : 0,
      endAttemptKey: randomUUID(), observedAt: new Date().toISOString()}, 2500);
  }

  beat(record) {
    return this.post('/heartbeat', {ownerId: record.owner, pid: process.pid, host: hostname()}, 3000);
  }

  // `context` is the session's context size as its native session last reported it; the
  // operator answers with the gauge to put in front of the session (`state.context`).
  // The client's prompt, enrolled with the operator as machine-sent before it reaches the
  // session: the answer is the envelope that goes at its head. A session's Papercusp hooks
  // would otherwise take a program's prompt for the owner's own words.
  async turnOrigin(record, text) {
    const reply = await this.post('/acp-turn-origin', {adv:record.adv, native:record.native, owner:record.owner,
      workspace:record.workspace, text}, 5000);
    if (!reply?.ok || typeof reply.envelope !== 'string') throw new Error('The operator did not enroll the prompt');
    return reply.envelope;
  }

  async census(record, ack = [], context) {
    const state = await this.post('/acp-census', {adv:record.adv, native:record.native, owner:record.owner,
      workspace:record.workspace, ack, ...(context === undefined ? {} : {context})}, 5000);
    if (!Array.isArray(state.wakes) || typeof state.waiting !== 'boolean') throw new Error('Papercusp returned an incomplete wake census');
    return state;
  }

  async resume(record) {
    const key = randomUUID();
    const result = await this.post('/session-resumed', { advSessionId: record.adv, resumeClaimKey: key });
    if (!result.acquired) throw new Error('Papercusp refused the session resume claim: ' + (result.reason || record.id));
    return key;
  }

  async transition(record, key, outcome) {
    await this.post('/session-resume-' + outcome, {advSessionId: record.adv, resumeClaimKey: key});
  }

  async server(record) {
    const url = new URL('/api/mcp', this.config.operatorUrl);
    const params = {superuser:'1', origin:'agent', workspace:record.workspace, client:record.owner,
      native_session:record.native, profile:record.profile, tools:this.tools(record).join(','),
      // Every session of this front is Claude Code's. Said here, as psu says it on its own
      // sessions' URLs: Claude loads a tool's whole definition into its prompt when the tool is
      // listed, so the operator must not widen the session's list on its own account
      // (coord:orient activates a task's tools for a client it takes to be something else).
      agent:'claude'};
    // A launched member's tools are delivered compact (a summary and the schema, without the
    // long guidance): its own prompt gives it the calls it makes, and the full definitions of
    // a handful of tools were most of what a member's session carried.
    if (this.member && this.config.memberTools) params.tools_compact = this.tools(record).join(',');
    url.search = new URLSearchParams(params);
    return {type:'http', name:'papercusp-su', url:String(url), headers:[
      {name:'Authorization', value:'Bearer ' + await this.token()},
      {name:'x-papercusp-native-session', value:record.native}, {name:'x-papercusp-call-origin', value:'agent'}]};
  }

  async save(record) {
    const path = join(this.config.stateDir, requireUuid(record.id) + '.json');
    await mkdir(dirname(path), {recursive:true, mode:0o700});
    const tmp = path + '.' + randomUUID();
    await writeFile(tmp, JSON.stringify({...record, operatorUrl:this.config.operatorUrl}), {flag:'wx', mode:0o600});
    await rename(tmp, path);
  }

  async read(id, cwd) {
    const record = JSON.parse(await readFile(join(this.config.stateDir, requireUuid(id) + '.json'), 'utf8'));
    if (record.id !== id || record.operatorUrl !== this.config.operatorUrl || record.workspace !== this.config.workspace
      || record.cwd !== await realpath(cwd)) throw new Error('Session belongs to a different operator, workspace or worktree');
    requireUuid(record.native);
    return record;
  }
}
