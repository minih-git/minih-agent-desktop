import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  Aurora,
  AvatarButton,
  Banner,
  Button,
  Callout,
  Chip,
  EmptyState,
  ListGroup,
  ListRow,
  ModelPill,
  NavBar,
  Sheet,
  SkeletonRow,
  StatusDot,
  SwipeRow,
  Tag,
  Toast,
} from "../components/ui/index.js";
import {
  THEME_PREFERENCE_KEY,
  applyTheme,
  readThemePreference,
  resolveTheme,
  writeThemePreference,
  type ThemeDocument,
  type ThemeStorage,
} from "./theme.js";

const STYLES_CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/**
 * Appearance preference storage, token contract, and Aurora Glass primitives
 * (ADR mobile-redesign D4, D6).
 *
 * Pure node-env tests: storage and `document` are injected fakes, and blocked
 * `localStorage` must degrade to `"system"` without throwing.
 */
describe("readThemePreference", () => {
  it("defaults to system when nothing has been stored or storage is null", () => {
    expect(readThemePreference(null)).toBe("system");
    expect(readThemePreference(fakeStorage({}))).toBe("system");
  });

  it("reads a valid stored preference", () => {
    expect(readThemePreference(fakeStorage({ [THEME_PREFERENCE_KEY]: "dark" }))).toBe("dark");
    expect(readThemePreference(fakeStorage({ [THEME_PREFERENCE_KEY]: "light" }))).toBe("light");
    expect(readThemePreference(fakeStorage({ [THEME_PREFERENCE_KEY]: "system" }))).toBe("system");
  });

  it("degrades to system when the stored value is not a recognized preference", () => {
    expect(readThemePreference(fakeStorage({ [THEME_PREFERENCE_KEY]: "aurora" }))).toBe("system");
    expect(readThemePreference(fakeStorage({ [THEME_PREFERENCE_KEY]: "" }))).toBe("system");
  });

  it("degrades to system and never throws when localStorage access is blocked", () => {
    const blocked: ThemeStorage = {
      getItem: () => {
        throw new Error("SecurityError: storage blocked");
      },
      setItem: () => {
        throw new Error("SecurityError: storage blocked");
      },
    };
    expect(() => readThemePreference(blocked)).not.toThrow();
    expect(readThemePreference(blocked)).toBe("system");
  });
});

describe("writeThemePreference", () => {
  it("stores the chosen preference under the versioned key", () => {
    const storage = fakeStorage({});
    writeThemePreference("dark", storage);
    expect(storage.get(THEME_PREFERENCE_KEY)).toBe("dark");
    writeThemePreference("light", storage);
    expect(storage.get(THEME_PREFERENCE_KEY)).toBe("light");
    writeThemePreference("system", storage);
    expect(storage.get(THEME_PREFERENCE_KEY)).toBe("system");
  });

  it("never throws when storage is null or refuses the write", () => {
    const blocked: ThemeStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => writeThemePreference("dark", blocked)).not.toThrow();
    expect(() => writeThemePreference("light", null)).not.toThrow();
  });
});

