/**
 * An `electron` stub that records message boxes.
 *
 * `plugin-active-work` imports nothing else from Electron, so a stub with a
 * controllable `dialog.showMessageBox` lets a test drive the real decision logic
 * — which plugins it asks, what the prompt says, and what a Cancel answers —
 * without launching the app.
 */
export const dialog = {
  /** Every `showMessageBox` call, in order: `{ options, parent }` per call. */
  calls: [],
  /** The button index the next prompt answers with. */
  response: 0,
  reset() {
    dialog.calls.length = 0;
    dialog.response = 0;
  },
  async showMessageBox(...args) {
    const [first, second] = args;
    const parent = second ? first : undefined;
    const options = second ?? first;
    dialog.calls.push({ options, parent });
    return { response: dialog.response, checkboxChecked: false };
  },
};
