#!/usr/bin/env bash
# install.sh: copy the parallel-agent workflow kit into another Git repository.
# Run with --help for usage. Nothing is committed or pushed.
set -euo pipefail
# Never let an inherited git or shell environment redirect reads, writes or `cd`.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT CDPATH
while IFS='=' read -r v _; do case $v in GIT_TRACE*) unset "$v" ;; esac; done < <(env)

usage() {
  cat <<'EOT'
Usage: install.sh [--owner GITHUB_LOGIN] [--force] [--no-tests] [--no-hooks-path] [--] TARGET_DIR

Copies the merge gate, guard hooks, CI workflow, PR template, CONTRIBUTING and the kit's
tests into TARGET_DIR, which must be the top level of a Git repository.

  --owner LOGIN     write .github/CODEOWNERS as "* @LOGIN" (otherwise a placeholder)
  --force           overwrite existing regular files (symlinks, hard links to other files,
                    directories and nested repositories are never touched)
  --no-tests        do not copy tests/
  --no-hooks-path   do not set core.hooksPath=.githooks in the target
  -h, --help        show this help

Existing files are left alone unless --force. .claude/settings.json is merged so the
agent-guard hook is registered without dropping existing hooks. core.hooksPath is set in the
clone's local config only when it is not already set there. Exit status: 0 when everything
requested was done, 1 when nothing was written because of a refused argument or state,
2 when the run completed but some paths were refused (see the report).
EOT
}
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

