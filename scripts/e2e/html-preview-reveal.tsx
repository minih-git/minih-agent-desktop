/**
 * The page card's "Reveal in Finder" action, clicked in a real renderer.
 *
 * Only the preload bridge is synthetic: the real `api` module, the real
 * `useOpenChatFileRef` resolver, the real card components and the real store
 * run here, so the click exercises path/base-directory completion and the
 * `fs/reveal` destination the way the app does. The fixture also carries the
 * two shapes that must not offer the action — a plain `html` fence, and a card
 * whose pane belongs to a remote workspace.
 */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import { HtmlPreviewBlock } from "../../apps/desktop/src/components/HtmlPreviewBlock";
import { LocalHtmlPageLink } from "../../apps/desktop/src/components/LocalHtmlPageLink";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const WORKSPACE = "/work";
const PAGE = "<h1>Quarterly report</h1><p>Rendered from disk.</p>";
const LINKS = { local: "./report.html", sibling: "/elsewhere/shared/page.html" };

const reads: string[] = [];
const resolveRefs: unknown[] = [];
const reveals: Array<{ path: string; sessionId?: string }> = [];
const calls: string[] = [];

window.minihAgent = {
  platform: "darwin",
  channels: IPC,
  on: () => () => {},
  async invoke(channel, ...args) {
    const input = (args[0] ?? {}) as Record<string, unknown>;
    calls.push(channel);
    if (channel === IPC.invoke.fsRead) {
      reads.push(String(input.path ?? ""));
      return { ok: true, data: { kind: "text", content: PAGE, size: PAGE.length } };
    }
    if (channel === IPC.invoke.fsResolveRef) {
      resolveRefs.push(input);
      return {
        ok: true,
        data: {
          match: {
            root: "workspace",
            relativePath: "notes/report.html",
            absolutePath: `${WORKSPACE}/notes/report.html`,
            matchedBy: "exact-relative",
            projectRoot: { path: WORKSPACE, name: "Fixture", primary: true },
          },
        },
      };
    }
    if (channel === IPC.invoke.fsReveal) {
      reveals.push({
        path: String(input.path ?? ""),
        sessionId: input.sessionId === undefined ? undefined : String(input.sessionId),
      });
      return { ok: true, data: undefined };
    }
    // Anything else is recorded, not served: this fixture measures what the
    // card reaches for, and an unexpected channel shows up as a call.
    return { ok: true, data: undefined };
  },
};

useAppStore.setState({
  workspace: { path: WORKSPACE, name: "Fixture" },
  activeSessionId: "local-session",
  sessions: [
    {
      id: "local-session",
      title: "Local",
      createdAt: "2026-11-16T00:00:00.000Z",
      capabilities: { canUseLocalTools: true },
    },
    {
      id: "remote:box",
      title: "Remote",
      createdAt: "2026-11-16T00:00:00.000Z",
      source: "remote",
      remoteWorkspace: { hostKey: "ssh", path: "/srv/app" },
      capabilities: { canUseLocalTools: true },
    },
  ],
  pluginViews: [{ pluginId: "pi.browser", viewId: "browser" }],
});

const i18n = createInstance();
void i18n
  .use(initReactI18next)
  .init({
    lng: "en",
    fallbackLng: "en",
    keySeparator: false,
    resources: { en: { translation: flattenCatalog(catalogs.en) } },
    interpolation: { escapeValue: false },
  })
  .then(() => {
    const root = createRoot(document.getElementById("root")!);
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <div className="fixture-chat">
            <section data-case="local">
              <LocalHtmlPageLink
                path={LINKS.local}
                name="report.html"
                baseDir="notes"
                fallback={<span className="fixture-fallback">report.html</span>}
              />
            </section>
            <section data-case="fence">
              <HtmlPreviewBlock code={PAGE} />
            </section>
          </div>
        </I18nextProvider>,
      ),
    );

    window.htmlPreviewRevealProbe = async () => {
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const until = async (predicate: () => boolean, label: string) => {
        for (let index = 0; index < 180; index++) {
          if (predicate()) return true;
          await frame();
        }
        throw new Error(`Timed out waiting for ${label}`);
      };
      const cards = (testId: string) =>
        Array.from(document.querySelectorAll<HTMLElement>(`[data-case="${testId}"] .html-block`));
      const labelsOf = (card: HTMLElement) =>
        Array.from(card.querySelectorAll<HTMLButtonElement>(".html-action-btn")).map(
          (button) => button.getAttribute("aria-label") ?? "",
        );
      const revealButton = (card: HTMLElement) =>
        Array.from(card.querySelectorAll<HTMLButtonElement>(".html-action-btn")).find(
          (button) => button.getAttribute("aria-label") === "Reveal in Finder",
        ) ?? null;

      // Both shapes render: the linked page once its host read lands, the fence
      // immediately.
      await until(() => cards("local").length === 1 && cards("fence").length === 1, "both cards");
      const [localCard] = cards("local");
      const [fenceCard] = cards("fence");
      const localLabels = labelsOf(localCard);
      const fenceLabels = labelsOf(fenceCard);

      const reveal = revealButton(localCard);
      if (!reveal) throw new Error("the page card offered no reveal action");
      const callsBeforeClick = calls.length;
      flushSync(() => reveal.click());
      await until(() => reveals.length === 1, "the reveal destination");
      const revealCalls = calls.slice(callsBeforeClick);

      // The panel action beside it must keep its own destination.
      const panel = Array.from(
        localCard.querySelectorAll<HTMLButtonElement>(".html-action-btn"),
      ).find((button) => button.getAttribute("aria-label") === "Open in work panel");
      if (!panel) throw new Error("the page card lost its panel action");
      const callsBeforePanel = calls.length;
      flushSync(() => panel.click());
      await frame();
      await frame();
      const panelCalls = calls.slice(callsBeforePanel);

      // The same card in a pane that belongs to a remote workspace: no OS file
      // action, and nothing is revealed by re-rendering.
      useAppStore.setState({ activeSessionId: "remote:box" });
      await until(() => Boolean(document.querySelector('[data-case="local"] .html-block')), "remote card");
      await frame();
      const remoteCard = cards("local")[0];
      const remoteLabels = labelsOf(remoteCard);
      const remoteReveal = revealButton(remoteCard);

      // Back to the local pane so the captured frame shows the offered action.
      useAppStore.setState({ activeSessionId: "local-session" });
      await until(() => Boolean(revealButton(cards("local")[0])), "the restored local card");
      await frame();

      return {
        localLabels,
        fenceLabels,
        revealLabels: localLabels.filter((label) => label === "Reveal in Finder"),
        resolveRefs,
        reveals,
        revealCalls,
        panelCalls,
        reads,
        remoteLabels,
        remoteHasReveal: Boolean(remoteReveal),
        revealButtonCount: document.querySelectorAll('[aria-label="Reveal in Finder"]').length,
        fenceHasReveal: fenceLabels.includes("Reveal in Finder"),
        frameCount: document.querySelectorAll("iframe.html-frame").length,
      };
    };
  })
  .catch((error: unknown) => {
    console.error(error);
    throw error;
  });

declare global {
  interface Window {
    minihAgent?: {
      platform: string;
      channels: typeof IPC;
      on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    };
    htmlPreviewRevealProbe: () => Promise<Record<string, unknown>>;
  }
}