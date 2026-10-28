#!/usr/bin/env bash
# install.sh: copy the parallel-agent workflow kit into another Git repository.
# Run with --help for usage. Nothing is committed or pushed.
set -euo pipefail
# Never let an inherited git environment (hooks, tools) redirect config writes elsewhere.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR

usage() {
  cat <<'EOT'
Usage: install.sh [--owner GITHUB_LOGIN] [--force] [--no-tests] [--no-hooks-path] TARGET_DIR

Copies the merge gate, guard hooks, CI workflow, PR template, CONTRIBUTING and the kit's
tests into TARGET_DIR, which must be the top level of a Git repository.

  --owner LOGIN     write .github/CODEOWNERS as "* @LOGIN" (otherwise a placeholder)
  --force           overwrite existing regular files (symlinks and directories are never touched)
  --no-tests        do not copy tests/
  --no-hooks-path   do not set core.hooksPath=.githooks in the target
  -h, --help        show this help

Existing files are left alone unless --force. .claude/settings.json is merged so the
agent-guard hook is registered without dropping existing hooks. An existing core.hooksPath
other than .githooks is left alone and reported. Nothing is committed or pushed.
EOT
}
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

KIT=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd -P)
OWNER='' OWNER_SET=0 FORCE=0 TESTS=1 HOOKS_PATH=1 TARGET=''
while [ $# -gt 0 ]; do
  case $1 in
    -h|--help) usage; exit 0 ;;
    --owner) [ $# -ge 2 ] || die "--owner needs a GitHub login"; OWNER=$2; OWNER_SET=1; shift ;;
    --owner=*) OWNER=${1#--owner=}; OWNER_SET=1 ;;
    --force) FORCE=1 ;;
    --no-tests) TESTS=0 ;;
    --no-hooks-path) HOOKS_PATH=0 ;;
    --) shift; [ $# -eq 1 ] || die "exactly one TARGET_DIR is required"; TARGET=$1 ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *) [ -z "$TARGET" ] || die "only one TARGET_DIR allowed"; TARGET=$1 ;;
  esac
  shift
done

# ---- Pre-flight: everything that can refuse does so before any write. ----
[ -n "$TARGET" ] || { usage >&2; die "TARGET_DIR is required"; }
command -v git >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "node (20 or newer) is required"
[ -d "$TARGET" ] || die "not a directory: $TARGET"
TARGET=$(cd "$TARGET" && pwd -P)
top=$(git -C "$TARGET" rev-parse --show-toplevel 2>/dev/null) || die "$TARGET is not inside a Git repository"
[ "$(readlink -f "$top")" = "$TARGET" ] || die "run against the repository top level: $top"
[ "$TARGET" != "$KIT" ] || die "TARGET_DIR is the kit itself"
if (( OWNER_SET )); then
  OWNER=${OWNER#@}
  [[ $OWNER =~ ^[A-Za-z0-9](-?[A-Za-z0-9]){0,38}$ ]] || die "invalid GitHub login: '$OWNER'"
fi

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
for f in "${FILES[@]}" .claude/settings.json; do
  [ -f "$KIT/$f" ] || die "kit file missing: $f (incomplete checkout of the kit at $KIT)"
done

# ---- Report: printed on every exit, so an abort still shows what was written. ----
added=() updated=() overwritten=() skipped=() refused=() notes=()
report() { local label=$1; shift; [ $# -gt 0 ] || return 0; printf '%s\n' "$label"; printf '  %s\n' "$@"; }
finish() {
  local rc=$?
  report 'Added:' "${added[@]+"${added[@]}"}"
  report 'Updated:' "${updated[@]+"${updated[@]}"}"
  report 'Overwritten (--force):' "${overwritten[@]+"${overwritten[@]}"}"
  report 'Left unchanged (exists; use --force to overwrite):' "${skipped[@]+"${skipped[@]}"}"
  report 'Refused (never touched):' "${refused[@]+"${refused[@]}"}"
  report 'Notes:' "${notes[@]+"${notes[@]}"}"
  if [ "$rc" -ne 0 ]; then printf 'install.sh aborted (exit %s); the lists above show what was already written.\n' "$rc" >&2; fi
}
trap finish EXIT

# A relative path is safe to write only if no existing component of it is a symlink;
# otherwise a copy could land outside the repository.
path_ok() {
  local acc=$TARGET IFS=/ comp
  for comp in $1; do
    acc=$acc/$comp
    [ -L "$acc" ] && return 1
  done
  return 0
}
is_exec() { local e; for e in "${EXEC[@]}"; do [ "$e" = "$1" ] && return 0; done; return 1; }

put() { # relative path, source file
  local rel=$1 src=$2 dst="$TARGET/$1"
  if ! path_ok "$rel"; then refused+=("$rel (a symlink is in its path)"); return; fi
  if [ -e "$dst" ] && [ ! -f "$dst" ]; then refused+=("$rel (exists and is not a regular file)"); return; fi
  if [ -e "$dst" ] && (( ! FORCE )); then skipped+=("$rel"); return; fi
  if [ -e "$dst" ]; then overwritten+=("$rel"); else added+=("$rel"); fi
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  if is_exec "$rel"; then chmod +x "$dst"; fi
}
for f in "${FILES[@]}"; do put "$f" "$KIT/$f"; done
if [ -e "$TARGET/.github/workflows/ci.yml" ] && ! [[ " ${added[*]-} ${overwritten[*]-} " == *' .github/workflows/ci.yml '* ]]; then
  notes+=('.github/workflows/ci.yml already existed: the gate needs a check named "verify" in a workflow named "CI"; add that job to your workflow or install the kit'"'"'s with --force')
fi

# ---- CODEOWNERS ----
PLACEHOLDER='* @OWNER'
co_rel=.github/CODEOWNERS co=$TARGET/.github/CODEOWNERS
if ! path_ok "$co_rel"; then refused+=("$co_rel (a symlink is in its path)")
elif [ -e "$co" ] && [ ! -f "$co" ]; then refused+=("$co_rel (exists and is not a regular file)")
else
  existing=''; [ -e "$co" ] && existing=$(<"$co")
  if (( OWNER_SET )); then
    if [ ! -e "$co" ]; then mkdir -p "$(dirname "$co")"; printf '* @%s\n' "$OWNER" >"$co"; added+=("$co_rel")
    elif [ "$existing" = "$PLACEHOLDER" ]; then printf '* @%s\n' "$OWNER" >"$co"; updated+=("$co_rel (placeholder replaced with @$OWNER)")
    elif (( FORCE )); then printf '* @%s\n' "$OWNER" >"$co"; overwritten+=("$co_rel")
    else skipped+=("$co_rel"); fi
  else
    if [ ! -e "$co" ]; then mkdir -p "$(dirname "$co")"; printf '%s\n' "$PLACEHOLDER" >"$co"; added+=("$co_rel (placeholder: replace @OWNER with the owner's GitHub login)")
    elif [ "$existing" = "$PLACEHOLDER" ]; then notes+=("$co_rel still holds the placeholder @OWNER; re-run with --owner LOGIN or edit it")
    else skipped+=("$co_rel"); fi
  fi
fi

# ---- .claude/settings.json: create, or merge the agent-guard hook into an existing object. ----
st_rel=.claude/settings.json settings=$TARGET/.claude/settings.json
if ! path_ok "$st_rel"; then refused+=("$st_rel (a symlink is in its path)")
elif [ -e "$settings" ] && [ ! -f "$settings" ]; then refused+=("$st_rel (exists and is not a regular file)")
elif [ ! -e "$settings" ]; then
  mkdir -p "$(dirname "$settings")"; cp "$KIT/.claude/settings.json" "$settings"; added+=("$st_rel")
else
  merged=$(node - "$settings" <<'JS' || echo error
const fs = require('node:fs');
const file = process.argv[2];
const cmd = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-guard.mjs"';
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
try {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isObj(s)) throw new Error('not an object');
  if (s.hooks !== undefined && !isObj(s.hooks)) throw new Error('hooks is not an object');
  const pre = s.hooks?.PreToolUse;
  if (pre !== undefined && !Array.isArray(pre)) throw new Error('hooks.PreToolUse is not an array');
  const registered = (pre ?? []).some((e) => isObj(e) && Array.isArray(e.hooks)
    && e.hooks.some((h) => isObj(h) && typeof h.command === 'string' && h.command.includes('agent-guard.mjs')));
  if (registered) { console.log('present'); process.exit(0); }
  s.hooks ??= {};
  s.hooks.PreToolUse ??= [];
  s.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: cmd }] });
  fs.writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
  console.log('merged');
} catch (e) { console.log(`unsupported: ${e.message}`); }
JS
)
  case $merged in
    merged) updated+=("$st_rel (agent-guard PreToolUse hook added)") ;;
    present) skipped+=("$st_rel (agent-guard hook already registered)") ;;
    *) refused+=("$st_rel (${merged#unsupported: }; register the hook by hand, see .claude/settings.json in the kit)") ;;
  esac
