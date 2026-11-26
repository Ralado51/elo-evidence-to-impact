import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

const dir = new URL("../v3/catalogs/", import.meta.url);

test("JS-A2-05: web catalogs match MANIFEST sha256", () => {
  const manifest = JSON.parse(readFileSync(new URL("MANIFEST.json", dir), "utf8"));
  const files = readdirSync(dir).filter((f) => f !== "MANIFEST.json").sort();
  assert.deepEqual(files, Object.keys(manifest).sort());
  for (const f of files) {
    assert.equal(createHash("sha256").update(readFileSync(new URL(f, dir))).digest("hex"), manifest[f], f);
  }
});

test("JS-A2-05b: web catalogs equal contract sources byte for byte", () => {
  const a2 = new URL("../../contracts/CL06_3-A2/contracts/", import.meta.url);
  const eq = (a, b) => assert.ok(readFileSync(a).equals(readFileSync(b)), String(a));
  eq(new URL("goal-target-rules.v1.json", dir), new URL("catalogs/goal-target-rules.v1.json", a2));
  eq(new URL("units.json", dir), new URL("registries/units.json", a2));
});
