// cargo-result.mjs — the pure classification behind the native cargo-test
// reporter and the affected-tests wrapper. Keep this dependency-free: both
// scripts are gate entry points, so a helper import must not pull in a service
// or database module and turn a diagnostic into a runner failure.

/**
 * @typedef {{ signal: number, signalName: string }} CargoTermination
 */

/**
 * Extract cargo's own process-signal discriminator from a failed rustc command.
 * Cargo prints this in the `Caused by:` block, for example:
 *   process didn't exit successfully: `...rustc ...` (signal: 15, SIGTERM: termination signal)
 *
 * @param {string} output combined cargo stdout/stderr
 * @returns {CargoTermination | null}
 */
export function detectCargoTermination(output) {
  const re = /\(signal:\s*(\d+),\s*(SIG[A-Z0-9]+)\b[^)]*\)/g;
  let match;
  while ((match = re.exec(output)) !== null) {
    const signal = Number(match[1]);
    const signalName = match[2];
    if (Number.isInteger(signal) && signal > 0) return { signal, signalName };
  }
  return null;
}

/**
 * Classify the cargo task independently of the recorder's database result.
 *
 * @param {{ code: number | null, output: string, resultCount: number }} input
 * @returns {{ status: 'passed' | 'failed' | 'killed' | 'error', termination: CargoTermination | null }}
 */
export function classifyCargoRun({ code, output, resultCount }) {
  const termination = code !== 0 ? detectCargoTermination(output) : null;
  if (termination) return { status: 'killed', termination };
  if (code === 0 && resultCount > 0) return { status: 'passed', termination: null };
  if (code === 0) return { status: 'error', termination: null };
  return { status: 'failed', termination: null };
}

/**
 * A keyed, grep-safe line for the run log. The signal fields are deliberately
 * on the same line as the status so a fixed-size tail cannot leave a reader
 * with only "could not compile" and no cause.
 *
 * @param {{ status: 'passed' | 'failed' | 'killed' | 'error', termination?: CargoTermination | null }} result
 * @returns {string}
 */
export function formatCargoResultLine({ status, termination = null }) {
  const fields = [`CARGO_RESULT status=${status}`];
  if (termination) {
    fields.push(
      `signal=${termination.signal}`,
      `signalName=${termination.signalName}`,
      'cause=killed-by-signal',
    );
  }
  return fields.join(' ');
}
