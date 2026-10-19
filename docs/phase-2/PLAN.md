# Phase 2 — Foundation Build Plan

| | |
|---|---|
| Started | 19 Oct 2026, after Gate G1 approval |
| Goal | The platform every later phase builds on: repository, database migrations for the foundation tables, authentication, devices, permissions, idempotency, audit, live updates, background jobs, health checks, the web app shell, the Electron shell, Windows service skeleton and the test harness |
| Exit criteria | TEST_PLAN.md §4 (Phase 2 row): unit/integration/API tests green; idempotency, SSE and auth tests pass; services start on a clean Windows machine (AT-47); migrations apply to an empty database |
| Not in Phase 2 | Menu, ordering, billing, stock (Phases 3–4). Their tables are added by migrations in their own phases, exactly as specified in DATABASE.md |

## 1. Development toolchain (needed before any code runs)

| Tool | Version | Why | Install (by the owner/developer on this Mac) |
|---|---|---|---|
| Apple Command Line Tools | current | `git`, compilers for native modules (argon2) | Terminal: `xcode-select --install` and accept the dialog |
| Node.js | **24 LTS** | Runtime for server, worker, build tools | Installer from nodejs.org (macOS .pkg, LTS) |
| pnpm | via Corepack (ships with Node) | Workspace package manager | Nothing to install: the project runs `corepack pnpm …` |
| PostgreSQL | **17** | Development and test database (same major version as the shop's server) | Postgres.app from postgresapp.com, choosing the PostgreSQL 17 build |

Windows-specific work (services, installer, spooler printing, clock check) must be proven on Windows. This needs either **a GitHub repository with a Windows CI runner** or **a Windows 10 x64 test PC/VM**. Decision needed before step 2.8.

## 2. Build order

| Step | Work | Tests that must pass | Depends on |
|---|---|---|---|
| 2.1 ✅ | Repository: `git init`, pnpm workspaces (`apps/server`, `apps/web`, `apps/desktop`, `packages/shared`), TypeScript strict, ESLint/Prettier, Vitest, dependency rules (ARCH-01), traceability check in the test script | ARCH-01, traceability check | Toolchain |
| 2.2 ✅ | Foundation migrations from DATABASE.md §2–§3 and §12: schema, domains, helper functions, identity/RBAC/devices/sessions/step-up, audit, settings, document counters, idempotency, outbox; append-only and freeze triggers; DB roles; seeds (roles, permission catalog from RBAC.md, settings from DECISIONS.md §4) | Migrations apply to empty DB; AT-95, AT-96 | 2.1 |
| 2.3 ✅ | Server platform: Fastify with **two listeners** (customer 8080 / staff 8443), config, pino logging with correlation IDs, problem+json errors (API.md §6), Zod validation, decimal types, transaction helper enforcing lock order, idempotency (API.md §3), audit writer, startup **clock check** (WINDOWS_DEPLOYMENT.md §5) | AT-72, AT-79, unit tests for decimals and errors | 2.2 |
| 2.4 | Identity & RBAC: password/PIN (argon2id), lockouts, sessions, device registration codes, PIN switch, effective permissions with scopes and deny-wins, step-up approvals, protected owner permissions, last-owner protection, owner recovery CLI | AT-38, AT-39, AT-41, AT-76, AT-77, AT-118, AT-119, AT-18, SEC-ALL (for existing routes) | 2.3 |
| 2.5 | Live updates and jobs: outbox → LISTEN/NOTIFY → SSE hub with topic filtering, `Last-Event-ID` replay and resync; graphile-worker with heartbeat, idempotency-key expiry, outbox pruning | AT-73, AT-43 (stream part) | 2.3 |
| 2.6 | Health: `/health/live`, `/health/ready`, `/system/health` (DB, worker heartbeat, disk; printer/backup fields stubbed until their phases) | AT-120 (foundation parts), AT-17 (restart) | 2.5 |
| 2.7 | Web app shell: Vite + React, design tokens (UI_UX.md §2), fonts self-hosted, device registration, login, PIN switch, role-based navigation from `/auth/me`, connection banner, SSE client with refetch | AT-86 (shell screens), E2E login journey | 2.4, 2.5 |
| 2.8 | Electron shell: hardened (context isolation, sandbox, CSP, origin lock, certificate pinning), "server unavailable" screen | AT-46 | 2.7 |
| 2.9 | Windows skeleton: WinSW service definitions (API, worker), dependency on PostgreSQL, recovery policies; installer skeleton; local CA + server certificate generation tool | AT-47 on Windows | 2.6, Windows environment |
| 2.10 | Test harness: disposable database per test file, concurrency harness with barriers, ESC/POS printer simulator (TCP 9100 + byte capture), API route × role generator | Harness self-tests | 2.1 (grows with each step) |

## 3. Working rules for the build

- Every step ends with its tests passing locally and a commit; nothing is reported as done without test output.
- Migrations are forward-only SQL files reviewed against DATABASE.md; any deviation is recorded in DATABASE.md in the same commit.
- No business tables beyond the foundation in Phase 2.
- Secrets never enter the repository; `.env.example` carries placeholders only.
