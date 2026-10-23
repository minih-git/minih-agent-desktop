import type { RacpInputRequest } from "@minih-agent/shared";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";

import { buildResources, DEFAULT_LOCALE } from "../../locales/index.js";
import { DecisionArea } from "./DecisionArea.js";

/**
 * One input request per body (RACP `input/request`).
 *
 * The panel reused a single `InputBody` across two requests, so the second
 * question inherited the first one's selection and reading `selected[i]` past
 * the shorter array threw. The body is now keyed by its request
 * (`key={request.id}`); the answer state itself is covered in
 * `lib/input-answers.test.ts`, because a state transition needs a DOM this
 * suite deliberately does not have.
 */
function input(overrides: Partial<RacpInputRequest> & { id: string }): RacpInputRequest {
  return {
    sessionId: "s-1",
    turnId: "t-1",
    expiresAt: "2026-10-23T11:00:00.000Z",
    questions: [{ id: "q-1", question: "Ship it?", options: ["Yes", "No"], multiSelect: false }],
    ...overrides,
  };
}

async function render(inputs: RacpInputRequest[]): Promise<string> {
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
    createElement(I18nextProvider, {
      i18n,
      children: createElement(DecisionArea, {
        approvals: [],
        inputs,
        pending: {},
        hostLabel: "Host",
        onDecideApproval: () => undefined,
        onSubmitInput: () => undefined,
      }),
    }),
  );
}

describe("DecisionArea input body", () => {
  it("renders the questions of the request it is showing", async () => {
    const html = await render([
      input({
        id: "input-a",
        questions: [
          { id: "q-1", question: "First question?", options: ["A1", "A2"], multiSelect: false },
        ],
      }),
    ]);
    expect(html).toContain('data-request-id="input-a"');
    expect(html).toContain("First question?");
    expect(html).toContain("A1");
    expect(html).toContain('aria-checked="false"');
  });

  it("renders a later request with its own questions, not the previous ones", async () => {
    const html = await render([
      input({
        id: "input-b",
        questions: [
          { id: "q-1", question: "Which target?", options: ["staging", "prod"], multiSelect: false },
          { id: "q-2", question: "Any notes?", options: ["none"], multiSelect: false },
        ],
      }),
    ]);
    expect(html).toContain('data-request-id="input-b"');
    expect(html).toContain("Which target?");
    expect(html).toContain("staging");
    expect(html).toContain("Any notes?");
    // Nothing is pre-selected in a request the user has not answered.
    expect(html).not.toContain('aria-checked="true"');
  });
});