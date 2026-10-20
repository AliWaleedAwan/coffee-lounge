import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cartTotal,
  choiceProblems,
  roundBody,
  unitPrice,
  type CartLine,
  type MenuCategory,
} from './cart.ts';
import { Composer } from './Composer.tsx';

const milk = {
  id: 'g1',
  name: 'Milk',
  minSelect: 0,
  maxSelect: 1,
  options: [
    { id: 'o1', name: 'Oat', priceDelta: '80.00', available: true },
    { id: 'o2', name: 'Almond', priceDelta: '90.00', available: false },
  ],
};
const shots = {
  id: 'g2',
  name: 'Shots',
  minSelect: 1,
  maxSelect: 2,
  options: [
    { id: 's1', name: 'Single', priceDelta: '0.00', available: true },
    { id: 's2', name: 'Extra', priceDelta: '90.00', available: true },
  ],
};
const regular = {
  id: 'v1',
  name: 'Regular',
  price: '450.00',
  promotionPrice: '400.00',
  available: true,
  unavailableReason: null,
  isDefault: true,
};
const latte = {
  id: 'i1',
  name: 'Latte',
  description: null,
  dietaryTags: ['Contains milk'],
  variants: [
    {
      id: 'v1',
      name: 'Regular',
      price: '450.00',
      promotionPrice: '400.00',
      available: true,
      unavailableReason: null,
      isDefault: true,
    },
    {
      id: 'v2',
      name: 'Large',
      price: '550.00',
      promotionPrice: null,
      available: true,
      unavailableReason: null,
      isDefault: false,
    },
  ],
  modifierGroups: [milk, shots],
};
const cake = {
  id: 'i2',
  name: 'Cake',
  description: null,
  dietaryTags: [],
  variants: [
    {
      id: 'v3',
      name: 'Slice',
      price: '300.00',
      promotionPrice: null,
      available: false,
      unavailableReason: 'out_of_stock',
      isDefault: true,
    },
  ],
  modifierGroups: [],
};
const categories: MenuCategory[] = [{ id: 'c1', name: 'Coffee', items: [latte, cake] }];

describe('cart rules', () => {
  it('prices a unit as promotion price plus choices, and the cart as the sum', () => {
    expect(unitPrice(regular, latte.modifierGroups, ['o1', 's2'])).toBe('570.00');
    const line = { unitPrice: '570.00', qty: 2 } as CartLine;
    expect(cartTotal([line, { unitPrice: '300.00', qty: 1 } as CartLine])).toBe('1440.00');
  });

  it('checks each group minimum and maximum', () => {
    expect(choiceProblems([milk, shots], [])).toEqual(['Shots: choose at least 1']);
    expect(choiceProblems([milk, shots], ['o1', 'o2', 's1'])).toEqual(['Milk: choose at most 1']);
    expect(choiceProblems([milk, shots], ['s1', 's2'])).toEqual([]);
  });

  it('sends what was shown, so the server can notice a price change', () => {
    const body = roundBody([
      {
        key: 'k',
        variantId: 'v1',
        itemName: 'Latte',
        variantName: 'Regular',
        optionIds: ['s1'],
        optionNames: ['Single'],
        notes: '  no foam ',
        qty: 2,
        unitPrice: '400.00',
      },
    ]);
    expect(body).toEqual({
      lines: [
        {
          variantId: 'v1',
          qty: 2,
          modifierOptionIds: ['s1'],
          notes: 'no foam',
          quotedUnitPrice: '400.00',
        },
      ],
    });
  });
});

function Harness({ flagged = [] }: { flagged?: number[] }) {
  const [cart, setCart] = useState<CartLine[]>([]);
  return (
    <Composer
      categories={categories}
      cart={cart}
      onCartChange={setCart}
      onSend={() => undefined}
      sending={false}
      sendLabel="Send order"
      flagged={flagged}
    />
  );
}

afterEach(cleanup);

describe('order composer', () => {
  it('adds a sized item with choices, and keeps unavailable items out', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: /Cake.*Unavailable right now/ })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: /Latte/ }));
    const add = () => screen.getByRole('button', { name: /^Add/ });
    expect(add()).toHaveProperty('disabled', true); // a shot is required
    expect(screen.getByLabelText(/Almond/)).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText(/Large/));
    fireEvent.click(screen.getByLabelText(/Oat/));
    fireEvent.click(screen.getByLabelText(/Extra/));
    fireEvent.click(screen.getByRole('button', { name: 'One more' }));
    expect(add().textContent).toBe('Add 2 to order · Rs 1440');
    fireEvent.click(add());
    const order = screen.getByRole('region', { name: 'Order' });
    expect(within(order).getByText('Latte · Large')).toBeTruthy();
    expect(within(order).getByText('Oat, Extra')).toBeTruthy();
    expect(within(order).getByText('Total Rs 1440')).toBeTruthy();
  });

  it('flags the lines the shop could not make', () => {
    function Flagged() {
      const [cart, setCart] = useState<CartLine[]>([
        {
          key: 'a',
          variantId: 'v1',
          itemName: 'Latte',
          variantName: 'Regular',
          optionIds: ['s1'],
          optionNames: ['Single'],
          notes: '',
          qty: 1,
          unitPrice: '400.00',
        },
        {
          key: 'b',
          variantId: 'v2',
          itemName: 'Latte',
          variantName: 'Large',
          optionIds: ['s1'],
          optionNames: ['Single'],
          notes: '',
          qty: 1,
          unitPrice: '550.00',
        },
      ]);
      return (
        <Composer
          categories={categories}
          cart={cart}
          onCartChange={setCart}
          onSend={() => undefined}
          sending={false}
          sendLabel="Send"
          flagged={[2]}
        />
      );
    }
    render(<Flagged />);
    const lines = screen.getByRole('region', { name: 'Order' }).querySelectorAll('li');
    expect(lines[0]?.textContent).not.toMatch(/Not enough stock/);
    expect(lines[1]?.textContent).toMatch(/Not enough stock/);
  });
});
