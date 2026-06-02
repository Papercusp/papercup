-- baseline-extra-tables.sql — GENERATED, transient (deleted in Phase 2 with the generator).
-- DDL for the 9 'ghost' tables the reference build can't reach via migrations/ensures:
--   Group B (inline TS runtime DDL, Phase-2 delete targets): voice_lease, operator_claims, harness_prompt_overrides, git_export_outbox
--   Group C (true orphans — no active creator; DDL only in Drizzle 0000/generated.reference.sql): harness_experts, harness_skills, orchestrator_settings, agent_chats_consolidated, feature_audit_consolidated
-- Captured from the live native :5432 papercusp DB (authoritative — none are sql/ migration-managed, so the box's missing 098-106 don't affect them).
-- NOTE: Group A (agent_actions, agent_queries, el_conv_calls, voice_utterances, delegates) is NOT here — it's applied via apps/operator/lib/commands/migrations/*.sql (carries the claude_sessions→delegates rename).

\restrict 4cNnPavtf9SD52hB4FJ9MGUa9TuvC4hQX33ZJ4Ux2zvVJGX7FS3NjfYcNkCoIh5
CREATE TABLE harness_shared.agent_chats_consolidated (
    workspace_id text DEFAULT ''::text NOT NULL,
    harness_slug text NOT NULL,
    id text NOT NULL,
    role text NOT NULL,
    feature_id text,
    title text,
    transcript jsonb DEFAULT '[]'::jsonb NOT NULL,
    total_input_tokens bigint DEFAULT 0 NOT NULL,
    total_output_tokens bigint DEFAULT 0 NOT NULL,
    total_cost_usd_cents bigint DEFAULT 0 NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    archived_at bigint
);
CREATE TABLE harness_shared.feature_audit_consolidated (
    id bigint NOT NULL,
    workspace_id text DEFAULT ''::text NOT NULL,
    harness_slug text NOT NULL,
    feature_id text NOT NULL,
    ts bigint NOT NULL,
    field text NOT NULL,
    old_value text,
    new_value text,
    actor text
);
CREATE SEQUENCE harness_shared.feature_audit_consolidated_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_shared.feature_audit_consolidated_id_seq OWNED BY harness_shared.feature_audit_consolidated.id;
CREATE TABLE harness_shared.git_export_outbox (
    id bigint NOT NULL,
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    table_name text NOT NULL,
    op text NOT NULL,
    key text NOT NULL,
    "row" jsonb,
    ts bigint NOT NULL,
    exported_at bigint,
    CONSTRAINT git_export_outbox_op_check CHECK ((op = ANY (ARRAY['put'::text, 'del'::text])))
);
CREATE SEQUENCE harness_shared.git_export_outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_shared.git_export_outbox_id_seq OWNED BY harness_shared.git_export_outbox.id;
CREATE TABLE harness_shared.harness_experts (
    workspace_id text DEFAULT ''::text NOT NULL,
    harness_slug text NOT NULL,
    expert_id text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'unknown'::text NOT NULL,
    budget_cents bigint DEFAULT 0 NOT NULL,
    feature_size text,
    high_level_spec text DEFAULT ''::text NOT NULL,
    agent_count integer DEFAULT 0 NOT NULL,
    round_count integer DEFAULT 0 NOT NULL,
    personas_used jsonb DEFAULT '[]'::jsonb NOT NULL,
    user_engaged boolean DEFAULT false NOT NULL,
    created_at bigint DEFAULT 0 NOT NULL,
    updated_at bigint DEFAULT 0 NOT NULL,
    termination_reason text,
    spec_content text DEFAULT ''::text NOT NULL,
    assertions_content text DEFAULT ''::text NOT NULL
);
CREATE TABLE harness_shared.harness_prompt_overrides (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    role text NOT NULL,
    prompt_md text NOT NULL,
    updated_at bigint NOT NULL
);
CREATE TABLE harness_shared.harness_skills (
    workspace_id text DEFAULT ''::text NOT NULL,
    harness_slug text NOT NULL,
    name text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    mtime_ms bigint DEFAULT 0 NOT NULL
);
CREATE TABLE harness_shared.operator_claims (
    harness_slug text NOT NULL,
    plugin_slug text NOT NULL,
    machine_id text NOT NULL,
    pid integer NOT NULL,
    run_id text NOT NULL,
    script_hash text NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    workspace_id text DEFAULT ''::text NOT NULL
);
CREATE TABLE harness_shared.orchestrator_settings (
    id integer DEFAULT 1 NOT NULL,
    tiers jsonb DEFAULT '[1, 2, 4]'::jsonb NOT NULL,
    labels jsonb DEFAULT '["trivial", "normal", "hard"]'::jsonb NOT NULL,
    rubric text DEFAULT ''::text NOT NULL,
    updated_ts bigint DEFAULT 0 NOT NULL,
    CONSTRAINT orchestrator_settings_id_check CHECK ((id = 1))
);
CREATE TABLE harness_shared.voice_lease (
    workspace_id text NOT NULL,
    owner_id text NOT NULL,
    owner_kind text NOT NULL,
    expires_at_ms bigint NOT NULL,
    CONSTRAINT voice_lease_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['desktop'::text, 'mobile'::text])))
);
ALTER TABLE ONLY harness_shared.feature_audit_consolidated ALTER COLUMN id SET DEFAULT nextval('harness_shared.feature_audit_consolidated_id_seq'::regclass);
ALTER TABLE ONLY harness_shared.git_export_outbox ALTER COLUMN id SET DEFAULT nextval('harness_shared.git_export_outbox_id_seq'::regclass);
ALTER TABLE ONLY harness_shared.agent_chats_consolidated
    ADD CONSTRAINT agent_chats_consolidated_pkey PRIMARY KEY (workspace_id, harness_slug, id);
