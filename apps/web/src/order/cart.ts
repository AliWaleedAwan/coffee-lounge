/**
 * The cart behind the order composer, shared by the waiter screens and the guest app.
 * Prices here are what the person sees; the server prices every line again and refuses
 * the round if a price moved (`quotedUnitPrice`, API.md §2).
 */
import { Decimal, money } from '@cl/shared';

export interface MenuOption {
  id: string;
  name: string;
  priceDelta: string;
  available: boolean;
}

export interface MenuGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: MenuOption[];
}

export interface MenuVariant {
  id: string;
  name: string;
  price: string;
  promotionPrice: string | null;
  available: boolean;
  unavailableReason: string | null;
  isDefault: boolean;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  dietaryTags: string[];
  variants: MenuVariant[];
  modifierGroups: MenuGroup[];
}

export interface MenuCategory {
  id: string;
  name: string;
  items: MenuItem[];
}

export interface CartLine {
  key: string;
  variantId: string;
  itemName: string;
  variantName: string;
  optionIds: string[];
  optionNames: string[];
  notes: string;
  qty: number;
  /** Size price (after any promotion) + choices, as shown: "530.00". */
  unitPrice: string;
}

/** What one unit costs with these choices. */
export function unitPrice(
  variant: MenuVariant,
  groups: readonly MenuGroup[],
  optionIds: readonly string[],
): string {
  const options = groups.flatMap((g) => g.options);
  const extras = optionIds.reduce(
    (sum, id) => sum.plus(options.find((o) => o.id === id)?.priceDelta ?? '0'),
    new Decimal(0),
  );
  return money.format(new Decimal(variant.promotionPrice ?? variant.price).plus(extras));
}

/** Problems with a choice of options for an item, in words; empty when it can be added. */
export function choiceProblems(
  groups: readonly MenuGroup[],
  optionIds: readonly string[],
): string[] {
  return groups.flatMap((g) => {
    const n = optionIds.filter((id) => g.options.some((o) => o.id === id)).length;
    if (n < g.minSelect) return [`${g.name}: choose at least ${String(g.minSelect)}`];
    if (n > g.maxSelect) return [`${g.name}: choose at most ${String(g.maxSelect)}`];
    return [];
  });
}

export function cartTotal(lines: readonly CartLine[]): string {
  return money.format(
    lines.reduce((sum, l) => sum.plus(new Decimal(l.unitPrice).times(l.qty)), new Decimal(0)),
  );
}

/** "450.00" → "Rs 450"; paisa only when there are some. */
export function rupees(amount: string): string {
  const [whole = amount, paisa = '00'] = amount.split('.');
  return paisa === '00' ? `Rs ${whole}` : `Rs ${whole}.${paisa}`;
}

/** The body of a round submission (API.md §5.1 / §5.4). */
export function roundBody(lines: readonly CartLine[]) {
  return {
    lines: lines.map((l) => ({
      variantId: l.variantId,
      qty: l.qty,
      modifierOptionIds: l.optionIds,
      ...(l.notes.trim() ? { notes: l.notes.trim() } : {}),
      quotedUnitPrice: l.unitPrice,
    })),
  };
}
