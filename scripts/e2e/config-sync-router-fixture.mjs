import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

// Independent verifier: this server implements the Minih Router client-backup
// contract itself and imports no production transport code. The account is
// identified by its bearer token, which namespaces every stored object, so the
// four isolated Host processes below share one destination the way four
// devices of one user do.
const accessKey = "fixture-router-access-key";
const maxBodyBytes = 64 * 1024 * 1024;
// The only objects a run may create: the vault header plus vault-scoped state.
const layout = /^(header|vault\/[^/]+\/(head|backup-head|revisions\/[^/]+|objects\/[^/]+))$/;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
// A strong, opaque etag that changes with every write, like the router.
const etagFor = (name, version) => `"${sha256(`${name}:${version}`).slice(0, 16)}-${version}"`;

export async function startRouterFixture(label) {
  const objects = new Map();
  const requests = [];
  let failureStatus = null;
  let probes = 0;
  let rejectedCredentials = 0;
  let tokenInUrl = 0;
  const errors = [];
  const server = createServer((request, response) => {
    const send = (status, body = Buffer.alloc(0), headers = {}) => {
      response.writeHead(status, { "Content-Length": body.length, ...headers });
      response.end(body);
    };
    void (async () => {
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > maxBodyBytes) return send(413);
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (request.headers.authorization !== `Bearer ${accessKey}`) {
        rejectedCredentials += 1;
        return send(401);
      }
      if (request.url.includes("?")) {
        tokenInUrl += 1;
        return send(400);
      }
      const path = decodeURIComponent(request.url);
      if (path === "/api/client-backup/probe" && request.method === "POST") {
        probes += 1;
        if (failureStatus) return send(failureStatus);
        return send(200, Buffer.from(JSON.stringify({ code: 0, data: { conditionalWrites: true } })), {
          "Content-Type": "application/json",
        });
      }
      const name = path.startsWith("/api/client-backup/objects/")
        ? path.slice("/api/client-backup/objects/".length)
        : null;
      if (!name) return send(404);
      requests.push({ method: request.method, name });
      if (failureStatus) return send(failureStatus);
      const existing = objects.get(name);
      switch (request.method) {
        case "GET":
          return existing
            ? send(200, existing.body, { ETag: existing.etag })
            : send(404);
        case "PUT": {
          const none = request.headers["if-none-match"];
          const match = request.headers["if-match"];
          if ((!none && !match) || (none && match)) return send(400);
          if ((none === "*" && existing) || (match && existing?.etag !== match)) return send(412);
          const version = (existing?.version ?? 0) + 1;
          const etag = etagFor(name, version);
          objects.set(name, { body, etag, version });
          return send(200, Buffer.alloc(0), { ETag: etag });
        }
        default:
          return send(405);
      }
    })().catch((error) => {
      errors.push(error);
      if (!response.headersSent) send(500);
      else response.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    kind: "local-router",
    label,
    account: { endpoint: `http://127.0.0.1:${server.address().port}`, accessKey },
    failWith(status) {
      failureStatus = status;
    },
    async inventory() {
      return [...objects.keys()].sort();
    },
    async inspect(markers) {
      assert.ok(objects.size > 0, "encrypted objects must exist");
      for (const { body } of objects.values()) {
        assert.ok(
          markers.every((marker) => !body.includes(Buffer.from(marker))),
          "remote plaintext leaked",
        );
      }
      assert.equal(rejectedCredentials, 0, "every Host request must present the fixture account token");
      assert.equal(tokenInUrl, 0, "the account token must never travel in a URL");
      assert.ok(probes > 0, "setup must run the router self-test instead of trusting configuration");
      // The router probe is a server-side self-test, so a run leaves no probe
      // object behind; only the documented vault layout may exist.
      assert.deepEqual(
        [...objects.keys()].filter((name) => !layout.test(name)),
        [],
        "a run must not create objects outside the vault layout",
      );
      return { objects: objects.size, requests: requests.length, probes, ciphertext: true, credentials: true };
    },
    async cleanup() {
      objects.clear();
      return { remaining: objects.size, versions: 0 };
    },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      if (errors.length) throw new AggregateError(errors, "router fixture failed");
    },
  };
}
