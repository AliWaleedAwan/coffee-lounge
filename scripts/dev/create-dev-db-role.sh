#!/bin/sh
# One-time (safe to re-run) setup of the development database login and databases.
# Asks for the password of the PostgreSQL 'postgres' account chosen during installation.
# The cl_dev password is read from .local/dev-db-password (git-ignored) and never printed.
set -eu
cd "$(dirname "$0")/../.."
BIN=/Library/PostgreSQL/17/bin
[ -f .local/dev-db-password ] || { echo "Missing .local/dev-db-password" >&2; exit 1; }

"$BIN/psql" -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
\set pw `tr -d '\n' < .local/dev-db-password`
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cl_dev')
            THEN 'Login cl_dev already existed: resetting its password.'
            ELSE 'Creating login cl_dev.' END AS step \gset
\echo :step
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cl_dev')
            THEN 'ALTER ROLE cl_dev LOGIN CREATEDB CREATEROLE PASSWORD ' || quote_literal(:'pw')
            ELSE 'CREATE ROLE cl_dev LOGIN CREATEDB CREATEROLE PASSWORD ' || quote_literal(:'pw') END \gexec
SELECT 'CREATE DATABASE coffee_lounge_dev OWNER cl_dev'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'coffee_lounge_dev') \gexec
SELECT 'CREATE DATABASE coffee_lounge_test OWNER cl_dev'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'coffee_lounge_test') \gexec
SQL

# Prove the login works with the stored password before reporting success.
PGPASSWORD="$(tr -d '\n' < .local/dev-db-password)" "$BIN/psql" -h localhost -U cl_dev -d coffee_lounge_test -Atc \
  "SELECT 'Verified: logged in as ' || current_user || ' to ' || current_database()"
