import { describe, expect, it, vi } from 'vitest';
import { composeCheckpointQualificationBeforePromotion, createCheckpointQualificationNativeObserver } from './green-checkpoint';
import type { QualificationWorkProgressInput } from '@papercusp/operator-core/lib/release/checkpoint-qualification-transaction';

const progress: QualificationWorkProgressInput = {
  attemptId: 'attempt', candidate: 'candidate', repairHead: null, runnerId: 'runner',
  runId: 'run', pidIdentity: 'boot:42', root: '/repo', taskKey: 'qualification',
  manifest: { schemaVersion: 1, units: [{ id: 'test:a.test.ts', kind: 'test', path: 'a.test.ts' }] },
  retryStates: [], runContext: 'ci', runnerIdentity: 'native', updates: [],
};
const announcement = (task = 'ws :: test', path = '/out/a.producer.json') =>
  `QUALIFICATION_NATIVE_PRODUCER task=${JSON.stringify(task)} path=${JSON.stringify(path)}`;
const fixture = () => {
  const enroll = vi.fn().mockResolvedValue({ status: 'updated', transaction: {} });
  const recover = vi.fn().mockResolvedValue({ status: 'idempotent', transaction: { attemptId: 'attempt' } });
  const tasks = new Map([['ws :: test', { workspaceName: 'ws', selectedSpecifications: [{ testFile: 'a.test.ts' }] }]]);
  return { enroll, recover, tasks,
    observer: createCheckpointQualificationNativeObserver({ target: { workspaceId: 'w', installSlug: 'h' },
      progress, tasks }, { enroll, recover }) };
};

describe('the production green barrier before promotion', () => {
  const setup = () => {
    const transaction = { attemptId: progress.attemptId, candidate: progress.candidate,
      repairHead: progress.repairHead, runId: progress.runId,
      currentPhysicalRunner: { id: progress.runnerId, pidIdentity: progress.pidIdentity },
      continuation: { root: progress.root, taskKey: progress.taskKey,
        manifest: progress.manifest, retryStates: progress.retryStates } };
    const read = vi.fn().mockResolvedValue({ status: 'present', transaction });
    const compose = vi.fn().mockResolvedValue({ status: 'idempotent', transaction });
    const classifier = vi.fn();
    const deps = { read, compose, pidIdentity: () => progress.pidIdentity,
      runnerIdentity: () => progress.runnerIdentity, classify: vi.fn(() => classifier) };
    const input = { target: { workspaceId: 'w', installSlug: 'h' }, attemptId: progress.attemptId,
      candidate: progress.candidate, runId: progress.runId, root: progress.root };
    return { transaction, read, compose, deps, input, classifier };
  };

  it('awaits the row composer with the current fence and maintained input classifier', async () => {
    const { deps, input, compose, classifier } = setup();
    let release!: () => void;
    compose.mockImplementation(() => new Promise(resolve => { release = () => resolve({ status: 'idempotent' }); }));
    const ready = composeCheckpointQualificationBeforePromotion(input, deps);
    await vi.waitFor(() => expect(compose).toHaveBeenCalledWith(input.target, progress, { classifyReadPaths: classifier }));
    release();
    expect(await ready).toEqual({ status: 'ready' });
  });

  it.each(['none', 'unreadable'])('refuses an %s row instead of falling back to child exit zero', async status => {
    const { deps, input, read, compose } = setup();
    read.mockResolvedValue({ status });
    expect(await composeCheckpointQualificationBeforePromotion(input, deps)).toMatchObject({ status: 'refused' });
    expect(compose).not.toHaveBeenCalled();
  });

  it.each(['attemptId', 'candidate', 'runId'])('refuses a different %s', async key => {
    const { deps, input, transaction, compose } = setup();
    Object.assign(transaction, { [key]: 'other' });
    expect(await composeCheckpointQualificationBeforePromotion(input, deps)).toMatchObject({ status: 'refused' });
    expect(compose).not.toHaveBeenCalled();
  });

  it('preserves a legacy attempt only when no continuation was frozen', async () => {
    const { deps, input, read, transaction, compose } = setup();
    read.mockResolvedValue({ status: 'present', transaction: { ...transaction, continuation: undefined } });
    expect(await composeCheckpointQualificationBeforePromotion(input, deps)).toEqual({ status: 'legacy' });
    expect(compose).not.toHaveBeenCalled();
  });

  it('refuses stolen custody and a missing post-suite proof', async () => {
    const { deps, input, compose } = setup();
    expect(await composeCheckpointQualificationBeforePromotion(input, { ...deps, pidIdentity: () => 'other' }))
      .toMatchObject({ status: 'refused', reason: 'qualification-runner-fence-mismatch' });
    expect(compose).not.toHaveBeenCalled();
    compose.mockResolvedValue({ status: 'conflict', refusalReason: 'continuation-verdict-not-green' });
    expect(await composeCheckpointQualificationBeforePromotion(input, deps)).toEqual({ status: 'refused',
      reason: 'qualification-composition-conflict:continuation-verdict-not-green' });
  });
});

