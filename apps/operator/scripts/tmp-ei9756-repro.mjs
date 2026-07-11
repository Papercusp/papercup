import { resolveTrackedResumeSession, findUntrackedSession, sessionHasTranscript } from './psu-launcher.mjs';

const TOKEN = (await import('node:fs')).readFileSync(
  (await import('node:os')).homedir() + '/.papercusp/superuser-token', 'utf8'
).trim();

const resp = await fetch('http://127.0.0.1:3070/api/adv/sessions/resumable', {
  headers: { authorization: `Bearer ${TOKEN}` },
});
const data = await resp.json();
const sessions = (data.sessions || []).filter((s) => s.agent && s.cwd);
console.log('resumable count:', sessions.length);

const id = '893b87f9-da32-4c87-a9a9-28ccafec01a9';
const tracked = resolveTrackedResumeSession(sessions, id);
console.log('tracked match:', tracked ? JSON.stringify(tracked) : null);

const untracked = findUntrackedSession(id);
console.log('untracked match:', untracked ? JSON.stringify(untracked, null, 2) : null);

if (untracked) {
  console.log('sessionHasTranscript(untracked):', sessionHasTranscript(untracked));
}
