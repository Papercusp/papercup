import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { classifySample, inspectAudioService, measureSource, recover, sampleStats } from './fixmic.mjs';

const live = { source: 'brio', bytes: 100, peak: 12 };

test('classifies capture bytes separately from digital silence', () => {
  assert.deepEqual(sampleStats(Buffer.from([0, 0, 0xff, 0x7f])), {
    bytes: 4, peak: 32767, nonzeroSamples: 1,
  });
  assert.equal(classifySample({ bytes: 100, peak: 0 }), 'silent-frames');
  assert.equal(classifySample({ bytes: 0, peak: 0 }), 'no-frames');
});

test('capture uses a named temporary file and removes it after measurement', () => {
  const calls = [];
  const run = (name, args) => {
    calls.push([name, args]);
    if (name === 'pactl') return { status: 0, stdout: 'brio\n' };
    writeFileSync(args.at(-1), Buffer.from([1, 0, 2, 0]));
    return { status: null, error: { code: 'ETIMEDOUT' } };
  };
  assert.deepEqual(measureSource({ run }), {
    source: 'brio', bytes: 4, peak: 2, nonzeroSamples: 2,
  });
  assert.match(calls[1][1].at(-1), /capture\.raw$/);
  assert.equal(existsSync(calls[1][1].at(-1)), false);
});

test('live capture recommends reload and never restarts the audio server', () => {
  const calls = [];
  const output = [];
  assert.equal(recover({ measure: () => live, run: (...args) => calls.push(args),
    write: (line) => output.push(line) }), 'live-frames');
  assert.deepEqual(calls, []);
  assert.match(output.join('\n'), /reload that tab and retry first/);
});

test('silent frames do not trigger a disruptive server restart', () => {
  let calls = 0;
  assert.equal(recover({ measure: () => ({ ...live, peak: 0 }), run: () => calls++,
    write: () => {} }), 'silent-frames');
  assert.equal(calls, 0);
});

test('a single no-frame probe does not restart user audio services', () => {
  let calls = 0;
  assert.equal(recover({ measure: () => ({ ...live, bytes: 0, peak: 0 }), run: () => calls++,
    write: () => {} }), 'no-frames');
  assert.equal(calls, 0);
});

test('confirmed no frames restart only the audio services and remeasure', () => {
  const calls = [];
  let measures = 0;
  assert.equal(recover({ args: ['--restart-audio-server', '--confirmed-no-frames'],
    measure: () => (++measures === 1 ? { ...live, bytes: 0, peak: 0 } : live),
    run: (name, args) => { calls.push([name, args]); return { status: 0, stdout: '' }; },
    write: () => {} }), 'live-frames');
  assert.deepEqual(calls.map(([name]) => name), ['systemctl', 'sleep']);
  assert.deepEqual(calls[0][1], ['--user', 'restart', 'pipewire.service', 'pipewire-pulse.service', 'wireplumber.service']);
});

test('confirmed restart rechecks first and skips server restart when capture recovered', () => {
  let calls = 0;
  assert.equal(recover({ args: ['--restart-audio-server', '--confirmed-no-frames'],
    measure: () => live, run: () => calls++, write: () => {} }), 'live-frames');
  assert.equal(calls, 0);
});

test('targeted Chrome restart requires a reload attempt and validates PID identity', () => {
  const killed = [];
  const readFile = (path) => path.endsWith('/cmdline')
    ? Buffer.from('/opt/google/chrome/chrome\0--type=utility\0--utility-sub-type=audio.mojom.AudioService\0')
    : 'Name:\tchrome\nUid:\t1000\t1000\t1000\t1000\n';
  assert.throws(() => recover({ args: ['--restart-audio-service', '123'], kill: (...args) => killed.push(args) }), /reload/);
  assert.equal(recover({ args: ['--restart-audio-service', '123', '--reload-tried'],
    readFile, uid: 1000, kill: (...args) => killed.push(args), write: () => {} }), 'audio-service-restarted');
  assert.deepEqual(killed, [[123, 'SIGTERM']]);
  assert.throws(() => inspectAudioService(123, { uid: 2000, readFile }), /another user/);
  assert.throws(() => inspectAudioService(123, { uid: 1000, readFile: (path) =>
    path.endsWith('/cmdline') ? Buffer.from('/bin/bash\0--utility-sub-type=audio.mojom.AudioService\0') : readFile(path) }), /not a Chrome AudioService/);
});
