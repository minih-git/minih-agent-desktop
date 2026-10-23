import assert from "node:assert/strict";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, it, vi, beforeEach, afterEach } from "vitest";
import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
vi.mock("@capacitor/filesystem", () => ({
  Directory: {
    Documents: "DOCUMENTS",
    Data: "DATA",
    Cache: "CACHE",
    External: "EXTERNAL",
    ExternalStorage: "EXTERNAL_STORAGE",
    Library: "LIBRARY",
  },
  Filesystem: {
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
  },
}));
import { buildResources, DEFAULT_LOCALE } from "../../locales/index.js";

import {
  MediaViewer,
  type MediaViewerItem,
  isAbortOrCancel,
  prepareCacheFileForShare,
  cleanupCacheFiles,
  triggerWebDownload,
} from "./MediaViewer.js";

async function renderViewer(props: {
  open: boolean;
  items: readonly MediaViewerItem[];
  initialIndex?: number;
}): Promise<string> {
  const i18n = createInstance();
  await i18n.init({
    lng: DEFAULT_LOCALE,
    resources: buildResources(),
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(MediaViewer, {
        open: props.open,
        onClose: () => {},
        items: props.items,
        initialIndex: props.initialIndex,
      }),
    ),
  );
}

describe("MediaViewer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing when open is false", async () => {
    const markup = await renderViewer({
      open: false,
      items: [{ id: "m1", url: "blob:http://localhost/m1" }],
    });
    assert.equal(markup, "");
  });

  it("renders dialog, image, share, and save buttons on web", async () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(false);
    const markup = await renderViewer({
      open: true,
      items: [
        { id: "m1", url: "blob:http://localhost/m1", name: "test.png" },
      ],
    });
    assert.match(markup, /role="dialog"/);
    assert.match(markup, /aria-label="Image viewer"/);
    assert.match(markup, /src="blob:http:\/\/localhost\/m1"/);
    assert.match(markup, /aria-label="Close"/);
    assert.match(markup, /aria-label="Save image"/);
    assert.match(markup, /aria-label="Share image"/);
    assert.doesNotMatch(markup, /aria-label="Save or share"/);
  });

  it("renders save-or-share button on native platform", async () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
    const markup = await renderViewer({
      open: true,
      items: [
        { id: "m1", url: "blob:http://localhost/m1", name: "test.png" },
      ],
    });
    assert.match(markup, /role="dialog"/);
    assert.match(markup, /aria-label="Save or share"/);
    // Native should not show separate web download button
    assert.doesNotMatch(markup, /aria-label="Save image"/);
  });

  it("renders count and navigation buttons when multiple items exist", async () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(false);
    const markup = await renderViewer({
      open: true,
      items: [
        { id: "m1", url: "blob:http://localhost/m1" },
        { id: "m2", url: "blob:http://localhost/m2" },
      ],
      initialIndex: 0,
    });
    assert.match(markup, /1 \/ 2/);
    assert.match(markup, /aria-label="Next image"/);
  });

  it("identifies abort, dismiss, and cancel errors without false negatives", () => {
    assert.equal(isAbortOrCancel(null), false);
    assert.equal(isAbortOrCancel(new Error("Network failed")), false);
    assert.equal(isAbortOrCancel(new Error("AbortError: user aborted")), true);
    assert.equal(isAbortOrCancel(new Error("Share was canceled by user")), true);
    assert.equal(isAbortOrCancel(new Error("Dialog dismissed")), true);
    assert.equal(isAbortOrCancel({ name: "AbortError" }), true);
    assert.equal(isAbortOrCancel("User cancelled"), true);
  });

  it("writes verified bytes to Directory.Cache and returns temporary path and URI", async () => {
    const fakeData = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const writeSpy = vi.spyOn(Filesystem, "writeFile").mockResolvedValue({
      uri: "file:///var/mobile/Containers/Data/Application/123/Library/Caches/share_123_sample.png",
    });

    const result = await prepareCacheFileForShare({
      id: "img-1",
      url: fakeData,
      name: "sample.png",
    });

    assert.equal(writeSpy.mock.calls.length, 1);
    const callArg = writeSpy.mock.calls[0]?.[0];
    assert.equal(callArg?.directory, Directory.Cache);
    assert.match(callArg?.path ?? "", /^share_\d+_sample\.png$/);
    assert.equal(callArg?.recursive, true);
    assert.equal(result.uri, "file:///var/mobile/Containers/Data/Application/123/Library/Caches/share_123_sample.png");
  });

  it("cleans up temporary cache files via deleteFile", async () => {
    const deleteSpy = vi.spyOn(Filesystem, "deleteFile").mockResolvedValue();

    await cleanupCacheFiles(["share_1_test.png", "share_2_test.png"]);

    assert.equal(deleteSpy.mock.calls.length, 2);
    assert.equal(deleteSpy.mock.calls[0]?.[0]?.directory, Directory.Cache);
    assert.equal(deleteSpy.mock.calls[0]?.[0]?.path, "share_1_test.png");
    assert.equal(deleteSpy.mock.calls[1]?.[0]?.directory, Directory.Cache);
    assert.equal(deleteSpy.mock.calls[1]?.[0]?.path, "share_2_test.png");
  });
  it("triggers web download via anchor click without asserting saved state", () => {
    const clickSpy = vi.fn();
    const fakeAnchor = {
      href: "",
      download: "",
      click: clickSpy,
    };
    const appendSpy = vi.fn();
    const removeSpy = vi.fn();

    const originalDocument = (globalThis as unknown as { document?: unknown }).document;
    (globalThis as unknown as { document: unknown }).document = {
      createElement: vi.fn().mockReturnValue(fakeAnchor),
      body: {
        appendChild: appendSpy,
        removeChild: removeSpy,
      },
    };

    try {
      triggerWebDownload("blob:http://localhost/sample", "sample.png");
      assert.equal(clickSpy.mock.calls.length, 1);
      assert.equal(fakeAnchor.download, "sample.png");
      assert.equal(fakeAnchor.href, "blob:http://localhost/sample");
      assert.equal(appendSpy.mock.calls.length, 1);
      assert.equal(removeSpy.mock.calls.length, 1);
    } finally {
      (globalThis as unknown as { document: unknown }).document = originalDocument;
    }
  });

  it("locales contain downloadStarted and do not describe web download as saved", () => {
    const resources = buildResources();
    for (const [lang, bundle] of Object.entries(resources)) {
      const translation = bundle.translation as Record<string, string>;
      assert.ok(translation["mediaViewer.downloadStarted"], `missing downloadStarted in ${lang}`);
      assert.ok(translation["mediaViewer.saveOrShare"], `missing saveOrShare in ${lang}`);
      assert.notEqual(translation["mediaViewer.downloadStarted"], translation["mediaViewer.saved"]);
    }
  });
});
