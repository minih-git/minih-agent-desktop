import { readMainSource } from "./helpers/source-contracts.mjs";
/**
 * The AI service is the authority on which models it serves.
 *
 * `providersListModels` used to answer from the bundled models.dev snapshot
 * before it ever contacted the endpoint, which offered every model a vendor
 * publishes — including ones a given deployment does not host and ones the key
 * is not entitled to. These tests pin the corrected order: resolve the endpoint,
 * probe the service through that resolution, enrich what it returned with
 * models.dev, and answer with nothing else when the endpoint publishes nothing
 * usable — a directory stand-in would make a rejected key look ready to save.
 */
import assert from "node:assert/strict";
import test from "node:test";

const mainSource = await readMainSource();

/** Body of the providersListModels handler, so offsets are local to it. */
const handler = (() => {
  const start = mainSource.indexOf("IPC.invoke.providersListModels");
  assert.notEqual(start, -1, "providersListModels handler not found");
  // The handler ends at its own fallback return; the next `handle(` registration
  // is not guaranteed to be the create one. The cache branch returns a bare
  // fallback too, so anchor on the live branch's shape (resolution + error) and
  // keep the closing lines of that return in the body.
  const endMarker = 'source: "fallback" as const,\n        ...resolution,';
  const end = mainSource.indexOf(endMarker, start);
  assert.notEqual(end, -1, "could not bound the handler body");
  return mainSource.slice(start, end + endMarker.length + 80);
})();

test("the live endpoint is probed before anything else answers", () => {
  const discovery = handler.indexOf("await probeDiscoveryCandidates(");
  assert.notEqual(discovery, -1, "live discovery call missing");
  assert.doesNotMatch(
    handler,
    /modelsDevCatalog\.modelsForProvider\(/,
    "the bundled catalog must not stand in for the service's own /models",
  );
});

test("the probe asks the resolved candidates, not the typed URL alone", () => {
  // The typed Base URL is a starting point: a bare host must be able to resolve
  // to the path that answers, and every candidate stays on the typed origin.
  assert.match(handler, /inferEndpointProfile\(\{/);
  assert.match(handler, /candidates: profile\.candidates/);
  assert.match(handler, /origin: profile\.origin/);
  // The renderer reads the answer from the IPC result instead of re-deriving it.
  assert.match(handler, /effectiveBaseUrl: outcome\.effectiveBaseUrl/);
  assert.match(handler, /discoveryStyle: outcome\.discoveryStyle/);
});

test("a refusal or empty answer is reported as a failure, not a directory list", () => {
  // The fallback return carries the discovery error and nothing else: the
  // renderer has to be able to tell the user the service published no list.
  const fallbackReturn = handler.slice(handler.indexOf("There is no catalog stand-in"));
  assert.ok(fallbackReturn.length > 0, "fallback return missing");
  assert.match(fallbackReturn, /error: discoveryError/);
  assert.doesNotMatch(fallbackReturn, /source: "catalog"/);
  // The live branch keeps its own distinct source value. What it returns may be
  // widened with the user's configured bindings, but only the rows the endpoint
  // actually served are cached, which the next test pins.
  const liveReturn = handler.slice(handler.indexOf("await cacheForCurrentProvider(models);"));
  assert.match(liveReturn.slice(0, 240), /source: "remote" as const/);
});

test("only a live answer is written back to the model cache", () => {
  // Caching a directory guess would make it indistinguishable from a real probe
  // on the next cold start.
  const cacheCall = handler.indexOf("await cacheForCurrentProvider(");
  const fallback = handler.indexOf("There is no catalog stand-in");
  assert.ok(cacheCall !== -1, "the live branch must cache what it served");
  assert.ok(cacheCall < fallback, "the cache write must belong to the live branch");
  assert.match(handler, /if \(!provider \|\| req\.source === "cache"\) return;/);
  // The cache key stays the saved endpoint, so a resolved candidate never
  // rewrites the cache of a row that has not been saved with it yet.
  assert.match(handler, /const requestBaseUrl = baseUrl\.replace/);
});

test("every returned model is enriched through the published models.dev catalog regardless of origin", () => {
  // `decorate` is what attaches published limits, modalities and thinking
  // levels, so the live branch must route through it.
  assert.match(handler, /const modelsDevModel = .*modelsDevCatalog\.publishedModelFor/);
  assert.match(handler, /outcome\.models\.map\(\(model\) => decorate\(model\)\)/);
});

test("the stored secret is resolved before probing, so edits need no retyped key", () => {
  const secret = handler.indexOf('"providers.getSecret"');
  const discovery = handler.indexOf("await probeDiscoveryCandidates(");
  assert.notEqual(secret, -1, "stored secret lookup missing");
  assert.ok(secret < discovery, "the key must be resolved before the probe");
});
