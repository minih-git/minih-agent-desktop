import { RacpError } from "@minih-agent/racp/browser";
import { describe, expect, it } from "vitest";

import { failureFrom, reasonKeyForCode } from "./errors.js";

describe("failureFrom", () => {
  it("keeps the RACP code and retriability", () => {
    expect(failureFrom(new RacpError("AGENT_BUSY", "the host is busy"))).toEqual({
      code: "AGENT_BUSY",
      message: "the host is busy",
      retriable: false,
    });
    expect(failureFrom(new RacpError("TIMEOUT", "turn/start timed out", { retriable: true })).retriable).toBe(true);
  });

  it("maps a plain error to INTERNAL and keeps its message", () => {
    expect(failureFrom(new Error("socket closed"))).toEqual({
      code: "INTERNAL",
      message: "socket closed",
      retriable: true,
    });
  });

  it("never throws on a non-error value", () => {
    expect(failureFrom("nope")).toEqual({ code: "INTERNAL", message: "nope", retriable: true });
  });
});

describe("reasonKeyForCode", () => {
  it("maps the codes the client localizes", () => {
    expect(reasonKeyForCode("UNAUTHORIZED")).toBe("error.reason.unauthorized");
    expect(reasonKeyForCode("HOST_DISCONNECTED")).toBe("error.reason.disconnected");
    expect(reasonKeyForCode("PAIRING_TOKEN_EXPIRED")).toBe("error.reason.pairingExpired");
    expect(reasonKeyForCode("CAPABILITY_UNAVAILABLE")).toBe("error.reason.unsupported");
  });

  it("leaves an unknown code to the raw reason", () => {
    expect(reasonKeyForCode("SOMETHING_NEW")).toBeUndefined();
  });
});
