/**
 * The keyboard handoff that goes with hiding a plugin view.
 *
 * A `WebContentsView` holds first responder while it is attached. Removing it
 * from the window's view tree gives that up as part of leaving, so an
 * implementation that asks `isFocused()` after `removeChildView()` reads "no"
 * for a page that was focused a moment earlier and never gives the keyboard
 * back — the dialog the user is looking at then ignores Escape and Tab.
 *
 * The fakes below behave the way Electron does: detaching clears the page's
 * focus. That is what makes the ordering observable here.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { detachPluginView } = await import("../electron/main/plugin-view-detach.ts");

function harness({ focused = true, viewDestroyed = false, windowDestroyed = false, attached = true } = {}) {
  const order = [];
  const view = {
    webContents: {
      isFocused: () => {
        order.push("isFocused");
        return focused;
      },
      isDestroyed: () => viewDestroyed,
    },
  };
  const window = {
    isDestroyed: () => windowDestroyed,
    contentView: {
      children: attached ? [view] : [],
      removeChildView(target) {
        order.push("remove");
        assert.equal(target, view, "removed a view that was not the one asked for");
        // Electron's behavior: the detached page is no longer the first responder.
        focused = false;
        window.contentView.children.length = 0;
      },
    },
    webContents: {
      focus() {
        order.push("windowFocus");
      },
    },
  };
  return { window, view, order, isFocused: () => focused };
}

test("a focused view gives the keyboard back to the window, after it is removed", () => {
  const { window, view, order, isFocused } = harness({ focused: true });

  const handedOver = detachPluginView({ window, view });

  assert.equal(handedOver, true);
  assert.deepEqual(order, ["isFocused", "remove", "windowFocus"]);
  // The regression this guards: after the removal the answer is already "no".
  assert.equal(isFocused(), false);
});

test("a view that did not hold the keyboard does not steal it back", () => {
  const { window, view, order } = harness({ focused: false });

  const handedOver = detachPluginView({ window, view });

  assert.equal(handedOver, false);
  assert.deepEqual(order, ["isFocused", "remove"]);
});

test("a destroyed page is removed without being asked about focus", () => {
  const { window, view, order } = harness({ viewDestroyed: true });

  const handedOver = detachPluginView({ window, view });

  assert.equal(handedOver, false);
  assert.deepEqual(order, ["remove"]);
});

test("a destroyed window is left alone", () => {
  const { window, view, order } = harness({ windowDestroyed: true });

  const handedOver = detachPluginView({ window, view });

  assert.equal(handedOver, false);
  assert.deepEqual(order, []);
});

test("a view that already left the view tree still hands the keyboard over", () => {
  const { window, view, order } = harness({ focused: true, attached: false });

  const handedOver = detachPluginView({ window, view });

  assert.equal(handedOver, true);
  assert.deepEqual(order, ["isFocused", "windowFocus"]);
});