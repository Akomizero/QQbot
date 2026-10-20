import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

// A get_image response may contain one GIF up to 20 MiB, before first-frame conversion.
const maxPayloadBytes = 32 * 1024 * 1024;
const responseTimeoutMs = 10_000;
const numericIdKeys = new Set([
  "self_id", "user_id", "group_id", "message_id", "operator_id", "target_id",
  "guild_id", "channel_id", "qq", "id",
]);

function jsonStringEnd(source, start) {
  let quote = source.indexOf('"', start + 1);
  while (quote !== -1) {
    let backslashes = 0;
    for (let index = quote - 1; index > start && source[index] === "\\"; index -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return quote + 1;
    quote = source.indexOf('"', quote + 1);
  }
  return source.length;
}

// Preserve numeric OneBot identifiers before JSON.parse can round 64-bit values.
function preserveNumericIds(source) {
  const output = [];
  let index = 0;
  let copiedUntil = 0;

  while (index < source.length) {
    const quoteStart = source.indexOf('"', index);
    if (quoteStart === -1) break;
    index = quoteStart;

    const stringEnd = jsonStringEnd(source, index);
    const rawString = source.slice(index, stringEnd);
    let cursor = stringEnd;
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== ":") {
      index = stringEnd;
      continue;
    }

    let key;
    try { key = JSON.parse(rawString); } catch {
      index = stringEnd;
      continue;
    }
    if (!numericIdKeys.has(key)) { index = stringEnd; continue; }

    cursor += 1;
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    const numberStart = cursor;
    if (source[cursor] === "-") cursor += 1;
    const digitStart = cursor;
    while (source[cursor] >= "0" && source[cursor] <= "9") cursor += 1;
    if (cursor === digitStart) { index = stringEnd; continue; }
    const numberEnd = cursor;
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (![",", "}", "]"].includes(source[cursor])) { index = stringEnd; continue; }

    output.push(source.slice(copiedUntil, numberStart), JSON.stringify(source.slice(numberStart, numberEnd)));
    copiedUntil = numberEnd;
    index = numberEnd;
  }

  output.push(source.slice(copiedUntil));
  return output.join("");
}

function rejectUpgrade(socket, status, reason) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function hasValidAuthorization(request, token) {
  const header = request.headers.authorization;
  const match = typeof header === "string" ? header.match(/^Bearer\s+([^\s]+)$/iu) : null;
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function createOneBotBridge({ port, path, accessToken, onMessage, onStatus }) {
  const server = createServer();
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes, perMessageDeflate: false });
  const pendingActions = new Map();
  let activeClient = null;
  let nextEcho = 0;
  let closed = false;

  function reportStatus(connected) {
    try {
      onStatus?.({ connected });
    } catch {
      // Status reporting must never interfere with message processing.
    }
  }

  function sendAction(action, params) {
    const client = activeClient;
    if (!client || client.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("OneBot WebSocket is not connected"));
    }

    const echo = `codex-${++nextEcho}`;
    const hasOutgoingImage = action === "send_msg" && Array.isArray(params?.message) && params.message.some((segment) => segment?.type === "image");
    const isForward = action === "send_group_forward_msg" || action === "send_private_forward_msg";
    const actionTimeoutMs = hasOutgoingImage || isForward ? 60_000 : action === "get_image" ? 30_000 : responseTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingActions.delete(echo);
        reject(new Error("OneBot action timed out"));
      }, actionTimeoutMs);
      pendingActions.set(echo, { resolve, reject, timer });

      try {
        client.send(JSON.stringify({ action, params, echo }), (error) => {
          if (!error) return;
          clearTimeout(timer);
          pendingActions.delete(echo);
          reject(error);
        });
      } catch (error) {
        clearTimeout(timer);
        pendingActions.delete(echo);
        reject(error);
      }
    });
  }

  async function handlePayload(client, source) {
    let payload;
    try {
      payload = JSON.parse(preserveNumericIds(source));
    } catch {
      return;
    }

    if (payload && payload.echo !== undefined && pendingActions.has(String(payload.echo))) {
      const pending = pendingActions.get(String(payload.echo));
      pendingActions.delete(String(payload.echo));
      clearTimeout(pending.timer);
      if (payload.status === "ok" && payload.retcode === 0) pending.resolve(payload.data ?? null);
      else {
        const error = new Error("OneBot action failed");
        error.code = payload.status === "failed" ? "ONEBOT_ACTION_REJECTED" : "ONEBOT_ACTION_UNCONFIRMED";
        pending.reject(error);
      }
      return;
    }

    if (payload?.post_type !== "message" || client !== activeClient) return;
    try {
      await onMessage(payload, { sendMessage: sendAction });
    } catch {
      // Caller owns redacted diagnostics; inbound event payloads are never logged here.
    }
  }

  function handleConnection(client) {
    if (activeClient && activeClient.readyState === WebSocket.OPEN) {
      client.close(1013, "Another local OneBot client is active");
      return;
    }

    activeClient = client;
    reportStatus(true);
    client.on("message", (data, isBinary) => {
      if (isBinary) return;
      void handlePayload(client, data.toString("utf8"));
    });
    client.on("close", () => {
      if (client !== activeClient) return;
      activeClient = null;
      reportStatus(false);
      for (const [echo, pending] of pendingActions) {
        clearTimeout(pending.timer);
        pending.reject(new Error("OneBot WebSocket disconnected"));
        pendingActions.delete(echo);
      }
    });
    client.on("error", () => {
      // Avoid logging transport errors that can include local connection details.
    });
  }

  server.on("upgrade", (request, socket, head) => {
    let requestPath;
    try {
      requestPath = new URL(request.url, "http://127.0.0.1").pathname;
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (requestPath !== path) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!hasValidAuthorization(request, accessToken)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    if (activeClient && activeClient.readyState === WebSocket.OPEN) {
      rejectUpgrade(socket, 409, "Conflict");
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, handleConnection);
  });

  return {
    start() {
      if (closed) return Promise.reject(new Error("OneBot bridge is closed"));
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    getStatus() {
      return { connected: Boolean(activeClient && activeClient.readyState === WebSocket.OPEN) };
    },
    async close() {
      if (closed) return;
      closed = true;
      reportStatus(false);
      for (const [echo, pending] of pendingActions) {
        clearTimeout(pending.timer);
        pending.reject(new Error("OneBot bridge stopped"));
        pendingActions.delete(echo);
      }
      for (const client of websocketServer.clients) client.close(1001, "Bridge stopping");
      websocketServer.close();
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
