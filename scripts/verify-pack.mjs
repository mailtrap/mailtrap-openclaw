#!/usr/bin/env node
// Pack the plugin (lifecycle scripts enabled, so `prepack` builds dist/) and
// assert the tarball is publishable. Prints the tarball path and sizes.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_UNPACKED = 20 * 1024 * 1024;
const failures = [];
const expect = (ok, msg) => {
  if (!ok) failures.push(msg);
};

const out = execFileSync("npm", ["pack", "--pack-destination", root], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"]
});
// Lifecycle banners share stdout with the result; the tarball name is the last line.
const filename = out.trim().split("\n").pop().trim();
const tarball = join(root, filename);
const files = new Set(
  execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter((f) => f && !f.endsWith("/"))
    .map((f) => f.replace(/^package\//, ""))
);

const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

for (const required of ["package.json", "openclaw.plugin.json", "README.md", "LICENSE", "dist/index.js"]) {
  expect(files.has(required), `tarball is missing ${required}`);
}
const skillNames = readdirSync(join(root, "skills"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);
expect(skillNames.length > 0, "skills/ has no skill folders");
for (const name of skillNames) expect(files.has(`skills/${name}/SKILL.md`), `tarball is missing skills/${name}/SKILL.md`);

for (const ext of pkg.openclaw.extensions) expect(files.has(ext.replace(/^\.\//, "")), `extension entry ${ext} is not in the tarball`);
for (const server of Object.values(manifest.mcpServers ?? {})) {
  for (const arg of server.args ?? []) {
    if (arg.startsWith("./")) expect(files.has(arg.slice(2)), `mcpServers arg ${arg} is not in the tarball`);
  }
}
expect(/^\d+\.\d+\.\d+$/.test(pkg.dependencies?.["mcp-mailtrap"] ?? ""), "mcp-mailtrap must be pinned to an exact version in dependencies");
expect(![...files].some((f) => f.startsWith("node_modules/")), "tarball must not carry node_modules (dependencies install separately)");

// Unpacked size, measured by extracting the tarball.
const work = mkdtempSync(join(tmpdir(), "mailtrap-pack-"));
let unpacked = 0;
try {
  execFileSync("tar", ["-xzf", tarball, "-C", work]);
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else unpacked += statSync(p).size;
    }
  };
  walk(work);
} finally {
  rmSync(work, { recursive: true, force: true });
}
expect(unpacked < MAX_UNPACKED, `unpacked size ${unpacked} B is not under 20 MiB`);

const mib = (n) => (n / 1024 / 1024).toFixed(2);
console.log(`tarball: ${tarball}`);
console.log(`files: ${files.size}, packed: ${mib(statSync(tarball).size)} MiB, unpacked: ${mib(unpacked)} MiB (limit 20 MiB)`);
if (failures.length) {
  console.error(failures.map((f) => `FAIL: ${f}`).join("\n"));
  process.exit(1);
}
console.log("pack:verify OK");
