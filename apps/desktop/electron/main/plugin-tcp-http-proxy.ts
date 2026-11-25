/**
 * The HTTP `CONNECT` handshake that opens a tunnel to one mail server.
 *
 * `CONNECT host:port` is the whole request, and the proxy either opens a tunnel
 * (any 2xx) or does not. The host is sent as the account stored it: this is the
 * one place a name has to stay a name, because resolving it locally is exactly
 * the DNS the proxy exists to bypass.
 *
 * `Proxy-Authorization` is Basic, and only when the account has a proxy login.
 * That header travels unencrypted to the proxy hop — a property of the protocol,
 * which is why a proxy login is meant for the user's own or their LAN's proxy.
 * The mail password is not part of this exchange and never reaches the proxy in
 * the clear.
 */
import type { Socket } from "node:net";
import { PluginSocketError } from "./plugin-websocket";
import {
  PROXY_AUTH_FAILED_MESSAGE,
  PROXY_FAILED_MESSAGE,
  ProxyStream,
  type ProxyTarget,
  type TcpProxy,
} from "./plugin-tcp-proxy";

const CRLF = "\r\n";

/** Ask `proxy` for a tunnel to `target`, then hand the socket back. */
export async function httpProxyHandshake(
  socket: Socket,
  target: ProxyTarget,
  proxy: TcpProxy,
): Promise<void> {
  const stream = new ProxyStream(socket);
  const authority = `${target.host}:${target.port}`;
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
  if (proxy.username) {
    const basic = Buffer.from(`${proxy.username}:${proxy.password}`, "utf8").toString("base64");
    lines.push(`Proxy-Authorization: Basic ${basic}`);
  }
  lines.push(CRLF);
  try {
    socket.write(lines.join(CRLF), "utf8");
    const end = await stream.until(`${CRLF}${CRLF}`);
    const head = stream.take(end).toString("latin1");
    const status = /^HTTP\/1\.[01] (\d{3})/i.exec(head);
    if (!status) throw new PluginSocketError("PROXY_FAILED", PROXY_FAILED_MESSAGE);
    const code = Number(status[1]);
    if (code === 407) {
      throw new PluginSocketError("PROXY_AUTH_FAILED", PROXY_AUTH_FAILED_MESSAGE);
    }
    if (code < 200 || code > 299) {
      throw new PluginSocketError("PROXY_FAILED", PROXY_FAILED_MESSAGE);
    }
    stream.release();
  } catch (error) {
    stream.abort();
    if (error instanceof PluginSocketError) throw error;
    throw new PluginSocketError("PROXY_FAILED", PROXY_FAILED_MESSAGE);
  }
}