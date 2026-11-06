#!/usr/bin/env bash
# Release gate. Stops at the first failure and prints a summary table.
set -uo pipefail
cd "$(dirname "$0")/.."

names=()
results=()

run() {
  local name="$1"; shift
  echo "=== ${name}: $*"
  if "$@"; then
    names+=("$name"); results+=("PASS")
  else
    names+=("$name"); results+=("FAIL")
    summary
    exit 1
  fi
}

summary() {
  echo
  echo "Release gate summary"
  echo "--------------------"
  for i in "${!names[@]}"; do
    printf '%-14s %s\n' "${names[$i]}" "${results[$i]}"
  done
}

tarball() {
  node -p "const p=require('./package.json');p.name.replace(/^@/,'').replace('/','-')+'-'+p.version+'.tgz'"
}

run typecheck npm run typecheck
run build npm run build
run test npm test
run skills:check npm run skills:check
run pack:verify npm run pack:verify
# The CLI needs source metadata even for a dry run. It needs no login.
run clawhub-dry-run npx --no-install clawhub package publish "./$(tarball)" \
  --family code-plugin --owner mailtrap --source-repo mailtrap/mailtrap-openclaw \
  --source-commit "$(git rev-parse HEAD)" --source-ref "$(git rev-parse --abbrev-ref HEAD)" --dry-run

summary
