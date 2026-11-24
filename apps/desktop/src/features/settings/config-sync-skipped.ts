/**
 * Which sentence reports one skill whose resources stayed behind.
 *
 * A skill folder can be larger than one encrypted package, so the host captures
 * its document and leaves the resources where they are, reporting the bound it
 * broke (`files`, `resourceBytes`, `packageBytes`) with the measured value and
 * the limit (ADR 0303 amendment 2). The numbers stay data and the sentence
 * stays translated, so this maps a reason to an interface key rather than
 * formatting host text.
 */
export function skippedPackageMessageKey(reason: string): string {
  switch (reason) {
    case "resourceBytes":
      return "settings.configSync.skippedPackageResourceBytes";
    case "packageBytes":
      return "settings.configSync.skippedPackageBytes";
    default:
      return "settings.configSync.skippedPackageFiles";
  }
}