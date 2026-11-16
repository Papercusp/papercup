/** Shared by the canonical store and SQL-backed artifact tool handlers.
 * Keep this leaf free of database imports so the handlers use only ctx.tx. */
export function assertMutableTextArtifactKey(key: string): void {
  if (key.startsWith('immutable/')) throw new Error('text_artifact_immutable_namespace');
}