describe('native output adoption on the qualification host', () => {
  it('waits for durable enrollment before recovering native artifacts, across chunks and streams', async () => {
    const { observer, enroll, recover, tasks } = fixture();
    let release!: () => void;
    enroll.mockImplementation(() => new Promise<void>(resolve => { release = resolve; })
      .then(() => ({ status: 'updated', transaction: {} })));
    const line = announcement();
    observer.onOutput('stdout', line.slice(0, 30));
    observer.onOutput('stderr', 'diagnostic\n');
    observer.onOutput('stdout', line.slice(30) + '\n');
    // A caller mutation must not replace the independently prepared selection.
    tasks.get('ws :: test')!.selectedSpecifications[0]!.testFile = 'foreign.test.ts';
    const result = observer.finish();
    await Promise.resolve();
    expect(enroll).toHaveBeenCalledWith({ workspaceId: 'w', installSlug: 'h' }, progress, {
      taskKey: 'ws :: test', workspaceName: 'ws', selectedSpecifications: [{ testFile: 'a.test.ts' }],
      producerPath: '/out/a.producer.json', path: '/out/a',
    });
    expect(recover).not.toHaveBeenCalled();
    release();
    expect(await result).toMatchObject({ status: 'ready', transaction: { attemptId: 'attempt' } });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(observer.finish()).toBe(result);
  });

  it('coalesces repeated announcements and accepts the final unterminated line', async () => {
    const { observer, enroll } = fixture();
    observer.onOutput('stdout', announcement() + '\n' + announcement());
    expect(await observer.finish()).toMatchObject({ status: 'ready' });
    expect(enroll).toHaveBeenCalledTimes(1);
  });

  it('refuses a second producer for the same physical task instead of growing an unbounded queue', async () => {
    const { observer, recover } = fixture();
    observer.onOutput('stdout', announcement() + '\n' + announcement('ws :: test', '/out/other.producer.json') + '\n');
    expect(await observer.finish()).toEqual({ status: 'refused', reason: 'native-producer-announcement-conflict' });
    expect(recover).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed', 'QUALIFICATION_NATIVE_PRODUCER task=broken path="/out/a.producer.json"'],
    ['child refusal', 'QUALIFICATION_NATIVE_PRODUCER_REFUSED task="ws :: test" reason="unknown"'],
    ['foreign task', announcement('foreign :: test')],
    ['relative artifact', announcement('ws :: test', 'relative.producer.json')],
    ['wrong artifact', announcement('ws :: test', '/out/a.json')],
  ])('refuses %s without recovering banked outcomes', async (_name, text) => {
    const { observer, enroll, recover } = fixture();
    observer.onOutput('stdout', text + '\n');
    expect(await observer.finish()).toMatchObject({ status: 'refused' });
    expect(enroll).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it('never recovers or falls back to stored passes after an enrollment fence conflict', async () => {
    const { observer, enroll, recover } = fixture();
    enroll.mockResolvedValue({ status: 'conflict', refusalReason: 'runner-fence-mismatch' });
    observer.onOutput('stdout', announcement() + '\n');
    expect(await observer.finish()).toEqual({ status: 'refused', reason: 'native-producer-enrollment-conflict' });
    expect(recover).not.toHaveBeenCalled();
  });

  it('rechecks earlier enrolled artifacts even when no new producer is announced', async () => {
    const { observer, recover } = fixture();
    recover.mockResolvedValue({ status: 'conflict', refusalReason: 'snapshot-integrity-mismatch' });
    expect(await observer.finish()).toEqual({ status: 'refused', reason: 'native-producer-recovery-conflict' });
  });

  it('retains asynchronous storage failures as refusal rather than an unhandled observer error', async () => {
    const { observer, enroll, recover } = fixture();
    enroll.mockRejectedValue(new Error('database unavailable'));
    observer.onOutput('stdout', announcement() + '\n');
    expect(await observer.finish()).toEqual({ status: 'refused', reason: 'native-producer-enrollment-unreadable' });
    expect(recover).not.toHaveBeenCalled();
  });

  it('bounds diagnostic fragments without accepting an embedded marker as a new line', async () => {
    const { observer, enroll } = fixture();
    observer.onOutput('stdout', 'x'.repeat(20_000));
    observer.onOutput('stdout', announcement() + '\n' + announcement() + '\n');
    expect(await observer.finish()).toMatchObject({ status: 'ready' });
    expect(enroll).toHaveBeenCalledTimes(1);
  });
});
