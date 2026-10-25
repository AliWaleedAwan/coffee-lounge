-- 0005 Worker heartbeat (WINDOWS_DEPLOYMENT.md §2: the health page shows "worker down"
-- after 60 s without a heartbeat). One row per worker process name, updated every 15 s.

CREATE TABLE cl.worker_heartbeats (
  worker_name text PRIMARY KEY,
  pid         int  NOT NULL,
  version     text NOT NULL,
  started_at  timestamptz NOT NULL,
  beat_at     timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

GRANT UPDATE ON cl.worker_heartbeats TO cl_app;
