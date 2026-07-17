import { readFileSync } from 'node:fs';
import { parseFailingFilesByWorkspace, parseTestQuarantine, applyTestQuarantine, checkpointFailureSignature } from './green-checkpoint.ts';
const log = readFileSync('/home/marsh-office/.papercusp/checkpoint-logs/2026-07-17T03-13-23-188Z-base-f08ae7385252.log','utf8');
const q = readFileSync('/home/marsh-office/papercupai-workspace/papercusp/quarantine.txt','utf8');
console.log('parseFailingFilesByWorkspace:', JSON.stringify(parseFailingFilesByWorkspace(log)));
const sig = checkpointFailureSignature(log, false, true);
const v = applyTestQuarantine(log, sig, parseTestQuarantine(q));
console.log('allFailuresQuarantined:', v.allFailuresQuarantined, '| quarantined:', JSON.stringify(v.quarantined), '| filtered:', JSON.stringify(v.failingTests));
