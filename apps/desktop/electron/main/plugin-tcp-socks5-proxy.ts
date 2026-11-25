/**
 * The SOCKS5 handshake that opens a tunnel to one mail server (RFC 1928, with
 * RFC 1929 when the account has a proxy login).
 *
 * The mail host travels to the proxy as a name — `ATYP 0x03` — whenever the
 * account stored a hostname, so the proxy is what resolves it. An address the
 * account stored as an IP literal is sent as an address (`0x01`/`0x04`), because
 * that is what it is; nothing is resolved here either way.
 *
 * Every refusal is coded: no acceptable authentication method and a rejected
 * sub-negotiation are `PROXY_AUTH_FAILED`, a failed CONNECT or a malformed reply
 * is `PROXY_FAILED`. No reply text is quoted back, and the proxy credential
 * never appears in a message.
 */
import { isIP, type Socket } from "node:net";
import { PluginSocketError } from "./plugin-websocket";
import {
  PROXY_AUTH_FAILED_MESSAGE,
  PROXY_FAILED_MESSAGE,
  ProxyStream,
  type ProxyTarget,
  type TcpProxy,
} from "./plugin-tcp-proxy";

const VERSION = 0x05;
const NO_AUTH = 0x00;
const USERNAME_PASSWORD = 0x02;
const CONNECT = 0x01;
const AUTH_SUCCEEDED = 0x00;

/** Open a tunnel to `target` through `proxy`, then hand the socket back. */
export async function socks5ProxyHandshake(
  socket: Socket,
  target: ProxyTarget,
  proxy: TcpProxy,
): Promise<void> {
  const stream = new ProxyStream(socket);
  try {
    const wantsLogin = Boolean(proxy.username);
    socket.write(
      Buffer.from([VERSION, wantsLogin ? 2 : 1, NO_AUTH, ...(wantsLogin ? [USERNAME_PASSWORD] : [])]),
    );
    await stream.need(2);
    const [version, method] = stream.take(2);
    if (version !== VERSION) throw new PluginSocketError("PROXY_FAILED", PROXY_FAILED_MESSAGE);
    if (method === USERNAME_PASSWORD) {
      await authenticate(stream, socket, proxy);
    } else if (method !== NO_AUTH) {
      // `0xFF` is "no acceptable method": the account needs a proxy login, or the
      // login it has was not accepted.
      throw new PluginSocketError("PROXY_AUTH_FAILED", PROXY_AUTH_FAILED_MESSAGE);
    }
    socket.write(connectRequest(target));
    await readConnectReply(stream);
    stream.release();
  } catch (error) {
    stream.abort();
    if (error instanceof PluginSocketError) throw error;
    throw new PluginSocketError("PROXY_FAILED", PROXY_FAILED_MESSAGE);
  }
}

/** RFC 1929 sub-negotiation, once the proxy asked for it. */
async function authenticate(
  stream: ProxyStream,
  socket: Socket,
  proxy: TcpProxy,
): Promise<void> {
  if (!proxy.username) {
    // A proxy that demands a login it was never offered is a wrong answer, not
    // a credential problem: the account has no proxy login to give it.
    throw new PluginSocketError("PROXY_AUTH_FAILED", PROXY_AUTH_FAILED_MESSAGE);
  }
  const username = Buffer.from(proxy.username, "utf8");
  const password = Buffer.from(proxy.password ?? "", "utf8");
  socket.write(
    Buffer.concat([
      Buffer.from([0x01, username.length]),
      username,
      Buffer.from([password.length]),
      password,
    ]),
  );
  await stream.need(2);
  const [, status] = stream.take(2);
  if (status !== AUTH_SUCCEEDED) {
    throw new PluginSocketError("PROXY_AUTH_FAILED", PROXY_AUTH_FAILED_MESSAGE);
  }
}

/** `CONNECT <address>:<port>`, with the address in the form the account stored. */
function connectRequest(target: ProxyTarget): Buffer {
  const port = Buffer.alloc(2);
  port.writeUInt16BE(target.port, 0);
  const family = isIP(target.host);
  if (family === 4) {
    const octets = target.host.split(".").map((part) => Number(part));
    return Buffer.concat([Buffer.from([VERSION, CONNECT, 0x00, 0x01, ...octets]), port]);
  }
  if (family === 6) {
    return Buffer.concat([
      Buffer.from([VERSION, CONNECT, 0x00, 0x04]),
      ipv6Bytes(target.host),
      port,
    ]);
  }
  const name = Buffer.from(target.host, "utf8");
  if (name.length === 0 || name.length > 255) {
    throw new PluginSocketError("PROXY_FAILED", PROXY_FAILED_MESSAGE);
  }
  return Buffer.concat([
    Buffer.from([VERSION, CONNECT, 0x00, 0x03, name.length]),
    name,
    port,
  ]);
}

/** One IPv6 literal as its sixteen bytes; `isIP` already accepted the syntax. */
function ipv6Bytes(address: string): Buffer {
  const [head, tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(Number.parseInt(group || "0", 16), index * 2));
  return bytes;
}

/**
 * The CONNECT reply: a fixed four-byte prefix, a variable address, two port
 * bytes. The whole reply is consumed here; anything after it belongs to the
 * mail server and is put back by `release`.
 */
async function readConnectReply(stream: ProxyStream): Promise<void> {
  await stream.need(4);
  const [version, reply, , atyp] = stream.take(4);
  if (version !== VERSION) throw new PluginSocketError("PROXY_FAILED", PROXY_FAILED_MESSAGE);
  let remainder: number;
  if (atyp === 0x01) {
    remainder = 4;
  } else if (atyp === 0x04) {
    remainder = 16;
  } else if (atyp === 0x03) {
    await stream.need(1);
    remainder = stream.take(1)[0];
  } else {
    throw new PluginSocketError("PROXY_FAILED", PROXY_FAILED_MESSAGE);
  }
  await stream.need(remainder + 2);
  stream.take(remainder + 2);
  if (reply !== 0x00) throw new PluginSocketError("PROXY_FAILED", PROXY_FAILED_MESSAGE);
}