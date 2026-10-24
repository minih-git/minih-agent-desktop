import assert from "node:assert/strict";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { test } from "vitest";

import type { RacpSession } from "@minih-agent/shared";

import { ForegroundNoticeDialog } from "../ForegroundNotice.js";
import { SessionStatusPill } from "../ui/StatusMark.js";
import { ProjectCard } from "./ProjectCard.js";
import { SessionRow } from "./SessionRow.js";
import { DEFAULT_LOCALE, buildResources } from "../../locales/index.js";
import type { SessionStateView } from "../../lib/session-state.js";

/**
 * The status vocabulary of §17.4, as markup.
 *
 * These are the three placements the spec says must agree — a project card, a
 * session row, and (through `SessionStatusInline`) a navigation subtitle — and
 * the rule they share: never colour alone. Rendered statically because this
 * package runs no DOM and the question is what the markup says.
 */
async function render(element: Parameters<typeof renderToStaticMarkup>[0]): Promise<string> {
  const i18n = createInstance();
  await i18n.init({
    lng: DEFAULT_LOCALE,
    resources: buildResources(),
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element));
}

function session(overrides: Partial<RacpSession> = {}): RacpSession {
  return {
    id: "s1",
    title: "Refactor the login flow",
    mode: "agent",
    status: "idle",
    planningState: "inactive",
    permissionMode: "ask",
    queuedTurnIds: [],
    revision: 1,
    createdAt: "2026-10-21T09:00:00.000Z",
    updatedAt: "2026-10-21T09:30:00.000Z",
    modelLabel: "Claude Sonnet 5",
    ...overrides,
  };
}

function row(view: SessionStateView, overrides: Partial<RacpSession> = {}, waitingCount?: number) {
  return render(
    createElement(SessionRow, {
      session: session(overrides),
      view,
      ...(waitingCount ? { waitingCount } : {}),
      onOpen: () => undefined,
    }),
  );
}

test("an approval row says so in words, in a pill, not only in colour", async () => {
  const html = await row("approval", { status: "waiting_permission" });
  assert.match(html, /Needs your approval/);
  // The pill is the only filled status mark (§17.4).
  assert.match(html, /rm-decision/);
  assert.match(html, /aria-label="Refactor the login flow, Needs your approval"/);
});

test("the pill names the state once, not twice", async () => {
  // The two attention branches each rendered `{label}` twice, so the row read
  // "Needs your approvalNeeds your approval".
  const html = await render(
    createElement(SessionStatusPill, { view: "approval" }),
  );
  assert.equal(html.match(/Needs your approval/g)?.length, 1);
});

test("an answer the device learned from a push reads as its own state", async () => {
  const html = await row("input", { status: "running" });
  assert.match(html, /Needs your answer/);
});

test("more than one waiting session turns the pill into a count", async () => {
  const html = await row("approval", { status: "waiting_permission" }, 3);
  assert.match(html, /3 need you/);
});

test("running keeps a word beside its dot, and the dot breathes twice", async () => {
  const html = await row("running", { status: "running" });
  assert.match(html, /Running/);
  assert.match(html, /rm-breathe/);
});

test("a failure is named, and carries the error tone", async () => {
  const html = await row("error", { status: "error" });
  assert.match(html, /Failed/);
  assert.match(html, /rm-error/);
});

test("finished and not looked at adds a ring, not just a dimmer check", async () => {
  const unseen = await row("unseen");
  assert.match(unseen, /Finished/);
  // The ring is an inset shadow on the glyph: a shape difference (§17.4).
  assert.match(unseen, /shadow-\[inset_0_0_0_1\.5px_var\(--rm-success\)\]/);
});

test("a looked-at, idle session says nothing at all", async () => {
  const html = await row("idle");
  assert.doesNotMatch(html, /Needs your|Running|Failed|Finished/);
  // The model is still worth a glance on the line.
  assert.match(html, /Claude Sonnet 5/);
});

test("a stopped session keeps the word the Host used", async () => {
  const html = await row("idle", { status: "aborted" });
  assert.match(html, /Stopped/);
});

test("a project with something waiting gets the rail and the pill", async () => {
  const html = await render(
    createElement(ProjectCard, {
      summary: {
        key: "p1",
        projectId: "p1",
        label: "Desktop",
        other: false,
        total: 5,
        waiting: 2,
        running: 1,
        lastActivity: "2026-10-21T09:30:00.000Z",
      },
      onOpen: () => undefined,
    }),
  );
  assert.match(html, /Desktop/);
  assert.match(html, /5 sessions/);
  assert.match(html, /2 need you/);
  assert.match(html, /1 running/);
  assert.match(html, /w-\[3px\] bg-\[var\(--rm-decision\)\]/);
});

test("a project with nothing waiting says so instead of showing empty pills", async () => {
  const html = await render(
    createElement(ProjectCard, {
      summary: { key: "p1", projectId: "p1", label: "Desktop", other: false, total: 3, waiting: 0, running: 0 },
      onOpen: () => undefined,
    }),
  );
  assert.match(html, /Nothing needs you/);
  assert.doesNotMatch(html, /w-\[3px\]/);
});

test("a project that holds no session still says how to start one", async () => {
  const html = await render(
    createElement(ProjectCard, {
      summary: { key: "p2", projectId: "p2", label: "Empty", other: false, total: 0, waiting: 0, running: 0 },
      onOpen: () => undefined,
    }),
  );
  assert.match(html, /No sessions yet/);
  assert.match(html, /Start one here/);
});

test("the ungrouped card is labelled, not left blank", async () => {
  const html = await render(
    createElement(ProjectCard, {
      summary: { key: "__other__", label: null, other: true, total: 1, waiting: 0, running: 0 },
      onOpen: () => undefined,
    }),
  );
  assert.match(html, /Other/);
});

test("a foreground notice is a centred dialog that offers the two actions", async () => {
  const html = await render(
    createElement(ForegroundNoticeDialog, {
      notice: { kind: "approval.requested", hostId: "h1", sessionId: "s1" },
      onOpen: () => undefined,
      onDismiss: () => undefined,
    }),
  );
  // A dialog, not a bar under the navigation bar: the bar counted the safe-area
  // inset twice and left a blank block above its text.
  assert.match(html, /role="alertdialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /items-center justify-center/);
  assert.doesNotMatch(html, /rm-nav/);
  assert.match(html, /Needs your approval/);
  assert.match(html, /View/);
  assert.match(html, /Close/);
});
