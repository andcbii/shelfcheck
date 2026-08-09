import assert from "node:assert/strict";
import test from "node:test";
import { matchesSearch, normalizeSearchText } from "../lib/search";

test("search matching is case and diacritic insensitive", () => {
  assert.equal(matchesSearch("Pokémon Horizons", "pokemon"), true);
  assert.equal(matchesSearch("CAFÉ", "cafe"), true);
});

test("search normalization remains Unicode-safe", () => {
  assert.equal(normalizeSearchText("  Ångström  "), "angstrom");
  assert.equal(matchesSearch("Pokémon Horizons", "digimon"), false);
});
