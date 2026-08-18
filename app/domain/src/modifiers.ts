/**
 * Modifier validation (epic E3).
 *
 * A menu is a configurable program: reusable groups, min/max selection
 * counts, defaults, and nesting (choosing "Add shrimp" can open
 * "Cooked how?"). This validator is THE gate for FR-12: an item whose
 * required choices are unanswered never becomes an order line, and the
 * SAME code runs on the client (to disable the Add button) and on the
 * server (to refuse the command), so the two can never disagree.
 *
 * Design rules:
 *   - Total over garbage: corrupt snapshots and hostile selections
 *     produce error values, never exceptions.
 *   - Collect ALL errors, not the first: the UI highlights every
 *     unanswered group at once.
 *   - Depth is limited by policy (V1: 2), not by the data model.
 */

export interface ModifierOption {
  id: string;
  name: string;
  priceMinor: number;
  isDefault?: boolean;
  /** choosing this option opens these child groups */
  childGroupIds?: readonly string[];
}

export interface ModifierGroup {
  id: string;
  name: string;
  /** 0 = optional group */
  minSelect: number;
  /** null = unlimited */
  maxSelect: number | null;
  options: readonly ModifierOption[];
}

export interface MenuItemSpec {
  id: string;
  name: string;
  modifierGroupIds: readonly string[];
}

export type GroupIndex = Readonly<Record<string, ModifierGroup>>;

export interface SelectedModifier {
  groupId: string;
  modifierId: string;
  children?: readonly SelectedModifier[];
}

export type ModifierError =
  | { code: "group_not_defined"; groupId: string }
  | { code: "unknown_group"; groupId: string }
  | { code: "unknown_option"; groupId: string; modifierId: string }
  | { code: "duplicate_option"; groupId: string; modifierId: string }
  | { code: "too_few"; groupId: string; min: number; got: number }
  | { code: "too_many"; groupId: string; max: number; got: number }
  | { code: "depth_exceeded"; depth: number; maxDepth: number };

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: readonly ModifierError[] };

export interface ValidateOptions {
  /** how deep selection nesting may go; V1 ships 2 */
  maxDepth?: number;
}

export function validateModifiers(
  item: MenuItemSpec,
  groups: GroupIndex,
  selections: readonly SelectedModifier[],
  options: ValidateOptions = {},
): ValidationResult {
  const maxDepth = options.maxDepth ?? 2;
  const errors: ModifierError[] = [];
  validateLevel(item.modifierGroupIds, groups, selections, 1, maxDepth, errors);
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

function validateLevel(
  groupIds: readonly string[],
  groups: GroupIndex,
  selections: readonly SelectedModifier[],
  depth: number,
  maxDepth: number,
  errors: ModifierError[],
): void {
  if (selections.length > 0 && depth > maxDepth) {
    errors.push({ code: "depth_exceeded", depth, maxDepth });
    return;
  }

  // selections pointing at groups this level does not offer
  for (const sel of selections) {
    if (!groupIds.includes(sel.groupId)) {
      errors.push({ code: "unknown_group", groupId: sel.groupId });
    }
  }

  for (const groupId of groupIds) {
    const group = groups[groupId];
    if (!group) {
      errors.push({ code: "group_not_defined", groupId });
      continue;
    }

    const chosen = selections.filter((s) => s.groupId === groupId);
    const seen = new Set<string>();
    let validCount = 0;

    for (const sel of chosen) {
      const option = group.options.find((o) => o.id === sel.modifierId);
      if (!option) {
        errors.push({ code: "unknown_option", groupId, modifierId: sel.modifierId });
        continue;
      }
      if (seen.has(sel.modifierId)) {
        errors.push({ code: "duplicate_option", groupId, modifierId: sel.modifierId });
        continue;
      }
      seen.add(sel.modifierId);
      validCount++;
      // recurse: children are validated against the option's child groups;
      // children under an option with no child groups fall out as unknown_group
      validateLevel(option.childGroupIds ?? [], groups, sel.children ?? [], depth + 1, maxDepth, errors);
    }

    if (validCount < group.minSelect) {
      errors.push({ code: "too_few", groupId, min: group.minSelect, got: validCount });
    }
    if (group.maxSelect !== null && validCount > group.maxSelect) {
      errors.push({ code: "too_many", groupId, max: group.maxSelect, got: validCount });
    }
  }
}

/**
 * Price of a selection tree, in minor units. Call only on VALIDATED
 * selections: unknown ids throw here, because pricing garbage silently
 * would be a money bug, not a UX event.
 */
export function selectionPriceMinor(groups: GroupIndex, selections: readonly SelectedModifier[]): number {
  let total = 0;
  for (const sel of selections) {
    const group = groups[sel.groupId];
    if (!group) throw new RangeError(`selectionPriceMinor: unknown group ${sel.groupId}`);
    const option = group.options.find((o) => o.id === sel.modifierId);
    if (!option) throw new RangeError(`selectionPriceMinor: unknown option ${sel.modifierId} in ${sel.groupId}`);
    total += option.priceMinor;
    if (sel.children) total += selectionPriceMinor(groups, sel.children);
  }
  return total;
}

/**
 * Seed a selection with each group's defaults (capped at maxSelect).
 * A required group with no defaults stays unsatisfied on purpose: the
 * validator reports too_few and the UI prompts the server. Defaults do
 * not recurse into child groups; picking a default that opens children
 * is a human decision.
 */
export function defaultSelections(item: MenuItemSpec, groups: GroupIndex): SelectedModifier[] {
  const out: SelectedModifier[] = [];
  for (const groupId of item.modifierGroupIds) {
    const group = groups[groupId];
    if (!group) continue;
    const cap = group.maxSelect ?? Number.POSITIVE_INFINITY;
    let taken = 0;
    for (const option of group.options) {
      if (!option.isDefault || taken >= cap) continue;
      out.push({ groupId, modifierId: option.id });
      taken++;
    }
  }
  return out;
}
