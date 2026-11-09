/** Enable the existing native process trace without inheriting parent preloads. */
export function nativeProcessTraceEnv(
  env?: NodeJS.ProcessEnv,
  options?: { enabled?: boolean },
): NodeJS.ProcessEnv;
