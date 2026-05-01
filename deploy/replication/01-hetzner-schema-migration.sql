-- Bring Hetzner schemas up to local's structure for logical replication.
-- Idempotent: uses IF NOT EXISTS / CREATE OR REPLACE patterns where possible;
-- for tables that don't exist, CREATE TABLE will fail if already there but
-- we wrap each in a DO block.

-- ─────────────────────────────────────── harness_org ───
CREATE TABLE IF NOT EXISTS harness_org.config_token (
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_org.directive_summaries (
    id bigint NOT NULL,
    directive_id text NOT NULL,
    source text DEFAULT 'ceo'::text NOT NULL,
    summary text NOT NULL,
    caller_slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_org.directive_summaries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_org.directive_summaries_id_seq OWNED BY harness_org.directive_summaries.id;
CREATE TABLE IF NOT EXISTS harness_org.executed_actions (
    action_id uuid NOT NULL,
    op text NOT NULL,
    caller_slug text NOT NULL,
    target_slug text,
    reason text,
    request jsonb NOT NULL,
    response jsonb NOT NULL,
    executed_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_org.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_slug text NOT NULL,
    to_slug text NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    body text,
    parent_message_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    to_role text,
    CONSTRAINT messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'acknowledged'::text, 'archived'::text])))
);
CREATE TABLE IF NOT EXISTS harness_org.supervisor_notes (
    id bigint NOT NULL,
    body text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_org.supervisor_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_org.supervisor_notes_id_seq OWNED BY harness_org.supervisor_notes.id;
ALTER TABLE ONLY harness_org.directive_summaries ALTER COLUMN id SET DEFAULT nextval('harness_org.directive_summaries_id_seq'::regclass);
ALTER TABLE ONLY harness_org.supervisor_notes ALTER COLUMN id SET DEFAULT nextval('harness_org.supervisor_notes_id_seq'::regclass);
DO $$
BEGIN
ALTER TABLE ONLY harness_org.config_token
    ADD CONSTRAINT config_token_pkey PRIMARY KEY (token);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org.directive_summaries
    ADD CONSTRAINT directive_summaries_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org.executed_actions
    ADD CONSTRAINT executed_actions_pkey PRIMARY KEY (action_id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org.supervisor_notes
    ADD CONSTRAINT supervisor_notes_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS directive_summaries_directive_idx ON harness_org.directive_summaries USING btree (directive_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_caller_idx ON harness_org.executed_actions USING btree (caller_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_op_idx ON harness_org.executed_actions USING btree (op, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_target_idx ON harness_org.executed_actions USING btree (target_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS messages_from_idx ON harness_org.messages USING btree (from_slug, created_at);
CREATE INDEX IF NOT EXISTS messages_status_idx ON harness_org.messages USING btree (status, created_at);
CREATE INDEX IF NOT EXISTS messages_to_idx ON harness_org.messages USING btree (to_slug, status);
CREATE INDEX IF NOT EXISTS messages_to_role_idx ON harness_org.messages USING btree (to_slug, to_role) WHERE (to_role IS NOT NULL);

-- ─────────────────────────────────────── harness_org_business ───
CREATE TABLE IF NOT EXISTS harness_org_business.config_token (
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_org_business.directive_summaries (
    id bigint NOT NULL,
    directive_id text NOT NULL,
    source text DEFAULT 'ceo'::text NOT NULL,
    summary text NOT NULL,
    caller_slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_org_business.directive_summaries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_org_business.directive_summaries_id_seq OWNED BY harness_org_business.directive_summaries.id;
CREATE TABLE IF NOT EXISTS harness_org_business.executed_actions (
    action_id uuid NOT NULL,
    op text NOT NULL,
    caller_slug text NOT NULL,
    target_slug text,
    reason text,
    request jsonb NOT NULL,
    response jsonb NOT NULL,
    executed_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_org_business.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_slug text NOT NULL,
    to_slug text NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    body text,
    parent_message_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    to_role text,
    CONSTRAINT messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'acknowledged'::text, 'archived'::text])))
);
CREATE TABLE IF NOT EXISTS harness_org_business.supervisor_notes (
    id bigint NOT NULL,
    body text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_org_business.supervisor_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_org_business.supervisor_notes_id_seq OWNED BY harness_org_business.supervisor_notes.id;
ALTER TABLE ONLY harness_org_business.directive_summaries ALTER COLUMN id SET DEFAULT nextval('harness_org_business.directive_summaries_id_seq'::regclass);
ALTER TABLE ONLY harness_org_business.supervisor_notes ALTER COLUMN id SET DEFAULT nextval('harness_org_business.supervisor_notes_id_seq'::regclass);
DO $$
BEGIN
ALTER TABLE ONLY harness_org_business.config_token
    ADD CONSTRAINT config_token_pkey PRIMARY KEY (token);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_business.directive_summaries
    ADD CONSTRAINT directive_summaries_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_business.executed_actions
    ADD CONSTRAINT executed_actions_pkey PRIMARY KEY (action_id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_business.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_business.supervisor_notes
    ADD CONSTRAINT supervisor_notes_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS directive_summaries_directive_idx ON harness_org_business.directive_summaries USING btree (directive_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_caller_idx ON harness_org_business.executed_actions USING btree (caller_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_op_idx ON harness_org_business.executed_actions USING btree (op, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_target_idx ON harness_org_business.executed_actions USING btree (target_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS messages_from_idx ON harness_org_business.messages USING btree (from_slug, created_at);
CREATE INDEX IF NOT EXISTS messages_status_idx ON harness_org_business.messages USING btree (status, created_at);
CREATE INDEX IF NOT EXISTS messages_to_idx ON harness_org_business.messages USING btree (to_slug, status);
CREATE INDEX IF NOT EXISTS messages_to_role_idx ON harness_org_business.messages USING btree (to_slug, to_role) WHERE (to_role IS NOT NULL);

-- ─────────────────────────────────────── harness_org_coordination ───
CREATE TABLE IF NOT EXISTS harness_org_coordination.config_token (
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_org_coordination.directive_summaries (
    id bigint NOT NULL,
    directive_id text NOT NULL,
    source text DEFAULT 'ceo'::text NOT NULL,
    summary text NOT NULL,
    caller_slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_org_coordination.directive_summaries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_org_coordination.directive_summaries_id_seq OWNED BY harness_org_coordination.directive_summaries.id;
CREATE TABLE IF NOT EXISTS harness_org_coordination.executed_actions (
    action_id uuid NOT NULL,
    op text NOT NULL,
    caller_slug text NOT NULL,
    target_slug text,
    reason text,
    request jsonb NOT NULL,
    response jsonb NOT NULL,
    executed_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_org_coordination.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_slug text NOT NULL,
    to_slug text NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    body text,
    parent_message_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    to_role text,
    CONSTRAINT messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'acknowledged'::text, 'archived'::text])))
);
CREATE TABLE IF NOT EXISTS harness_org_coordination.supervisor_notes (
    id bigint NOT NULL,
    body text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_org_coordination.supervisor_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_org_coordination.supervisor_notes_id_seq OWNED BY harness_org_coordination.supervisor_notes.id;
ALTER TABLE ONLY harness_org_coordination.directive_summaries ALTER COLUMN id SET DEFAULT nextval('harness_org_coordination.directive_summaries_id_seq'::regclass);
ALTER TABLE ONLY harness_org_coordination.supervisor_notes ALTER COLUMN id SET DEFAULT nextval('harness_org_coordination.supervisor_notes_id_seq'::regclass);
DO $$
BEGIN
ALTER TABLE ONLY harness_org_coordination.config_token
    ADD CONSTRAINT config_token_pkey PRIMARY KEY (token);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_coordination.directive_summaries
    ADD CONSTRAINT directive_summaries_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_coordination.executed_actions
    ADD CONSTRAINT executed_actions_pkey PRIMARY KEY (action_id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_coordination.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_coordination.supervisor_notes
    ADD CONSTRAINT supervisor_notes_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS directive_summaries_directive_idx ON harness_org_coordination.directive_summaries USING btree (directive_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_caller_idx ON harness_org_coordination.executed_actions USING btree (caller_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_op_idx ON harness_org_coordination.executed_actions USING btree (op, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_target_idx ON harness_org_coordination.executed_actions USING btree (target_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS messages_from_idx ON harness_org_coordination.messages USING btree (from_slug, created_at);
CREATE INDEX IF NOT EXISTS messages_status_idx ON harness_org_coordination.messages USING btree (status, created_at);
CREATE INDEX IF NOT EXISTS messages_to_idx ON harness_org_coordination.messages USING btree (to_slug, status);
CREATE INDEX IF NOT EXISTS messages_to_role_idx ON harness_org_coordination.messages USING btree (to_slug, to_role) WHERE (to_role IS NOT NULL);

-- ─────────────────────────────────────── harness_org_management ───
CREATE TABLE IF NOT EXISTS harness_org_management.config_token (
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_org_management.directive_summaries (
    id bigint NOT NULL,
    directive_id text NOT NULL,
    source text DEFAULT 'ceo'::text NOT NULL,
    summary text NOT NULL,
    caller_slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_org_management.directive_summaries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_org_management.directive_summaries_id_seq OWNED BY harness_org_management.directive_summaries.id;
CREATE TABLE IF NOT EXISTS harness_org_management.executed_actions (
    action_id uuid NOT NULL,
    op text NOT NULL,
    caller_slug text NOT NULL,
    target_slug text,
    reason text,
    request jsonb NOT NULL,
    response jsonb NOT NULL,
    executed_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_org_management.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_slug text NOT NULL,
    to_slug text NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    body text,
    parent_message_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    to_role text,
    CONSTRAINT messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'acknowledged'::text, 'archived'::text])))
);
CREATE TABLE IF NOT EXISTS harness_org_management.supervisor_notes (
    id bigint NOT NULL,
    body text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_org_management.supervisor_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_org_management.supervisor_notes_id_seq OWNED BY harness_org_management.supervisor_notes.id;
ALTER TABLE ONLY harness_org_management.directive_summaries ALTER COLUMN id SET DEFAULT nextval('harness_org_management.directive_summaries_id_seq'::regclass);
ALTER TABLE ONLY harness_org_management.supervisor_notes ALTER COLUMN id SET DEFAULT nextval('harness_org_management.supervisor_notes_id_seq'::regclass);
DO $$
BEGIN
ALTER TABLE ONLY harness_org_management.config_token
    ADD CONSTRAINT config_token_pkey PRIMARY KEY (token);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_management.directive_summaries
    ADD CONSTRAINT directive_summaries_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_management.executed_actions
    ADD CONSTRAINT executed_actions_pkey PRIMARY KEY (action_id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_management.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_management.supervisor_notes
    ADD CONSTRAINT supervisor_notes_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS directive_summaries_directive_idx ON harness_org_management.directive_summaries USING btree (directive_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_caller_idx ON harness_org_management.executed_actions USING btree (caller_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_op_idx ON harness_org_management.executed_actions USING btree (op, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_target_idx ON harness_org_management.executed_actions USING btree (target_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS messages_from_idx ON harness_org_management.messages USING btree (from_slug, created_at);
CREATE INDEX IF NOT EXISTS messages_status_idx ON harness_org_management.messages USING btree (status, created_at);
CREATE INDEX IF NOT EXISTS messages_to_idx ON harness_org_management.messages USING btree (to_slug, status);
CREATE INDEX IF NOT EXISTS messages_to_role_idx ON harness_org_management.messages USING btree (to_slug, to_role) WHERE (to_role IS NOT NULL);

-- ─────────────────────────────────────── harness_org_marketing ───
CREATE TABLE IF NOT EXISTS harness_org_marketing.config_token (
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_org_marketing.directive_summaries (
    id bigint NOT NULL,
    directive_id text NOT NULL,
    source text DEFAULT 'ceo'::text NOT NULL,
    summary text NOT NULL,
    caller_slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_org_marketing.directive_summaries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_org_marketing.directive_summaries_id_seq OWNED BY harness_org_marketing.directive_summaries.id;
CREATE TABLE IF NOT EXISTS harness_org_marketing.executed_actions (
    action_id uuid NOT NULL,
    op text NOT NULL,
    caller_slug text NOT NULL,
    target_slug text,
    reason text,
    request jsonb NOT NULL,
    response jsonb NOT NULL,
    executed_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_org_marketing.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_slug text NOT NULL,
    to_slug text NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    body text,
    parent_message_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    to_role text,
    CONSTRAINT messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'acknowledged'::text, 'archived'::text])))
);
CREATE TABLE IF NOT EXISTS harness_org_marketing.supervisor_notes (
    id bigint NOT NULL,
    body text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_org_marketing.supervisor_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_org_marketing.supervisor_notes_id_seq OWNED BY harness_org_marketing.supervisor_notes.id;
ALTER TABLE ONLY harness_org_marketing.directive_summaries ALTER COLUMN id SET DEFAULT nextval('harness_org_marketing.directive_summaries_id_seq'::regclass);
ALTER TABLE ONLY harness_org_marketing.supervisor_notes ALTER COLUMN id SET DEFAULT nextval('harness_org_marketing.supervisor_notes_id_seq'::regclass);
DO $$
BEGIN
ALTER TABLE ONLY harness_org_marketing.config_token
    ADD CONSTRAINT config_token_pkey PRIMARY KEY (token);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_marketing.directive_summaries
    ADD CONSTRAINT directive_summaries_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_marketing.executed_actions
    ADD CONSTRAINT executed_actions_pkey PRIMARY KEY (action_id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_marketing.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_marketing.supervisor_notes
    ADD CONSTRAINT supervisor_notes_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS directive_summaries_directive_idx ON harness_org_marketing.directive_summaries USING btree (directive_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_caller_idx ON harness_org_marketing.executed_actions USING btree (caller_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_op_idx ON harness_org_marketing.executed_actions USING btree (op, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_target_idx ON harness_org_marketing.executed_actions USING btree (target_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS messages_from_idx ON harness_org_marketing.messages USING btree (from_slug, created_at);
CREATE INDEX IF NOT EXISTS messages_status_idx ON harness_org_marketing.messages USING btree (status, created_at);
CREATE INDEX IF NOT EXISTS messages_to_idx ON harness_org_marketing.messages USING btree (to_slug, status);
CREATE INDEX IF NOT EXISTS messages_to_role_idx ON harness_org_marketing.messages USING btree (to_slug, to_role) WHERE (to_role IS NOT NULL);

-- ─────────────────────────────────────── harness_org_rd ───
CREATE TABLE IF NOT EXISTS harness_org_rd.config_token (
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_org_rd.directive_summaries (
    id bigint NOT NULL,
    directive_id text NOT NULL,
    source text DEFAULT 'ceo'::text NOT NULL,
    summary text NOT NULL,
    caller_slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_org_rd.directive_summaries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_org_rd.directive_summaries_id_seq OWNED BY harness_org_rd.directive_summaries.id;
CREATE TABLE IF NOT EXISTS harness_org_rd.executed_actions (
    action_id uuid NOT NULL,
    op text NOT NULL,
    caller_slug text NOT NULL,
    target_slug text,
    reason text,
    request jsonb NOT NULL,
    response jsonb NOT NULL,
    executed_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_org_rd.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_slug text NOT NULL,
    to_slug text NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    body text,
    parent_message_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    to_role text,
    CONSTRAINT messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'acknowledged'::text, 'archived'::text])))
);
CREATE TABLE IF NOT EXISTS harness_org_rd.supervisor_notes (
    id bigint NOT NULL,
    body text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_org_rd.supervisor_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_org_rd.supervisor_notes_id_seq OWNED BY harness_org_rd.supervisor_notes.id;
ALTER TABLE ONLY harness_org_rd.directive_summaries ALTER COLUMN id SET DEFAULT nextval('harness_org_rd.directive_summaries_id_seq'::regclass);
ALTER TABLE ONLY harness_org_rd.supervisor_notes ALTER COLUMN id SET DEFAULT nextval('harness_org_rd.supervisor_notes_id_seq'::regclass);
DO $$
BEGIN
ALTER TABLE ONLY harness_org_rd.config_token
    ADD CONSTRAINT config_token_pkey PRIMARY KEY (token);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_rd.directive_summaries
    ADD CONSTRAINT directive_summaries_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_rd.executed_actions
    ADD CONSTRAINT executed_actions_pkey PRIMARY KEY (action_id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_rd.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_rd.supervisor_notes
    ADD CONSTRAINT supervisor_notes_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS directive_summaries_directive_idx ON harness_org_rd.directive_summaries USING btree (directive_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_caller_idx ON harness_org_rd.executed_actions USING btree (caller_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_op_idx ON harness_org_rd.executed_actions USING btree (op, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_target_idx ON harness_org_rd.executed_actions USING btree (target_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS messages_from_idx ON harness_org_rd.messages USING btree (from_slug, created_at);
CREATE INDEX IF NOT EXISTS messages_status_idx ON harness_org_rd.messages USING btree (status, created_at);
CREATE INDEX IF NOT EXISTS messages_to_idx ON harness_org_rd.messages USING btree (to_slug, status);
CREATE INDEX IF NOT EXISTS messages_to_role_idx ON harness_org_rd.messages USING btree (to_slug, to_role) WHERE (to_role IS NOT NULL);

-- ─────────────────────────────────────── harness_org_technology ───
CREATE TABLE IF NOT EXISTS harness_org_technology.config_token (
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_org_technology.directive_summaries (
    id bigint NOT NULL,
    directive_id text NOT NULL,
    source text DEFAULT 'ceo'::text NOT NULL,
    summary text NOT NULL,
    caller_slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_org_technology.directive_summaries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_org_technology.directive_summaries_id_seq OWNED BY harness_org_technology.directive_summaries.id;
CREATE TABLE IF NOT EXISTS harness_org_technology.executed_actions (
    action_id uuid NOT NULL,
    op text NOT NULL,
    caller_slug text NOT NULL,
    target_slug text,
    reason text,
    request jsonb NOT NULL,
    response jsonb NOT NULL,
    executed_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_org_technology.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_slug text NOT NULL,
    to_slug text NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    body text,
    parent_message_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    to_role text,
    CONSTRAINT messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'acknowledged'::text, 'archived'::text])))
);
CREATE TABLE IF NOT EXISTS harness_org_technology.supervisor_notes (
    id bigint NOT NULL,
    body text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_org_technology.supervisor_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_org_technology.supervisor_notes_id_seq OWNED BY harness_org_technology.supervisor_notes.id;
ALTER TABLE ONLY harness_org_technology.directive_summaries ALTER COLUMN id SET DEFAULT nextval('harness_org_technology.directive_summaries_id_seq'::regclass);
ALTER TABLE ONLY harness_org_technology.supervisor_notes ALTER COLUMN id SET DEFAULT nextval('harness_org_technology.supervisor_notes_id_seq'::regclass);
DO $$
BEGIN
ALTER TABLE ONLY harness_org_technology.config_token
    ADD CONSTRAINT config_token_pkey PRIMARY KEY (token);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_technology.directive_summaries
    ADD CONSTRAINT directive_summaries_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_technology.executed_actions
    ADD CONSTRAINT executed_actions_pkey PRIMARY KEY (action_id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_technology.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_org_technology.supervisor_notes
    ADD CONSTRAINT supervisor_notes_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS directive_summaries_directive_idx ON harness_org_technology.directive_summaries USING btree (directive_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_caller_idx ON harness_org_technology.executed_actions USING btree (caller_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_op_idx ON harness_org_technology.executed_actions USING btree (op, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_target_idx ON harness_org_technology.executed_actions USING btree (target_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS messages_from_idx ON harness_org_technology.messages USING btree (from_slug, created_at);
CREATE INDEX IF NOT EXISTS messages_status_idx ON harness_org_technology.messages USING btree (status, created_at);
CREATE INDEX IF NOT EXISTS messages_to_idx ON harness_org_technology.messages USING btree (to_slug, status);
CREATE INDEX IF NOT EXISTS messages_to_role_idx ON harness_org_technology.messages USING btree (to_slug, to_role) WHERE (to_role IS NOT NULL);

-- ─────────────────────────────────────── harness_restart ───
CREATE TABLE IF NOT EXISTS harness_restart.config_token (
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_restart.directive_summaries (
    id bigint NOT NULL,
    directive_id text NOT NULL,
    source text DEFAULT 'ceo'::text NOT NULL,
    summary text NOT NULL,
    caller_slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_restart.directive_summaries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_restart.directive_summaries_id_seq OWNED BY harness_restart.directive_summaries.id;
CREATE TABLE IF NOT EXISTS harness_restart.executed_actions (
    action_id uuid NOT NULL,
    op text NOT NULL,
    caller_slug text NOT NULL,
    target_slug text,
    reason text,
    request jsonb NOT NULL,
    response jsonb NOT NULL,
    executed_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_restart.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_slug text NOT NULL,
    to_slug text NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    body text,
    parent_message_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    to_role text,
    CONSTRAINT messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'acknowledged'::text, 'archived'::text])))
);
CREATE TABLE IF NOT EXISTS harness_restart.supervisor_notes (
    id bigint NOT NULL,
    body text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_restart.supervisor_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_restart.supervisor_notes_id_seq OWNED BY harness_restart.supervisor_notes.id;
ALTER TABLE ONLY harness_restart.directive_summaries ALTER COLUMN id SET DEFAULT nextval('harness_restart.directive_summaries_id_seq'::regclass);
ALTER TABLE ONLY harness_restart.supervisor_notes ALTER COLUMN id SET DEFAULT nextval('harness_restart.supervisor_notes_id_seq'::regclass);
DO $$
BEGIN
ALTER TABLE ONLY harness_restart.config_token
    ADD CONSTRAINT config_token_pkey PRIMARY KEY (token);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_restart.directive_summaries
    ADD CONSTRAINT directive_summaries_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_restart.executed_actions
    ADD CONSTRAINT executed_actions_pkey PRIMARY KEY (action_id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_restart.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_restart.supervisor_notes
    ADD CONSTRAINT supervisor_notes_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS directive_summaries_directive_idx ON harness_restart.directive_summaries USING btree (directive_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_caller_idx ON harness_restart.executed_actions USING btree (caller_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_op_idx ON harness_restart.executed_actions USING btree (op, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_target_idx ON harness_restart.executed_actions USING btree (target_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS messages_from_idx ON harness_restart.messages USING btree (from_slug, created_at);
CREATE INDEX IF NOT EXISTS messages_status_idx ON harness_restart.messages USING btree (status, created_at);
CREATE INDEX IF NOT EXISTS messages_to_idx ON harness_restart.messages USING btree (to_slug, status);
CREATE INDEX IF NOT EXISTS messages_to_role_idx ON harness_restart.messages USING btree (to_slug, to_role) WHERE (to_role IS NOT NULL);

-- ─────────────────────────────────────── harness_sheets ───
CREATE TABLE IF NOT EXISTS harness_sheets.config_token (
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_sheets.directive_summaries (
    id bigint NOT NULL,
    directive_id text NOT NULL,
    source text DEFAULT 'ceo'::text NOT NULL,
    summary text NOT NULL,
    caller_slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_sheets.directive_summaries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_sheets.directive_summaries_id_seq OWNED BY harness_sheets.directive_summaries.id;
CREATE TABLE IF NOT EXISTS harness_sheets.executed_actions (
    action_id uuid NOT NULL,
    op text NOT NULL,
    caller_slug text NOT NULL,
    target_slug text,
    reason text,
    request jsonb NOT NULL,
    response jsonb NOT NULL,
    executed_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_sheets.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_slug text NOT NULL,
    to_slug text NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    body text,
    parent_message_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    to_role text,
    CONSTRAINT messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'acknowledged'::text, 'archived'::text])))
);
CREATE TABLE IF NOT EXISTS harness_sheets.supervisor_notes (
    id bigint NOT NULL,
    body text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_sheets.supervisor_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_sheets.supervisor_notes_id_seq OWNED BY harness_sheets.supervisor_notes.id;
ALTER TABLE ONLY harness_sheets.directive_summaries ALTER COLUMN id SET DEFAULT nextval('harness_sheets.directive_summaries_id_seq'::regclass);
ALTER TABLE ONLY harness_sheets.supervisor_notes ALTER COLUMN id SET DEFAULT nextval('harness_sheets.supervisor_notes_id_seq'::regclass);
DO $$
BEGIN
ALTER TABLE ONLY harness_sheets.config_token
    ADD CONSTRAINT config_token_pkey PRIMARY KEY (token);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_sheets.directive_summaries
    ADD CONSTRAINT directive_summaries_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_sheets.executed_actions
    ADD CONSTRAINT executed_actions_pkey PRIMARY KEY (action_id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_sheets.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_sheets.supervisor_notes
    ADD CONSTRAINT supervisor_notes_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS directive_summaries_directive_idx ON harness_sheets.directive_summaries USING btree (directive_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_caller_idx ON harness_sheets.executed_actions USING btree (caller_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_op_idx ON harness_sheets.executed_actions USING btree (op, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_target_idx ON harness_sheets.executed_actions USING btree (target_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS messages_from_idx ON harness_sheets.messages USING btree (from_slug, created_at);
CREATE INDEX IF NOT EXISTS messages_status_idx ON harness_sheets.messages USING btree (status, created_at);
CREATE INDEX IF NOT EXISTS messages_to_idx ON harness_sheets.messages USING btree (to_slug, status);
CREATE INDEX IF NOT EXISTS messages_to_role_idx ON harness_sheets.messages USING btree (to_slug, to_role) WHERE (to_role IS NOT NULL);

-- ─────────────────────────────────────── harness_verify_multi ───
CREATE TABLE IF NOT EXISTS harness_verify_multi.config_token (
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_verify_multi.directive_summaries (
    id bigint NOT NULL,
    directive_id text NOT NULL,
    source text DEFAULT 'ceo'::text NOT NULL,
    summary text NOT NULL,
    caller_slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_verify_multi.directive_summaries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_verify_multi.directive_summaries_id_seq OWNED BY harness_verify_multi.directive_summaries.id;
CREATE TABLE IF NOT EXISTS harness_verify_multi.executed_actions (
    action_id uuid NOT NULL,
    op text NOT NULL,
    caller_slug text NOT NULL,
    target_slug text,
    reason text,
    request jsonb NOT NULL,
    response jsonb NOT NULL,
    executed_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_verify_multi.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_slug text NOT NULL,
    to_slug text NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    body text,
    parent_message_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    to_role text,
    CONSTRAINT messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'acknowledged'::text, 'archived'::text])))
);
CREATE TABLE IF NOT EXISTS harness_verify_multi.supervisor_notes (
    id bigint NOT NULL,
    body text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_verify_multi.supervisor_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_verify_multi.supervisor_notes_id_seq OWNED BY harness_verify_multi.supervisor_notes.id;
ALTER TABLE ONLY harness_verify_multi.directive_summaries ALTER COLUMN id SET DEFAULT nextval('harness_verify_multi.directive_summaries_id_seq'::regclass);
ALTER TABLE ONLY harness_verify_multi.supervisor_notes ALTER COLUMN id SET DEFAULT nextval('harness_verify_multi.supervisor_notes_id_seq'::regclass);
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi.config_token
    ADD CONSTRAINT config_token_pkey PRIMARY KEY (token);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi.directive_summaries
    ADD CONSTRAINT directive_summaries_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi.executed_actions
    ADD CONSTRAINT executed_actions_pkey PRIMARY KEY (action_id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi.supervisor_notes
    ADD CONSTRAINT supervisor_notes_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS directive_summaries_directive_idx ON harness_verify_multi.directive_summaries USING btree (directive_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_caller_idx ON harness_verify_multi.executed_actions USING btree (caller_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_op_idx ON harness_verify_multi.executed_actions USING btree (op, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_target_idx ON harness_verify_multi.executed_actions USING btree (target_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS messages_from_idx ON harness_verify_multi.messages USING btree (from_slug, created_at);
CREATE INDEX IF NOT EXISTS messages_status_idx ON harness_verify_multi.messages USING btree (status, created_at);
CREATE INDEX IF NOT EXISTS messages_to_idx ON harness_verify_multi.messages USING btree (to_slug, status);
CREATE INDEX IF NOT EXISTS messages_to_role_idx ON harness_verify_multi.messages USING btree (to_slug, to_role) WHERE (to_role IS NOT NULL);

-- ─────────────────────────────────────── harness_verify_multi_business ───
CREATE TABLE IF NOT EXISTS harness_verify_multi_business.config_token (
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_verify_multi_business.directive_summaries (
    id bigint NOT NULL,
    directive_id text NOT NULL,
    source text DEFAULT 'ceo'::text NOT NULL,
    summary text NOT NULL,
    caller_slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_verify_multi_business.directive_summaries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_verify_multi_business.directive_summaries_id_seq OWNED BY harness_verify_multi_business.directive_summaries.id;
CREATE TABLE IF NOT EXISTS harness_verify_multi_business.executed_actions (
    action_id uuid NOT NULL,
    op text NOT NULL,
    caller_slug text NOT NULL,
    target_slug text,
    reason text,
    request jsonb NOT NULL,
    response jsonb NOT NULL,
    executed_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_verify_multi_business.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_slug text NOT NULL,
    to_slug text NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    body text,
    parent_message_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    to_role text,
    CONSTRAINT messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'acknowledged'::text, 'archived'::text])))
);
CREATE TABLE IF NOT EXISTS harness_verify_multi_business.supervisor_notes (
    id bigint NOT NULL,
    body text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_verify_multi_business.supervisor_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_verify_multi_business.supervisor_notes_id_seq OWNED BY harness_verify_multi_business.supervisor_notes.id;
ALTER TABLE ONLY harness_verify_multi_business.directive_summaries ALTER COLUMN id SET DEFAULT nextval('harness_verify_multi_business.directive_summaries_id_seq'::regclass);
ALTER TABLE ONLY harness_verify_multi_business.supervisor_notes ALTER COLUMN id SET DEFAULT nextval('harness_verify_multi_business.supervisor_notes_id_seq'::regclass);
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_business.config_token
    ADD CONSTRAINT config_token_pkey PRIMARY KEY (token);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_business.directive_summaries
    ADD CONSTRAINT directive_summaries_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_business.executed_actions
    ADD CONSTRAINT executed_actions_pkey PRIMARY KEY (action_id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_business.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_business.supervisor_notes
    ADD CONSTRAINT supervisor_notes_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS directive_summaries_directive_idx ON harness_verify_multi_business.directive_summaries USING btree (directive_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_caller_idx ON harness_verify_multi_business.executed_actions USING btree (caller_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_op_idx ON harness_verify_multi_business.executed_actions USING btree (op, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_target_idx ON harness_verify_multi_business.executed_actions USING btree (target_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS messages_from_idx ON harness_verify_multi_business.messages USING btree (from_slug, created_at);
CREATE INDEX IF NOT EXISTS messages_status_idx ON harness_verify_multi_business.messages USING btree (status, created_at);
CREATE INDEX IF NOT EXISTS messages_to_idx ON harness_verify_multi_business.messages USING btree (to_slug, status);
CREATE INDEX IF NOT EXISTS messages_to_role_idx ON harness_verify_multi_business.messages USING btree (to_slug, to_role) WHERE (to_role IS NOT NULL);

-- ─────────────────────────────────────── harness_verify_multi_coordination ───
CREATE TABLE IF NOT EXISTS harness_verify_multi_coordination.config_token (
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_verify_multi_coordination.directive_summaries (
    id bigint NOT NULL,
    directive_id text NOT NULL,
    source text DEFAULT 'ceo'::text NOT NULL,
    summary text NOT NULL,
    caller_slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_verify_multi_coordination.directive_summaries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_verify_multi_coordination.directive_summaries_id_seq OWNED BY harness_verify_multi_coordination.directive_summaries.id;
CREATE TABLE IF NOT EXISTS harness_verify_multi_coordination.executed_actions (
    action_id uuid NOT NULL,
    op text NOT NULL,
    caller_slug text NOT NULL,
    target_slug text,
    reason text,
    request jsonb NOT NULL,
    response jsonb NOT NULL,
    executed_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_verify_multi_coordination.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_slug text NOT NULL,
    to_slug text NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    body text,
    parent_message_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    to_role text,
    CONSTRAINT messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'acknowledged'::text, 'archived'::text])))
);
CREATE TABLE IF NOT EXISTS harness_verify_multi_coordination.supervisor_notes (
    id bigint NOT NULL,
    body text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_verify_multi_coordination.supervisor_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_verify_multi_coordination.supervisor_notes_id_seq OWNED BY harness_verify_multi_coordination.supervisor_notes.id;
ALTER TABLE ONLY harness_verify_multi_coordination.directive_summaries ALTER COLUMN id SET DEFAULT nextval('harness_verify_multi_coordination.directive_summaries_id_seq'::regclass);
ALTER TABLE ONLY harness_verify_multi_coordination.supervisor_notes ALTER COLUMN id SET DEFAULT nextval('harness_verify_multi_coordination.supervisor_notes_id_seq'::regclass);
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_coordination.config_token
    ADD CONSTRAINT config_token_pkey PRIMARY KEY (token);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_coordination.directive_summaries
    ADD CONSTRAINT directive_summaries_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_coordination.executed_actions
    ADD CONSTRAINT executed_actions_pkey PRIMARY KEY (action_id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_coordination.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_coordination.supervisor_notes
    ADD CONSTRAINT supervisor_notes_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS directive_summaries_directive_idx ON harness_verify_multi_coordination.directive_summaries USING btree (directive_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_caller_idx ON harness_verify_multi_coordination.executed_actions USING btree (caller_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_op_idx ON harness_verify_multi_coordination.executed_actions USING btree (op, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_target_idx ON harness_verify_multi_coordination.executed_actions USING btree (target_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS messages_from_idx ON harness_verify_multi_coordination.messages USING btree (from_slug, created_at);
CREATE INDEX IF NOT EXISTS messages_status_idx ON harness_verify_multi_coordination.messages USING btree (status, created_at);
CREATE INDEX IF NOT EXISTS messages_to_idx ON harness_verify_multi_coordination.messages USING btree (to_slug, status);
CREATE INDEX IF NOT EXISTS messages_to_role_idx ON harness_verify_multi_coordination.messages USING btree (to_slug, to_role) WHERE (to_role IS NOT NULL);

-- ─────────────────────────────────────── harness_verify_multi_management ───
CREATE TABLE IF NOT EXISTS harness_verify_multi_management.config_token (
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_verify_multi_management.directive_summaries (
    id bigint NOT NULL,
    directive_id text NOT NULL,
    source text DEFAULT 'ceo'::text NOT NULL,
    summary text NOT NULL,
    caller_slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_verify_multi_management.directive_summaries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_verify_multi_management.directive_summaries_id_seq OWNED BY harness_verify_multi_management.directive_summaries.id;
CREATE TABLE IF NOT EXISTS harness_verify_multi_management.executed_actions (
    action_id uuid NOT NULL,
    op text NOT NULL,
    caller_slug text NOT NULL,
    target_slug text,
    reason text,
    request jsonb NOT NULL,
    response jsonb NOT NULL,
    executed_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_verify_multi_management.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_slug text NOT NULL,
    to_slug text NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    body text,
    parent_message_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    to_role text,
    CONSTRAINT messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'acknowledged'::text, 'archived'::text])))
);
CREATE TABLE IF NOT EXISTS harness_verify_multi_management.supervisor_notes (
    id bigint NOT NULL,
    body text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_verify_multi_management.supervisor_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_verify_multi_management.supervisor_notes_id_seq OWNED BY harness_verify_multi_management.supervisor_notes.id;
ALTER TABLE ONLY harness_verify_multi_management.directive_summaries ALTER COLUMN id SET DEFAULT nextval('harness_verify_multi_management.directive_summaries_id_seq'::regclass);
ALTER TABLE ONLY harness_verify_multi_management.supervisor_notes ALTER COLUMN id SET DEFAULT nextval('harness_verify_multi_management.supervisor_notes_id_seq'::regclass);
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_management.config_token
    ADD CONSTRAINT config_token_pkey PRIMARY KEY (token);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_management.directive_summaries
    ADD CONSTRAINT directive_summaries_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_management.executed_actions
    ADD CONSTRAINT executed_actions_pkey PRIMARY KEY (action_id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_management.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_management.supervisor_notes
    ADD CONSTRAINT supervisor_notes_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS directive_summaries_directive_idx ON harness_verify_multi_management.directive_summaries USING btree (directive_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_caller_idx ON harness_verify_multi_management.executed_actions USING btree (caller_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_op_idx ON harness_verify_multi_management.executed_actions USING btree (op, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_target_idx ON harness_verify_multi_management.executed_actions USING btree (target_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS messages_from_idx ON harness_verify_multi_management.messages USING btree (from_slug, created_at);
CREATE INDEX IF NOT EXISTS messages_status_idx ON harness_verify_multi_management.messages USING btree (status, created_at);
CREATE INDEX IF NOT EXISTS messages_to_idx ON harness_verify_multi_management.messages USING btree (to_slug, status);
CREATE INDEX IF NOT EXISTS messages_to_role_idx ON harness_verify_multi_management.messages USING btree (to_slug, to_role) WHERE (to_role IS NOT NULL);

-- ─────────────────────────────────────── harness_verify_multi_marketing ───
CREATE TABLE IF NOT EXISTS harness_verify_multi_marketing.config_token (
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_verify_multi_marketing.directive_summaries (
    id bigint NOT NULL,
    directive_id text NOT NULL,
    source text DEFAULT 'ceo'::text NOT NULL,
    summary text NOT NULL,
    caller_slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_verify_multi_marketing.directive_summaries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_verify_multi_marketing.directive_summaries_id_seq OWNED BY harness_verify_multi_marketing.directive_summaries.id;
CREATE TABLE IF NOT EXISTS harness_verify_multi_marketing.executed_actions (
    action_id uuid NOT NULL,
    op text NOT NULL,
    caller_slug text NOT NULL,
    target_slug text,
    reason text,
    request jsonb NOT NULL,
    response jsonb NOT NULL,
    executed_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_verify_multi_marketing.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_slug text NOT NULL,
    to_slug text NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    body text,
    parent_message_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    to_role text,
    CONSTRAINT messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'acknowledged'::text, 'archived'::text])))
);
CREATE TABLE IF NOT EXISTS harness_verify_multi_marketing.supervisor_notes (
    id bigint NOT NULL,
    body text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_verify_multi_marketing.supervisor_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_verify_multi_marketing.supervisor_notes_id_seq OWNED BY harness_verify_multi_marketing.supervisor_notes.id;
ALTER TABLE ONLY harness_verify_multi_marketing.directive_summaries ALTER COLUMN id SET DEFAULT nextval('harness_verify_multi_marketing.directive_summaries_id_seq'::regclass);
ALTER TABLE ONLY harness_verify_multi_marketing.supervisor_notes ALTER COLUMN id SET DEFAULT nextval('harness_verify_multi_marketing.supervisor_notes_id_seq'::regclass);
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_marketing.config_token
    ADD CONSTRAINT config_token_pkey PRIMARY KEY (token);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_marketing.directive_summaries
    ADD CONSTRAINT directive_summaries_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_marketing.executed_actions
    ADD CONSTRAINT executed_actions_pkey PRIMARY KEY (action_id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_marketing.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_marketing.supervisor_notes
    ADD CONSTRAINT supervisor_notes_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS directive_summaries_directive_idx ON harness_verify_multi_marketing.directive_summaries USING btree (directive_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_caller_idx ON harness_verify_multi_marketing.executed_actions USING btree (caller_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_op_idx ON harness_verify_multi_marketing.executed_actions USING btree (op, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_target_idx ON harness_verify_multi_marketing.executed_actions USING btree (target_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS messages_from_idx ON harness_verify_multi_marketing.messages USING btree (from_slug, created_at);
CREATE INDEX IF NOT EXISTS messages_status_idx ON harness_verify_multi_marketing.messages USING btree (status, created_at);
CREATE INDEX IF NOT EXISTS messages_to_idx ON harness_verify_multi_marketing.messages USING btree (to_slug, status);
CREATE INDEX IF NOT EXISTS messages_to_role_idx ON harness_verify_multi_marketing.messages USING btree (to_slug, to_role) WHERE (to_role IS NOT NULL);

-- ─────────────────────────────────────── harness_verify_multi_rd ───
CREATE TABLE IF NOT EXISTS harness_verify_multi_rd.config_token (
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_verify_multi_rd.directive_summaries (
    id bigint NOT NULL,
    directive_id text NOT NULL,
    source text DEFAULT 'ceo'::text NOT NULL,
    summary text NOT NULL,
    caller_slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_verify_multi_rd.directive_summaries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_verify_multi_rd.directive_summaries_id_seq OWNED BY harness_verify_multi_rd.directive_summaries.id;
CREATE TABLE IF NOT EXISTS harness_verify_multi_rd.executed_actions (
    action_id uuid NOT NULL,
    op text NOT NULL,
    caller_slug text NOT NULL,
    target_slug text,
    reason text,
    request jsonb NOT NULL,
    response jsonb NOT NULL,
    executed_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_verify_multi_rd.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_slug text NOT NULL,
    to_slug text NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    body text,
    parent_message_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    to_role text,
    CONSTRAINT messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'acknowledged'::text, 'archived'::text])))
);
CREATE TABLE IF NOT EXISTS harness_verify_multi_rd.supervisor_notes (
    id bigint NOT NULL,
    body text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_verify_multi_rd.supervisor_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_verify_multi_rd.supervisor_notes_id_seq OWNED BY harness_verify_multi_rd.supervisor_notes.id;
ALTER TABLE ONLY harness_verify_multi_rd.directive_summaries ALTER COLUMN id SET DEFAULT nextval('harness_verify_multi_rd.directive_summaries_id_seq'::regclass);
ALTER TABLE ONLY harness_verify_multi_rd.supervisor_notes ALTER COLUMN id SET DEFAULT nextval('harness_verify_multi_rd.supervisor_notes_id_seq'::regclass);
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_rd.config_token
    ADD CONSTRAINT config_token_pkey PRIMARY KEY (token);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_rd.directive_summaries
    ADD CONSTRAINT directive_summaries_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_rd.executed_actions
    ADD CONSTRAINT executed_actions_pkey PRIMARY KEY (action_id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_rd.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_rd.supervisor_notes
    ADD CONSTRAINT supervisor_notes_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS directive_summaries_directive_idx ON harness_verify_multi_rd.directive_summaries USING btree (directive_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_caller_idx ON harness_verify_multi_rd.executed_actions USING btree (caller_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_op_idx ON harness_verify_multi_rd.executed_actions USING btree (op, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_target_idx ON harness_verify_multi_rd.executed_actions USING btree (target_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS messages_from_idx ON harness_verify_multi_rd.messages USING btree (from_slug, created_at);
CREATE INDEX IF NOT EXISTS messages_status_idx ON harness_verify_multi_rd.messages USING btree (status, created_at);
CREATE INDEX IF NOT EXISTS messages_to_idx ON harness_verify_multi_rd.messages USING btree (to_slug, status);
CREATE INDEX IF NOT EXISTS messages_to_role_idx ON harness_verify_multi_rd.messages USING btree (to_slug, to_role) WHERE (to_role IS NOT NULL);

-- ─────────────────────────────────────── harness_verify_multi_technology ───
CREATE TABLE IF NOT EXISTS harness_verify_multi_technology.config_token (
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_verify_multi_technology.directive_summaries (
    id bigint NOT NULL,
    directive_id text NOT NULL,
    source text DEFAULT 'ceo'::text NOT NULL,
    summary text NOT NULL,
    caller_slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_verify_multi_technology.directive_summaries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_verify_multi_technology.directive_summaries_id_seq OWNED BY harness_verify_multi_technology.directive_summaries.id;
CREATE TABLE IF NOT EXISTS harness_verify_multi_technology.executed_actions (
    action_id uuid NOT NULL,
    op text NOT NULL,
    caller_slug text NOT NULL,
    target_slug text,
    reason text,
    request jsonb NOT NULL,
    response jsonb NOT NULL,
    executed_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_verify_multi_technology.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_slug text NOT NULL,
    to_slug text NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    body text,
    parent_message_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    to_role text,
    CONSTRAINT messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'acknowledged'::text, 'archived'::text])))
);
CREATE TABLE IF NOT EXISTS harness_verify_multi_technology.supervisor_notes (
    id bigint NOT NULL,
    body text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS harness_verify_multi_technology.supervisor_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE harness_verify_multi_technology.supervisor_notes_id_seq OWNED BY harness_verify_multi_technology.supervisor_notes.id;
ALTER TABLE ONLY harness_verify_multi_technology.directive_summaries ALTER COLUMN id SET DEFAULT nextval('harness_verify_multi_technology.directive_summaries_id_seq'::regclass);
ALTER TABLE ONLY harness_verify_multi_technology.supervisor_notes ALTER COLUMN id SET DEFAULT nextval('harness_verify_multi_technology.supervisor_notes_id_seq'::regclass);
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_technology.config_token
    ADD CONSTRAINT config_token_pkey PRIMARY KEY (token);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_technology.directive_summaries
    ADD CONSTRAINT directive_summaries_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_technology.executed_actions
    ADD CONSTRAINT executed_actions_pkey PRIMARY KEY (action_id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_technology.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
DO $$
BEGIN
ALTER TABLE ONLY harness_verify_multi_technology.supervisor_notes
    ADD CONSTRAINT supervisor_notes_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS directive_summaries_directive_idx ON harness_verify_multi_technology.directive_summaries USING btree (directive_id, created_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_caller_idx ON harness_verify_multi_technology.executed_actions USING btree (caller_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_op_idx ON harness_verify_multi_technology.executed_actions USING btree (op, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_target_idx ON harness_verify_multi_technology.executed_actions USING btree (target_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS messages_from_idx ON harness_verify_multi_technology.messages USING btree (from_slug, created_at);
CREATE INDEX IF NOT EXISTS messages_status_idx ON harness_verify_multi_technology.messages USING btree (status, created_at);
CREATE INDEX IF NOT EXISTS messages_to_idx ON harness_verify_multi_technology.messages USING btree (to_slug, status);
CREATE INDEX IF NOT EXISTS messages_to_role_idx ON harness_verify_multi_technology.messages USING btree (to_slug, to_role) WHERE (to_role IS NOT NULL);

-- harness_shared.projects: add parent_slug column missing on Hetzner.
ALTER TABLE harness_shared.projects ADD COLUMN IF NOT EXISTS parent_slug text;
CREATE INDEX IF NOT EXISTS projects_parent_idx ON harness_shared.projects (parent_slug);
