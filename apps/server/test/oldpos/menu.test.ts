import { describe, expect, it } from 'vitest';
import { cleanCategory, planMenu, type OldProduct } from '../../src/modules/oldpos/menu.ts';

const p = (over: Partial<OldProduct>): OldProduct => ({
  name: 'Plain Fries',
  barcode: '1',
  price: 250,
  inStock: true,
  category: 'Starter',
  ...over,
});

describe('the old POS products as a menu', () => {
  it('drops the old till keys and keeps real barcodes as scannable products', () => {
    const plan = planMenu([
      p({}),
      p({ name: 'Pepsi Tin', barcode: '8964000101476', price: 120, category: 'Pepsi Drink' }),
    ]);
    expect(plan.items).toEqual([
      {
        category: 'Starter',
        name: 'Plain Fries',
        variants: [{ name: 'Regular', price: '250' }],
        barcode: null,
        onSale: true,
      },
      {
        category: 'Pepsi Drink',
        name: 'Pepsi Tin',
        variants: [{ name: 'Regular', price: '120' }],
        barcode: '8964000101476',
        onSale: true,
      },
    ]);
  });

  it('one name at several prices becomes one item with a size per price, cheapest first', () => {
    const plan = planMenu([
      p({ name: 'Lays', price: 50, category: 'Snacks', barcode: '' }),
      p({ name: 'Lays', price: 20, category: 'Snacks', barcode: '' }),
      p({ name: 'Lays', price: 50, category: 'Snacks', barcode: '' }),
    ]);
    expect(plan.items[0]?.variants).toEqual([
      { name: 'Rs 20', price: '20' },
      { name: 'Rs 50', price: '50' },
    ]);
  });

  it('leaves out rows with no name or no price, and says why', () => {
    const plan = planMenu([p({ name: '  ' }), p({ name: 'Free thing', price: 0 })]);
    expect(plan.items).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['no name', 'no price']);
  });

  it('a barcode on two products is used once; the same name twice says which', () => {
    const plan = planMenu([
      p({ name: 'Donut', barcode: '8961014017564', category: 'Walls' }),
      p({ name: 'Donut', barcode: '8961014017999', category: 'Walls' }),
      p({ name: 'Copy', barcode: '8961014017564', category: 'Walls' }),
    ]);
    expect(plan.items.map((i) => i.name)).toEqual(['Donut', 'Donut (7999)']);
    expect(plan.skipped).toEqual([
      { name: 'Copy', category: 'Walls', reason: 'barcode 8961014017564 is on another product' },
    ]);
  });

  it('out of stock comes in off sale; an item on sale at any price stays on sale', () => {
    const plan = planMenu([
      p({ name: 'Cone', inStock: false, barcode: '' }),
      p({ name: 'Bar', inStock: false, barcode: '' }),
      p({ name: 'Bar', inStock: true, price: 300, barcode: '' }),
    ]);
    expect(plan.items.map((i) => [i.name, i.onSale])).toEqual([
      ['Cone', false],
      ['Bar', true],
    ]);
  });

  it('cleans category names typed twice, with stray spaces, or left blank', () => {
    expect(cleanCategory('Bliss Ice creamBliss Ice cream')).toBe('Bliss Ice cream');
    expect(cleanCategory('  Steak   Beef ')).toBe('Steak Beef');
    expect(cleanCategory('')).toBe('Other');
    expect(cleanCategory('Tea')).toBe('Tea');
  });
});
