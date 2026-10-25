-- 0006 Access for the installed services, which log in as a member of cl_app, never as
-- the schema owner (DATABASE.md §12, WINDOWS_DEPLOYMENT.md §2).

-- They check the schema version at startup: they may read, never change, that record.
GRANT USAGE ON SCHEMA cl_meta TO cl_app, cl_readonly;
GRANT SELECT ON cl_meta.schema_migrations TO cl_app, cl_readonly;

-- The job queue (graphile-worker) protects its tables with row-level security that only
-- their owner passes. cl_jobs owns that schema (db:migrate hands it over after each
-- job-queue migration); cl_app is a member, so the API can queue jobs and the worker can
-- run them. This gives no extra rights on the business schema cl.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cl_jobs') THEN
    CREATE ROLE cl_jobs NOLOGIN;
  END IF;
END $$;
GRANT cl_jobs TO cl_app;
-- The login running migrations manages the job-queue schema too.
GRANT cl_jobs TO CURRENT_USER;
