#!/usr/bin/env node
// Sync ./skills with the commit pinned in skills-source.json.
//   node scripts/sync-skills.mjs          replace ./skills with the pinned copy
//   node scripts/sync-skills.mjs --check  compare only; exit 1 on any difference
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(root, "skills");
const check = process.argv.includes("--check");

const { repo, commit } = JSON.parse(readFileSync(join(root, "skills-source.json"), "utf8"));
if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[0-9a-f]{40}$/.test(commit)) {
  console.error("skills-source.json must hold { repo: 'owner/name', commit: <40-char sha> }");
  process.exit(2);
}

function relFiles(base) {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [relative(base, join(dir, e.name)).split("\\").join("/")]
    );
  return walk(base).sort();
}

const work = mkdtempSync(join(tmpdir(), "mailtrap-skills-"));
try {
  const url = `https://codeload.github.com/${repo}/tar.gz/${commit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const archive = join(work, "src.tar.gz");
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  const extracted = join(work, "x");
  execFileSync("mkdir", ["-p", extracted]);
  execFileSync("tar", ["-xzf", archive, "-C", extracted]);
  const [top] = readdirSync(extracted);
  const upstream = join(extracted, top, "skills");
  if (!existsSync(upstream)) throw new Error(`${repo}@${commit} has no skills/ directory`);

  if (check) {
    const want = relFiles(upstream);
    const have = existsSync(skillsDir) ? relFiles(skillsDir) : [];
    const problems = [];
    for (const f of want) {
      if (!have.includes(f)) problems.push(`missing: ${f}`);
      else if (!readFileSync(join(upstream, f)).equals(readFileSync(join(skillsDir, f)))) problems.push(`differs: ${f}`);
    }
    for (const f of have) if (!want.includes(f)) problems.push(`extra: ${f}`);
    if (problems.length) {
      console.error(`skills/ drifted from ${repo}@${commit}:\n  ${problems.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`skills/ matches ${repo}@${commit} (${want.length} files)`);
  } else {
    rmSync(skillsDir, { recursive: true, force: true });
    cpSync(upstream, skillsDir, { recursive: true });
    console.log(`skills/ replaced from ${repo}@${commit} (${relFiles(skillsDir).length} files)`);
  }
} catch (err) {
  console.error(`sync-skills failed: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
} finally {
  rmSync(work, { recursive: true, force: true });
}
