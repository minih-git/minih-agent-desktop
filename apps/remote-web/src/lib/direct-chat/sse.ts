/**
 * Server-sent events, decoded from a byte stream (ADR
 * mobile-direct-gateway-chat §2, data plane).
 *
 * The gateway streams `text/event-stream`; the WebView's `fetch` gives a
 * `ReadableStream` that splits wherever the network felt like splitting, so a
 * chunk can end in the middle of a field, a line, or a multi-byte character. This
 * module owns exactly that problem and nothing else: it takes bytes, returns
 * complete events, and keeps the remainder for the next chunk.
 *
 * The grammar is the event-stream one: `field: value` lines, a blank line
 * dispatches the event, `:` starts a comment (which is what a keep-alive is), and
 * a leading space after the colon is dropped. `data` lines accumulate with a
 * newline between them.
 */

export type SseEvent = {
  /** The `event:` field, or `""` when the stream did not name one. */
  event: string;
  /** The accumulated `data` payload, without the trailing newline. */
  data: string;
  /** The `id:` field, kept for a future resume; this client never sends it back. */
  id: string;
};

/**
 * A streaming decoder: feed it chunks, take the events that became complete.
 *
 * A `TextDecoder` is kept across chunks because a multi-byte character may be
 * split between them; `{ stream: true }` is what makes that safe.
 */
export class SseDecoder {
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  private dataLines: string[] = [];
  private eventName = "";
  private eventId = "";

  /** Feed one chunk of bytes; returns the events that completed inside it. */
  push(chunk: Uint8Array): SseEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain();
  }

  /** Flush at end of stream: any trailing event that was not blank-line terminated. */
  end(): SseEvent[] {
    this.buffer += this.decoder.decode();
    // A stream may end without a final newline; that last line is still a line.
    if (this.buffer.length > 0 && !this.buffer.endsWith("\n")) this.buffer += "\n";
    const events = this.drain();
    // A stream that ends without its final blank line still sent the data.
    if (this.dataLines.length > 0 || this.eventName) {
      const trailing = this.take();
      if (trailing) events.push(trailing);
    }
    return events;
  }

  private drain(): SseEvent[] {
    const events: SseEvent[] = [];
    // Only whole lines are consumed; a partial line waits for the next chunk.
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (line === "") {
        const event = this.take();
        if (event) events.push(event);
      } else if (!line.startsWith(":")) {
        this.field(line);
      }
      index = this.buffer.indexOf("\n");
    }
    return events;
  }

  private field(line: string): void {
    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "data") this.dataLines.push(value);
    else if (name === "event") this.eventName = value;
    else if (name === "id") this.eventId = value;
    // `retry` and unknown fields are ignored: this client does not reconnect on
    // its own, so a retry hint would be a promise it cannot keep.
  }

  private take(): SseEvent | null {
    const data = this.dataLines.join("\n");
    const event: SseEvent = { event: this.eventName, data, id: this.eventId };
    this.dataLines = [];
    this.eventName = "";
    // The id persists across events per the event-stream format.
    return data === "" && event.event === "" ? null : event;
  }
}

/** Split an SSE payload into events, for tests and for a fully buffered body. */
export function decodeSse(chunks: readonly Uint8Array[]): SseEvent[] {
  const decoder = new SseDecoder();
  const events: SseEvent[] = [];
  for (const chunk of chunks) events.push(...decoder.push(chunk));
  events.push(...decoder.end());
  return events;
}
