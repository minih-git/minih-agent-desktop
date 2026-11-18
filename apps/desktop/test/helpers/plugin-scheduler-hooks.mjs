export async function resolve(specifier, context, next) {
  if (specifier === "electron") {
    return { url: new URL("./plugin-scheduler-electron-stub.mjs", import.meta.url).href, shortCircuit: true };
  }
  if (specifier === "@minih-agent/shared") {
    return { url: new URL("../../../../packages/shared/dist/index.js", import.meta.url).href, shortCircuit: true };
  }
  if (specifier === "@minih-agent/plugin-sdk") {
    return { url: new URL("../../../../packages/plugin-sdk/dist/index.js", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
