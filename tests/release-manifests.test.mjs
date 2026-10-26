import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parseEnv } from "node:util";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const version = JSON.parse(read("../package.json")).version;
const packages = ["types", "validation", "protocol", "client"];

test("public workspace packages and the release template share the candidate version", () => {
  assert.equal(parseEnv(read("../.env.example")).RELAYRTC_VERSION, version);
  for (const name of packages) {
    const manifest = JSON.parse(read(`../packages/${name}/package.json`));
    assert.equal(manifest.version, version, `${name} version drift`);
    assert.equal(manifest.publishConfig.access, "public");
    assert.ok(manifest.scripts.prepack, `${name} must build before packing`);
  }
});

test("public package entry points and publication documents exist after a build", () => {
  for (const name of packages) {
    const manifest = JSON.parse(read(`../packages/${name}/package.json`));
    for (const file of ["README.md", "LICENSE", "CHANGELOG.md", manifest.main, manifest.types]) {
      assert.ok(
        existsSync(new URL(`../packages/${name}/${file}`, import.meta.url)),
        `${name}: missing ${file}`,
      );
    }
    for (const entry of Object.values(manifest.exports)) {
      for (const file of Object.values(entry))
        assert.ok(
          existsSync(new URL(`../packages/${name}/${file}`, import.meta.url)),
          `${name}: missing export ${file}`,
        );
    }
  }
});
