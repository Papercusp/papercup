/**
 * Browser boundary for the server-owned coordination event-log package.
 *
 * Client-reachable operator-core modules use only the shared default workspace
 * constant. Loading the real barrel also loads its Postgres and filesystem
 * backends, which cannot be parsed into a browser bundle.
 */
export const DEFAULT_COORD_WORKSPACE = "default";
