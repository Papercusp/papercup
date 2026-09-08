/** Keep the fixture's real upstream across starts of the same native home. */
export function nativeProviderTraceOrigin(
  configuredOrigin: string,
  traceOrigin: string,
  previousOrigin?: string,
): string {
  const trace = new URL(traceOrigin);
  const tracePath = trace.pathname.replace(/\/$/, '');
  const isSelf = (value: string) => {
    const url = new URL(value);
    return url.origin === trace.origin
      && (url.pathname === tracePath || url.pathname.startsWith(`${tracePath}/`));
  };
  const origin = isSelf(configuredOrigin) ? previousOrigin : configuredOrigin;
  if (!origin || isSelf(origin)) throw new Error('Provider trace has no non-recursive upstream');
  return origin;
}
