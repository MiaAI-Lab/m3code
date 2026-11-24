#!/usr/bin/env node
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { startM3Server } from "./server.ts";

function resolveDataDir(): string {
  return process.env.M3_SERVER_DATA_DIR?.trim() || NodePath.join(NodeOs.homedir(), ".m3-server");
}

function loadOrCreateToken(dataDir: string): { readonly token: string; readonly generated: boolean } {
  const fromEnv = process.env.M3_SERVER_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, generated: false };
  NodeFs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tokenPath = NodePath.join(dataDir, "admin-token");
  if (NodeFs.existsSync(tokenPath)) {
    const existing = NodeFs.readFileSync(tokenPath, "utf8").trim();
    if (existing.length > 0) return { token: existing, generated: false };
  }
  const generated = NodeCrypto.randomBytes(32).toString("base64url");
  NodeFs.writeFileSync(tokenPath, `${generated}\n`, { mode: 0o600 });
  return { token: generated, generated: true };
}

const dataDir = resolveDataDir();
const host = process.env.M3_SERVER_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.M3_SERVER_PORT || 8787);
const dbPath = NodePath.join(dataDir, "m3-server.sqlite");
const { token, generated } = loadOrCreateToken(dataDir);

const running = await startM3Server({ host, port, token, dbPath });

console.log(`[m3-server] listening on http://${running.host}:${running.port}`);
console.log(`[m3-server] database: ${dbPath}`);
if (generated) {
  console.log(`[m3-server] generated admin token saved to ${NodePath.join(dataDir, "admin-token")}`);
}

const shutdown = async () => {
  await running.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
