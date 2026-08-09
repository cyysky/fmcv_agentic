#!/usr/bin/env node
/**
 * cdp-relay.mjs — host-side TCP relay that exposes the loopback-only Chrome
 * DevTools endpoint to Docker containers (and anything else on the network).
 *
 * Modern Chrome (e.g. 151) headless ignores `--remote-debugging-address` /
 * `--remote-debugging-addresses` and binds only to 127.0.0.1, so compose's
 * host-gateway (172.17.0.1) cannot reach it from inside fmcv-backend. This
 * relay listens on 0.0.0.0:9222 and proxies to the local Chrome on
 * 127.0.0.1:9223 (loopback), keeping the documented "CDP on port 9222"
 * contract intact for host tooling and containers alike.
 *
 * Why the relay is HTTP-aware:
 *  - Chrome's DevTools HTTP handler rejects any `Host` header that is not an
 *    IP address or localhost, so the relay rewrites `Host:` to the target
 *    endpoint (127.0.0.1:9223) on every request.
 *  - Client connection pools (e.g. undici) keep idle sockets alive; a pooled
 *    socket's second request would bypass the Host rewrite. The relay
 *    therefore closes each non-WebSocket transaction after its
 *    Content-Length-sized response body, so every HTTP request and WebSocket
 *    handshake arrives on a fresh connection whose Host was rewritten.
 *  - WebSocket upgrades keep their connection (they carry exactly one
 *    request by design) and are streamed raw after the 101 handshake.
 *
 * Usage:
 *   node scripts/cdp-relay.mjs
 *   CDP_RELAY_LISTEN=0.0.0.0:9222 CDP_RELAY_TARGET=127.0.0.1:9223 node scripts/cdp-relay.mjs
 */
import net from "node:net";

const listen = process.env.CDP_RELAY_LISTEN || "0.0.0.0:9222";
const target = process.env.CDP_RELAY_TARGET || "127.0.0.1:9223";

