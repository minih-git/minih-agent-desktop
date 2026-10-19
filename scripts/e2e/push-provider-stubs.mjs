/**
 * Local APNs and FCM stubs for the redacted-push E2E (protocol §11.6).
 *
 * Both are real protocol endpoints over TLS, not mocks of the Gateway's
 * provider client:
 *
 * - APNs is **HTTP/2**, and every request's provider JWT is verified against the
 *   ES256 public key the operator "configured" — a JOSE-encoded signature, the
 *   right `kid`, and the right `iss`. A DER signature or a wrong team id fails
 *   here exactly as Apple would refuse it.
 * - FCM answers the OAuth2 token endpoint after verifying the service-account
 *   assertion's RS256 signature, `aud`, `iss`, `scope`, and `exp`, then accepts
 *   an HTTP v1 `messages:send` only with the access token it minted, and only
 *   when the message is *valid HTTP v1*: a field FCM does not define (the
 *   loc keys under `notification` were exactly that mistake) is answered with
 *   400 INVALID_ARGUMENT, as Google does.
 *
 * Nothing leaves the machine, and no credential used here exists outside the
 * run: the keys are generated per invocation and the tokens are fixtures.
 */
import { verify as cryptoVerify } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createSecureServer } from "node:http2";


/**
 * The fields HTTP v1 defines for the part of a message this Gateway sends, and
 * nothing else. Returns a reason string when the message is not valid, or null
 * when it is.
 *
 * `notification` is `{ title, body, image }` only — the localization keys belong
 * to `android.notification`, and a value like `title_loc_key` under
 * `notification` is exactly the bug this check exists to catch.
 */
function validateFcmMessage(parsed, options) {
  const message = parsed?.message;
  if (!message || typeof message !== "object") return "missing message";
  const allowed = ["token", "data", "android"];
  const extra = Object.keys(message).filter((key) => !allowed.includes(key));
  if (extra.length > 0) return `unknown message field: ${extra.join(", ")}`;
  if (message.token !== options.fcmToken) return "the message names another token";
  const data = message.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return "missing data";
  for (const [key, value] of Object.entries(data)) {
    // HTTP v1 `data` is a map of strings, and nothing about content is allowed.
    if (typeof value !== "string") return `data.${key} is not a string`;
    if (!["kind", "titleKey", "bodyKey", "hostId", "sessionId", "approvalId", "notifyId"].includes(key)) {
      return `unknown data field: ${key}`;
    }
  }
  const android = message.android;
  if (!android || typeof android !== "object") return "missing android block";
  const androidExtra = Object.keys(android).filter((key) => !["priority", "notification"].includes(key));
  if (androidExtra.length > 0) return `unknown android field: ${androidExtra.join(", ")}`;
  if (android.priority !== "high") return `android.priority is ${android.priority}`;
  const notification = android.notification;
  if (!notification || typeof notification !== "object") return "missing android.notification";
  const notificationExtra = Object.keys(notification).filter((key) => !["title_loc_key", "body_loc_key"].includes(key));
  if (notificationExtra.length > 0) return `unknown android.notification field: ${notificationExtra.join(", ")}`;
  for (const key of ["title_loc_key", "body_loc_key"]) {
    if (typeof notification[key] !== "string" || !/^[a-z0-9_]+$/.test(notification[key])) {
      return `android.notification.${key} is not an Android resource name`;
    }
  }
  return null;
}

/** One free loopback port, so the stub binds an address the Gateway can dial. */
export async function freePort() {
  const probe = createHttpServer();
  await new Promise((resolveListen) => probe.listen(0, "127.0.0.1", resolveListen));
  const { port } = probe.address();
  await new Promise((resolveClose) => probe.close(resolveClose));
  return port;
}

/** Decode one JWT segment as JSON; throws on garbage, which the caller treats as invalid. */
function segment(jwt, index) {
  return JSON.parse(Buffer.from(jwt.split(".")[index] ?? "", "base64url").toString("utf8"));
}

