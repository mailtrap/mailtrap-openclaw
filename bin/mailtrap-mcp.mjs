#!/usr/bin/env node
// Starts the pinned `mcp-mailtrap` server (stdio) from wherever npm installed it.
//
// OpenClaw installs plugins into a managed npm project, and npm hoists
// `mcp-mailtrap` beside this package instead of nesting it under
// ./node_modules, so a fixed relative path in openclaw.plugin.json would not
// resolve. Resolving from this file works for hoisted, nested and linked
// layouts alike.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

// OpenClaw gives MCP children a minimal environment, so read the Mailtrap
// credentials from ~/.openclaw/.env. Only these keys are copied, so no other
// secret in that file reaches the server. A value already set wins.
// (Not process.loadEnvFile: that would load every key.)
const KEYS = ["MAILTRAP_API_TOKEN", "MAILTRAP_ACCOUNT_ID", "MAILTRAP_SANDBOX_ID"];
const envFile = join(homedir(), ".openclaw", ".env");
if (existsSync(envFile)) {
  const parsed = parseEnv(readFileSync(envFile, "utf8"));
  for (const key of KEYS) {
    if (process.env[key] === undefined && parsed[key] !== undefined) process.env[key] = parsed[key];
  }
}

const require = createRequire(import.meta.url);
await import(pathToFileURL(require.resolve("mcp-mailtrap/dist/index.js")).href);
