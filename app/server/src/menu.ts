/**
 * The published menu snapshot the server runs on. In the full build this
 * comes from menu_snapshot rows in PostgreSQL; for the skeleton it is one
 * frozen in-code snapshot (same immutability rule: nothing mutates it).
 * Shapes are the E3 types, so the REAL validator guards every add_item.
 */
import type { GroupIndex, MenuItemSpec } from "@restaurantos/domain";

export interface MenuEntry extends MenuItemSpec {
  priceMinor: number;
  course: "BEVERAGE" | "ANTIPASTI" | "PRIMI" | "SECONDI" | "DOLCI";
  station: string;
}

export const SNAPSHOT_ID = "snap-0001";

export const GROUPS: GroupIndex = {
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
      { id: "parm", name: "Extra parmigiano", priceMinor: 300 },
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
    options: [
      { id: "rare", name: "Rare", priceMinor: 0 },
      { id: "mr", name: "Medium rare", priceMinor: 0 },
      { id: "med", name: "Medium", priceMinor: 0 },
      { id: "mw", name: "Medium well", priceMinor: 0 },
    ],
  },
  size: {
    id: "size", name: "Size", minSelect: 1, maxSelect: 1,
    options: [
      { id: "glass", name: "Glass", priceMinor: 0, isDefault: true },
      { id: "bottle", name: "Bottle", priceMinor: 2600 },
    ],
  },
};

export const MENU: readonly MenuEntry[] = [
  { id: "burrata", name: "Burrata e Prosciutto", priceMinor: 1600, course: "ANTIPASTI", station: "FREDDO", modifierGroupIds: [] },
  { id: "calamari", name: "Calamari Fritti", priceMinor: 1500, course: "ANTIPASTI", station: "SAUTE", modifierGroupIds: [] },
  { id: "ragu", name: "Ragu alla Bolognese", priceMinor: 2400, course: "PRIMI", station: "SAUTE", modifierGroupIds: ["pasta", "additions"] },
  { id: "cacio", name: "Cacio e Pepe", priceMinor: 2100, course: "PRIMI", station: "SAUTE", modifierGroupIds: ["pasta", "additions"] },
  { id: "bistecca", name: "Bistecca Fiorentina", priceMinor: 9800, course: "SECONDI", station: "GRILL", modifierGroupIds: ["temp"] },
  { id: "branzino", name: "Branzino al Forno", priceMinor: 3400, course: "SECONDI", station: "GRILL", modifierGroupIds: [] },
  { id: "tiramisu", name: "Tiramisu della Casa", priceMinor: 1200, course: "DOLCI", station: "FREDDO", modifierGroupIds: [] },
  { id: "chianti", name: "Chianti Classico", priceMinor: 1400, course: "BEVERAGE", station: "BAR", modifierGroupIds: ["size"] },
  { id: "acqua", name: "Acqua Panna", priceMinor: 600, course: "BEVERAGE", station: "BAR", modifierGroupIds: [] },
];

export function findMenuEntry(id: string): MenuEntry | undefined {
  return MENU.find((m) => m.id === id);
}