/**
 * @typedef {object} StubOptions
 * @property {string} cert PEM certificate both stubs present
 * @property {string} key PEM key for that certificate
 * @property {import("node:crypto").KeyObject} apnsPublicKey ES256 key the operator "configured"
 * @property {string} apnsKeyId the `kid` that key is registered under
 * @property {string} apnsTeamId the `iss` Apple expects
 * @property {import("node:crypto").KeyObject} fcmPublicKey RSA key of the service account
 * @property {string} projectId FCM project the messages are addressed to
 * @property {string} fcmAccessToken the token the FCM stub mints and then expects
 * @property {string} fcmClientEmail the service account the assertion must name
 * @property {string} fcmToken the registration token the message must address
 */

/**
 * @typedef {object} PushStubs
 * @property {string} apnsEndpoint `https://127.0.0.1:<port>` for `--apns-endpoint`
 * @property {string} fcmEndpoint `https://127.0.0.1:<port>` for `--fcm-endpoint`
 * @property {Array<{ token: string, topic?: string, jwtVerdict: string, payload: unknown }>} apnsRequests
 * @property {Array<{ path: string, authorization?: string, body: unknown }>} fcmRequests
 * @property {Array<{ grantType: string | null, verdict: string }>} fcmTokenRequests
 * @property {(token: string) => void} markApnsTokenDead
 * @property {(token: string) => void} markApnsTokenSilent
 * @property {() => Promise<void>} close
 */

/**
 * Start both stubs. The APNs stub listens on its own port and the FCM stub on
 * another, each with the same self-signed certificate.
 *
 * @param {StubOptions} options
 * @returns {Promise<PushStubs>}
 */
