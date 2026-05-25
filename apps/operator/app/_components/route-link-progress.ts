export function shouldStartRouteProgressForClick(opts: {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  download: boolean;
  targetBlank: boolean;
  disableProgress: boolean;
  targetBlocksProgress: boolean;
  currentHref: string;
  targetHref: string;
}): boolean {
  if (opts.defaultPrevented) return false;
  if (opts.button !== 0) return false;
  if (opts.metaKey || opts.ctrlKey || opts.shiftKey || opts.altKey) return false;
  if (opts.download) return false;
  if (opts.targetBlank) return false;
  if (opts.disableProgress) return false;
  if (opts.targetBlocksProgress) return false;

  const targetUrl = new URL(opts.targetHref);
  const currentUrl = new URL(opts.currentHref);
  if (targetUrl.origin !== currentUrl.origin) return false;
  return targetUrl.href !== currentUrl.href;
}
