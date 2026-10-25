/**
 * Navigation built from the signed-in user's effective permissions (API.md §4: the UI
 * builds navigation from `/auth/me`; UI_UX.md §6). Hiding an area is convenience only:
 * the server checks every request (SEC-ALL).
 */
export interface Area {
  id: string;
  label: string;
  path: string;
  /** Visible when the user has any of these permissions. */
  anyOf: readonly string[];
  /** Built so far; the others show a placeholder until their phase. */
  ready: boolean;
}

/** In priority order: the first visible area is the user's home screen. */
export const AREAS: readonly Area[] = [
  { id: 'floor', label: 'Floor', path: '/floor', anyOf: ['tables.read'], ready: true },
  {
    id: 'operations',
    label: 'Live operations',
    path: '/operations',
    anyOf: ['reports.sales'],
    ready: true,
  },
  {
    id: 'approvals',
    label: 'Approvals',
    path: '/approvals',
    anyOf: ['orders.accept'],
    ready: true,
  },
  { id: 'pickup', label: 'Pickup', path: '/pickup', anyOf: ['kitchen.pickup'], ready: true },
  {
    id: 'counter',
    label: 'Bills & payments',
    path: '/counter',
    anyOf: ['payments.collect', 'invoices.lock'],
    ready: true,
  },
  {
    id: 'deliveries',
    label: 'Deliveries',
    path: '/deliveries',
    anyOf: ['delivery.create', 'delivery.dispatch', 'delivery.record_return'],
    ready: true,
  },
  {
    id: 'inventory',
    label: 'Inventory',
    path: '/inventory',
    anyOf: ['inventory.read'],
    ready: false,
  },
  {
    id: 'menu',
    label: 'Menu & recipes',
    path: '/menu',
    anyOf: [
      'menu.manage',
      'menu.price_change',
      'menu.availability_toggle',
      'promotions.manage',
      'recipes.manage',
      'recipes.read',
    ],
    ready: true,
  },
  {
    id: 'reports',
    label: 'Reports',
    path: '/reports',
    anyOf: ['reports.sales', 'reports.profit', 'reports.inventory', 'reports.staff'],
    ready: false,
  },
  { id: 'users', label: 'Users & roles', path: '/users', anyOf: ['users.manage'], ready: false },
  { id: 'devices', label: 'Devices', path: '/devices', anyOf: ['devices.manage'], ready: true },
  {
    id: 'settings',
    label: 'Settings',
    path: '/settings',
    anyOf: ['settings.manage', 'printers.manage'],
    ready: true,
  },
  { id: 'audit', label: 'Audit log', path: '/audit', anyOf: ['audit.read'], ready: false },
  {
    id: 'health',
    label: 'System health',
    path: '/system-health',
    anyOf: ['system.health'],
    ready: true,
  },
];

export function visibleAreas(permissions: ReadonlySet<string>): Area[] {
  return AREAS.filter((area) => area.anyOf.some((p) => permissions.has(p)));
}

/** Where a user lands after signing in: their first area, or their account page. */
export function homePath(permissions: ReadonlySet<string>): string {
  return visibleAreas(permissions)[0]?.path ?? '/account';
}
