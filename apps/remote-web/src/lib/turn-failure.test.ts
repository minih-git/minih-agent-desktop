import { describe, expect, it } from "vitest";

import { describeTurnFailure } from "./turn-failure.js";

describe("describeTurnFailure", () => {
  it("keeps the status and the provider's sentence, and drops the JSON envelope", () => {
    const raw =
      '401: {"message":"Authentication Fails, Your api key: ****f073 is invalid (request_id: 595f21d0-4db1-41eb-98fe-d8d2f4990951)","type":"authentication_error","param":null,"code":"invalid_api_key"}';
    expect(describeTurnFailure(raw)).toEqual({
      status: 401,
      reason: "Authentication Fails, Your api key: ****f073 is invalid",
    });
  });

  it("unwraps a nested error object and a bare request id", () => {
    const raw = '429: {"error":{"message":"Rate limit reached"},"request_id":"abc-123"}';
    expect(describeTurnFailure(raw)).toEqual({ status: 429, reason: "Rate limit reached" });
  });

  it("unwraps a JSON body that carries no status", () => {
    expect(describeTurnFailure('{"message":"Model not found"}')).toEqual({
      reason: "Model not found",
    });
  });

  it("passes plain text through unchanged", () => {
    expect(describeTurnFailure("the host went away")).toEqual({ reason: "the host went away" });
  });

  it("keeps a body that is not valid JSON instead of dropping the reason", () => {
    const raw = '500: {"message":"truncated';
    expect(describeTurnFailure(raw)).toEqual({ status: 500, reason: '{"message":"truncated' });
  });

  it("reports an empty message as empty, so no banner is drawn", () => {
    expect(describeTurnFailure("   ")).toEqual({ reason: "" });
  });

  it("drops a body that is only an envelope", () => {
    // A complete payload with no sentence in it is protocol structure, not a
    // reason: showing it would print JSON into the timeline.
    expect(describeTurnFailure('{"event":{"type":"error","error":{"code":"INTERNAL"}}}')).toEqual({
      reason: "",
    });
  });
});