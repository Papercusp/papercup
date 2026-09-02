/**
 * Wire tooldef's ambient-dispatch-arg-keys seam to Papercusp's own dispatch-level
 * reserved args (EI-22174225494240206).
 *
 * `unknownArgHint`'s "this tool accepts ONLY: …" list is built from a tool's OWN
 * declared schema only, so a dispatch-level arg the transport strips BEFORE tooldef
 * ever validates the call — Papercusp's `projection` and `view`
 * (result-projection/types.ts, result-projection/named-views.ts), both reserved "at
 * the dispatch layer, available on EVERY tool" per their own module docs — could
 * never appear in it, even though both are genuinely accepted on every tool call.
 * The rejection then instructed the caller, in imperative terms, to re-send WITHOUT
 * a capability that actually works (a measured contributing cause of an agent
 * concluding a working feature — full-payload retrieval — did not exist:
 * EI-21736465978852433).
 *
 * `@papercusp/tooldef`'s `unknownArgHint` calls the host-registered resolver on
 * every `Unrecognized key` invalid_args failure; the default is unregistered (empty
 * list, no change to the message). The HOST owns the policy, so the resolver is
 * registered HERE — imported as a side effect at startup (see `agent-tools/index.ts`),
 * the same shape as `server-vintage-wiring.ts`.
 *
 * `payloadTier` needs NO entry here: it is tooldef's OWN framework-reserved arg
 * (`payload-tier.ts`) and `unknownArgHint` already names it directly. This resolver
 * exists only for dispatch keys a domain-free `libs/generic/*` package must not know
 * the name of. Reading them straight from `result-projection`'s own exported
 * constants (rather than re-typed string literals) keeps this list DERIVED, not a
 * second hand-maintained copy (derived-truth-ladder rung 1): if either constant is
 * ever renamed, or a THIRD dispatch-reserved arg joins them there, this resolver
 * only needs its import list extended, not a parallel string re-typed from memory.
 */

import { setAmbientArgKeysResolver } from '@papercusp/agent-mcp';
import { PROJECTION_ARG, VIEW_ARG } from '../result-projection';

setAmbientArgKeysResolver((): readonly string[] => [PROJECTION_ARG, VIEW_ARG]);
