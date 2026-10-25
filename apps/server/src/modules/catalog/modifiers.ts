/**
 * Modifier choices for one order line (AT-113): every option must belong to one of the
 * item's groups and be active, and each group's min/max must hold. Used when a round is
 * submitted (step 3.4); the browser checks the same rules but the server decides.
 */
export interface ModifierGroupRule {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: readonly { id: string; isActive: boolean }[];
}

export type ModifierProblem =
  | { kind: 'unknown_option'; optionId: string }
  | { kind: 'inactive_option'; optionId: string }
  | { kind: 'duplicate_option'; optionId: string }
  | { kind: 'too_few'; groupId: string; group: string; min: number }
  | { kind: 'too_many'; groupId: string; group: string; max: number };

export function checkModifierSelection(
  groups: readonly ModifierGroupRule[],
  selectedOptionIds: readonly string[],
): ModifierProblem[] {
  const problems: ModifierProblem[] = [];
  const groupOf = new Map<string, { group: ModifierGroupRule; isActive: boolean }>();
  for (const group of groups) {
    for (const option of group.options)
      groupOf.set(option.id, { group, isActive: option.isActive });
  }
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const id of selectedOptionIds) {
    if (seen.has(id)) {
      problems.push({ kind: 'duplicate_option', optionId: id });
      continue;
    }
    seen.add(id);
    const found = groupOf.get(id);
    if (!found) {
      problems.push({ kind: 'unknown_option', optionId: id });
      continue;
    }
    if (!found.isActive) problems.push({ kind: 'inactive_option', optionId: id });
    counts.set(found.group.id, (counts.get(found.group.id) ?? 0) + 1);
  }
  for (const group of groups) {
    const n = counts.get(group.id) ?? 0;
    if (n < group.minSelect)
      problems.push({
        kind: 'too_few',
        groupId: group.id,
        group: group.name,
        min: group.minSelect,
      });
    if (n > group.maxSelect)
      problems.push({
        kind: 'too_many',
        groupId: group.id,
        group: group.name,
        max: group.maxSelect,
      });
  }
  return problems;
}

export function describeModifierProblem(p: ModifierProblem): string {
  switch (p.kind) {
    case 'unknown_option':
      return 'A choice does not belong to this item';
    case 'inactive_option':
      return 'A choice is no longer offered';
    case 'duplicate_option':
      return 'The same choice was picked twice';
    case 'too_few':
      return `${p.group}: choose at least ${String(p.min)}`;
    case 'too_many':
      return `${p.group}: choose at most ${String(p.max)}`;
  }
}
