/**
 * `papercusp://hindsight/banks` — list Hindsight memory banks the
 * workspace's company has access to.
 *
 * Bank IDs follow `paperclip::<companyId>` per the workspace registry.
 * If the workspace has no `companyId`, returns degraded with no banks.
 * Same auth model as the `hindsight:recall` tool.
 */
declare const _default: import("@papercusp/tooldef").ResourceDefinition;
export default _default;
