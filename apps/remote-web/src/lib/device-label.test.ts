import { describe, expect, it } from "vitest";

import { FALLBACK_DEVICE_LABEL, defaultDeviceLabel } from "./device-label.js";

describe("defaultDeviceLabel", () => {
  it("names the browser and the platform", () => {
    expect(
      defaultDeviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iPhone");
    expect(
      defaultDeviceLabel("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36"),
    ).toBe("Chrome on Android");
    expect(defaultDeviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/133.0")).toBe("Firefox on Windows");
    expect(defaultDeviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Edg/131.0.0.0")).toBe("Edge on macOS");
  });

  it("prefers the mobile browser token over the desktop one", () => {
    expect(
      defaultDeviceLabel("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/130.0 Safari/604.1"),
    ).toBe("Chrome on iPad");
  });

  it("falls back when the user agent carries nothing recognisable", () => {
    expect(defaultDeviceLabel("")).toBe(FALLBACK_DEVICE_LABEL);
    expect(defaultDeviceLabel("curl/8.7.1")).toBe(FALLBACK_DEVICE_LABEL);
  });

  it("uses whichever half it can recognise", () => {
    expect(defaultDeviceLabel("something Linux something")).toBe("Linux");
    expect(defaultDeviceLabel("Opera/9.80")).toBe("Opera");
  });
});
