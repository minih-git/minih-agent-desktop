/**
 * Module hook that stubs only the `electron` specifier.
 *
 * `settings-ipc` reaches `network-proxy`, which imports Electron; the handler
 * under test is otherwise production code. Unlike
 * `network-proxy-module-stubs.mjs` this hook leaves real workspace packages
 * alone, so a test may also import the gateway bootstrap (and through it
 * `host-runtime`).
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "electron") {
    return {
      url: pathToFileURL(join(here, "network-proxy-electron-stub.mjs")).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
