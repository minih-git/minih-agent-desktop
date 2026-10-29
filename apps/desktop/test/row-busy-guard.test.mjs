import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("a row busy guard tracks rows independently", async () => {
  const { createRowBusyGuard } = await import("../src/lib/row-busy-guard.ts");

  const guard = createRowBusyGuard();
  assert.equal(guard.begin("provider:p1"), true);
  assert.equal(guard.isBusy("provider:p1"), true);

  // The same row cannot double-claim — this is the double-click guard.
  assert.equal(guard.begin("provider:p1"), false);

  // Another row claims freely: one busy row never blocks or clears another.
  assert.equal(guard.begin("provider:p2"), true);
  assert.equal(guard.isBusy("provider:p2"), true);

  // Releasing the first row leaves the second one's guard in place — the
  // single-slot regression this guard replaces cleared every row here.
  guard.end("provider:p1");
  assert.equal(guard.isBusy("provider:p1"), false);
  assert.equal(guard.begin("provider:p1"), true);
  assert.equal(guard.isBusy("provider:p2"), true);

  guard.end("provider:p2");
  guard.end("provider:p2"); // releasing twice stays safe
  assert.equal(guard.isBusy("provider:p2"), false);
});

test("other providers section rows keep independent busy guards", async () => {
  const otherProvidersSource = await read("../src/components/settings/OtherProvidersSection.tsx");
  assert.match(otherProvidersSource, /import \{ useRowBusy \} from "\.\.\/\.\.\/hooks\/use-row-busy"/);
  assert.match(otherProvidersSource, /const rowBusy = useRowBusy\(\)/);
  assert.match(otherProvidersSource, /const testingRows = useRowBusy\(\)/);

  for (const name of ["toggleEnabled", "removeProvider", "saveProviderKey", "testProvider"]) {
    const start = otherProvidersSource.indexOf(`const ${name} = async`);
    assert.ok(start >= 0, `${name} missing`);
    const body = otherProvidersSource.slice(start, start + 1600);
    assert.match(body, /if \(!rowBusy\.begin\(provider\.id\)\) return/, `${name} must claim its row`);
    assert.match(body, /rowBusy\.end\(provider\.id\)/, `${name} must release its row`);
  }

  assert.doesNotMatch(otherProvidersSource, /busyId/);
  assert.doesNotMatch(otherProvidersSource, /testingId/);
  assert.match(otherProvidersSource, /isRowBusy=\{\(id\) => rowBusy\.isBusy\(id\) \|\| busyAccountId === id\}/);
  assert.match(otherProvidersSource, /isTesting=\{testingRows\.isBusy\}/);
});

test("provider test spinners remain independent while requests overlap", async () => {
  const otherProvidersSource = await read("../src/components/settings/OtherProvidersSection.tsx");
  const serviceListSource = await read("../src/components/settings/ServiceList.tsx");

  assert.match(otherProvidersSource, /testingRows\.begin\(provider\.id\)/);
  assert.match(otherProvidersSource, /testingRows\.end\(provider\.id\)/);
  assert.match(serviceListSource, /isTesting: \(providerId: string\) => boolean/);
  assert.match(serviceListSource, /testing=\{isTesting\(provider\.id\)\}/);
  assert.doesNotMatch(serviceListSource, /testingId/);
});
