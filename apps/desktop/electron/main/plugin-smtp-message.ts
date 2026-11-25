/** Prepare an RFC 5322 message for the SMTP DATA command without transcoding. */
export function smtpDataFrame(mime: Uint8Array): { frame: Buffer; hasEightBit: boolean } {
  // Latin-1 maps each byte to exactly one code point; the transformation below
  // only changes line endings and leading dots, never the message's other bytes.
  const text = Buffer.from(mime).toString("latin1");
  const normalized = text.replace(/\r\n|\r|\n/g, "\r\n");
  const escaped = normalized.replace(/(^|\r\n)\./g, "$1..");
  const terminated = escaped.endsWith("\r\n") ? escaped : `${escaped}\r\n`;
  return {
    frame: Buffer.from(`${terminated}.\r\n`, "latin1"),
    hasEightBit: mime.some((byte) => byte >= 0x80),
  };
}
