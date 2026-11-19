import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

test("TCP usage renders empty, per-endpoint windows, and a visible error", async (t) => {
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => vite.close());
  const { PluginTcpUsageContent } = await vite.ssrLoadModule("/src/components/plugins/PluginTcpUsage.tsx");
  const i18n = createInstance();
  await i18n.init({ lng: "zh", resources: { zh: { translation: { plugins: {
    tcpUsage: "TCP 流量", tcpUsageEmpty: "暂无记录", tcpUsageLoading: "加载中",
    tcpUsageError: "加载失败：{{reason}}", tcpUsageToday: "今天", tcpUsageWeek: "近 7 天",
    tcpUsageReceived: "接收", tcpUsageSent: "发送",
  } } } } });
  const render = (usage, error = null) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(PluginTcpUsageContent, { usage, error })));
  const empty = { today: { endpoints: [] }, last7Days: { endpoints: [] } };
  assert.match(render(empty), /暂无记录/);
  const usage = {
    today: { endpoints: [{ host: "mail.example", port: 993, bytesIn: 12, bytesOut: 5 }] },
    last7Days: { endpoints: [
      { host: "mail.example", port: 993, bytesIn: 100, bytesOut: 20 },
      { host: "old.example", port: 143, bytesIn: 4, bytesOut: 0 },
    ] },
  };
  const html = render(usage);
  assert.match(html, /mail\.example:993/);
  assert.match(html, /今天.*接收.*12 B.*发送.*5 B/);
  assert.match(html, /近 7 天.*接收.*100 B.*发送.*20 B/);
  assert.match(html, /old\.example:143/);
  assert.match(html, /0 B/);
  assert.match(render(null, "offline"), /加载失败：offline/);
  assert.match(render(null), /加载中/);
  const { PluginRowDetails } = await vite.ssrLoadModule("/src/features/plugins/presentation.tsx");
  const renderDetails = (permissions) => renderToStaticMarkup(createElement(I18nextProvider, { i18n },
    createElement(PluginRowDetails, { plugin: { id: "fixture", name: "Fixture", permissions }, services: [] })));
  assert.match(renderDetails(["net.tcp"]), /<details/);
  assert.doesNotMatch(renderDetails(["net.tcp"]), /TCP 流量/);
  assert.doesNotMatch(renderDetails(["net.fetch"]), /TCP 流量/);
});
