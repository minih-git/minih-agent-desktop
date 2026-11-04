import { describe, expect, it } from "vitest";
import { classifyAgentError } from "./agent-errors.js";
import { classifyProviderError } from "./provider-retry.js";

const assistantError = (errorMessage: string) => ({
  role: "assistant",
  stopReason: "error",
  errorMessage,
} as const);

const overflow =
  "input length (9000 tokens) exceeds the model's maximum context length (8192 tokens)";

describe("provider error classification regressions", () => {
  it.each([400, 422])("recognizes explicit API-key rejection with HTTP %s", (status) => {
    const body = JSON.stringify({
      error: {
        code: status,
        message: "API key not valid. Please pass a valid API key.",
        status: "INVALID_ARGUMENT",
        details: [{ reason: "API_KEY_INVALID", domain: "googleapis.com" }],
      },
    });
    const expected = {
      code: "PROVIDER_UNAUTHORIZED",
      retriable: false,
      details: { providerStatus: status },
    };
    for (const error of [
      body,
      new Error(body),
      assistantError(body),
      `${status}: ${body}`,
      Object.assign(new Error("Invalid API key"), { status }),
    ]) {
      expect(classifyAgentError(error)).toMatchObject(expected);
      expect(classifyProviderError(error)).toMatchObject(expected);
    }
  });

  it.each([
    "400: Invalid API key",
    "400: API key not valid",
    '400: {"reason":"API_KEY_INVALID"}',
    "422: invalid_api_key",
  ])("recognizes the explicit key wording: %s", (message) => {
    expect(classifyAgentError(message)).toMatchObject({
      code: "PROVIDER_UNAUTHORIZED", retriable: false,
    });
  });

  it.each([
    "400: Invalid value at 'contents'",
    "400: permission denied",
    "422: unauthorized",
    "400: unknown parameter",
  ])("keeps an ordinary malformed request terminal: %s", (message) => {
    expect(classifyAgentError(message)).toMatchObject({
      code: "PROVIDER_ERROR", retriable: false,
    });
  });

  it.each(["invalid_api_key", "API key not valid", "API_KEY_INVALID", "unauthorized", "permission denied"])(
    "preserves statusless credential failures: %s", (message) => {
      expect(classifyAgentError(message)).toMatchObject({
        code: "PROVIDER_UNAUTHORIZED", retriable: false,
      });
    },
  );

  it.each([500, 502, 503])("makes an HTTP %s wrapped overflow terminal", (status) => {
    const body = JSON.stringify({ error: { code: status, message: overflow } });
    const expected = {
      code: "CONTEXT_TOO_LARGE",
      retriable: false,
      details: { providerStatus: status },
    };
    for (const error of [
      body,
      `${status}: ${body}`,
      assistantError(`${status} ${body}`),
      Object.assign(new Error(overflow), { status }),
      new Error(overflow, { cause: { statusCode: status } }),
    ]) {
      expect(classifyAgentError(error)).toMatchObject(expected);
      expect(classifyProviderError(error)).toMatchObject(expected);
    }
  });

  it.each([
    "500 Internal Server Error",
    "500: Internal Server Error",
    "502: upstream connect error or disconnect/reset before headers",
    "503 Service Unavailable",
    "503: overloaded",
    "503: Too many requests",
    "503: rate limit exceeded",
    "503: Throttling error: Too many tokens, please wait before trying again.",
    "503: rate limit: too many tokens, please wait before trying again.",
  ])("keeps ordinary and throttled 5xx retryable: %s", (message) => {
    expect(classifyAgentError(message)).toMatchObject({
      code: "PROVIDER_ERROR", retriable: true,
    });
  });

  it("keeps overflow, cancellation, local failure and credit exhaustion precedence", () => {
    expect(classifyAgentError("400: maximum context length exceeded; invalid API key"))
      .toMatchObject({ code: "CONTEXT_TOO_LARGE", retriable: false });
    expect(classifyAgentError({ ...assistantError(`503: ${overflow}`), stopReason: "aborted" }))
      .toMatchObject({ code: "TURN_ABORTED", retriable: false });
    expect(classifyAgentError({
      ...assistantError(`503: ${overflow}`),
      errorDetails: { code: "LOCAL_REQUEST_ERROR", phase: "request-preparation" },
    })).toMatchObject({ code: "INTERNAL", retriable: false });
    expect(classifyAgentError(`503: insufficient credits; ${overflow}`))
      .toMatchObject({ code: "PROVIDER_ERROR", retriable: false });
  });
});
