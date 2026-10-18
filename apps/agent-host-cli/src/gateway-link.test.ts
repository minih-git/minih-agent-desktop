import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentHostCliConfig } from "./config.js";
import { gatewayLinkPath, readGatewayLink, removeGatewayLink, writeGatewayLink } from "./gateway-link.js";
import { startAgentHostCli } from "./app.js";

const credentials = {
  hostId: "host_test",
  gatewayUrl: "wss://10.0.0.5:8787/v1/hostlink",
  gatewayCaPem: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n",
  certificatePem: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n",
  privateKeyPem: "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n",
  expiresAt: "2027-10-18T00:00:00.000Z",
};

describe("gateway link credentials", () => {
  const directories: string[] = [];

  afterEach(async () => {
    for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function dataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "host-gateway-link-"));
    directories.push(dir);
    return dir;
  }

  it("round-trips the credentials through a 0600 file", async () => {
    const dir = await dataDir();
    const path = await writeGatewayLink(dir, credentials);
    expect(path).toBe(gatewayLinkPath(dir));
    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
    expect(await readGatewayLink(dir)).toEqual(credentials);
  });

  it("reports an unenrolled Host as null and a corrupt file as a typed error", async () => {
    const dir = await dataDir();
    expect(await readGatewayLink(dir)).toBeNull();
    const path = gatewayLinkPath(dir);
    await mkdir(join(dir, "agent-host-cli"), { recursive: true, mode: 0o700 });
    await writeFile(path, "{not json", { mode: 0o600 });
    await expect(readGatewayLink(dir)).rejects.toMatchObject({ code: "GATEWAY_LINK_INVALID" });
    await writeFile(path, JSON.stringify({ hostId: "host_test" }), { mode: 0o600 });
    await expect(readGatewayLink(dir)).rejects.toMatchObject({ code: "GATEWAY_LINK_INVALID" });
  });

  it("removes the file and tolerates a missing one", async () => {
    const dir = await dataDir();
    await writeGatewayLink(dir, credentials);
    await removeGatewayLink(dir);
    await expect(readFile(gatewayLinkPath(dir), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(removeGatewayLink(dir)).resolves.toBeUndefined();
  });
});

describe("--gateway startup without enrollment", () => {
  const directories: string[] = [];

  afterEach(async () => {
    for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it("fails before spawning host-core or the sidecar", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-gateway-boot-"));
    directories.push(dir);
    // Both "binaries" would leave a marker behind if they were ever launched.
    const hostMarker = join(dir, "host-core-spawned");
    const sidecarMarker = join(dir, "sidecar-spawned");
    const probe = async (marker: string): Promise<string> => {
      const path = join(dir, `${marker.split("/").pop()}.sh`);
      await writeFile(path, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o700 });
      return path;
    };
    const config: AgentHostCliConfig = {
      dataDir: join(dir, "data"),
      host: "127.0.0.1",
      port: 0,
      hostCoreBinary: await probe(hostMarker),
      sidecarEntry: await probe(sidecarMarker),
      nodeBinary: process.execPath,
      pair: false,
      gateway: true,
      pairingLifetimeMs: 60_000,
      browseRoot: dir,
      logLevel: "error",
    };
    await expect(startAgentHostCli(config)).rejects.toMatchObject({ errorCode: "GATEWAY_LINK_MISSING" });
    // Nothing was launched, so neither marker exists.
    await expect(stat(hostMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(sidecarMarker)).rejects.toMatchObject({ code: "ENOENT" });
    // The message tells the operator what to do instead of naming internals.
    await expect(startAgentHostCli(config)).rejects.toThrow(/agent-host-cli enroll/);
  });
});
