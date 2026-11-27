# One-time (safe to re-run) setup of the development database login and databases.
# Windows version of create-dev-db-role.sh.
# Asks for the password of the PostgreSQL 'postgres' account chosen during installation.
# The cl_dev password is read from .local/dev-db-password (git-ignored) and never printed.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')
$psql = 'C:\Program Files\PostgreSQL\17\bin\psql.exe'
if (-not (Test-Path .local\dev-db-password)) { throw 'Missing .local/dev-db-password' }
$password = (Get-Content .local\dev-db-password -Raw).Trim()

$sql = @'
\getenv pw CL_DEV_PASSWORD
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cl_dev')
            THEN 'Login cl_dev already existed: resetting its password.'
            ELSE 'Creating login cl_dev.' END AS step \gset
\echo :step
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cl_dev')
            THEN 'ALTER ROLE cl_dev LOGIN CREATEDB CREATEROLE PASSWORD ' || quote_literal(:'pw')
            ELSE 'CREATE ROLE cl_dev LOGIN CREATEDB CREATEROLE PASSWORD ' || quote_literal(:'pw') END \gexec
-- Let cl_dev act as the roles the migrations create (demo-shop connects as cl_app).
ALTER ROLE cl_dev SET createrole_self_grant = 'set';
SELECT format('GRANT %I TO cl_dev WITH INHERIT FALSE, SET TRUE', rolname)
  FROM pg_roles WHERE rolname IN ('cl_app', 'cl_readonly') \gexec
SELECT 'CREATE DATABASE coffee_lounge_dev OWNER cl_dev'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'coffee_lounge_dev') \gexec
SELECT 'CREATE DATABASE coffee_lounge_test OWNER cl_dev'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'coffee_lounge_test') \gexec
'@

$env:CL_DEV_PASSWORD = $password
$sql | & $psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -q
if ($LASTEXITCODE -ne 0) { throw 'Database setup failed.' }
Remove-Item Env:CL_DEV_PASSWORD

# Prove the login works with the stored password before reporting success.
$env:PGPASSWORD = $password
& $psql -h localhost -U cl_dev -d coffee_lounge_test -Atc "SELECT 'Verified: logged in as ' || current_user || ' to ' || current_database()"
Remove-Item Env:PGPASSWORD