KIT=$(cd -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")" && pwd -P)
OWNER='' OWNER_SET=0 FORCE=0 TESTS=1 HOOKS_PATH=1 TARGET=''
while [ $# -gt 0 ]; do
  case $1 in
    -h|--help) usage; exit 0 ;;
    --owner) [ $# -ge 2 ] || die "--owner needs a GitHub login"; OWNER=$2; OWNER_SET=1; shift ;;
    --owner=*) OWNER=${1#--owner=}; OWNER_SET=1 ;;
    --force) FORCE=1 ;;
    --no-tests) TESTS=0 ;;
    --no-hooks-path) HOOKS_PATH=0 ;;
    --) shift; while [ $# -gt 0 ]; do [ -z "$TARGET" ] || die "only one TARGET_DIR allowed"; TARGET=$1; shift; done; break ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *) [ -z "$TARGET" ] || die "only one TARGET_DIR allowed"; TARGET=$1 ;;
  esac
  shift
done

# ---- Pre-flight: everything that can refuse the whole run does so before any write. ----
[ -n "$TARGET" ] || { usage >&2; die "TARGET_DIR is required"; }
command -v git >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "node (20 or newer) is required"
[ -d "$TARGET" ] || die "not a directory: $TARGET"
TARGET=$(cd -- "$TARGET" && pwd -P)
top=$(git -C "$TARGET" rev-parse --show-toplevel 2>/dev/null) || die "$TARGET is not inside a Git repository"
[ "$(readlink -f -- "$top")" = "$TARGET" ] || die "run against the repository top level: $top"
[ "$TARGET" != "$KIT" ] || die "TARGET_DIR is the kit itself"
if (( OWNER_SET )); then
  OWNER=${OWNER#@}
  LC_ALL=C bash -c '[[ $1 =~ ^[A-Za-z0-9](-?[A-Za-z0-9])*$ ]] && [ ${#1} -le 39 ]' _ "$OWNER" || die "invalid GitHub login: '$OWNER'"
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

# ---- Report: printed on every exit, so an abort still shows what was actually written. ----
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
  if [ "$rc" -ne 0 ]; then printf 'install.sh aborted (exit %s); the lists above show what was actually written.\n' "$rc" >&2; fi
}
trap finish EXIT

# A relative path may be written only if no existing component is a symlink, no intermediate
# component is a non-directory, no intermediate directory is another repository, and an existing
# leaf is a regular file with a single hard link. Prints the reason when it refuses.
path_problem() {
  local acc=$TARGET rel=$1 IFS=/ comp leaf sub='' mode
  leaf=${rel##*/}
  for comp in $rel; do
    acc=$acc/$comp; sub=${sub:+$sub/}$comp
    [ -L "$acc" ] && { printf 'a symlink is in its path'; return; }
    if [ "$comp" != "$leaf" ] && [ -e "$acc" ]; then
      [ -d "$acc" ] || { printf 'a non-directory is in its path'; return; }
      [ -e "$acc/.git" ] && { printf 'a nested repository is in its path'; return; }
      mode=$(git -C "$TARGET" ls-files -s -- "$sub" 2>/dev/null | awk 'NR == 1 { print $1 }')
      [ "$mode" = 160000 ] && { printf 'a submodule is in its path'; return; }
    fi
  done
  if [ -e "$acc" ]; then
    [ -f "$acc" ] || { printf 'exists and is not a regular file'; return; }
    [ "$(stat -c %h -- "$acc")" = 1 ] || { printf 'is a hard link to another file'; return; }
  fi
}
is_exec() { local e; for e in "${EXEC[@]}"; do [ "$e" = "$1" ] && return 0; done; return 1; }

# Write $2 (a file) to relative path $1 atomically; records the outcome. $3 = mode (add|force).
write_file() {
  local rel=$1 src=$2 dst="$TARGET/$1" tmp
  if ! mkdir -p -- "$(dirname -- "$dst")" 2>/dev/null; then refused+=("$rel (cannot create its directory)"); return; fi
  tmp=$(mktemp -- "$dst.XXXXXX" 2>/dev/null) || { refused+=("$rel (directory not writable)"); return; }
  if ! cp -- "$src" "$tmp" 2>/dev/null; then rm -f -- "$tmp"; refused+=("$rel (copy failed)"); return; fi
  if is_exec "$rel"; then chmod 755 -- "$tmp"; else chmod 644 -- "$tmp"; fi
  if ! mv -f -- "$tmp" "$dst" 2>/dev/null; then rm -f -- "$tmp"; refused+=("$rel (cannot replace it)"); return; fi
  if [ "$3" = force ]; then overwritten+=("$rel"); else added+=("$rel"); fi
}

put() { # relative path, source file
  local rel=$1 src=$2 dst="$TARGET/$1" why
  why=$(path_problem "$rel"); if [ -n "$why" ]; then refused+=("$rel ($why)"); return; fi
  if [ -e "$dst" ] && (( ! FORCE )); then skipped+=("$rel"); return; fi
  if [ -e "$dst" ]; then write_file "$rel" "$src" force; else write_file "$rel" "$src" add; fi
}
for f in "${FILES[@]}"; do put "$f" "$KIT/$f"; done
# CI_STATE: installed (written now), kept (an existing file was left alone) or refused.
CI_STATE=refused
if [[ " ${added[*]-} ${overwritten[*]-} " == *' .github/workflows/ci.yml '* ]]; then CI_STATE=installed
elif [[ " ${skipped[*]-} " == *' .github/workflows/ci.yml '* ]]; then
  CI_STATE=kept
  notes+=('.github/workflows/ci.yml already existed: the gate needs a check named "verify" in a workflow named "CI"; add that job to your workflow or copy the kit'"'"'s .github/workflows/ci.yml by hand')
fi

# ---- CODEOWNERS (GitHub reads .github/, then the root, then docs/) ----
PLACEHOLDER='* @OWNER'
co_rel=.github/CODEOWNERS co=$TARGET/.github/CODEOWNERS
normalized_co() { tr -d '\r' <"$co" | sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }
# write_co TEXT LABEL-ARRAY LABEL: atomic write; a failure is a refusal, never an abort.
write_co() {
  local tmp
  if ! mkdir -p -- "$(dirname -- "$co")" 2>/dev/null || ! tmp=$(mktemp -- "$co.XXXXXX" 2>/dev/null); then refused+=("$co_rel (directory not writable)"); return; fi
  if ! printf '%s\n' "$1" >"$tmp" 2>/dev/null || ! chmod 644 -- "$tmp" || ! mv -f -- "$tmp" "$co" 2>/dev/null; then rm -f -- "$tmp"; refused+=("$co_rel (cannot write it)"); return; fi
  case $2 in added) added+=("$3") ;; updated) updated+=("$3") ;; overwritten) overwritten+=("$3") ;; esac
}
why=$(path_problem "$co_rel")
if [ -n "$why" ]; then refused+=("$co_rel ($why)")
elif [ ! -e "$co" ] && { [ -e "$TARGET/CODEOWNERS" ] || [ -e "$TARGET/docs/CODEOWNERS" ]; }; then
  notes+=("$co_rel not created: CODEOWNERS already exists at the repository root or in docs/ and .github/ would shadow it")
