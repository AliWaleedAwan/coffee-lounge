/**
 * The old POS's products as Coffee Lounge's menu (owner's request, Nov 2026). Pure: the rules
 * for cleaning the old list live here, so they can be tested without a database.
 *
 *   - Real barcodes (8 digits or more) become products: an inventory item with its barcode and a
 *     one-to-one recipe left as a draft, so a scan sells it (step 8.3) and stock control starts
 *     when stock is counted. Shorter codes (1, 2, 3...) were the old till's keys and are dropped.
 *   - Everything else becomes a menu item without stock (fries, karhai...).
 *   - The same name in one category at different prices becomes one item with a size per price.
 *   - Rows without a name or a price are left out and listed.
 */

export interface OldProduct {
  name: string;
  barcode: string;
  price: number;
  inStock: boolean;
  category: string;
}

export interface PlannedVariant {
  name: string;
  price: string;
}

export interface PlannedItem {
  category: string;
  name: string;
  variants: PlannedVariant[];
  /** Set for a product sold by scanning; then there is exactly one variant. */
  barcode: string | null;
  onSale: boolean;
}

export interface MenuPlan {
  categories: string[];
  items: PlannedItem[];
  skipped: { name: string; category: string; reason: string }[];
}

const REAL_BARCODE = /^\d{8,14}$/;

/** "Bliss Ice creamBliss Ice cream" (typed twice) becomes "Bliss Ice cream"; blank, "Other". */
export function cleanCategory(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name) return 'Other';
  const half = name.length / 2;
  if (Number.isInteger(half) && name.slice(0, half) === name.slice(half))
    return name.slice(0, half);
  return name;
}

const cleanName = (raw: string) => raw.replace(/\s+/g, ' ').trim().slice(0, 80);
const key = (category: string, name: string) =>
  `${category.toLowerCase()}\u0000${name.toLowerCase()}`;

export function planMenu(products: readonly OldProduct[]): MenuPlan {
  const skipped: MenuPlan['skipped'] = [];
  const items = new Map<string, PlannedItem>();
  const scanned = new Set<string>();

  for (const p of products) {
    const name = cleanName(p.name);
    const category = cleanCategory(p.category);
    const code = p.barcode.trim();
    if (!name) {
      skipped.push({ name: '(no name)', category, reason: 'no name' });
      continue;
    }
    if (!Number.isInteger(p.price) || p.price <= 0) {
      skipped.push({ name, category, reason: 'no price' });
      continue;
    }
    const price = String(p.price);

    if (REAL_BARCODE.test(code)) {
      if (scanned.has(code)) {
        skipped.push({ name, category, reason: `barcode ${code} is on another product` });
        continue;
      }
      scanned.add(code);
      // A product is one item per barcode; a second one of the same name says which.
      let itemName = name;
      if (items.has(key(category, itemName))) itemName = cleanName(`${name} (${code.slice(-4)})`);
      items.set(key(category, itemName), {
        category,
        name: itemName,
        variants: [{ name: 'Regular', price }],
        barcode: code,
        onSale: p.inStock,
      });
      continue;
    }

    const existing = items.get(key(category, name));
    if (existing && existing.barcode === null) {
      if (!existing.variants.some((v) => v.price === price)) {
        existing.variants.push({ name: `Rs ${price}`, price });
      }
      existing.onSale = existing.onSale || p.inStock;
      continue;
    }
    const itemName = existing ? cleanName(`${name} (menu)`) : name;
    items.set(key(category, itemName), {
      category,
      name: itemName,
      variants: [{ name: 'Regular', price }],
      barcode: null,
      onSale: p.inStock,
    });
  }

  // An item that gained sizes names every size by its price, cheapest first.
  for (const item of items.values()) {
    if (item.variants.length > 1) {
      item.variants = item.variants
        .map((v) => ({ name: `Rs ${v.price}`, price: v.price }))
        .sort((a, b) => Number(a.price) - Number(b.price));
    }
  }

  const list = [...items.values()];
  return {
    categories: [...new Set(list.map((i) => i.category))],
    items: list,
    skipped,
  };
}
