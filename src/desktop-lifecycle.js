import { createServer } from "node:net";
import { timingSafeEqual } from "node:crypto";

// Local named pipe only. The desktop owns a per-session random capability.
// Not exposed through the management HTTP server or page JavaScript.
export async function startDesktopLifecycle(onStop) {
  const name = process.env.FEIYU_DESKTOP_PIPE ?? "";
  const token = process.env.FEIYU_DESKTOP_TOKEN ?? "";
  if (!name && !token) return null;
  if (process.platform !== "win32" || !/^FeiyuBot-[a-f0-9]{48}$/u.test(name) || !/^[a-f0-9]{64}$/u.test(token)) {
    throw new Error("桌面生命周期参数无效。");
  }
  let requested = false;
  const server = createServer(socket => {
    let text = "";
    socket.setTimeout(1500, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", chunk => {
      text += chunk.toString("utf8");
      if (text.length > 2048) { socket.destroy(); return; }
      if (!text.includes("\n")) return;
      let command;
      try { command = JSON.parse(text.split("\n")[0]); } catch { socket.destroy(); return; }
      const candidate = Buffer.from(typeof command.token === "string" ? command.token : "");
      const expected = Buffer.from(token);
      if (command.action !== "shutdown" || candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
        socket.destroy(); return;
      }
      socket.end('{"accepted":true}\n');
      if (!requested) { requested = true; setImmediate(onStop); }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(`\\\\.\\pipe\\${name}`, resolve); });
  return { close: () => new Promise(resolve => server.close(resolve)) };
}