function parseEndpoint(endpoint) {
  const idx = endpoint.lastIndexOf(":");
  const host = endpoint.slice(0, idx);
  const port = Number(endpoint.slice(idx + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid endpoint: ${endpoint}`);
  }
  return { host, port };
}

const upstreamTarget = parseEndpoint(target);
const log = (msg) => process.stdout.write(`relay: ${msg}\n`);

const server = net.createServer((client) => {
  let upstream = null;
  let connecting = null;
  let pending = [];

  /** Rewrite Host (Chrome requires IP/localhost) and request Connection: close. */
  function rewriteHead(head, isUpgrade) {
    const lines = [];
    let replacedHost = false;
    let replacedConnection = false;
    for (const line of head.split(/\r\n/)) {
      if (/^Host:/i.test(line)) {
        lines.push(`Host: ${upstreamTarget.host}:${upstreamTarget.port}`);
        replacedHost = true;
      } else if (/^Connection:/i.test(line) && !isUpgrade) {
        lines.push("Connection: close");
        replacedConnection = true;
      } else {
        lines.push(line);
      }
    }
    if (!replacedHost) {
      const end = lines.pop() ?? "";
      lines.push(`Host: ${upstreamTarget.host}:${upstreamTarget.port}`, end);
    }
    if (!isUpgrade && !replacedConnection) {
      const end = lines.pop() ?? "";
      lines.push("Connection: close", end);
    }
    return lines.join("\r\n");
  }

  const connectUpstream = () =>
    new Promise((resolve, reject) => {
      const sock = net.connect(upstreamTarget, () => {
        sock.on("error", () => client.destroy());
        client.on("error", () => sock.destroy());
        resolve(sock);
      });
      sock.on("error", reject);
      upstream = sock;
    });

  /* -------------------- client -> upstream (requests) -------------------- */

  let requestBuf = Buffer.alloc(0);
  let requestSent = false;
  let requestBodyRemaining = 0;
  let wsStream = false;

  client.on("data", async (chunk) => {
    if (requestSent) {
      if (wsStream) {
        upstream?.write(chunk);
        return;
      }
      if (requestBodyRemaining <= 0) {
        client.destroy(); // pipelining after a request we'll close anyway
        return;
      }
      const take = Math.min(requestBodyRemaining, chunk.length);
      upstream?.write(chunk.subarray(0, take));
      requestBodyRemaining -= take;
      if (requestBodyRemaining <= 0 && chunk.length > take) {
        client.destroy();
      }
      return;
    }

    requestBuf = Buffer.concat([requestBuf, chunk]);
    const headEnd = requestBuf.indexOf("\r\n\r\n");
    if (headEnd === -1) return; // wait for the full request head
    requestSent = true;

    const head = requestBuf.subarray(0, headEnd).toString("utf8");
    const rest = requestBuf.subarray(headEnd + 4);
    requestBuf = Buffer.alloc(0);
    wsStream = /^Upgrade:\s*websocket/im.test(head);
    const lengthMatch = /^Content-Length:\s*(\d+)[ \t]*$/im.exec(head);
    requestBodyRemaining = lengthMatch ? Number(lengthMatch[1]) : 0;

    try {
      if (!upstream) {
        connecting = connectUpstream();
        await connecting;
        connecting = null;
      }
      log(`${head.split(/\r\n/)[0]}${wsStream ? " (websocket)" : ""}`);
      upstream.write(rewriteHead(head, wsStream) + "\r\n\r\n");
      if (rest.length > 0) upstream.write(rest);
      for (const p of pending) upstream.write(p);
      pending = [];
      if (wsStream) {
        // The client data handler above already forwards every chunk, so no
        // `client.pipe(upstream)` here — it would duplicate each WebSocket
        // frame (Chrome then rejects duplicates with "Duplicate `id`...").
        upstream.pipe(client);
      } else {
        forwardResponseThenClose();
      }
    } catch {
      client.destroy();
    }
  });

  /* ------------------ upstream -> client (responses) ------------------ */
  /*
   * Chrome answers /json/* with Content-Length JSON. Forward the head + that
   * many body bytes, then close the pair, so the client's connection pool
   * never reuses a socket whose next request would bypass the Host rewrite.
   */
  let responseBuf = Buffer.alloc(0);
  let responseStage = 0; // 0 = head, 1 = body
  let bodyRemaining = null;

  function forwardResponseThenClose() {
    upstream.on("data", (chunk) => {
      if (responseStage === 0) {
        responseBuf = Buffer.concat([responseBuf, chunk]);
        const hEnd = responseBuf.indexOf("\r\n\r\n");
        if (hEnd === -1) return;
        const headText = responseBuf.subarray(0, hEnd).toString("utf8");
        const lengthMatch = /^Content-Length:\s*(\d+)[ \t]*$/im.exec(headText);
        client.write(responseBuf.subarray(0, hEnd + 4));
        const body = responseBuf.subarray(hEnd + 4);
        responseBuf = Buffer.alloc(0);
        responseStage = 1;
        bodyRemaining = lengthMatch ? Number(lengthMatch[1]) : null;
        log(
          `response ${headText.split(/\r\n/)[0]} contentLength=${bodyRemaining ?? "close-delimited"}`,
        );
        if (bodyRemaining === null) {
          if (body.length > 0) client.write(body);
          return; // close-delimited: client.end() fires on upstream 'end'
        }
        if (body.length > 0) forwardBody(body);
        return;
      }
      forwardBody(chunk);
    });
    upstream.on("end", () => {
      if (bodyRemaining === null) client.end();
    });
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream?.destroy());
  }

  function forwardBody(data) {
    if (bodyRemaining === null) {
      client.write(data);
      return;
    }
    const take = Math.min(bodyRemaining, data.length);
    if (take > 0) client.write(data.subarray(0, take));
    bodyRemaining -= take;
    if (bodyRemaining <= 0) {
      client.end();
      upstream.destroy();
    }
  }
});

server.listen(parseEndpoint(listen), () => {
  const { address, port } = server.address();
  console.log(`CDP relay listening on ${address}:${port} -> ${target}`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
