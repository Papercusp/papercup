// Calibration lifetime belongs to the observer, independently of runner-policy
// fixtures that deliberately change their inherited deadline or run group.
import { appendFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isMainThread, threadId } from 'node:worker_threads';
import { assertManagedTestCgroup } from '../proc-guard.mjs';

let context;
try {
  context = Object.freeze(JSON.parse(process.env.PAPERCUSP_TEST_CGROUP_CONTEXT));
} catch {
  throw new Error('PAPERCUSP_TEST_CGROUP_CONTAINMENT: missing calibration context');
}
if (!context || typeof context.evidencePath !== 'string' || !isAbsolute(context.evidencePath)) {
  throw new Error('PAPERCUSP_TEST_CGROUP_CONTAINMENT: invalid calibration evidence path');
}
const env = Object.freeze({
  PAPERCUSP_TEST_RUN_GROUP: context.runGroup,
  PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(context.deadlineEpochMs ?? ''),
  PAPERCUSP_EXPECTED_TEST_CGROUP: context.cgroupPath,
});
const observe = phase => {
  const observation = assertManagedTestCgroup({ env });
  const argv = process.argv.slice(1);
  const vitestFork = isMainThread && argv.some(arg => arg.replaceAll('\\', '/').endsWith('/vitest/dist/workers/forks.js'));
  appendFileSync(context.evidencePath, JSON.stringify({ ...observation, phase, argv, vitestFork, isMainThread, threadId }) + '\n');
};
observe('preload');
process.on('exit', () => observe('exit'));
