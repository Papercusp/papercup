import { describe, expect, it } from 'vitest';
import {
  buildTaskScopeArgv,
  buildTaskServiceArgv,
  escapeSystemdServiceArgument,
} from './systemd-scope';

const PROPS = { unit: 'papercusp-bash-job-test.service', slice: 'papercusp-bash-job.slice' };

describe('transient service payload escaping', () => {
  it('escapes dollars for systemd while preserving Bash parameter expansions', () => {
    const command = 'false | cat; printf "PS0=[${PIPESTATUS[0]}] PID=[$$]\\n"';
    const argv = buildTaskServiceArgv(['/bin/bash', '-o', 'pipefail', '-c', command], PROPS);

    expect(argv.at(-1)).toBe(escapeSystemdServiceArgument(command));
    expect(argv.at(-1)).toContain('$${PIPESTATUS[0]}');
    expect(argv.at(-1)).toContain('[$$$$]');
    expect(argv.at(-1)).not.toBe(command);
  });

  it('leaves transient scope payloads byte-for-byte unchanged', () => {
    const command = 'printf "%s" "${PIPESTATUS[0]} $$"';
    const argv = buildTaskScopeArgv(['/bin/bash', '-c', command], {
      unit: 'papercusp-bash-job-test.scope',
      slice: 'papercusp-bash-job.slice',
    });

    expect(argv.at(-1)).toBe(command);
  });
});
