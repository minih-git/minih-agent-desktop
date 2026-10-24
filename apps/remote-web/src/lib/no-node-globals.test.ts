/**
 * The phone's bundle may not reach Node's globals or Node's modules.
 *
 * Vite compiles every import the client pulls in, and a `Buffer.from` inside a
 * shared helper reaches the WebView as a bare `Buffer.from` — a name that does
 * not exist there. TypeScript cannot see this: `@types/node` is loaded for the
 * tests, so the call typechecks, and it is the runtime that disagrees. That is
 * exactly how a generated image once decoded fine in vitest and failed on the
 * phone.
 *
 * So this reads the sources that end up in the client bundle and refuses the two
 * shapes that cannot survive the trip: an identifier named `Buffer`, and an
 * import of `node:*`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/** Repository root, four levels up from `apps/remote-web/src/lib`. */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * The sources the client bundles: its own code and the shared contracts it
 * imports. Tests are their own kind of code and may use anything.
 */
const BUNDLED_DIRECTORIES = ["apps/remote-web/src", "packages/shared/src"];

function sourcesIn(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      found.push(...sourcesIn(path));
      continue;
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
    found.push(path);
  }
  return found;
}

/** The offences in one source text, as `line: reason`. */
function offencesIn(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const offences: string[] = [];
  const at = (node: ts.Node): string => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `line ${line + 1}`;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "Buffer") {
      offences.push(`${at(node)}: uses Buffer`);
    }
    const specifier =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
        ? node.moduleSpecifier
        : ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments.length === 1
          ? node.arguments[0]
          : undefined;
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith("node:")) {
      offences.push(`${at(specifier)}: imports ${specifier.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return offences;
}

describe("the phone's bundle", () => {
  it("names no Node global and imports no Node module", () => {
    const files = BUNDLED_DIRECTORIES.flatMap((directory) => sourcesIn(join(ROOT, directory)));
    // A scan that found nothing to read would pass for the wrong reason.
    expect(files.length).toBeGreaterThan(100);

    const offences = files.flatMap((file) =>
      offencesIn(file, readFileSync(file, "utf8")).map(
        (offence) => `${relative(ROOT, file).split(sep).join("/")}: ${offence}`,
      ),
    );
    expect(offences).toEqual([]);
  });

  it("recognises what it is looking for", () => {
    // The guard is only worth its runtime if it fails on the shape that shipped
    // the bug: a bare `Buffer.from` in a file the client bundles.
    expect(offencesIn("sample.ts", 'const bytes = Buffer.from("aGk=", "base64");')).toEqual([
      "line 1: uses Buffer",
    ]);
    expect(offencesIn("sample.ts", 'import { readFileSync } from "node:fs";')).toEqual([
      "line 1: imports node:fs",
    ]);
    expect(offencesIn("sample.ts", "// Buffer is mentioned in a comment only\nexport const a = 1;")).toEqual([]);
  });
});