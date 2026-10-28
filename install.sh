#!/usr/bin/env bash
# install.sh: copy the parallel-agent workflow kit into another Git repository.
#
#   install.sh [--owner GITHUB_LOGIN] [--force] [--no-tests] [--no-hooks-path] TARGET_DIR
#
# Copies the merge gate, guard hooks, CI workflow, PR template, CONTRIBUTING and the tests
# into TARGET_DIR (the top level of a Git repository). Existing files are left alone unless
# --force is given. CODEOWNERS is written for --owner. .claude/settings.json is merged so the
# agent-guard hook is registered without dropping existing hooks. Sets core.hooksPath to
# .githooks in the target unless --no-hooks-path. Nothing is committed or pushed.
set -euo pipefail

KIT=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
OWNER='' FORCE=0 TESTS=1 HOOKS_PATH=1 TARGET=''

usage() { sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case $1 in
    -h|--help) usage; exit 0 ;;
    --owner) [ $# -ge 2 ] || die "--owner needs a GitHub login"; OWNER=$2; shift ;;
    --owner=*) OWNER=${1#--owner=} ;;
    --force) FORCE=1 ;;
    --no-tests) TESTS=0 ;;
    --no-hooks-path) HOOKS_PATH=0 ;;
    -*) die "unknown option: $1" ;;
    *) [ -z "$TARGET" ] || die "only one TARGET_DIR allowed"; TARGET=$1 ;;
  esac
  shift
done
[ -n "$TARGET" ] || { usage >&2; die "TARGET_DIR is required"; }
[ -d "$TARGET" ] || die "not a directory: $TARGET"
TARGET=$(cd "$TARGET" && pwd -P)
top=$(git -C "$TARGET" rev-parse --show-toplevel 2>/dev/null) || die "$TARGET is not inside a Git repository"
[ "$(readlink -f "$top")" = "$TARGET" ] || die "run against the repository top level: $top"
[ "$TARGET" != "$KIT" ] || die "TARGET_DIR is the kit itself"
if [ -n "$OWNER" ]; then
  OWNER=${OWNER#@}
  [[ $OWNER =~ ^[A-Za-z0-9](-?[A-Za-z0-9])*$ ]] || die "invalid GitHub login: $OWNER"
fi

# Files copied verbatim. Keep in sync with the repository layout.
FILES=(
  scripts/land.sh
  scripts/codex-review.sh
  scripts/agents-status.sh
  scripts/gate-files.txt
  scripts/ui-paths.txt
  scripts/risky-paths.txt
  scripts/codex-exclude.txt
  scripts/codex-review-contract.md
  .githooks/pre-push
  .github/pull_request_template.md
  .github/workflows/ci.yml
  .claude/hooks/agent-guard.mjs
  CONTRIBUTING.md
)
TEST_FILES=(
  tests/agent-guard.test.mjs
  tests/agents-status.test.mjs
  tests/codex-review.test.mjs
  tests/land.test.mjs
  tests/pre-push-hook.test.mjs
  tests/helpers/land-gh-stub.mjs
)
EXEC=(scripts/land.sh scripts/codex-review.sh scripts/agents-status.sh .githooks/pre-push .claude/hooks/agent-guard.mjs)
(( TESTS )) && FILES+=("${TEST_FILES[@]}")

added=() skipped=() overwritten=()
put() { # relative path, source file
  local rel=$1 src=$2 dst="$TARGET/$1"
  if [ -e "$dst" ] && (( ! FORCE )); then skipped+=("$rel"); return; fi
  [ -e "$dst" ] && overwritten+=("$rel") || added+=("$rel")
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
}
for f in "${FILES[@]}"; do
  [ -f "$KIT/$f" ] || die "kit file missing: $f (is this a complete checkout?)"
  put "$f" "$KIT/$f"
done
for f in "${EXEC[@]}"; do [ -f "$TARGET/$f" ] && chmod +x "$TARGET/$f"; done

# CODEOWNERS: written for --owner, otherwise a placeholder the owner must edit.
co=$TARGET/.github/CODEOWNERS
if [ -n "$OWNER" ]; then
  if [ ! -e "$co" ] || (( FORCE )); then
    [ -e "$co" ] && overwritten+=(.github/CODEOWNERS) || added+=(.github/CODEOWNERS)
    printf '* @%s\n' "$OWNER" >"$co"
  else skipped+=(.github/CODEOWNERS); fi
elif [ ! -e "$co" ]; then
  printf '* @OWNER\n' >"$co"; added+=('.github/CODEOWNERS (placeholder: replace @OWNER)')
else skipped+=(.github/CODEOWNERS); fi

# .claude/settings.json: create, or merge the agent-guard PreToolUse hook into an existing file.
settings=$TARGET/.claude/settings.json
if [ ! -e "$settings" ]; then
  mkdir -p "$TARGET/.claude"; cp "$KIT/.claude/settings.json" "$settings"; added+=(.claude/settings.json)
else
  merged=$(node - "$settings" <<'JS'
const fs = require('node:fs');
const file = process.argv[2];
const cmd = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-guard.mjs"';
let s;
try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log('unparseable'); process.exit(0); }
if (typeof s !== 'object' || s === null || Array.isArray(s)) { console.log('unparseable'); process.exit(0); }
s.hooks ??= {};
s.hooks.PreToolUse ??= [];
const has = s.hooks.PreToolUse.some((e) => (e.hooks ?? []).some((h) => h.command === cmd));
if (has) { console.log('present'); process.exit(0); }
s.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: cmd }] });
fs.writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
console.log('merged');
JS
)
  case $merged in
    merged) overwritten+=('.claude/settings.json (agent-guard hook merged in)') ;;
    present) skipped+=('.claude/settings.json (hook already registered)') ;;
    *) skipped+=('.claude/settings.json (not valid JSON object; register the hook by hand)') ;;
  esac
fi

if (( HOOKS_PATH )); then git -C "$TARGET" config core.hooksPath .githooks; fi

report() { local label=$1; shift; [ $# -gt 0 ] || return 0; printf '%s\n' "$label"; printf '  %s\n' "$@"; }
report 'Added:' "${added[@]+"${added[@]}"}"
report 'Overwritten (--force):' "${overwritten[@]+"${overwritten[@]}"}"
report 'Left unchanged (exists; use --force to overwrite):' "${skipped[@]+"${skipped[@]}"}"
(( HOOKS_PATH )) && printf 'Set core.hooksPath=.githooks in %s\n' "$TARGET"

cat <<EOT

Next steps in $TARGET:
  1. Review scripts/gate-files.txt, scripts/ui-paths.txt, scripts/risky-paths.txt,
     scripts/codex-exclude.txt and scripts/codex-review-contract.md for this project.
  2. Make "npm run verify" exist and mean "the checks that must pass before merge"; the
     CI workflow runs "npm ci && npm run verify" and the gate requires the check
     "CI / verify" to be green. Add "node --test tests/*.test.mjs" to it to keep the kit's own tests.
  3. Commit on a branch and open a pull request. Bootstrap rule: the PR that first adds
     scripts/land.sh is reviewed and merged by the owner in GitHub's web UI; afterwards every
     merge goes through scripts/land.sh <PR#> from the primary checkout of main.
  4. Each clone runs: git config core.hooksPath .githooks
EOT
