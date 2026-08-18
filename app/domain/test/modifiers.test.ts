import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  defaultSelections,
  selectionPriceMinor,
  validateModifiers,
  type GroupIndex,
  type MenuItemSpec,
  type ModifierGroup,
  type SelectedModifier,
} from "../src/modifiers.js";

/* ------------------------- fixture: the ragu ------------------------- */
// Mirrors the Osteria Nove prototype: required pasta shape, optional paid
// additions where shrimp opens a required child group.

const GROUPS: GroupIndex = {
  pasta: {
    id: "pasta", name: "Pasta", minSelect: 1, maxSelect: 1,
    options: [
      { id: "spag", name: "Spaghetti", priceMinor: 0, isDefault: true },
      { id: "tagl", name: "Tagliatelle", priceMinor: 0 },
      { id: "gf", name: "Gluten-free penne", priceMinor: 200 },
    ],
  },
  additions: {
    id: "additions", name: "Additions", minSelect: 0, maxSelect: null,
    options: [
      { id: "shrimp", name: "Add shrimp", priceMinor: 800, childGroupIds: ["cooked"] },
      { id: "truffle", name: "Shaved truffle", priceMinor: 1400 },
    ],
  },
  cooked: {
    id: "cooked", name: "Cooked how", minSelect: 1, maxSelect: 1,
    options: [
      { id: "grill", name: "Grilled", priceMinor: 0 },
      { id: "poach", name: "Poached", priceMinor: 0 },
    ],
  },
  temp: {
    id: "temp", name: "Temperature", minSelect: 1, maxSelect: 1,
    options: [{ id: "mr", name: "Medium rare", priceMinor: 0 }],
  },
};

const RAGU: MenuItemSpec = { id: "ragu", name: "Ragu alla Bolognese", modifierGroupIds: ["pasta", "additions"] };

const codes = (r: ReturnType<typeof validateModifiers>) =>
  r.valid ? [] : r.errors.map((e) => e.code).sort();