export async function startPushProviderStubs(options) {
  /** @type {PushStubs["apnsRequests"]} */
  const apnsRequests = [];
  /** @type {PushStubs["fcmRequests"]} */
  const fcmRequests = [];
  /** @type {PushStubs["fcmTokenRequests"]} */
  const fcmTokenRequests = [];
  const deadApnsTokens = new Set();
  /** Tokens whose next push is answered with silence, to exercise the deadline. */
  const silentApnsTokens = new Set();

  const apnsPort = await freePort();
  const apnsServer = createSecureServer({ cert: options.cert, key: options.key }, (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const path = String(request.headers[":path"] ?? "");
      const token = decodeURIComponent(path.replace("/3/device/", ""));
      const jwt = String(request.headers.authorization ?? "").replace(/^bearer\s+/i, "");
      let jwtVerdict = "malformed";
      try {
        const [header, claims, signature] = jwt.split(".");
        const verified = cryptoVerify(
          "sha256",
          Buffer.from(`${header}.${claims}`),
          { key: options.apnsPublicKey, dsaEncoding: "ieee-p1363" },
          Buffer.from(signature ?? "", "base64url"),
        );
        // What Apple checks: the signature, the key id, and the issuer.
        jwtVerdict =
          verified && segment(jwt, 0).kid === options.apnsKeyId && segment(jwt, 1).iss === options.apnsTeamId
            ? "valid"
            : "invalid";
      } catch {
        jwtVerdict = "malformed";
      }
      let payload = null;
      try {
        payload = body ? JSON.parse(body) : null;
      } catch {
        payload = { unparsable: true };
      }
      apnsRequests.push({ token, topic: request.headers["apns-topic"], jwtVerdict, payload });
      if (jwtVerdict !== "valid") {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify({ reason: "InvalidProviderToken" }));
        return;
      }
      if (silentApnsTokens.has(token)) {
        // Accept the request and answer nothing: what a wedged provider looks
        // like. The Gateway must give up on its own deadline, close the session,
        // and keep the other devices going.
        silentApnsTokens.delete(token);
        return;
      }
      if (deadApnsTokens.has(token)) {
        response.writeHead(410, { "content-type": "application/json" });
        response.end(JSON.stringify({ reason: "Unregistered" }));
        return;
      }
      response.writeHead(200);
      response.end();
    });
  });
  await new Promise((resolveListen, reject) => {
    apnsServer.once("error", reject);
    apnsServer.listen(apnsPort, "127.0.0.1", resolveListen);
  });

  const fcmPort = await freePort();
  // `fetch` in Node speaks HTTP/1.1, so this endpoint offers both ALPN protocols:
  // the OAuth2 exchange and the v1 send arrive over HTTP/1.1 TLS, and a client
  // that prefers h2 is still served.
  const fcmServer = createHttpsServer(
    { cert: options.cert, key: options.key, ALPNProtocols: ["http/1.1", "h2"] },
    (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      // This endpoint speaks HTTP/1.1 (the Gateway uses `fetch` for FCM), so the
      // request target is `url`, not the HTTP/2 `:path` header.
      const path = String(request.url ?? "/");
      if (path === "/token") {
        // The `aud` the assertion must carry: this stub's own token endpoint.
        const tokenUri = options.fcmTokenUri ?? `https://127.0.0.1:${fcmPort}/token`;
        const params = new URLSearchParams(body);
        const assertion = params.get("assertion") ?? "";
        let verdict = "malformed";
        try {
          const [header, claims, signature] = assertion.split(".");
          const verified = cryptoVerify(
            "RSA-SHA256",
            Buffer.from(`${header}.${claims}`),
            options.fcmPublicKey,
            Buffer.from(signature ?? "", "base64url"),
          );
          verdict =
            verified && segment(assertion, 1).scope === "https://www.googleapis.com/auth/firebase.messaging"
              ? "valid"
              : "invalid";
        } catch {
          verdict = "malformed";
        }
        const claimsForVerdict = verdict === "valid" ? segment(assertion, 1) : {};
        if (verdict === "valid") {
          // Google checks all four: a wrong audience, a wrong client, an expired
          // assertion, or a scope without the messaging grant is refused.
          const nowSeconds = Math.floor(Date.now() / 1000);
          const claimsOk =
            claimsForVerdict.aud === tokenUri &&
            claimsForVerdict.iss === options.fcmClientEmail &&
            claimsForVerdict.scope === "https://www.googleapis.com/auth/firebase.messaging" &&
            typeof claimsForVerdict.exp === "number" &&
            claimsForVerdict.exp > nowSeconds &&
            typeof claimsForVerdict.iat === "number" &&
            claimsForVerdict.iat <= nowSeconds + 60;
          if (!claimsOk) verdict = "wrong-claims";
        }
        fcmTokenRequests.push({ grantType: params.get("grant_type"), verdict });
        if (verdict !== "valid") {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ access_token: options.fcmAccessToken, expires_in: 3600, token_type: "Bearer" }),
        );
        return;
      }
      if (path === `/v1/projects/${options.projectId}/messages:send`) {
        let parsed = null;
        try {
          parsed = body ? JSON.parse(body) : null;
        } catch {
          parsed = { unparsable: true };
        }
        fcmRequests.push({
          path,
          ...(request.headers.authorization ? { authorization: String(request.headers.authorization) } : {}),
          body: parsed,
        });
        if (request.headers.authorization !== `Bearer ${options.fcmAccessToken}`) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { status: "UNAUTHENTICATED" } }));
          return;
        }
        const invalid = validateFcmMessage(parsed, options);
        if (invalid) {
          // What FCM answers for a message it cannot parse as HTTP v1. A Gateway
          // that put the localization keys anywhere else fails here.
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: { code: 400, status: "INVALID_ARGUMENT", message: invalid, details: [{ errorCode: "INVALID_ARGUMENT" }] },
            }),
          );
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ name: `projects/${options.projectId}/messages/1` }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { status: "NOT_FOUND" } }));
    });
  },
  );
  await new Promise((resolveListen, reject) => {
    fcmServer.once("error", reject);
    fcmServer.listen(fcmPort, "127.0.0.1", resolveListen);
  });

  return {
    apnsEndpoint: `https://127.0.0.1:${apnsPort}`,
    fcmEndpoint: `https://127.0.0.1:${fcmPort}`,
    apnsRequests,
    fcmRequests,
    fcmTokenRequests,
    markApnsTokenDead: (token) => deadApnsTokens.add(token),
    markApnsTokenSilent: (token) => silentApnsTokens.add(token),
    async close() {
      apnsServer.close();
      fcmServer.close();
      await once(apnsServer, "close").catch(() => undefined);
    },
  };
}
