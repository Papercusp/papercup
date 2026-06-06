"use strict";
/**
 * `agent:role` — return the canonical role-prompt md for any agent role
 * (architect, orchestrator, scoper, worker, validator, debugger, …).
 *
 * Source of truth: libs/papercusp/packages/harness/prompts/<role>.md.
 * Returns the file content as a single system-role message. Used by
 * external clients that want to spin up an LLM session with the same
 * persona Papercusp uses internally.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const node_path_1 = require("node:path");
const host_platform_1 = require("@papercusp/host-platform");
const tooldef_1 = require("@papercusp/tooldef");
// No hand-kept role list here. The previous `KNOWN_ROLES` array had drifted
// from both `AGENT_ROLES` (role-config.ts) and the on-disk prompts — it
// accepted `tester` (which has no `<role>.md`, so the read below threw) and
// rejected `plan-gate`/`scanner`/`synthesizer` (which DO have one). The
// on-disk `libs/papercusp/packages/harness/prompts/<role>.md` set IS the
// source of truth for which roles have a persona, so we validate the id is
// well-formed (anti path-traversal) and let the file read below be the
// existence check — no second list to drift. (su-prompt-audit-fixes P-017 /
// D-006; the canonical role *registry* is `AGENT_ROLES`.)
const ROLE_ID_RE = /^[a-z][a-z0-9_-]*$/i;
function findPromptsDir() {
    // Search candidates from this file outward; works in monorepo + standalone.
    // We probe by trying to read a known-present file (any role.md), since
    // HostPlatform exposes file reads but not directory existence — and
    // "did this readTextFileSync return non-null" is a sufficient existence
    // check for the dir as a whole.
    const platform = (0, host_platform_1.getHostPlatform)();
    const candidates = [
        (0, node_path_1.resolve)(import.meta.dirname, '../../../../../libs/papercusp/packages/harness/prompts'),
        (0, node_path_1.resolve)(import.meta.dirname, '../../../../libs/papercusp/packages/harness/prompts'),
        (0, node_path_1.resolve)(process.cwd(), 'libs/papercusp/packages/harness/prompts'),
    ];
    for (const dir of candidates) {
        if (platform.fileExistsSync((0, node_path_1.join)(dir, 'architect.md')))
            return dir;
    }
    return null;
}
exports.default = (0, tooldef_1.definePrompt)({
    name: 'agent:role',
    description: 'Return the canonical role prompt for a Papercusp agent role. Args: role.',
    arguments: [
        {
            name: 'role',
            description: 'A Papercusp role id with a prompt at ' +
                'libs/papercusp/packages/harness/prompts/<role>.md ' +
                '(e.g. architect, scoper, worker, reviewer, validator, debugger, orchestrator).',
            required: true,
        },
    ],
    async render(args) {
        const role = args.role;
        if (!role || !ROLE_ID_RE.test(role)) {
            throw new Error(`Invalid role id "${role}".`);
        }
        const dir = findPromptsDir();
        if (!dir) {
            throw new Error('Could not locate libs/papercusp/packages/harness/prompts on disk.');
        }
        const path = (0, node_path_1.join)(dir, `${role}.md`);
        const text = (0, host_platform_1.getHostPlatform)().readTextFileSync(path);
        if (text === null) {
            throw new Error(`Role prompt not found: ${path}`);
        }
        return {
            description: `Canonical ${role} role prompt.`,
            messages: [{ role: 'system', content: { type: 'text', text } }],
        };
    },
});
