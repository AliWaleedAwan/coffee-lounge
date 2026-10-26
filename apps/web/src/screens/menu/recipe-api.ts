/**
 * Recipe data for the staff app (API.md §5.9, step 4.8). Recipes refetch on the `menu`
 * topic (activation and stock mode change what the menu offers); writes refresh the
 * recipe queries and the menu.
 */
import type { BaseUnit } from '@cl/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type RequestOptions } from '../../api/client.ts';

export type StockMode = 'untracked' | 'recipe';
export type OrderType = 'dine_in' | 'takeaway' | 'delivery';

export interface RecipeOverviewItem {
  menuItemId: string;
  name: string;
  category: string;
  variants: {
    id: string;
    name: string;
    stockMode: StockMode;
    activeVersion: number | null;
    draftVersion: number | null;
  }[];
}

export interface RecipeComponent {
  itemId: string;
  name: string;
  baseUom: BaseUnit;
  qtyBase: string;
  wasteFactor: string;
  forDineIn: boolean;
  forTakeaway: boolean;
  forDelivery: boolean;
  stockControlActive: boolean;
}

export interface RecipeVersion {
  id: string;
  versionNo: number;
  status: 'draft' | 'active' | 'retired';
  prepInstructions: string | null;
  activatedAt: string | null;
  activatedBy: string | null;
  retiredAt: string | null;
  components: RecipeComponent[];
  version: number;
}

export interface RecipeRule {
  id: string;
  optionId: string;
  optionName: string;
  groupName: string;
  variantId: string | null;
  action: 'add' | 'remove' | 'replace' | 'scale';
  itemId: string;
  itemName: string;
  replacementItemId: string | null;
  replacementName: string | null;
  qtyBase: string | null;
  scaleFactor: string | null;
  baseUom: BaseUnit;
}

export interface VariantRecipes {
  variantId: string;
  variantName: string;
  menuItemId: string;
  menuItemName: string;
  stockMode: StockMode;
  versions: RecipeVersion[];
  rules: RecipeRule[];
  options: { id: string; name: string; groupName: string }[];
}

const TOPICS = { topics: ['menu', 'inventory'] } as const;

export function useRecipeOverview() {
  return useQuery({
    queryKey: ['recipes', 'overview'],
    queryFn: ({ signal }) => api<{ items: RecipeOverviewItem[] }>('/recipes', { signal }),
    meta: TOPICS,
  });
}

export function useVariantRecipes(variantId: string) {
  return useQuery({
    queryKey: ['recipes', 'variant', variantId],
    queryFn: ({ signal }) => api<VariantRecipes>(`/recipes/variants/${variantId}`, { signal }),
    meta: TOPICS,
  });
}

export function useRecipeWrite<T = unknown>(onDone?: (result: T) => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (w: { path: string; method?: RequestOptions['method']; body?: unknown }) =>
      api<T>(w.path, { method: w.method ?? 'POST', body: w.body ?? {} }),
    onSuccess: (result) => {
      onDone?.(result);
    },
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: ['recipes'] });
      await client.invalidateQueries({ queryKey: ['menu'] });
    },
  });
}

export interface PreviewLine {
  itemId: string;
  name: string;
  baseUom: BaseUnit;
  qtyPerUnit: string;
}

export function previewRecipe(body: {
  variantId: string;
  orderType: OrderType;
  optionIds: string[];
  draft: boolean;
}): Promise<{ lines: PreviewLine[] }> {
  return api<{ lines: PreviewLine[] }>('/recipes/preview', { method: 'POST', body });
}

/** "0.0500" → "5" (percent, as entered). */
export function wastePercent(fraction: string): string {
  return String(Number((Number(fraction) * 100).toFixed(2)));
}
