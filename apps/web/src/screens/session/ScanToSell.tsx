/**
 * Scan to sell (Phase 8 step 8.3; P8-1), on the counter only: a box of its own takes the scan,
 * so a code never lands in another field. A scan adds one, or one more, to the order. The box
 * takes the focus back afterwards, ready for the next item.
 */
import { useRef, useState, type SubmitEvent } from 'react';
import { api, messageOf } from '../../api/client.ts';
import { Field } from '../../components/Field.tsx';
import { unitPrice, type CartLine, type MenuCategory } from '../../order/cart.ts';

export function ScanToSell({
  categories,
  cart,
  onCartChange,
}: {
  categories: MenuCategory[];
  cart: CartLine[];
  onCartChange: (lines: CartLine[]) => void;
}) {
  const box = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const add = async (scanned: string): Promise<void> => {
    const { variantId, problem: refused } = await api<{
      variantId: string | null;
      problem: string | null;
    }>(`/products/sell-scan?code=${encodeURIComponent(scanned)}`);
    if (!variantId) {
      setProblem(refused ?? `Barcode ${scanned} is not known`);
      return;
    }
    const item = categories
      .flatMap((c) => c.items)
      .find((i) => i.variants.some((v) => v.id === variantId));
    const variant = item?.variants.find((v) => v.id === variantId);
    if (!item || !variant) {
      setProblem(`${scanned}: this product is not on sale`);
      return;
    }
    if (!variant.available) {
      setProblem(`${item.name} is unavailable right now`);
      return;
    }
    if (item.modifierGroups.some((g) => g.minSelect > 0)) {
      setProblem(`${item.name} needs a choice: pick it from the menu`);
      return;
    }
    const same = cart.find(
      (l) => l.variantId === variantId && l.optionIds.length === 0 && !l.notes,
    );
    onCartChange(
      same
        ? cart.map((l) => (l === same ? { ...l, qty: l.qty + 1 } : l))
        : [
            ...cart,
            {
              key: crypto.randomUUID(),
              variantId,
              itemName: item.name,
              variantName: variant.name,
              optionIds: [],
              optionNames: [],
              notes: '',
              qty: 1,
              unitPrice: unitPrice(variant, item.modifierGroups, []),
            },
          ],
    );
  };

  const submit = (e: SubmitEvent): void => {
    e.preventDefault();
    const scanned = code.trim();
    setCode('');
    setProblem(null);
    if (!scanned) return;
    void add(scanned)
      .catch((error: unknown) => {
        setProblem(messageOf(error));
      })
      .finally(() => {
        box.current?.focus();
      });
  };

  return (
    <form className="row" noValidate onSubmit={submit} aria-label="Scan to sell">
      <Field
        ref={box}
        label="Scan a product"
        autoComplete="off"
        maxLength={64}
        value={code}
        error={problem}
        onChange={(e) => {
          setCode(e.target.value);
        }}
      />
    </form>
  );
}
