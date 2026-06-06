"use strict";
/**
 * List pending_events in the workspace. Summary-only — pending_events
 * is a queue and concierge agents are observers, never consumers.
 *
 * Typed via `schemaOf(pending_events).select`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const postgres_js_1 = require("drizzle-orm/postgres-js");
const drizzle_orm_1 = require("drizzle-orm");
const zod_1 = require("zod");
const db_org_1 = require("@papercusp/db-org");
const tooldef_1 = require("@papercusp/tooldef");
const pe = db_org_1.generated.pendingEventsInHarnessShared;
const PESelect = (0, db_org_1.schemaOf)(pe).select;
exports.default = (0, tooldef_1.defineTool)({
    name: 'pending_events:list',
    profile: 'engineer',
    capability: 'pending_events:read',
    guidance: {
        when: 'User asks "what\'s queued up?", "what events are pending?", or you need to inspect the hook-event backlog.',
        notWhen: 'For approvals (plan reviews, escalations awaiting user yes/no), use `pending_reviews_list`. Pending EVENTS are hook plumbing; pending REVIEWS are user-facing decisions.',
    },
    args: zod_1.z.object({
        detail: zod_1.z.enum(['summary']).default('summary'),
        kind: zod_1.z.string().optional(),
        targetRole: zod_1.z.string().optional(),
        limit: zod_1.z.number().int().positive().max(200).default(50),
    }),
    // Output schema (token-efficient-tool-result-formats P-013) — flat scalar
    // array → unlocks CSV + outputSchema advertisement.
    result: zod_1.z.array(zod_1.z.object({
        id: zod_1.z.string(),
        kind: zod_1.z.string(),
        targetRole: zod_1.z.string().nullable(),
        dueAt: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).nullable(),
        createdAt: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).nullable(),
        consumed: zod_1.z.boolean(),
    })),
    async handler(args, ctx) {
        const txDb = (0, postgres_js_1.drizzle)(ctx.tx);
        const preds = [
            args.kind ? (0, drizzle_orm_1.eq)(pe.kind, args.kind) : undefined,
            args.targetRole ? (0, drizzle_orm_1.eq)(pe.targetRole, args.targetRole) : undefined,
        ].filter((p) => p !== undefined);
        const rows = (await txDb
            .select({
            id: pe.id,
            kind: pe.kind,
            target_role: pe.targetRole,
            due_at: pe.dueAt,
            created_at: pe.createdAt,
            consumed_at: pe.consumedAt,
        })
            .from(pe)
            .where(preds.length ? (0, drizzle_orm_1.and)(...preds) : undefined)
            .orderBy((0, drizzle_orm_1.desc)(pe.createdAt))
            .limit(args.limit));
        return {
            data: rows.map((r) => ({
                id: r.id,
                kind: r.kind,
                targetRole: r.target_role,
                dueAt: r.due_at,
                createdAt: r.created_at,
                consumed: r.consumed_at != null,
            })),
        };
    },
});
