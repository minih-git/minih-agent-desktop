import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { ipcErrorCode } = await import("../electron/main/ipc/error-code.ts");
const { remoteHostErrorKey } = await import("../src/lib/remote-host-errors.ts");

/** A failure that crossed a Host boundary: `RacpError` keeps its code in `code`. */
function racpError(code) {
  const error = new Error(`remote failure ${code}`);
  error.name = "RacpError";
  error.code = code;
  return error;
}

/** The renderer-side error `api.invoke` throws: the envelope code lands in `code`. */
function rendererError(code) {
  const error = new Error("remote host refused");
  error.code = code;
  return error;
}

test("a remote host refusal keeps the code it was thrown with", () => {
  assert.equal(ipcErrorCode(racpError("REMOTE_PATH_FORBIDDEN")), "REMOTE_PATH_FORBIDDEN");
  assert.equal(ipcErrorCode(racpError("HOST_DISCONNECTED")), "HOST_DISCONNECTED");
  assert.equal(ipcErrorCode(racpError("METHOD_NOT_FOUND")), "METHOD_NOT_FOUND");
});

test("a main-process application error keeps its declared code", () => {
  assert.equal(ipcErrorCode(Object.assign(new Error("no"), { errorCode: "INVALID_ARGUMENT" })), "INVALID_ARGUMENT");
  assert.equal(
    ipcErrorCode(Object.assign(new Error("no"), { data: { errorCode: "PERMISSION_DENIED", retriable: false } })),
    "PERMISSION_DENIED",
  );
});

test("an operating-system errno is not an application code", () => {
  // A Node system error carries `code` too; reporting ENOENT as the call's
  // code would leak an errno into a contract the renderer switches on.
  assert.equal(ipcErrorCode(Object.assign(new Error("no such file"), { code: "ENOENT" })), "INTERNAL");
  assert.equal(ipcErrorCode(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })), "INTERNAL");
  assert.equal(ipcErrorCode(new Error("plain")), "INTERNAL");
  assert.equal(ipcErrorCode(undefined), "INTERNAL");
});

test("a folder picker refusal names the reason instead of a generic failure", () => {
  assert.equal(remoteHostErrorKey(rendererError("REMOTE_PATH_NOT_FOUND")), "remote:pathUnavailable");
  assert.equal(remoteHostErrorKey(rendererError("REMOTE_PATH_FORBIDDEN")), "remote:pathForbidden");
  assert.equal(remoteHostErrorKey(rendererError("HOST_DISCONNECTED")), "remote:connectionUnavailable");
  assert.equal(remoteHostErrorKey(rendererError("AGENT_UNAVAILABLE")), "remote:connectionUnavailable");
  assert.equal(remoteHostErrorKey(rendererError("TIMEOUT")), "remote:connectionUnavailable");
  assert.equal(remoteHostErrorKey(rendererError("HOST_UNAUTHORIZED")), "remote:authenticationRequired");
  assert.equal(remoteHostErrorKey(rendererError("FORBIDDEN")), "remote:permissionDenied");
});

test("a Host that predates the operation is reported as needing an upgrade", () => {
  // The desktop Host refuses an operation it does not implement with an
  // unknown method rather than a version mismatch; both mean the same thing
  // to the person: upgrade that Host.
  assert.equal(remoteHostErrorKey(rendererError("METHOD_NOT_FOUND")), "remote:upgradeRequired");
  assert.equal(remoteHostErrorKey(rendererError("CAPABILITY_UNAVAILABLE")), "remote:upgradeRequired");
  assert.equal(remoteHostErrorKey(rendererError("PROTOCOL_MISMATCH")), "remote:upgradeRequired");
  assert.equal(remoteHostErrorKey(rendererError("HOST_VERSION_MISMATCH")), "remote:upgradeRequired");
});

test("an unreadable Host answer is not reported as a connection problem", () => {
  // The Host answered; the two ends disagree about the shape of that answer.
  // "Check the Host connection and try again" sent people to diagnose a
  // connection that was working, which is what this code exists to stop.
  assert.equal(remoteHostErrorKey(rendererError("REMOTE_RESPONSE_INVALID")), "remote:responseUnrecognized");
});

test("a code this Desktop does not know stays a generic failure", () => {
  assert.equal(remoteHostErrorKey(rendererError("INTERNAL")), "remote:operationFailed");
  assert.equal(remoteHostErrorKey(undefined), "remote:operationFailed");
});