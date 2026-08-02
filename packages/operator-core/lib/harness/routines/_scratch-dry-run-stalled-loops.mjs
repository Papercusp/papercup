import { sweepStalledLoops } from './stalled-loops-guard.ts';
const res = await sweepStalledLoops({ workspaceId: 'papercusp-workspace', dryRun: true });
console.log(JSON.stringify(res, null, 2));
process.exit(0);
