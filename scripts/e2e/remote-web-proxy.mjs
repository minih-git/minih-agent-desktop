/**
 * E2E-266 test-only same-origin server for the H5 client.
 *
 * The H5 client is designed to be served by the Gateway origin itself: its CSP
 * allows `connect-src 'self'` only, and the Gateway sets both device cookies
 * with `Path=/hosts/{hostId}`. This harness therefore serves the built client
 * and reverse-proxies the Gateway client API under one origin, which is the
 * only way to drive the real cookie profile in a browser without adding a
 * static-file route to the Gateway.
 *
 * It is a fixture, not a product component: it listens on loopback only, is
 * never imported by the app, and its `/__control/` endpoints exist for this run
 * alone. The request log records header *presence* for every credential header
 * (never a value) and redacts a URL that carries a credential, so a leak is
 * detectable without writing a secret to disk.
 */
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Credential shapes that must never reach a URL, a query string, or the log. */
const CREDENTIAL_PREFIXES = ["pdt1.", "ppt1.", "mpt1:"];

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/** Bind one listener and resolve once it accepts connections. */
function listen(server, options) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

/**
 * Serve `options.distDir` at `/` and proxy `/v1/*` and `/hosts/*` to the
 * Gateway client port that `setGateway()` supplies once it is bound.
 *
 * @param {{ distDir: string, logPath: string }} options
 */
export async function startRemoteWebProxy(options) {
  const root = resolve(options.distDir);
  const logPath = options.logPath;
  const gateway = { host: "127.0.0.1", port: 0 };
  const entries = [];
  const streams = new Set();
  let sequence = 0;

  /** Append one request line to the JSONL log and keep it for the in-run queries. */
  function record(fields) {
    const entry = { seq: (sequence += 1), ts: new Date().toISOString(), ...fields };
    entries.push(entry);
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  /** Everything the run needs to know about a request, without a credential. */
  function describe(request, url) {
    const rawUrl = request.url ?? "/";
    const credentialInUrl = CREDENTIAL_PREFIXES.some((prefix) => rawUrl.includes(prefix));
    return {
      method: (request.method ?? "GET").toUpperCase(),
      url: credentialInUrl ? "<redacted: a credential appeared in the URL>" : rawUrl,
      credentialInUrl,
      origin: typeof request.headers.origin === "string" ? request.headers.origin : null,
      secFetchSite: typeof request.headers["sec-fetch-site"] === "string" ? request.headers["sec-fetch-site"] : null,
      cookie: Boolean(request.headers.cookie),
      authorization: Boolean(request.headers.authorization),
      csrf: Boolean(request.headers["x-csrf-token"]),
      lastEventId: typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : null,
      upstreamStatus: null,
      kind: url.pathname.startsWith("/hosts/") || url.pathname.startsWith("/v1/") ? "api" : "static",
    };
  }

  function serveStatic(response, url, entry) {
    const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    let filePath = resolve(root, relative);
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      entry.upstreamStatus = 403;
      response.writeHead(403).end("forbidden");
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      // A client-side route carries no extension; an unknown asset must not
      // answer with HTML, because that would hide a broken build behind a 200.
      if (extname(relative) !== "") {
        entry.upstreamStatus = 404;
        response.writeHead(404).end("not found");
        return;
      }
      filePath = join(root, "index.html");
    }
    entry.upstreamStatus = 200;
    response.writeHead(200, {
      "content-type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(readFileSync(filePath));
  }

  /** Reverse-proxy one API request; `done` runs once the upstream status is known. */
  function proxy(request, response, url, entry, isStream, done) {
    if (gateway.port === 0) {
      entry.upstreamStatus = 503;
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "the gateway client port is not set yet" }));
      done();
      return;
    }
    const headers = { ...request.headers, host: `${gateway.host}:${gateway.port}` };
    for (const name of HOP_BY_HOP) delete headers[name];
    const upstream = httpRequest(
      { host: gateway.host, port: gateway.port, method: request.method, path: `${url.pathname}${url.search}`, headers },
      (upstreamResponse) => {
        entry.upstreamStatus = upstreamResponse.statusCode ?? null;
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        if (isStream) {
          const active = { upstream, response, url: url.pathname };
          streams.add(active);
          const forget = () => streams.delete(active);
          upstreamResponse.once("close", forget);
          response.once("close", forget);
        }
        upstreamResponse.pipe(response);
        done();
      },
    );
    upstream.on("error", (error) => {
      entry.upstreamStatus = 502;
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `the gateway proxy failed: ${String(error)}` }));
      done();
    });
    request.pipe(upstream);
  }

  /**
   * Forcibly end proxied SSE streams; the browser sees a dropped connection.
   * `match` narrows the drop to one session's streams, so a run with several
   * open clients drops only the stream under test.
   */
  function dropStreams(match = "") {
    const dropped = [];
    for (const stream of [...streams]) {
      if (match && !stream.url.includes(match)) continue;
      streams.delete(stream);
      dropped.push(stream.url);
      stream.upstream.destroy();
      stream.response.destroy();
    }
    return dropped;
  }

  function control(request, response, url) {
    if (url.pathname === "/__control/log" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ entries }));
      return;
    }
    if (url.pathname === "/__control/drop-streams" && request.method === "POST") {
      const dropped = dropStreams(url.searchParams.get("match") ?? "");
      record({ kind: "control", method: "POST", url: url.pathname, credentialInUrl: false, dropped });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ dropped }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unknown control endpoint" }));
  }

  const handler = (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/__control/")) {
      control(request, response, url);
      return;
    }
    const entry = describe(request, url);
    if (entry.kind === "api") {
      proxy(request, response, url, entry, entry.method === "GET" && url.pathname.endsWith("/events"), () => record(entry));
      return;
    }
    serveStatic(response, url, entry);
    record(entry);
  };

  // `localhost` resolves to both loopback families and Chromium may try either
  // one first, so both are bound on the same port: the origin never depends on
  // which family the browser happened to pick.
  const servers = [createServer(handler)];
  await listen(servers[0], { host: "127.0.0.1", port: 0 });
  const port = servers[0].address().port;
  const v6 = createServer(handler);
  try {
    await listen(v6, { host: "::1", port, ipv6Only: true });
    servers.push(v6);
  } catch {
    // A host without an IPv6 loopback keeps the IPv4 listener only.
    v6.close();
  }

  return {
    /** Chromium treats `http://localhost` as a secure origin, so the Gateway's `Secure` cookies work. */
    origin: `http://localhost:${port}`,
    port,
    entries,
    dropStreams,
    setGateway(address) {
      gateway.host = address.host;
      gateway.port = address.port;
    },
    async close() {
      dropStreams();
      for (const listener of servers) {
        listener.closeAllConnections?.();
        await new Promise((resolveClose) => listener.close(() => resolveClose()));
      }
    },
  };
}
