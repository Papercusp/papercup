"use strict";
/**
 * Read a harness's outbox (messages it has sent). Useful for tracing
 * "what did harness X say recently?"
 *
 * Typed via `schemaOf(audit_log).select` — outbox is audit_log filtered
 * by actor=slug + action='send_message'.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const postgres_js_1 = require("drizzle-orm/postgres-js");
const drizzle_orm_1 = require("drizzle-orm");
const zod_1 = require("zod");
const db_org_1 = require("@papercusp/db-org");
const tooldef_1 = require("@papercusp/tooldef");
const audit = db_org_1.generated.auditLogInHarnessShared;
const AuditSelect = (0, db_org_1.schemaOf)(audit).select;
exports.default = (0, tooldef_1.defineTool)({
    name: 'messages:outbox',
    capability: 'messages:read',
    guidance: {
        when: 'User asks "what did I send?", "did the message go through?", or you need to confirm a recent send.',
        notWhen: 'For incoming, use `messages:inbox`.',
    },
    args: zod_1.z.object({
        slug: zod_1.z.string().min(1),
        detail: zod_1.z.enum(['summary', 'full']).default('summary'),
        limit: zod_1.z.number().int().positive().max(200).default(50),
    }),
    // Output schema (token-efficient-tool-result-formats P-011) — see audit:list /
    // messages:inbox: the default `summary` shape is a flat scalar array (CSV-
    // eligible + advertised `outputSchema`); `detail: 'full'` adds a nested
    // `details` object per row, which the serializer downgrades to TOON.
    result: zod_1.z.array(zod_1.z.object({
        ts: zod_1.z.number(),
        subject: zod_1.z.string(),
    })),
    async handler(args, ctx) {
        if (!/^[a-z0-9._-]+$/i.test(args.slug)) {
            return {
                data: [],
                degraded: true,
                degradedReasons: [`invalid slug ${JSON.stringify(args.slug)}`],
            };
        }
        const txDb = (0, postgres_js_1.drizzle)(ctx.tx);
        const rows = (await txDb
            .select({ ts: audit.ts, action: audit.action, subject: audit.subject, details: audit.details })
            .from(audit)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(audit.actor, args.slug), (0, drizzle_orm_1.eq)(audit.action, 'send_message')))
            .orderBy((0, drizzle_orm_1.desc)(audit.ts))
            .limit(args.limit));
        if (args.detail === 'summary') {
            return {
                data: rows.map((r) => ({ ts: r.ts, subject: r.subject })),
            };
        }
        return { data: rows };
    },
});
