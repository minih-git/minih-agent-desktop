import assert from "node:assert/strict";
import test from "node:test";
import { smtpDataFrame } from "../electron/main/plugin-smtp-message.ts";

test("SMTP DATA normalizes newlines and stuffs every leading dot", () => {
  const { frame, hasEightBit } = smtpDataFrame(Buffer.from(".first\n.second\rthird\r\n.\r\n"));
  assert.equal(frame.toString("latin1"), "..first\r\n..second\r\nthird\r\n..\r\n.\r\n");
  assert.equal(hasEightBit, false);
});

test("SMTP DATA preserves eight-bit bytes without transcoding", () => {
  const input = Buffer.from([0xff, 0x80, 0x0a, 0x2e, 0x00]);
  const { frame, hasEightBit } = smtpDataFrame(input);
  assert.deepEqual(frame, Buffer.from([0xff, 0x80, 0x0d, 0x0a, 0x2e, 0x2e, 0x00, 0x0d, 0x0a, 0x2e, 0x0d, 0x0a]));
  assert.equal(hasEightBit, true);
});

test("SMTP DATA adds the terminating line once when the message has no final newline", () => {
  assert.equal(smtpDataFrame(Buffer.from("body")).frame.toString("latin1"), "body\r\n.\r\n");
});
