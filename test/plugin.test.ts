import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel: string) => JSON.parse(readFileSync(join(root, rel), "utf8"));
const manifest = readJson("openclaw.plugin.json");
const pkg = readJson("package.json");
const skillNames = readdirSync(join(root, "skills"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

describe("openclaw.plugin.json", () => {
  it("has the required fields", () => {
    expect(manifest.id).toBe("mailtrap");
    expect(manifest.configSchema).toMatchObject({ type: "object" });
    expect(manifest.version).toBe(pkg.version);
  });

  it("declares the skills directory and the mailtrap stdio MCP server", () => {
    expect(manifest.skills).toEqual(["./skills"]);
    expect(manifest.mcpServers.mailtrap).toMatchObject({ transport: "stdio", command: "node" });
  });

  it("never uses npx and embeds no credentials", () => {
    const text = JSON.stringify(manifest);
    expect(text).not.toMatch(/npx/);
    expect(manifest.mcpServers.mailtrap.env).toBeUndefined();
    expect(text).not.toMatch(/MAILTRAP_API_TOKEN/);
  });

  it("points mcpServers.mailtrap at launcher files that exist", () => {
    for (const arg of manifest.mcpServers.mailtrap.args as string[]) {
      expect(arg.startsWith("./")).toBe(true);
      expect(existsSync(join(root, arg))).toBe(true);
    }
  });
});

describe("mcp-mailtrap resolution", () => {
  it("is pinned exactly in dependencies", () => {
    expect(pkg.dependencies["mcp-mailtrap"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("resolves from the launcher's location to the pinned version's entry", () => {
    const requireFromLauncher = createRequire(join(root, "bin", "mailtrap-mcp.mjs"));
    const entry = requireFromLauncher.resolve("mcp-mailtrap/dist/index.js");
    expect(existsSync(entry)).toBe(true);
    const installed = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8"));
    expect(installed.version).toBe(pkg.dependencies["mcp-mailtrap"]);
  });

  it("starts the MCP server and answers initialize and tools/list", () => {
    const requests =
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" }
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n";
    const stdout = execFileSync("node", [join(root, manifest.mcpServers.mailtrap.args[0])], {
      cwd: root,
      input: requests,
      encoding: "utf8",
      timeout: 20_000,
      env: { PATH: process.env.PATH ?? "", MAILTRAP_API_TOKEN: "test-token-not-real" }
    });
    const replies = stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(replies.find((r) => r.id === 1)?.result?.serverInfo).toBeDefined();
    const tools = replies.find((r) => r.id === 2)?.result?.tools as { name: string }[];
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((t) => t.name)).toContain("send-email");
  });
});

describe("launcher credentials", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });

  // Runs the real launcher with a preload that records the final process.env keys on exit.
  function runLauncher(envFile: string | null, childEnv: Record<string, string>) {
    const home = mkdtempSync(join(tmpdir(), "mailtrap-home-"));
    homes.push(home);
    if (envFile !== null) {
      mkdirSync(join(home, ".openclaw"));
      writeFileSync(join(home, ".openclaw", ".env"), envFile);
    }
    const out = join(home, "env.json");
    const preload = join(home, "dump.mjs");
    writeFileSync(
      preload,
      `import { writeFileSync } from "node:fs";\nprocess.on("exit", () => writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env)));\n`
    );
    const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    const stdout = execFileSync("node", ["--import", pathToFileURL(preload).href, join(root, "bin", "mailtrap-mcp.mjs")], {
      cwd: root,
      input: `${init}\n`,
      encoding: "utf8",
      timeout: 20_000,
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, ...childEnv }
    });
    return { env: JSON.parse(readFileSync(out, "utf8")) as Record<string, string>, stdout };
  }

  it("copies only the three Mailtrap keys from ~/.openclaw/.env", () => {
    const { env, stdout } = runLauncher(
      "MAILTRAP_API_TOKEN=fake-token\nMAILTRAP_ACCOUNT_ID=111\nMAILTRAP_SANDBOX_ID=222\nOPENAI_API_KEY=fake-openai\nOTHER=x\n",
      {}
    );
    expect(env.MAILTRAP_API_TOKEN).toBe("fake-token");
    expect(env.MAILTRAP_ACCOUNT_ID).toBe("111");
    expect(env.MAILTRAP_SANDBOX_ID).toBe("222");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OTHER).toBeUndefined();
    expect(stdout).not.toContain("fake-token");
  });

  it("keeps a value that is already in the environment", () => {
    const { env } = runLauncher("MAILTRAP_API_TOKEN=from-file\nMAILTRAP_ACCOUNT_ID=111\n", { MAILTRAP_API_TOKEN: "from-env" });
    expect(env.MAILTRAP_API_TOKEN).toBe("from-env");
    expect(env.MAILTRAP_ACCOUNT_ID).toBe("111");
  });

  it("starts the server when ~/.openclaw/.env does not exist", () => {
    const { env, stdout } = runLauncher(null, { MAILTRAP_API_TOKEN: "from-env" });
    expect(env.MAILTRAP_API_TOKEN).toBe("from-env");
    expect(JSON.parse(stdout.trim().split("\n")[0]).result.serverInfo).toBeDefined();
  });
});

describe("skills", () => {
  it("has the eight upstream skills", () => {
    expect(skillNames).toHaveLength(8);
  });

  it.each(skillNames)("%s has SKILL.md with name and description frontmatter", (name) => {
    const text = readFileSync(join(root, "skills", name, "SKILL.md"), "utf8");
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(match, "frontmatter block").not.toBeNull();
    expect(match![1]).toMatch(/^name:\s*\S+/m);
    expect(match![1]).toMatch(/^description:\s*\S+/m);
  });

  it("matches the pinned upstream commit (skills:check)", () => {
    execFileSync("node", [join(root, "scripts", "sync-skills.mjs"), "--check"], { cwd: root, stdio: "pipe" });
  });
});

describe("package.json", () => {
  it("lists in files everything the manifest and openclaw block reference", () => {
    const files = pkg.files as string[];
    const covered = (rel: string) => files.some((f) => rel === f || rel.startsWith(`${f}/`));
    expect(covered("openclaw.plugin.json")).toBe(true);
    expect(covered(manifest.skills[0].replace(/^\.\//, ""))).toBe(true);
    for (const arg of manifest.mcpServers.mailtrap.args as string[]) expect(covered(arg.replace(/^\.\//, ""))).toBe(true);
    for (const ext of pkg.openclaw.extensions as string[]) expect(covered(ext.replace(/^\.\//, ""))).toBe(true);
  });

  it("carries the ClawHub-required compat and build fields", () => {
    expect(pkg.openclaw.compat.pluginApi).toBe(">=2026.11.1");
    expect(pkg.openclaw.compat.minGatewayVersion).toBe("2026.11.1");
    expect(pkg.openclaw.build.openclawVersion).toBe("2026.11.1");
    expect(pkg.openclaw.build.pluginSdkVersion).toBe("2026.11.1");
    expect(pkg.peerDependencies.openclaw).toBe(">=2026.11.1");
  });
});
