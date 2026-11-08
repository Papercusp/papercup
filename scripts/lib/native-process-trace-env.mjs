/** Add the candidate preload without enabling stderr diagnostics.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ enabled?: boolean }} [options]
 */
export function nativeProcessTraceEnv(env = process.env, options = {}) {
  if (!(options.enabled ?? Boolean(env.PC_EXECUTED_SOURCE_MAP_OUT?.trim()))) return env;
  const preload = `--import=${JSON.stringify(new URL('./vitest-startup-trace.mjs', import.meta.url).href)}`;
  const nodeOptions = env.NODE_OPTIONS ?? '';
  return { ...env, NODE_OPTIONS: nodeOptions.includes(preload) ? nodeOptions : `${nodeOptions} ${preload}`.trim() };
}
