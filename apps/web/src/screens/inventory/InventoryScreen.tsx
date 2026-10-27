/**
 * Inventory area (UI_UX.md §6, clerk): an overview of what needs attention, items and scanning, receiving stock, past receipts
 * with supplier returns, waste, stock counts and suppliers. Tabs follow the user's permissions; the server checks every request.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { permissionSet } from '../../auth/session.ts';
import { useSignedIn } from '../Shell.tsx';
import { CountsTab } from './CountsTab.tsx';
import { ImportTab } from './ImportTab.tsx';
import { ItemsTab } from './ItemsTab.tsx';
import { OverviewTab } from './OverviewTab.tsx';
import { ReceiptsTab } from './ReceiptsTab.tsx';
import { ReceiveTab } from './ReceiveTab.tsx';
import { SuppliersTab } from './SuppliersTab.tsx';
import { WasteTab } from './WasteTab.tsx';

type Tab =
  'overview' | 'items' | 'receive' | 'receipts' | 'waste' | 'counts' | 'import' | 'suppliers';

export function InventoryScreen() {
  const permissions = permissionSet(useSignedIn());
  const can = {
    manageItems: permissions.has('inventory.items_manage'),
    receive: permissions.has('inventory.receive'),
    startStockControl: permissions.has('inventory.stock_control_activate'),
    manageSuppliers: permissions.has('suppliers.manage'),
    waste: permissions.has('inventory.waste'),
    count: permissions.has('inventory.count'),
    approveCount: permissions.has('inventory.count_approve'),
    correctCost: permissions.has('inventory.cost_adjust'),
  };
  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'items', label: 'Items' },
    ...(can.receive ? [{ id: 'receive' as const, label: 'Receive stock' }] : []),
    { id: 'receipts', label: 'Receipts' },
    { id: 'waste', label: 'Waste' },
    { id: 'counts', label: 'Counts' },
    { id: 'suppliers', label: 'Suppliers' },
    { id: 'import', label: 'Import' },
  ];
  // `?tab=counts` (from the inbox) opens that tab, when the user has it.
  const [params] = useSearchParams();
  const asked = tabs.find((t) => t.id === params.get('tab'))?.id;
  const [tab, setTab] = useState<Tab>(asked ?? 'overview');

  return (
    <>
      <h1>Inventory</h1>
      <div className="tabs" role="tablist" aria-label="Inventory sections">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`inventory-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="inventory-panel"
            onClick={() => {
              setTab(t.id);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        id="inventory-panel"
        role="tabpanel"
        aria-labelledby={`inventory-tab-${tab}`}
        className="stack"
      >
        {tab === 'overview' ? <OverviewTab canManage={can.manageItems} /> : null}
        {tab === 'items' ? <ItemsTab canManage={can.manageItems} /> : null}
        {tab === 'receive' ? (
          <ReceiveTab canLink={can.manageItems} canStartStockControl={can.startStockControl} />
        ) : null}
        {tab === 'receipts' ? (
          <ReceiptsTab canReverse={can.receive} canCorrect={can.correctCost} />
        ) : null}
        {tab === 'waste' ? <WasteTab canRecord={can.waste} /> : null}
        {tab === 'counts' ? <CountsTab canCount={can.count} canApprove={can.approveCount} /> : null}
        {tab === 'import' ? <ImportTab /> : null}
        {tab === 'suppliers' ? <SuppliersTab canManage={can.manageSuppliers} /> : null}
      </div>
    </>
  );
}
