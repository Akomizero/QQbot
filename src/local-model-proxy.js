import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdir, readFile, copyFile, access } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const localRoot = fileURLToPath(new URL("../.local/", import.meta.url));
export function validateLocalModelProxyConfig(value) {
  const config = value?.params?.config;
  if (value?.version !== 1 || typeof value.corePath !== "string" || !isAbsolute(value.corePath) || basename(value.corePath).toLowerCase() !== "flclashcore.exe"
    || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || !config || config["mixed-port"] !== value.port
    || config["bind-address"] !== "127.0.0.1" || config["allow-lan"] !== false || config.tun?.enable !== false || config.dns?.enable !== false
    || ["port", "socks-port", "redir-port", "tproxy-port", "external-controller", "external-controller-tls", "external-controller-pipe", "external-controller-unix"].some(key => Boolean(config[key]))
    || config.listeners?.length || config["proxy-providers"] || config["rule-providers"]
    || !Array.isArray(config.proxies) || !config.proxies.length || config.proxies.length > 4
    || !Array.isArray(config.authentication) || !config.authentication.length) throw new Error("模型专用出口配置无效。");
  return value;
}

export async function startConfiguredModelProxy({ configFile = resolve(localRoot, "model-proxy.json") } = {}) {
  let source;
  try { source = await readFile(configFile, "utf8"); } catch (error) { if (error.code === "ENOENT") return { configured: false, stop: async () => {} }; throw error; }
  if (Buffer.byteLength(source) > 100_000 || process.platform !== "win32") throw new Error("模型专用出口配置无法使用。");
  const config = validateLocalModelProxyConfig(JSON.parse(source));
  const home = resolve(localRoot, "model-proxy-home"); await mkdir(home, { recursive: true });
  if (typeof config.resourceDir === "string" && isAbsolute(config.resourceDir)) {
    for (const name of ["GeoSite.dat", "GeoIP.dat", "geoip.metadb", "ASN.mmdb"]) {
      try { await access(resolve(home, name)); } catch { try { await copyFile(resolve(config.resourceDir, name), resolve(home, name)); } catch (error) { if (error.code !== "ENOENT") throw error; } }
    }
  }
  let stopped = false, current = null, restarting = null;
  async function cleanup(state) {
    if (!state) return;
    state.closing = true;
    for (const task of state.pending.values()) { clearTimeout(task.timer); task.reject(new Error("模型专用出口已关闭。")); } state.pending.clear();
    state.socket?.destroy();
    if (state.child && state.child.exitCode === null) state.child.kill();
    if (state.server.listening) await new Promise(resolve => state.server.close(resolve));
  }
  async function launch() {
    if (stopped) return;
    let connectedResolve, connectedReject;
    const connected = new Promise((resolve, reject) => { connectedResolve = resolve; connectedReject = reject; });
    const state = { server: createServer(), socket: null, child: null, sequence: 0, pending: new Map(), buffer: "", closing: false };
    current = state;
    state.server.on("connection", socket => {
      if (state.socket) { socket.destroy(); return; }
      state.socket = socket; socket.on("error", () => {});
      socket.on("data", bytes => {
        state.buffer += bytes.toString("utf8");
        if (state.buffer.length > 2_000_000) { socket.destroy(); state.child?.kill(); return; }
        let end;
        while ((end = state.buffer.indexOf("\n")) >= 0) {
          const line = state.buffer.slice(0, end); state.buffer = state.buffer.slice(end + 1);
          let message; try { message = JSON.parse(line); } catch { continue; }
          const task = state.pending.get(message.id);
          if (task) { state.pending.delete(message.id); clearTimeout(task.timer); task.resolve(message); }
        }
      });
      connectedResolve();
    });
    await new Promise((resolve, reject) => { state.server.once("error", reject); state.server.listen(0, "127.0.0.1", resolve); });
    const deadline = setTimeout(() => connectedReject(new Error("模型专用出口启动超时。")), 10_000);
    function action(method, data = null) {
      return new Promise((resolve, reject) => {
        const id = String(++state.sequence);
        const timer = setTimeout(() => { state.pending.delete(id); reject(new Error("模型专用出口响应超时。")); }, 15_000);
        state.pending.set(id, { resolve, reject, timer });
        state.socket.write(JSON.stringify({ id, method, data }) + "\n");
      });
    }
    try {
      state.child = spawn(config.corePath, [String(state.server.address().port)], { cwd: home, windowsHide: true, stdio: "ignore" });
      state.child.on("error", () => connectedReject(new Error("模型专用出口启动失败。")));
      state.child.on("exit", () => {
        connectedReject(new Error("模型专用出口已退出。"));
        if (stopped || state.closing) return;
        console.warn("模型专用出口退出，5秒后自动恢复。");
        restarting = setTimeout(() => { restarting = null; void cleanup(state).then(launch).catch(() => retryStart()); }, 5000);
        restarting.unref?.();
      });
      await connected; clearTimeout(deadline);
      for (const [method, data] of [["initClash", JSON.stringify({ "home-dir": home, version: 1 })], ["setupConfig", JSON.stringify(config.params)], ["startListener", null]]) {
        if (stopped) throw new Error("模型专用出口已关闭。");
        state.stage = method;
        const result = await action(method, data);
        if (result.code !== 0 || result.data === false || method === "setupConfig" && result.data !== "") { console.warn("模型专用出口初始化失败（阶段：" + method + "）。"); throw new Error("模型专用出口初始化失败。"); }
      }
      console.log("模型专用出口已就绪（仅本机，自动备用线路）。");
    } catch (error) { console.warn("模型专用出口启动未完成（阶段：" + (state.stage ?? "connect") + "，类别：" + error.name + "）。"); clearTimeout(deadline); await cleanup(state); throw error; }
  }
  function retryStart() {
    if (stopped || restarting) return;
    console.warn("模型专用出口暂未恢复，稍后继续尝试。");
    restarting = setTimeout(() => { restarting = null; void launch().catch(() => retryStart()); }, 10_000); restarting.unref?.();
  }
  try { await launch(); } catch { retryStart(); }
  return { configured: true, stop: async () => { stopped = true; if (restarting) clearTimeout(restarting); await cleanup(current); } };
}