else
  is_placeholder=0 has_placeholder=0
  if [ -e "$co" ]; then
    [ "$(normalized_co)" = "$PLACEHOLDER" ] && is_placeholder=1
    normalized_co | grep -qxF "$PLACEHOLDER" && has_placeholder=1
  fi
  if (( OWNER_SET )); then
    if [ ! -e "$co" ]; then write_co "* @$OWNER" added "$co_rel"
    elif (( is_placeholder )); then write_co "* @$OWNER" updated "$co_rel (placeholder replaced with @$OWNER)"
    elif (( FORCE )); then write_co "* @$OWNER" overwritten "$co_rel"
    else skipped+=("$co_rel"); (( has_placeholder )) && notes+=("$co_rel still contains the placeholder line '* @OWNER' among other rules; edit it by hand"); fi
  else
    if [ ! -e "$co" ]; then write_co "$PLACEHOLDER" added "$co_rel (placeholder: replace @OWNER with the owner's GitHub login)"
    elif (( has_placeholder )); then notes+=("$co_rel still holds the placeholder @OWNER; re-run with --owner LOGIN or edit it")
    else skipped+=("$co_rel"); fi
  fi
fi

# ---- .claude/settings.json: create, or merge the agent-guard hook into an existing object. ----
st_rel=.claude/settings.json settings=$TARGET/.claude/settings.json
why=$(path_problem "$st_rel")
if [ -n "$why" ]; then refused+=("$st_rel ($why)")
elif [ ! -e "$settings" ] || ! grep -q '[^[:space:]]' "$settings"; then
  write_file "$st_rel" "$KIT/.claude/settings.json" add
else
  merged=$(node - "$settings" <<'JS' || echo error
const fs = require('node:fs');
const file = process.argv[2];
const cmd = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-guard.mjs"';
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
try {
  const s = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
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
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: fs.statSync(file).mode & 0o777 });
  fs.renameSync(tmp, file);
  console.log('merged');
} catch (e) { console.log(`unsupported: ${e.message}`); }
JS
)
  case $merged in
    merged) updated+=("$st_rel (agent-guard PreToolUse hook added; file re-serialised with two-space indentation)") ;;
    present) skipped+=("$st_rel (agent-guard hook already registered)") ;;
    *) refused+=("$st_rel (${merged#unsupported: }; register the hook by hand, see .claude/settings.json in the kit)") ;;
  esac
fi

