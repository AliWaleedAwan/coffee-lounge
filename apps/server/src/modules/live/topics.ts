/**
 * Which live-update topics a staff member may receive (API.md §7 "Who receives what").
 * A topic is `name` or `name:id`; unknown names are refused (deny by default).
 * Scope refinements (e.g. a waiter only for assigned tables) arrive with Phase 3,
 * where the round and session topics are published; fetching always re-checks access.
 */
import type { EffectivePermissions } from '../identity/index.ts';

/** Topic name → any one of these permissions (empty list = any logged-in staff). */
export const TOPIC_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  floor: ['tables.read'],
  table: ['tables.read'],
  approvals: ['orders.accept'],
  session: ['orders.read_all', 'orders.create', 'invoices.read'],
  kitchen: ['kitchen.read'],
  cashier: ['invoices.read', 'payments.collect'],
  deliveries: ['delivery.create', 'delivery.dispatch'],
  printers: ['printers.manage', 'kitchen.reprint'],
  system: ['system.health'],
  ledger: ['ledger.read'],
  inventory: ['inventory.read'],
  menu: [],
  alerts: [],
};

export function staffTopicPolicy(permissions: EffectivePermissions): (topic: string) => boolean {
  return (topic) => {
    const name = topic.split(':', 1)[0] ?? '';
    const needed = TOPIC_PERMISSIONS[name];
    if (needed === undefined) return false;
    return needed.length === 0 || needed.some((p) => permissions.has(p));
  };
}
