import { startManagementServer } from "./web.js";

startManagementServer().catch((error) => {
  console.error("本机管理面板启动失败：", error.message ?? error);
  process.exitCode = 1;
});
