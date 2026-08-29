/**
 * Bounded excerpting for failure diagnostics from expensive workspace-host operations.
 *
 * Extracted from workspace-host-clean-room-executor so the GCP image-family adapter can use it
 * too. It could not simply be imported from there: that module already imports
 * gcp-image-family-adapter, so the dependency would have been a cycle. Both now depend on this
 * leaf instead, and there is exactly one implementation of the rule below rather than two that
 * can drift apart.
 */

/**
 * Bounded because this string is embedded in a release-gate issue and read in a terminal —
 * NOT because the rest is expendable. Callers that can afford to keep the whole thing should
 * spill it to a file and name the path in the message.
 */
export const DIAGNOSTIC_BUDGET_CHARS = 4_000;

/**
 * Fraction of the budget spent on the HEAD of the diagnostic. Weighted toward the head on
 * purpose — see {@link excerptDiagnostic} for why that is the load-bearing end.
 */
export const DIAGNOSTIC_HEAD_FRACTION = 0.6;

/**
 * Excerpt a diagnostic so BOTH ends survive.
 *
 * ⛔ NEVER go back to a tail-only `slice(-N)` here. It is the intuitive way to bound this
 * string and it is exactly backwards: a failing process prints its message and stack FIRST and
 * its process/systemd/teardown epilogue LAST, so keeping only the tail keeps the CONSEQUENCE
 * and discards the CAUSE.
 *
 * Measured on P-046 (2026-08-29), twice, in two different subsystems:
 *
 *  - A clean-room boot failed because the guest could not load `rocksdb-native.node`. The
 *    2_000-char tail preserved six lines of `systemctl` summary — "Main process exited",
 *    "start-post operation timed out", "Consumed 8.465s CPU time" — every one of which
 *    describes systemd reacting to the failure, and none of which names it. The
 *    `require.addon` error headline and the candidate paths it searched, i.e. the only part of
 *    the output identifying what was actually missing, fell off the FRONT. Diagnosing it cost
 *    an extra billable boot.
 *
 *  - A production `packer build` failed and reported nothing at all, because the adapter's
 *    excerpt read only stderr while packer's `-machine-readable` mode writes its entire event
 *    stream — errors included — to stdout (EI-21762126059344308).
 *
 * The lesson generalises past either bug: bound a diagnostic by excerpting it, never by
 * truncating it, and be sure you are excerpting the stream the failure was actually written to.
 */
export function excerptDiagnostic(
  text: string,
  budget: number = DIAGNOSTIC_BUDGET_CHARS,
): string {
  const trimmed = text.trim();
  if (trimmed.length <= budget) return trimmed;

  const headChars = Math.ceil(budget * DIAGNOSTIC_HEAD_FRACTION);
  const tailChars = budget - headChars;
  const omitted = trimmed.length - budget;

  return (
    `${trimmed.slice(0, headChars)}\n` +
    `\n… [${String(omitted)} chars omitted from the middle of the output] …\n\n` +
    `${trimmed.slice(-tailChars)}`
  );
}
