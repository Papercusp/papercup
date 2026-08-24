import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateCpuProfile, classifyCpuFrame } from './lib/cpu-profile.mjs';

test('observer and non-work frames are excluded while GC remains real workload', () => {
  assert.equal(classifyCpuFrame('(garbage collector)'), null);

  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: 'inspectorPump', url: 'node:inspector', lineNumber: 1 } },
      { id: 2, callFrame: { functionName: '(idle)', url: '', lineNumber: 2 } },
      { id: 3, callFrame: { functionName: '(program)', url: '', lineNumber: 3 } },
      { id: 4, callFrame: { functionName: '(garbage collector)', url: '', lineNumber: 4 } },
      { id: 5, callFrame: { functionName: 'realWork', url: 'file:///repo/app.mjs', lineNumber: 5 } },
    ],
    samples: [1, 2, 3, 4, 5],
    timeDeltas: [100, 200, 300, 400, 500],
  };

  const result = aggregateCpuProfile(profile);

  assert.equal(result.totalUs, 1500);
  assert.equal(result.excludedUs, 600);
  assert.deepEqual(result.excludedByKind, { profiler: 100, 'non-work': 500 });
  assert.equal(result.realUs, 900);
  assert.deepEqual(result.frames.map(([frame, us]) => [frame.split(' @ ', 1)[0], us]), [
    ['realWork', 500],
    ['(garbage collector)', 400],
  ]);
});
