--
-- PostgreSQL database dump
--


-- Dumped from database version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)




--
-- Name: autoloop_state; Type: TABLE; Schema: harness_shared; Owner: -
--

CREATE TABLE IF NOT EXISTS harness_shared.autoloop_state (
    harness_slug text NOT NULL,
    role text DEFAULT 'director'::text NOT NULL,
    last_fired_at timestamp with time zone DEFAULT now() NOT NULL,
    last_status text,
    consecutive_errors integer DEFAULT 0 NOT NULL
);


--
-- Name: token_index; Type: TABLE; Schema: harness_shared; Owner: -
--

CREATE TABLE IF NOT EXISTS harness_shared.token_index (
    token text NOT NULL,
    harness_slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: autoloop_state autoloop_state_pkey; Type: CONSTRAINT; Schema: harness_shared; Owner: -
--

DO $$
BEGIN
ALTER TABLE ONLY harness_shared.autoloop_state
    ADD CONSTRAINT autoloop_state_pkey PRIMARY KEY (harness_slug, role);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;


--
-- Name: token_index token_index_harness_slug_key; Type: CONSTRAINT; Schema: harness_shared; Owner: -
--

DO $$
BEGIN
ALTER TABLE ONLY harness_shared.token_index
    ADD CONSTRAINT token_index_harness_slug_key UNIQUE (harness_slug);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;


--
-- Name: token_index token_index_pkey; Type: CONSTRAINT; Schema: harness_shared; Owner: -
--

DO $$
BEGIN
ALTER TABLE ONLY harness_shared.token_index
    ADD CONSTRAINT token_index_pkey PRIMARY KEY (token);
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL;
END $$;


--
-- PostgreSQL database dump complete
--