ALTER TABLE ONLY harness_shared.feature_audit_consolidated
    ADD CONSTRAINT feature_audit_consolidated_pkey PRIMARY KEY (id);
ALTER TABLE ONLY harness_shared.git_export_outbox
    ADD CONSTRAINT git_export_outbox_pkey PRIMARY KEY (id);
ALTER TABLE ONLY harness_shared.harness_experts
    ADD CONSTRAINT harness_experts_pkey PRIMARY KEY (workspace_id, harness_slug, expert_id);
ALTER TABLE ONLY harness_shared.harness_prompt_overrides
    ADD CONSTRAINT harness_prompt_overrides_pkey PRIMARY KEY (workspace_id, harness_slug, role);
ALTER TABLE ONLY harness_shared.harness_skills
    ADD CONSTRAINT harness_skills_pkey PRIMARY KEY (workspace_id, harness_slug, name);
ALTER TABLE ONLY harness_shared.operator_claims
    ADD CONSTRAINT operator_claims_pkey PRIMARY KEY (harness_slug, plugin_slug);
ALTER TABLE ONLY harness_shared.orchestrator_settings
    ADD CONSTRAINT orchestrator_settings_pkey PRIMARY KEY (id);
ALTER TABLE ONLY harness_shared.voice_lease
    ADD CONSTRAINT voice_lease_pkey PRIMARY KEY (workspace_id);
CREATE INDEX agent_chats_consolidated_recent_idx ON harness_shared.agent_chats_consolidated USING btree (workspace_id, harness_slug, updated_at DESC);
CREATE INDEX feature_audit_consolidated_lookup_idx ON harness_shared.feature_audit_consolidated USING btree (workspace_id, harness_slug, feature_id, ts DESC);
CREATE INDEX git_export_outbox_drain_idx ON harness_shared.git_export_outbox USING btree (workspace_id, harness_slug, exported_at, id);
CREATE INDEX harness_skills_lookup_idx ON harness_shared.harness_skills USING btree (workspace_id, harness_slug);
CREATE INDEX he_recent_idx ON harness_shared.harness_experts USING btree (workspace_id, harness_slug, updated_at DESC);
CREATE INDEX voice_lease_expires_idx ON harness_shared.voice_lease USING btree (expires_at_ms);
ALTER TABLE harness_shared.agent_chats_consolidated ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_chats_consolidated_workspace_isolation ON harness_shared.agent_chats_consolidated USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
ALTER TABLE harness_shared.feature_audit_consolidated ENABLE ROW LEVEL SECURITY;
CREATE POLICY feature_audit_consolidated_workspace_isolation ON harness_shared.feature_audit_consolidated USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
ALTER TABLE harness_shared.harness_experts ENABLE ROW LEVEL SECURITY;
CREATE POLICY harness_experts_workspace_isolation ON harness_shared.harness_experts USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
ALTER TABLE harness_shared.harness_prompt_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY harness_prompt_overrides_workspace_isolation ON harness_shared.harness_prompt_overrides USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
ALTER TABLE harness_shared.harness_skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY harness_skills_workspace_isolation ON harness_shared.harness_skills USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
ALTER TABLE harness_shared.operator_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY operator_claims_workspace_isolation ON harness_shared.operator_claims USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
ALTER TABLE harness_shared.voice_lease ENABLE ROW LEVEL SECURITY;
CREATE POLICY voice_lease_workspace_isolation ON harness_shared.voice_lease USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
\unrestrict 4cNnPavtf9SD52hB4FJ9MGUa9TuvC4hQX33ZJ4Ux2zvVJGX7FS3NjfYcNkCoIh5
