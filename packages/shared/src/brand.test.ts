import { describe, expect, it } from "vitest";
import {
  BRAND_PROFILES,
  brandProfileFor,
  currentAppId,
  currentAppName,
  currentBrandProfile,
  resolveBrandName,
} from "./brand.js";

const env = (values: Record<string, string | undefined>) => (key: string) =>
  values[key];

describe("resolveBrandName", () => {
  it("prefers DESKTOP_BRAND over the Vite-prefixed variables", () => {
    expect(
      resolveBrandName(
        env({
          DESKTOP_BRAND: "hungraim",
          MAIN_VITE_DESKTOP_BRAND: "minih",
          VITE_DESKTOP_BRAND: "minih",
        }),
      ),
    ).toBe("hungraim");
    expect(
      resolveBrandName(
        env({
          MAIN_VITE_DESKTOP_BRAND: "hungraim",
          VITE_DESKTOP_BRAND: "minih",
        }),
      ),
    ).toBe("hungraim");
    expect(resolveBrandName(env({ VITE_DESKTOP_BRAND: "hungraim" }))).toBe(
      "hungraim",
    );
  });

  it("falls back to minih for absent, empty, or unknown values", () => {
    expect(resolveBrandName(env({}))).toBe("minih");
    expect(resolveBrandName(env({ DESKTOP_BRAND: undefined }))).toBe("minih");
    expect(resolveBrandName(env({ DESKTOP_BRAND: "" }))).toBe("minih");
    expect(resolveBrandName(env({ DESKTOP_BRAND: "   " }))).toBe("minih");
    expect(resolveBrandName(env({ DESKTOP_BRAND: "acme" }))).toBe("minih");
    expect(
      resolveBrandName(env({ DESKTOP_BRAND: "acme", VITE_DESKTOP_BRAND: "hungraim" })),
      "an invalid higher-priority key must not shadow a valid one",
    ).toBe("hungraim");
  });

  it("matches brand names case-insensitively", () => {
    expect(resolveBrandName(env({ DESKTOP_BRAND: " HUNGRAIM " }))).toBe("hungraim");
    expect(resolveBrandName(env({ DESKTOP_BRAND: "Minih" }))).toBe("minih");
  });
});

describe("brand profiles", () => {
  it("keeps the minih profile byte-compatible with the pre-branding release", () => {
    const minih = BRAND_PROFILES.minih;
    expect(minih.productName).toBe("Minih-Agent-Desktop");
    expect(minih.appId).toBe("org.hmini.agent");
    expect(minih.dataDirName).toBe(".minih-agent-desktop");
    expect(minih.devDataDirName).toBe(".minih-agent-desktop-dev");
    expect(minih.devInstallationName).toBe("Minih-Agent-Desktop Dev");
    expect(minih.dataDirOverrideEnv).toBe("MINIH_AGENT_DATA_DIR");
    expect(minih.compatDataDirOverrideEnv).toBeUndefined();
    expect(minih.updateFeed).toEqual({
      provider: "github",
      owner: "minih-git",
      repo: "minih-agent-desktop",
    });
    expect(minih.releasesUrl).toBe(
      "https://github.com/minih-git/minih-agent-desktop/releases/latest",
    );
    expect(minih.agentHostCliDownloadBase).toBe(
      "https://github.com/minih-git/minih-agent-desktop/releases/download",
    );
    expect(minih.routerDefaultBaseUrl).toBe("https://router.hmini.org/v1");
    expect(minih.easyTierNetworkName).toBe("minih-router");
    expect(minih.easyTierPeers).toEqual([
      "udp://router.hmini.org:11012",
      "tcp://router.hmini.org:11012",
    ]);
    expect(minih.easyTierRouterLanUrl).toBe("http://11.12.0.1:3001/v1");
  });

  it("describes the hungraim profile", () => {
    const hungraim = BRAND_PROFILES.hungraim;
    expect(hungraim.productName).toBe("Hungraim-Agent-Desktop");
    expect(hungraim.appId).toBe("com.hungraim.agent");
    expect(hungraim.dataDirName).toBe(".hungraim-agent-desktop");
    expect(hungraim.devDataDirName).toBe(".hungraim-agent-desktop-dev");
    expect(hungraim.devInstallationName).toBe("Hungraim-Agent-Desktop Dev");
    expect(hungraim.dataDirOverrideEnv).toBe("HUNGRAIM_AGENT_DATA_DIR");
    expect(hungraim.compatDataDirOverrideEnv).toBe("MINIH_AGENT_DATA_DIR");
    expect(hungraim.updateFeed).toEqual({
      provider: "generic",
      url: "https://updates.hungraim.com/desktop/stable",
    });
    expect(hungraim.releasesUrl).toBe("https://updates.hungraim.com/desktop/");
    expect(hungraim.agentHostCliDownloadBase).toBe(
      "https://updates.hungraim.com/desktop/agent-host-cli",
    );
    expect(hungraim.routerDefaultBaseUrl).toBe("https://aiapi.hungraim.com/v1");
    expect(hungraim.easyTierNetworkName).toBe("hungraim-router");
    expect(hungraim.easyTierPeers).toEqual([
      "udp://router-mesh.hungraim.com:11023",
      "tcp://router-mesh.hungraim.com:11023",
    ]);
    expect(hungraim.easyTierRouterLanUrl).toBe("http://11.123.0.1:3001/v1");
  });

  it("resolves unknown brand names to the minih profile", () => {
    expect(brandProfileFor("hungraim")).toBe(BRAND_PROFILES.hungraim);
    expect(brandProfileFor("minih")).toBe(BRAND_PROFILES.minih);
    expect(brandProfileFor("acme")).toBe(BRAND_PROFILES.minih);
    expect(brandProfileFor(undefined)).toBe(BRAND_PROFILES.minih);
    expect(brandProfileFor(null)).toBe(BRAND_PROFILES.minih);
  });
});

describe("currentBrandProfile", () => {
  it("falls back to the minih profile in plain Node, where no brand is injected", () => {
    // `__DESKTOP_BRAND__` only exists in bundles built by electron-vite with a
    // DESKTOP_BRAND value; tests and tooling must stay on the default brand.
    expect(currentBrandProfile()).toBe(BRAND_PROFILES.minih);
    expect(currentAppName()).toBe("Minih-Agent-Desktop");
    expect(currentAppId()).toBe("org.hmini.agent");
  });
});
