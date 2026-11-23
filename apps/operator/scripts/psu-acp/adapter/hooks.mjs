import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// Papercusp's own hooks, for a session opened here.
//
// A host that admits only managed hooks (`allowManagedHooksOnly`) drops every hook a user's
// settings or plugin enrolls, Papercusp's included, and admits two kinds: its own, and the ones
// the program hosting the session registers itself. This front is that program. So it registers
// Papercusp's installed command hooks, read from the hooks file the Papercusp installer
// generates for its Claude plugin (`<home>/.papercusp/claude-plugins/plugins/papercusp/hooks/
// hooks.json`), and runs each command the way Claude Code runs a command hook: the event's
// JSON on stdin, the session's own environment, and the same reading of its exit code and
// output. Nothing is enrolled twice and no entry is copied: the file stays the one source.

// A hook that exits 2 refuses what is about to happen; its stderr says why.
const refuse = {
  PreToolUse: why => ({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:why}}),
  PostToolUse: why => ({decision:'block',reason:why}),
  PostToolBatch: why => ({decision:'block',reason:why}),
  UserPromptSubmit: why => ({decision:'block',reason:why}),
  Stop: why => ({decision:'block',reason:why}),
  SubagentStop: why => ({decision:'block',reason:why}),
};
// On these events a hook's plain output is context for the session.
const context = new Set(['UserPromptSubmit','SessionStart']);
const defaultSeconds = 60;

export async function loadHooks(file) {
  const parsed = JSON.parse(await readFile(file,'utf8'));
  const hooks = parsed?.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error('No hooks in '+file);
  // The plugin's root: its hooks file is <root>/hooks/hooks.json.
  return {hooks, root:resolve(dirname(resolve(file)),'..')};
}

export function answer(event,{code,stdout,stderr}) {
  if (code === 0) {
    const text = stdout.trim();
    if (text.startsWith('{')) {
      try {
        const said = JSON.parse(text);
        if (said && typeof said === 'object' && !Array.isArray(said)) return said;
      } catch {}
    }
    if (text && context.has(event)) return {hookSpecificOutput:{hookEventName:event,additionalContext:text}};
    return {};
  }
  if (code === 2 && refuse[event]) return refuse[event](stderr.trim() || 'Refused by a Papercusp hook');
  // Any other exit is a hook that failed, never a refusal: the session goes on.
  return {};
}

function run(command,input,env,cwd,seconds,signal) {
  return new Promise(done => {
    let child;
    // Its own process group, so a hook that overruns is ended with whatever it started.
    try { child = spawn('/bin/sh',['-c',command],{env,cwd,stdio:['pipe','pipe','pipe'],detached:true}); }
    catch (error) { return done({code:null,stdout:'',stderr:String(error?.message || error)}); }
    let stdout='', stderr='', settled=false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort',stop);
      done(result);
    };
    const stop = () => {
      try { process.kill(-child.pid,'SIGKILL'); } catch { child.kill('SIGKILL'); }
      // Not waited for: a child of the hook may still hold its pipes open.
      finish({code:null,stdout,stderr});
    };
    const timer = setTimeout(stop,seconds*1000);
    signal?.addEventListener?.('abort',stop,{once:true});
    child.stdout.on('data',chunk => { if (stdout.length < 1048576) stdout += chunk; });
    child.stderr.on('data',chunk => { if (stderr.length < 65536) stderr += chunk; });
    child.on('error',error => finish({code:null,stdout,stderr:stderr+String(error?.message || error)}));
    child.on('close',code => finish({code,stdout,stderr}));
    child.stdin.on('error',() => {});
    child.stdin.end(JSON.stringify(input ?? {}));
  });
}

// The loaded hooks as the SDK's own: one matcher entry per enrolled group, one callback per command.
export function sdkHooks(loaded,sessionEnv) {
  const out = {};
  for (const [event,groups] of Object.entries(loaded.hooks)) {
    const entries = [];
    for (const group of Array.isArray(groups) ? groups : []) {
      const commands = (group?.hooks || []).filter(h => h?.type === 'command' && typeof h.command === 'string' && h.command);
      if (!commands.length) continue;
      const matcher = typeof group.matcher === 'string' && group.matcher && group.matcher !== '*' ? {matcher:group.matcher} : {};
      const longest = Math.max(...commands.map(h => Number(h.timeout) > 0 ? Number(h.timeout) : defaultSeconds));
      entries.push({...matcher, timeout:longest+5, hooks:commands.map(h => async (input,_toolUseId,extra) => {
        const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
        const env = {...process.env, ...sessionEnv(), CLAUDE_PLUGIN_ROOT:loaded.root, CLAUDE_PROJECT_DIR:cwd};
        const seconds = Number(h.timeout) > 0 ? Number(h.timeout) : defaultSeconds;
        return answer(event,await run(h.command,input,env,cwd,seconds,extra?.signal));
      })});
    }
    if (entries.length) out[event] = entries;
  }
  return out;
}