fi

# ---- core.hooksPath ----
if (( HOOKS_PATH )); then
  current=$(git -C "$TARGET" config --get core.hooksPath || true)
  if [ -z "$current" ]; then git -C "$TARGET" config core.hooksPath .githooks; notes+=('set core.hooksPath=.githooks in this clone')
  elif [ "$current" = .githooks ]; then notes+=('core.hooksPath is already .githooks')
  else notes+=("core.hooksPath is '$current' and was left unchanged; chain .githooks/pre-push from your hook manager, or set core.hooksPath=.githooks to use the kit's hook")
  fi
fi

trap - EXIT
finish
cat <<EOT

Next steps in $TARGET:
  1. Review scripts/gate-files.txt, scripts/ui-paths.txt, scripts/risky-paths.txt,
     scripts/codex-exclude.txt and scripts/codex-review-contract.md for this project.
  2. Make "npm run verify" exist and mean "the checks that must pass before merge".
     The installed CI workflow runs "npm ci && npm run verify" with actions/setup-node's npm
     cache, so it needs a package.json and package-lock.json; adapt it for pnpm, yarn or a
     non-Node project. The gate requires the check "CI / verify" to be green on the exact
     head commit.$( (( TESTS )) && printf '\n     Include "node --test tests/*.test.mjs" in verify so the kit keeps testing itself.')
  3. Commit on a branch and open a pull request. Bootstrap rule: the PR that first adds
     scripts/land.sh is reviewed and merged by the owner in GitHub's web UI; afterwards every
     merge goes through scripts/land.sh <PR#> from the primary checkout of main.
  4. In every clone: git config core.hooksPath .githooks
EOT