describe("resolveTheme", () => {
  it("honours an explicit light or dark override regardless of OS preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows systemPrefersDark when preference is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("applyTheme", () => {
  it("sets data-theme and color-scheme on documentElement", () => {
    const doc: ThemeDocument = {
      documentElement: {
        dataset: {},
        style: {},
      },
    };
    applyTheme(doc, "dark");
    expect(doc.documentElement.dataset?.theme).toBe("dark");
    expect(doc.documentElement.style?.colorScheme).toBe("dark");

    applyTheme(doc, "light");
    expect(doc.documentElement.dataset?.theme).toBe("light");
    expect(doc.documentElement.style?.colorScheme).toBe("light");
  });

  it("falls back to setAttribute when dataset is absent and tolerates a null document", () => {
    const attributes: Record<string, string> = {};
    const doc: ThemeDocument = {
      documentElement: {
        setAttribute: (name, value) => {
          attributes[name] = value;
        },
      },
    };
    applyTheme(doc, "dark");
    expect(attributes["data-theme"]).toBe("dark");
    expect(() => applyTheme(null, "dark")).not.toThrow();
  });
});

describe("Aurora Glass tokens and motion in styles.css", () => {
  it("defines dark and light theme selectors, existing tokens, and new Aurora Glass tokens", () => {
    expect(STYLES_CSS).toContain('[data-theme="dark"]');
    expect(STYLES_CSS).toContain('[data-theme="light"]');
    expect(STYLES_CSS).toContain("prefers-color-scheme: light");
    expect(STYLES_CSS).toContain("prefers-color-scheme: dark");

    const requiredTokens = [
      "--rm-bg-page",
      "--rm-bg-surface",
      "--rm-bg-raised",
      "--rm-bg-inset",
      "--rm-text-primary",
      "--rm-text-secondary",
      "--rm-text-muted",
      "--rm-text-faint",
      "--rm-separator",
      "--rm-glass",
      "--rm-glass-strong",
      "--rm-hair",
      "--rm-aurora",
      "--rm-accent-1",
      "--rm-accent-2",
      "--rm-accent-3",
      "--rm-bubble",
      "--rm-code-bg",
      "--rm-radius-control",
      "--rm-radius-button",
      "--rm-radius-group",
      "--rm-radius-card",
      "--rm-radius-sheet",
      "--rm-ease-spring",
      "--rm-ease-out",
      "--rm-running",
      "--rm-decision",
      "--rm-success",
      "--rm-error",
      "--rm-warn",
    ];
    for (const token of requiredTokens) {
      expect(STYLES_CSS, `missing token ${token}`).toContain(token);
    }
  });

  it("disables animations and transitions under prefers-reduced-motion: reduce", () => {
    expect(STYLES_CSS).toContain("@media (prefers-reduced-motion: reduce)");
    expect(STYLES_CSS).toContain("animation: none !important;");
    expect(STYLES_CSS).toContain("transition-duration: 0.01ms !important;");
  });
});

describe("Aurora Glass UI primitives", () => {
  it("renders Aurora as decorative aria-hidden blobs", () => {
    const html = renderToStaticMarkup(createElement(Aurora, { height: 500 }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("pointer-events-none");
    expect(html).toContain("rm-aurora-blob");
  });

  it("renders NavBar with avatar action, centred title, and model pill slot", () => {
    const html = renderToStaticMarkup(
      createElement(NavBar, {
        title: "New chat",
        solid: true,
        onAvatarClick: () => undefined,
        avatarLabel: "Settings",
        avatarInitial: "M",
        modelPill: createElement(ModelPill, { label: "deepseek-v4" }),
        trailing: createElement(AvatarButton, { initial: "A", "aria-label": "Account" }),
      }),
    );
    expect(html).toContain('data-solid="true"');
    expect(html).toContain("New chat");
    expect(html).toContain("deepseek-v4");
    expect(html).toContain('aria-label="Settings"');
  });

  it("renders Button variants, sizes, and Tag/Chip tones", () => {
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(Button, { variant: "primary", size: "large" }, "Connect"),
        createElement(Button, { variant: "destructive", size: "medium" }, "Disconnect"),
        createElement(Tag, { tone: "gradient", children: "Vision" }),
        createElement(Tag, { tone: "decision", children: "Needs you" }),
        createElement(Chip, { tone: "warn", children: "Interrupted" }),
        createElement(StatusDot, { status: "online" }),
      ),
    );
    expect(html).toContain("Connect");
    expect(html).toContain("Disconnect");
    expect(html).toContain("Vision");
    expect(html).toContain("rm-status-pulse");
  });

  it("renders ListGroup, ListRow, SwipeRow, Sheet, Toast, EmptyState, Callout, Banner, and SkeletonRow", () => {
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(ListGroup, {
          children: createElement(SwipeRow, {
            actions: [{ key: "pin", label: "Pin", tone: "pin", onClick: () => undefined }],
            children: createElement(ListRow, {
              title: "Conversation",
              subtitle: "Replying",
              value: "Now",
              chevron: true,
              onClick: () => undefined,
            }),
          }),
        }),
        createElement(
          Sheet,
          { open: true, onClose: () => undefined, title: "Choose model", description: "Tap star for default" },
          createElement("div", null, "Model list"),
        ),
        createElement(Toast, { message: "Saved", visible: true }),
        createElement(EmptyState, { title: "Good evening", description: "Ask anything" }),
        createElement(Callout, { tone: "warn", children: "Check gateway" }),
        createElement(Banner, { tone: "running", children: "Reconnecting" }),
        createElement(SkeletonRow),
      ),
    );
    expect(html).toContain("Conversation");
    expect(html).toContain("rm-swipe-row");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Choose model");
    expect(html).toContain("Saved");
    expect(html).toContain("rm-orb");
    expect(html).toContain("Good evening");
  });
});

function fakeStorage(initial: Record<string, string>): ThemeStorage & {
  get: (key: string) => string | null;
} {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    get: (key) => map.get(key) ?? null,
  };
}