# ---- core.hooksPath: repository-level config only (local file, its includes, worktree config). ----
HOOKS_STATE=skipped
if (( HOOKS_PATH )); then
  # --show-scope reports where each value comes from; includes inherit the including file's scope.
  mapfile -t scoped < <(git -C "$TARGET" config --show-scope --get-all core.hooksPath 2>/dev/null || true)
  current=() global=''
  for line in "${scoped[@]}"; do
    case $line in local$'\t'*|worktree$'\t'*) current+=("${line#*$'\t'}") ;; *) global=${line#*$'\t'} ;; esac
  done
  hooks_dir=$(git -C "$TARGET" rev-parse --path-format=absolute --git-path hooks)
  if [ ${#current[@]} -gt 1 ]; then
    HOOKS_STATE=other; notes+=("core.hooksPath has several repository-level values (${current[*]}) and was left unchanged")
  elif [ ${#current[@]} -eq 1 ] && [ "${current[0]}" = .githooks ]; then HOOKS_STATE=set; notes+=('core.hooksPath is already .githooks')
  elif [ ${#current[@]} -eq 1 ]; then
    HOOKS_STATE=other; notes+=("core.hooksPath is '${current[0]}' (repository-level config) and was left unchanged; chain .githooks/pre-push from your hook manager, or set core.hooksPath=.githooks to use the kit's hook")
  elif [ ! -f "$TARGET/.githooks/pre-push" ]; then
    HOOKS_STATE=other; notes+=('core.hooksPath was not set because .githooks/pre-push is not in place (see Refused above)')
  elif ! git -C "$TARGET" config --local core.hooksPath .githooks 2>"$TARGET/.githooks/.config-error.$$"; then
    HOOKS_STATE=other; notes+=("could not set core.hooksPath: $(tr '\n' ' ' <"$TARGET/.githooks/.config-error.$$")")
    rm -f -- "$TARGET/.githooks/.config-error.$$"
  else
    rm -f -- "$TARGET/.githooks/.config-error.$$"
    HOOKS_STATE=set; notes+=('set core.hooksPath=.githooks in this clone (local config)')
    live=$(find -L "$hooks_dir" -maxdepth 1 -type f -perm -u+x ! -name '*.sample' 2>/dev/null | sort | tr '\n' ' ' || true)
    if [ -n "$live" ]; then notes+=("existing hooks in $hooks_dir are no longer run now that core.hooksPath is set: ${live% }; move them into .githooks/ to keep them"); fi
    if [ -n "$global" ] && [ "$global" != .githooks ]; then notes+=("a non-local core.hooksPath ($global) exists; the local value takes precedence in this clone"); fi
  fi
fi

trap - EXIT
finish
printf '\nNext steps in %s:\n' "$TARGET"
cat <<'EOT'
  1. Review scripts/gate-files.txt, scripts/ui-paths.txt, scripts/risky-paths.txt,
     scripts/codex-exclude.txt and scripts/codex-review-contract.md for this project.
EOT
if [ "$CI_STATE" = kept ]; then
  cat <<'EOT'
  2. Your existing .github/workflows/ci.yml was kept. The gate requires a check named
     "verify" in a workflow named "CI" to be green on the exact head commit; add that job
     (see the kit's .github/workflows/ci.yml) and make "npm run verify" mean "the checks
     that must pass before merge".
EOT
elif [ "$CI_STATE" = refused ]; then
  cat <<'EOT'
  2. The CI workflow could not be installed (see Refused above). The gate requires a check
     named "verify" in a workflow named "CI" to be green on the exact head commit; put the
     kit's .github/workflows/ci.yml in place by hand and make "npm run verify" mean "the
     checks that must pass before merge".
EOT
else
  cat <<'EOT'
  2. Make "npm run verify" exist and mean "the checks that must pass before merge".
     The installed CI workflow runs "npm ci && npm run verify" with actions/setup-node's npm
     cache, so it needs a package.json and package-lock.json; adapt it for pnpm, yarn or a
     non-Node project. The gate requires the check "CI / verify" to be green on the exact
     head commit.
EOT
fi
(( TESTS )) && printf '     Include "node --test tests/*.test.mjs" in verify so the kit keeps testing itself.\n'
cat <<'EOT'
  3. Commit on a branch and open a pull request. Bootstrap rule: the PR that first adds
     scripts/land.sh is reviewed and merged by the owner in GitHub's web UI; afterwards every
     merge goes through scripts/land.sh <PR#> from the primary checkout of main.
EOT
case $HOOKS_STATE in
  set) printf '  4. In every other clone: git config core.hooksPath .githooks\n' ;;
  other) printf '  4. Hooks: core.hooksPath was left as it is; wire .githooks/pre-push into your hook manager.\n' ;;
  skipped) printf '  4. In every clone (including this one): git config core.hooksPath .githooks\n' ;;
esac
[ ${#refused[@]} -eq 0 ] || exit 2
