import base from './vitest.config';

// Retain the project's real setup and reporter while bounding mutation work
// to the engine's existing behavior tests. The installed PTY journey remains
// separate acceptance evidence for the complete UI path.
export default {
  ...base,
  test: {
    ...base.test,
    include: ['lib/su-session-claude-engine.test.ts'],
    maxWorkers: 1,
    fileParallelism: false,
  },
};
