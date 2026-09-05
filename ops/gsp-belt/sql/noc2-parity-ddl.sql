--
-- PostgreSQL database dump
--

\restrict i1ZB9Rl9BjMeoVYgdJSBjCoH8E8OSvrpekY2q1jemhVyA22n8olQ3yndbrFesZi

-- Dumped from database version 17.10 (Debian 17.10-1.pgdg12+1)
-- Dumped by pg_dump version 17.10 (Debian 17.10-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: daemon_routing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daemon_routing (
    agent_id uuid NOT NULL,
    daemon_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: qc_review_card; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qc_review_card (
    id bigint NOT NULL,
    issue_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    builder_model text,
    verdict character varying(10),
    failure_categories text,
    evidence_checklist jsonb,
    "timestamp" timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT qc_review_card_verdict_check CHECK (((verdict)::text = ANY (ARRAY[('pass'::character varying)::text, ('fail'::character varying)::text])))
);


--
-- Name: qc_review_card_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.qc_review_card_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: qc_review_card_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.qc_review_card_id_seq OWNED BY public.qc_review_card.id;


--
-- Name: qc_verdict; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qc_verdict (
    id integer NOT NULL,
    issue_id uuid NOT NULL,
    checker_id uuid NOT NULL,
    checker_name text NOT NULL,
    verdict text NOT NULL,
    work_product_md5 text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT qc_verdict_verdict_check CHECK ((verdict = ANY (ARRAY['PASS'::text, 'FAIL'::text, 'NEEDS_WORK'::text]))),
    CONSTRAINT qc_verdict_work_product_md5_check CHECK (work_product_md5 ~* '^[0-9a-f]{32}$')
);


--
-- Name: qc_verdict_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.qc_verdict_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: qc_verdict_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.qc_verdict_id_seq OWNED BY public.qc_verdict.id;


--
-- Name: relay_run_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.relay_run_log (
    id integer NOT NULL,
    issue_id uuid NOT NULL,
    from_stage text NOT NULL,
    to_stage text,
    agent_id uuid,
    task_id uuid,
    status text DEFAULT 'pending'::text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT relay_run_log_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: relay_run_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.relay_run_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: relay_run_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.relay_run_log_id_seq OWNED BY public.relay_run_log.id;


--
-- Name: relay_stage_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.relay_stage_config (
    id integer NOT NULL,
    stage_name text NOT NULL,
    next_stage text,
    agent_id uuid,
    agent_name text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: relay_stage_config_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.relay_stage_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: relay_stage_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.relay_stage_config_id_seq OWNED BY public.relay_stage_config.id;


--
-- Name: workflow_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_state (
    id integer NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    color text DEFAULT '#808080'::text NOT NULL,
    "position" integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived boolean DEFAULT false NOT NULL
);


--
-- Name: workflow_state_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workflow_state_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workflow_state_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workflow_state_id_seq OWNED BY public.workflow_state.id;


--
-- Name: qc_review_card id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_review_card ALTER COLUMN id SET DEFAULT nextval('public.qc_review_card_id_seq'::regclass);


--
-- Name: qc_verdict id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_verdict ALTER COLUMN id SET DEFAULT nextval('public.qc_verdict_id_seq'::regclass);


--
-- Name: relay_run_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relay_run_log ALTER COLUMN id SET DEFAULT nextval('public.relay_run_log_id_seq'::regclass);


--
-- Name: relay_stage_config id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relay_stage_config ALTER COLUMN id SET DEFAULT nextval('public.relay_stage_config_id_seq'::regclass);


--
-- Name: workflow_state id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_state ALTER COLUMN id SET DEFAULT nextval('public.workflow_state_id_seq'::regclass);


--
-- Name: daemon_routing daemon_routing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daemon_routing
    ADD CONSTRAINT daemon_routing_pkey PRIMARY KEY (agent_id);


--
-- Name: qc_review_card qc_review_card_issue_id_timestamp_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_review_card
    ADD CONSTRAINT qc_review_card_issue_id_timestamp_key UNIQUE (issue_id, "timestamp");


--
-- Name: qc_review_card qc_review_card_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_review_card
    ADD CONSTRAINT qc_review_card_pkey PRIMARY KEY (id);


--
-- Name: qc_verdict qc_verdict_issue_id_created_at_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_verdict
    ADD CONSTRAINT qc_verdict_issue_id_created_at_key UNIQUE (issue_id, created_at);


--
-- Name: qc_verdict qc_verdict_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_verdict
    ADD CONSTRAINT qc_verdict_pkey PRIMARY KEY (id);


--
-- Name: relay_run_log relay_run_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relay_run_log
    ADD CONSTRAINT relay_run_log_pkey PRIMARY KEY (id);


--
-- Name: relay_stage_config relay_stage_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relay_stage_config
    ADD CONSTRAINT relay_stage_config_pkey PRIMARY KEY (id);


--
-- Name: relay_stage_config relay_stage_config_stage_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relay_stage_config
    ADD CONSTRAINT relay_stage_config_stage_name_key UNIQUE (stage_name);


--
-- Name: workflow_state workflow_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_state
    ADD CONSTRAINT workflow_state_pkey PRIMARY KEY (id);


--
-- Name: workflow_state workflow_state_workspace_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_state
    ADD CONSTRAINT workflow_state_workspace_id_name_key UNIQUE (workspace_id, name);


--
-- Name: idx_qc_review_card_issue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qc_review_card_issue ON public.qc_review_card USING btree (issue_id);


--
-- Name: idx_qc_review_card_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qc_review_card_timestamp ON public.qc_review_card USING btree ("timestamp" DESC);


--
-- Name: idx_qc_review_card_verdict; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qc_review_card_verdict ON public.qc_review_card USING btree (verdict);


--
-- Name: idx_qc_verdict_checker; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qc_verdict_checker ON public.qc_verdict USING btree (checker_id);


--
-- Name: idx_qc_verdict_issue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qc_verdict_issue ON public.qc_verdict USING btree (issue_id);


--
-- Name: idx_qc_verdict_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qc_verdict_status ON public.qc_verdict USING btree (verdict);


--
-- Name: idx_relay_run_log_issue_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_relay_run_log_issue_id ON public.relay_run_log USING btree (issue_id);


--
-- Name: idx_workflow_state_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_state_workspace ON public.workflow_state USING btree (workspace_id);


--
-- Name: idx_workflow_state_workspace_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_state_workspace_name ON public.workflow_state USING btree (workspace_id, name);


--
-- Name: qc_verdict_one_per_issue; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX qc_verdict_one_per_issue ON public.qc_verdict USING btree (issue_id);


--
-- Name: qc_review_card qc_review_card_issue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qc_review_card
    ADD CONSTRAINT qc_review_card_issue_id_fkey FOREIGN KEY (issue_id) REFERENCES public.issue(id) ON DELETE CASCADE;


--
-- Name: relay_run_log relay_run_log_issue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relay_run_log
    ADD CONSTRAINT relay_run_log_issue_id_fkey FOREIGN KEY (issue_id) REFERENCES public.issue(id) ON DELETE CASCADE;


--
-- Name: workflow_state workflow_state_workspace_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_state
    ADD CONSTRAINT workflow_state_workspace_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspace(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict i1ZB9Rl9BjMeoVYgdJSBjCoH8E8OSvrpekY2q1jemhVyA22n8olQ3yndbrFesZi

CREATE TABLE IF NOT EXISTS public.cicd_deploy_attempt (
    issue_id uuid PRIMARY KEY REFERENCES public.issue(id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('running','advanced','held','failed')),
    reason text,
    started_at timestamp with time zone,
    last_attempt_at timestamp with time zone,
    lease_until timestamp with time zone,
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