describe("validateModifiers: fixtures", () => {
  it("accepts a complete selection", () => {
    expect(validateModifiers(RAGU, GROUPS, [{ groupId: "pasta", modifierId: "tagl" }])).toEqual({ valid: true });
  });

  it("refuses an empty selection when a group is required, reporting the group", () => {
    const r = validateModifiers(RAGU, GROUPS, []);
    expect(codes(r)).toEqual(["too_few"]);
    if (!r.valid) expect(r.errors[0]).toEqual({ code: "too_few", groupId: "pasta", min: 1, got: 0 });
  });

  it("refuses two pasta shapes (too_many) and the same shape twice (duplicate)", () => {
    expect(codes(validateModifiers(RAGU, GROUPS, [
      { groupId: "pasta", modifierId: "spag" },
      { groupId: "pasta", modifierId: "tagl" },
    ]))).toEqual(["too_many"]);
    expect(codes(validateModifiers(RAGU, GROUPS, [
      { groupId: "pasta", modifierId: "spag" },
      { groupId: "pasta", modifierId: "spag" },
    ]))).toEqual(["duplicate_option"]);
  });

  it("shrimp demands its child group: bare shrimp refuses, cooked shrimp passes", () => {
    const bare = validateModifiers(RAGU, GROUPS, [
      { groupId: "pasta", modifierId: "spag" },
      { groupId: "additions", modifierId: "shrimp" },
    ]);
    expect(codes(bare)).toEqual(["too_few"]);

    const cooked = validateModifiers(RAGU, GROUPS, [
      { groupId: "pasta", modifierId: "spag" },
      { groupId: "additions", modifierId: "shrimp", children: [{ groupId: "cooked", modifierId: "grill" }] },
    ]);
    expect(cooked).toEqual({ valid: true });
  });

  it("collects every error at once, not just the first", () => {
    const r = validateModifiers(RAGU, GROUPS, [
      { groupId: "temp", modifierId: "mr" },          // group not on this item
      { groupId: "additions", modifierId: "nope" },   // option not in group
    ]);
    expect(codes(r)).toEqual(["too_few", "unknown_group", "unknown_option"]);
  });

  it("children under an option that opens nothing are refused", () => {
    const r = validateModifiers(RAGU, GROUPS, [
      { groupId: "pasta", modifierId: "spag", children: [{ groupId: "cooked", modifierId: "grill" }] },
    ]);
    expect(codes(r)).toEqual(["unknown_group"]);
  });

  it("enforces the depth policy without recursing forever", () => {
    const deepGroups: GroupIndex = {
      a: { id: "a", name: "A", minSelect: 0, maxSelect: null, options: [{ id: "a1", name: "a1", priceMinor: 0, childGroupIds: ["b"] }] },
      b: { id: "b", name: "B", minSelect: 0, maxSelect: null, options: [{ id: "b1", name: "b1", priceMinor: 0, childGroupIds: ["a"] }] },
    };
    const item: MenuItemSpec = { id: "x", name: "X", modifierGroupIds: ["a"] };
    const deep: SelectedModifier = {
      groupId: "a", modifierId: "a1",
      children: [{ groupId: "b", modifierId: "b1", children: [{ groupId: "a", modifierId: "a1" }] }],
    };
    expect(codes(validateModifiers(item, deepGroups, [deep], { maxDepth: 2 }))).toEqual(["depth_exceeded"]);
    expect(validateModifiers(item, deepGroups, [deep], { maxDepth: 3 })).toEqual({ valid: true });
  });

  it("a corrupt snapshot (item references a missing group) is an error value, not a crash", () => {
    const item: MenuItemSpec = { id: "x", name: "X", modifierGroupIds: ["ghost"] };
    expect(codes(validateModifiers(item, GROUPS, []))).toEqual(["group_not_defined"]);
  });

  it("prices a validated tree, including children", () => {
    const sel: SelectedModifier[] = [
      { groupId: "pasta", modifierId: "gf" },
      { groupId: "additions", modifierId: "shrimp", children: [{ groupId: "cooked", modifierId: "grill" }] },
      { groupId: "additions", modifierId: "truffle" },
    ];
    expect(selectionPriceMinor(GROUPS, sel)).toBe(200 + 800 + 0 + 1400);
  });

  it("defaults satisfy pasta but never invent answers for defaultless required groups", () => {
    const withTemp: MenuItemSpec = { id: "y", name: "Y", modifierGroupIds: ["pasta", "temp"] };
    const seeded = defaultSelections(withTemp, GROUPS);
    expect(seeded).toEqual([{ groupId: "pasta", modifierId: "spag" }]);
    expect(codes(validateModifiers(withTemp, GROUPS, seeded))).toEqual(["too_few"]); // temp still unanswered
  });
});

/* -------------------- properties over generated menus -------------------- */

interface GenGroup { optionCount: number; min: number; max: number | null }

const genGroupArb: fc.Arbitrary<GenGroup> = fc
  .record({
    optionCount: fc.integer({ min: 1, max: 6 }),
    minRaw: fc.integer({ min: 0, max: 6 }),
    maxRaw: fc.option(fc.integer({ min: 0, max: 6 }), { nil: null }),
  })
  .map(({ optionCount, minRaw, maxRaw }) => {
    const min = Math.min(minRaw, optionCount);
    const max = maxRaw === null ? null : Math.min(Math.max(min, maxRaw), optionCount);
    return { optionCount, min, max };
  });

function buildMenu(specs: GenGroup[]): { item: MenuItemSpec; groups: GroupIndex } {
  const groups: Record<string, ModifierGroup> = {};
  specs.forEach((s, gi) => {
    groups[`g${gi}`] = {
      id: `g${gi}`, name: `G${gi}`, minSelect: s.min, maxSelect: s.max,
      options: Array.from({ length: s.optionCount }, (_, oi) => ({
        id: `g${gi}o${oi}`, name: `O${oi}`, priceMinor: (oi + 1) * 25,
      })),
    };
  });
  return { item: { id: "item", name: "Item", modifierGroupIds: specs.map((_, gi) => `g${gi}`) }, groups };
}

/** pick a legal count of distinct options per group, steered by a seed */
function validSelection(specs: GenGroup[], seed: number): SelectedModifier[] {
  const out: SelectedModifier[] = [];
  specs.forEach((s, gi) => {
    const hi = Math.min(s.max ?? s.optionCount, s.optionCount);
    const k = s.min + ((seed + gi) % (hi - s.min + 1));
    for (let oi = 0; oi < k; oi++) out.push({ groupId: `g${gi}`, modifierId: `g${gi}o${oi}` });
  });
  return out;
}

