/** Dependency-free claim-spec workspace partition resolver (WI-1564). */
export function resolveClaimSpecWorkspace(
  identWorkspaceId: string | null | undefined,
): string | undefined {
  const ws = identWorkspaceId?.trim();
  return ws && ws !== '*' ? ws : undefined;
}
