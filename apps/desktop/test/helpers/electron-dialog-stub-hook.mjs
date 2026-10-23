/**
 * Module hook that stubs only the `electron` specifier with the recording
 * dialog in `electron-dialog-stub.mjs`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "electron") {
    return {
      url: pathToFileURL(join(here, "electron-dialog-stub.mjs")).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
