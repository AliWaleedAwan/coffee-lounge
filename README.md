# Coffee Lounge

Offline-first point-of-sale and management suite for a single coffee shop: guest QR ordering with staff approval, waiter tablets, kitchen pickup, one consolidated bill per visit, recipe-based stock with weighted-average costing, operational ledger, assets and owner reports. Runs entirely on the shop's local network from one Windows PC.

**Status:** Phase 2 (foundation) in progress. Design approved at Gate G1 on 19 Oct 2026. See [docs/phase-2/PLAN.md](docs/phase-2/PLAN.md).

## Documentation

| Topic                                         | Where                                                                                                                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Decisions (authoritative)                     | [docs/DECISIONS.md](docs/DECISIONS.md)                                                                                                                                                                                                                             |
| Database design                               | [docs/DATABASE.md](docs/DATABASE.md)                                                                                                                                                                                                                               |
| State machines and transactions               | [docs/ORDER_STATE_MACHINE.md](docs/ORDER_STATE_MACHINE.md)                                                                                                                                                                                                         |
| API and live updates                          | [docs/API.md](docs/API.md), [docs/openapi/phase3.yaml](docs/openapi/phase3.yaml)                                                                                                                                                                                   |
| Permissions                                   | [docs/RBAC.md](docs/RBAC.md)                                                                                                                                                                                                                                       |
| Recipes, stock, costing, reports              | [docs/RECIPE_INVENTORY.md](docs/RECIPE_INVENTORY.md), [docs/COST_VALUATION.md](docs/COST_VALUATION.md), [docs/FINANCE_REPORTING.md](docs/FINANCE_REPORTING.md)                                                                                                     |
| Network, printing, Windows, security, backups | [docs/LOCAL_LAN_HOSTING.md](docs/LOCAL_LAN_HOSTING.md), [docs/PRINTING_HARDWARE.md](docs/PRINTING_HARDWARE.md), [docs/WINDOWS_DEPLOYMENT.md](docs/WINDOWS_DEPLOYMENT.md), [docs/SECURITY.md](docs/SECURITY.md), [docs/BACKUP_RECOVERY.md](docs/BACKUP_RECOVERY.md) |
| UI/UX and prototypes                          | [docs/UI_UX.md](docs/UI_UX.md)                                                                                                                                                                                                                                     |
| Tests and traceability                        | [docs/TEST_PLAN.md](docs/TEST_PLAN.md), [docs/traceability.csv](docs/traceability.csv)                                                                                                                                                                             |
| Source requirements                           | [docs/source/](docs/source/)                                                                                                                                                                                                                                       |

## Development setup (macOS)

Requirements: Apple Command Line Tools, Node.js 24 LTS, PostgreSQL 17. pnpm is used through Corepack (bundled with Node), so it needs no separate install.

```bash
corepack pnpm install
corepack pnpm verify
```

`verify` runs formatting, lint, type-check, module dependency rules (ARCH-01), the requirement-to-test traceability check and all tests.

## Repository layout

```text
apps/            server, web, desktop (added in Phase 2 steps 2.3, 2.7, 2.8)
packages/shared  logic shared by all apps (business dates, decimals, validation schemas)
scripts/         project checks (traceability)
docs/            design, decisions, test plan, prototypes
```
