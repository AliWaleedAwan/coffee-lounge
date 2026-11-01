"""Turns the owner's item list (owner-items-*.tsv, from the old POS) into the menu
import template (docs/templates/04_menu.csv format). Run: python3 convert.py
Decisions are listed in README.md; nothing here changes a price."""
import csv, re, sys
from pathlib import Path

HERE = Path(__file__).parent
SRC = HERE / 'owner-items-2026-11-01.tsv'
OUT = HERE / '04_menu_owner.csv'

CATEGORY_FIX = {'Chineese': 'Chinese'}
SIZES = ['Small', 'Medium', 'Large', 'XL']
# Same name in two categories: the category is added to keep them apart.
CLASH = {('Extra Sauce', 'Steak Beef'): 'Extra Sauce (Beef Steak)',
         ('Extra Sauce', 'Steak Chicken'): 'Extra Sauce (Chicken Steak)',
         ('Donut', 'Walls Ice cream'): 'Donut Ice Cream',
         ('Seekh Kabab', 'Pakistani'): 'Seekh Kabab Karhai'}


def split(name: str, category: str) -> tuple[str, str]:
    """(item, variant) for one row of the old list."""
    if category == 'Pizza':
        m = re.match(r'^Spc (Small|Medium|Large|XL) Pizza$', name, re.I)
        if m:
            return 'Special Pizza', m.group(1).capitalize() if m.group(1) != 'XL' else 'XL'
        m = re.match(r'^(.*) (small|medium|large|xl)$', name, re.I)
        if m:
            size = next(s for s in SIZES if s.lower() == m.group(2).lower())
            base = m.group(1)
            return (base if base == 'Extra Topping' else f'{base} Pizza'), size
    if category == 'Pakistani':
        m = re.match(r'^(.*?)\s+(Full|Half)$', name, re.I)
        if m:
            base = m.group(1)
            return CLASH.get((base, category), base), m.group(2).capitalize()
    m = re.match(r'^(Grill Fish (?:Boneless|Rahu)) (1Kg|1/2Kg)$', name)
    if m:
        return m.group(1), '1 kg' if m.group(2) == '1Kg' else '½ kg'
    return CLASH.get((name, category), name), 'Regular'


def main() -> None:
    rows = list(csv.DictReader(SRC.open(encoding='utf-8'), delimiter='\t'))
    items: dict[str, dict] = {}
    skipped = []
    for r in rows:
        name = re.sub(r'\s+', ' ', r['pname']).strip()
        name = name[:1].upper() + name[1:]  # 'white Boneless' and 'White Boneless' are one dish
        if not name:
            skipped.append(r['ID'])
            continue
        category = CATEGORY_FIX.get(r['pcategory'].strip(), r['pcategory'].strip())
        price = int(r['pprice'])
        item, variant = split(name, category)
        if name in ('Biscut', 'Lays', 'Packing', 'Party Charge'):
            variant = f'Rs {price}'  # the old POS sold one name at several prices
        entry = items.setdefault(item, {'category': category, 'variants': []})
        if entry['category'] != category:
            sys.exit(f'{item} is in two categories: {entry["category"]}, {category}')
        if any(v[0] == variant for v in entry['variants']):
            sys.exit(f'{item} / {variant} twice')
        entry['variants'].append((variant, price, r['ID']))
    order = {s: i for i, s in enumerate(SIZES)}
    with OUT.open('w', newline='', encoding='utf-8') as f:
        w = csv.writer(f, lineterminator='\n')
        w.writerow(['category', 'item', 'description', 'variant', 'price', 'is_default',
                    'allow_dine_in', 'allow_takeaway', 'allow_delivery'])
        n = 0
        for item, e in items.items():
            vs = sorted(e['variants'], key=lambda v: order.get(v[0], 99)) if e['category'] == 'Pizza' else e['variants']
            dine_only = e['category'] == 'Gaming'
            for i, (variant, price, _) in enumerate(vs):
                w.writerow([e['category'], item, '', variant, f'{price}.00', 'yes' if i == 0 else 'no',
                            'yes', 'no' if dine_only else 'yes', 'no' if dine_only else 'yes'])
                n += 1
    print(f'{len(rows)} rows read, {len(skipped)} blank skipped, {len(items)} items, {n} sizes -> {OUT.name}')


main()
