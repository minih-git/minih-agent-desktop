/**
 * A group write refused over the pinned-memory cap reaches the user in their own
 * language (ADR 0249 §8): the dialogs translate that one host code, and every
 * other failure keeps the host's own message.
 *
 * The catalogs and the shared code registry are the closest testable interface —
 * `ProjectCreateDialog` and `ProjectEditDialog` only call
 * `projectGroupWriteError` and display what it returns through their existing
 * toast/`onError` path.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { ErrorCodes } from "@minih-agent/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { projectGroupErrorCode, projectGroupWriteError } = await import(
  "../src/lib/project-group-errors.ts"
);
const { catalogs, flattenCatalog } = await import("../../../packages/i18n/src/index.ts");

const LOCALES = ["en", "de", "es", "fr", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"];

test("the over-cap refusal is explained in every locale", () => {
  const code = ErrorCodes.PROJECT_MEMORY_TOO_LARGE;
  assert.equal(code, "PROJECT_MEMORY_TOO_LARGE");
  for (const locale of LOCALES) {
    const catalog = flattenCatalog(catalogs[locale]);
    const message = catalog["project.memoryTooLarge"];
    assert.equal(
      typeof message === "string" && message.trim().length > 0,
      true,
      `${locale} is missing project.memoryTooLarge`,
    );
    const localized = projectGroupWriteError({ code }, (key) => catalog[key] ?? key);
    assert.equal(localized instanceof Error, true, locale);
    assert.equal(localized.message, message, locale);
    assert.equal(localized.code, code, locale);
  }
});

test("every other failure keeps the host's own message", () => {
  const passthrough = (key) => key;
  const hostFailure = new Error("project group not found");
  const otherFailure = { code: ErrorCodes.INVALID_PARAMS, message: "invalid params" };
  assert.equal(projectGroupWriteError(hostFailure, passthrough), hostFailure);
  assert.equal(projectGroupWriteError(otherFailure, passthrough), otherFailure);
  assert.equal(projectGroupErrorCode(hostFailure), undefined);
  assert.equal(projectGroupErrorCode({ errorCode: "INVALID_PARAMS" }), "INVALID_PARAMS");
  assert.equal(projectGroupWriteError("boom", passthrough), "boom");
});
