/**
 * Module boundary rules (TEST_PLAN.md ARCH-01, ARCHITECTURE: 02-architecture §2.4).
 * Run: corepack pnpm check:deps
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Domain modules must not depend on each other in a cycle.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'shared-is-a-leaf',
      severity: 'error',
      comment: 'packages/shared is used by every app and must not import any app.',
      from: { path: '^packages/shared/' },
      to: { path: '^apps/' },
    },
    {
      name: 'apps-are-independent',
      severity: 'error',
      comment: 'Server, web and desktop talk over HTTP, never by importing each other.',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      name: 'server-modules-use-public-index',
      severity: 'error',
      comment: 'A server module may use another module only through that module’s index.ts.',
      from: { path: '^apps/server/src/modules/([^/]+)/' },
      to: {
        path: '^apps/server/src/modules/[^/]+/',
        pathNot: ['^apps/server/src/modules/$1/', '^apps/server/src/modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'reporting-reads-only',
      severity: 'error',
      comment:
        'Reporting may not import other modules’ services (it reads through its own queries).',
      from: { path: '^apps/server/src/modules/reporting/' },
      to: { path: '^apps/server/src/modules/(?!reporting/)[^/]+/' },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(node_modules|dist|coverage)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'default'] },
  },
};
