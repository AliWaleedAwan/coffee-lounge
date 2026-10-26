/**
 * Menu & recipes area (API.md §5.7, §5.9; UI_UX.md §6): items and sizes, modifier choices,
 * promotions and recipes for whoever may edit or read them; the "temporarily unavailable" switch for staff
 * who only have that. Tabs follow the user's permissions; the server checks every write.
 */
import { useState } from 'react';
import { permissionSet } from '../../auth/session.ts';
import { useSignedIn } from '../Shell.tsx';
import { ChoicesTab } from './ChoicesTab.tsx';
import { ItemsTab } from './ItemsTab.tsx';
import { PromotionsTab } from './PromotionsTab.tsx';
import { RecipesTab } from './RecipesTab.tsx';

type Tab = 'items' | 'choices' | 'promotions' | 'recipes';

export function MenuScreen() {
  const permissions = permissionSet(useSignedIn());
  const can = {
    manage: permissions.has('menu.manage'),
    price: permissions.has('menu.price_change'),
    toggle: permissions.has('menu.availability_toggle'),
    promotions: permissions.has('promotions.manage'),
    recipes: permissions.has('recipes.read'),
    recipesManage: permissions.has('recipes.manage'),
  };
  const tabs: { id: Tab; label: string }[] = [
    { id: 'items', label: 'Items' },
    ...(can.manage ? [{ id: 'choices' as const, label: 'Choices' }] : []),
    ...(can.promotions ? [{ id: 'promotions' as const, label: 'Promotions' }] : []),
    ...(can.recipes ? [{ id: 'recipes' as const, label: 'Recipes' }] : []),
  ];
  const [tab, setTab] = useState<Tab>('items');

  return (
    <>
      <h1>Menu</h1>
      {tabs.length > 1 ? (
        <div className="tabs" role="tablist" aria-label="Menu sections">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`menu-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="menu-panel"
              onClick={() => {
                setTab(t.id);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      ) : null}
      <div
        id="menu-panel"
        role={tabs.length > 1 ? 'tabpanel' : undefined}
        aria-labelledby={tabs.length > 1 ? `menu-tab-${tab}` : undefined}
        className="stack"
      >
        {tab === 'items' ? <ItemsTab can={can} /> : null}
        {tab === 'choices' ? <ChoicesTab canPrice={can.price} /> : null}
        {tab === 'promotions' ? <PromotionsTab /> : null}
        {tab === 'recipes' ? <RecipesTab canManage={can.recipesManage} /> : null}
      </div>
    </>
  );
}
