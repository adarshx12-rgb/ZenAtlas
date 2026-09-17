-- The watchdog (src/watchdog.ts) keeps its latest verdict on each dependency the search engine relies on: services,
-- external APIs, AI models, runtime tools and packages. status only changes once an observation repeats (see the
-- check's confirm count); observed and streak hold the latest raw result.
CREATE TABLE dependency_checks (
 name text PRIMARY KEY CHECK(name ~ '^[a-z0-9_]{1,64}$'),
 label text NOT NULL,
 category text NOT NULL,
 status text NOT NULL CHECK(status IN ('ok','warning','failing','disabled')),
 observed text NOT NULL CHECK(observed IN ('ok','warning','failing','disabled')),
 streak integer NOT NULL DEFAULT 1 CHECK(streak>=1),
 code text NOT NULL CHECK(char_length(code) BETWEEN 1 AND 100),
 summary text NOT NULL CHECK(char_length(summary) BETWEEN 1 AND 2000),
 details jsonb NOT NULL DEFAULT '{}',
 latency_ms integer NOT NULL CHECK(latency_ms>=0),
 checked_at timestamptz NOT NULL DEFAULT now(),
 changed_at timestamptz NOT NULL DEFAULT now(),
 next_at timestamptz NOT NULL
);
CREATE TABLE dependency_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 name text NOT NULL,
 from_status text,
 to_status text NOT NULL,
 code text NOT NULL,
 summary text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dependency_events_created_idx ON dependency_events(created_at DESC);
-- Each long-running process reports here, so a stopped or stuck worker is noticed even though nothing crashed.
CREATE TABLE service_heartbeats (
 service text PRIMARY KEY CHECK(service IN ('api','worker','watchdog')),
 pid integer NOT NULL,
 host text NOT NULL,
 started_at timestamptz NOT NULL,
 beat_at timestamptz NOT NULL DEFAULT now(),
 details jsonb NOT NULL DEFAULT '{}'
);
REVOKE ALL ON dependency_checks,dependency_events,service_heartbeats FROM PUBLIC;
