import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

function usage(message) {
  process.stderr.write(`[systemd-scope-env-runner] ${message}\n`);
  process.exitCode = 2;
}

function readEnvironment(sourcePath) {
  const records = readFileSync(sourcePath);
  const environment = {};
  for (const record of records.toString('utf8').split('\0')) {
    if (!record) continue;
    const separator = record.indexOf('=');
    if (separator <= 0) throw new Error('invalid environment payload');
    environment[record.slice(0, separator)] = record.slice(separator + 1);
  }
  return environment;
}

const mode = process.argv[2];
const source = process.argv[3];
const separator = process.argv.indexOf('--', 4);
if ((mode !== '--env-fd-path' && mode !== '--credential') || !source || separator < 0) {
  usage('expected --env-fd-path PATH -- COMMAND or --credential NAME -- COMMAND');
} else {
  try {
    const sourcePath = mode === '--credential'
      ? join(process.env.CREDENTIALS_DIRECTORY ?? '', source)
      : source;
    if (mode === '--credential' && !process.env.CREDENTIALS_DIRECTORY) {
      throw new Error('credential directory is unavailable');
    }
    const environment = readEnvironment(sourcePath);
    const command = process.argv[separator + 1];
    const args = process.argv.slice(separator + 2);
    if (!command) {
      usage('payload command is missing');
    } else {
      const child = spawn(command, args, { env: environment, stdio: 'inherit' });
      child.once('error', (error) => {
        process.stderr.write(`[systemd-scope-env-runner] payload spawn failed: ${error.message}\n`);
        process.exitCode = 1;
      });
      child.once('exit', (code, signal) => {
        process.exitCode = signal ? 1 : (code ?? 1);
      });
    }
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
}