const menuArb = fc.array(genGroupArb, { minLength: 1, maxLength: 5 });
const seedArb = fc.integer({ min: 0, max: 1_000 });

describe("validateModifiers: properties", () => {
  it("accepts every valid-by-construction selection", () => {
    fc.assert(
      fc.property(menuArb, seedArb, (specs, seed) => {
        const { item, groups } = buildMenu(specs);
        expect(validateModifiers(item, groups, validSelection(specs, seed))).toEqual({ valid: true });
      }),
    );
  });

  it("emptying a required group is always caught as too_few", () => {
    fc.assert(
      fc.property(menuArb, seedArb, (specs, seed) => {
        const gi = specs.findIndex((s) => s.min >= 1);
        fc.pre(gi >= 0);
        const { item, groups } = buildMenu(specs);
        const mutated = validSelection(specs, seed).filter((s) => s.groupId !== `g${gi}`);
        const r = validateModifiers(item, groups, mutated);
        expect(r.valid).toBe(false);
        if (!r.valid) expect(r.errors.some((e) => e.code === "too_few" && e.groupId === `g${gi}`)).toBe(true);
      }),
    );
  });

  it("exceeding a max is always caught as too_many", () => {
    fc.assert(
      fc.property(menuArb, (specs) => {
        const gi = specs.findIndex((s) => s.max !== null && s.max < s.optionCount);
        fc.pre(gi >= 0);
        const { item, groups } = buildMenu(specs);
        const s = specs[gi] as GenGroup;
        // minimal valid elsewhere, over-full here
        const sel = validSelection(specs, 0).filter((x) => x.groupId !== `g${gi}`);
        for (let oi = 0; oi <= (s.max as number); oi++) sel.push({ groupId: `g${gi}`, modifierId: `g${gi}o${oi}` });
        const r = validateModifiers(item, groups, sel);
        expect(r.valid).toBe(false);
        if (!r.valid) expect(r.errors.some((e) => e.code === "too_many" && e.groupId === `g${gi}`)).toBe(true);
      }),
    );
  });

  it("a foreign option id is always caught as unknown_option", () => {
    fc.assert(
      fc.property(menuArb, seedArb, (specs, seed) => {
        const { item, groups } = buildMenu(specs);
        const sel = [...validSelection(specs, seed), { groupId: "g0", modifierId: "not-a-real-option" }];
        const r = validateModifiers(item, groups, sel);
        expect(r.valid).toBe(false);
        if (!r.valid) expect(r.errors.some((e) => e.code === "unknown_option")).toBe(true);
      }),
    );
  });

  it("a selection for an unoffered group is always caught as unknown_group", () => {
    fc.assert(
      fc.property(menuArb, seedArb, (specs, seed) => {
        const { item, groups } = buildMenu(specs);
        const sel = [...validSelection(specs, seed), { groupId: "ghost", modifierId: "g0o0" }];
        const r = validateModifiers(item, groups, sel);
        expect(r.valid).toBe(false);
        if (!r.valid) expect(r.errors.some((e) => e.code === "unknown_group" && e.groupId === "ghost")).toBe(true);
      }),
    );
  });

  it("price equals the independent sum over the same tree", () => {
    fc.assert(
      fc.property(menuArb, seedArb, (specs, seed) => {
        const { groups } = buildMenu(specs);
        const sel = validSelection(specs, seed);
        const independent = sel.reduce((sum, s) => {
          const g = groups[s.groupId] as ModifierGroup;
          const o = g.options.find((x) => x.id === s.modifierId);
          return sum + (o ? o.priceMinor : Number.NaN);
        }, 0);
        expect(selectionPriceMinor(groups, sel)).toBe(independent);
      }),
    );
  });

  it("defaults are always within max and always validate for optional-only menus", () => {
    fc.assert(
      fc.property(menuArb, (specs) => {
        const optionalSpecs = specs.map((s) => ({ ...s, min: 0 }));
        const { item, groups } = buildMenu(optionalSpecs);
        // mark first option of each group default
        for (const g of Object.values(groups)) {
          (g.options[0] as { isDefault?: boolean }).isDefault = true;
        }
        const seeded = defaultSelections(item, groups);
        expect(validateModifiers(item, groups, seeded)).toEqual({ valid: true });
      }),
    );
  });
});
