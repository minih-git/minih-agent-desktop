/**
 * Browser entry for `@minih-agent/racp` (PR-1, D664 / ADR 0330). Exports only
 * Node-free pieces: the `RacpClient` and its types, the JSON-RPC codec, and
 * the `createHttpSseClient()` transport for the `RACP-HTTP` browser profile.
 *
 * A build check (see `test/browser-entry.test.mjs`) bundles this file with
 * esbuild on `platform: "browser"` and fails when a `node:` builtin or the
 * `ws` package is reachable, so the H5 client cannot accidentally pull Node
 * code into the browser bundle.
 */
export { RacpError, isRacpError } from "@minih-agent/agent-host";
export {
  encodeFrame,
  errorFromObject,
  isNotification,
  isRequest,
  isResponse,
  parseFrame,
  JSON_RPC_CODES,
  type JsonRpcErrorObject,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./jsonrpc.js";
export {
  RacpClient,
  type RacpClientOptions,
  type RacpClientState,
  type ClientTransport,
  type ClientTransportFactory,
  type SubscriptionClosedNotice,
} from "./client.js";
export { createHttpSseClient, type HttpSseClient, type HttpSseClientOptions } from "./http-sse.js";
