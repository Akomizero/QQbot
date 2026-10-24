import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

// Same ordered receipt as desktop/control.ps1; no configuration or user data.
export function runtimeRevision() {
  const root = new URL("./", import.meta.url);
  const receipt = readdirSync(root).filter(name => name.endsWith(".js")).sort()
    .map(name => `${name}:${createHash("sha256").update(readFileSync(new URL(name, root))).digest("hex")}\n`).join("");
  return createHash("sha256").update(receipt).digest("hex");
}
