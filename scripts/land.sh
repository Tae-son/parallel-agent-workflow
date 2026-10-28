#!/usr/bin/env bash
# Owner-only merge gate: verify a PR, print a review packet, squash-merge after typed confirmation.
set -euo pipefail

DEFAULT_REPO=''   # resolved from $LAND_REPO or the primary worktree's origin URL
REPO=''
CODEX=0
PR=''
MERGED=0
MERGE_STARTED=0
HELP=0
BRIEF=''
FETCH_REMOTE=origin
TMP=''
GATE=0
UI=0
GLOBS=()
GATE_PATTERNS=()
UI_PATTERNS=()
RISKY_PATTERNS=()
GATE_PATHS=()
CODEX_RESULT='Codex review: not requested'

usage() {
  cat <<'EOF'
Usage: scripts/land.sh [--codex] [--repo OWNER/NAME] <PR#>

Owner-only merge gate. Checks the PR against GitHub's main (CI verify green,
up to date, no symlinks/submodules), prints a review packet and squash-merges
only after confirmation typed on the terminal.

  --codex             run scripts/codex-review.sh before confirming
  --repo OWNER/NAME   target another repository. The default is $LAND_REPO if
                      set, otherwise OWNER/NAME parsed from the primary
                      worktree's "origin" remote URL on github.com.
  -h, --help          show this help
EOF
}

die() { printf 'REFUSED: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
# Replace C0/C1 controls (except tab/newline) so PR text cannot drive the terminal, and
# bidi/zero-width/invisible characters (U+00AD, U+061C, U+180E, U+200B-200F, U+2028-202E,
# U+2060-2064, U+2066-2069, U+FE00-FE0F, U+FEFF) so it cannot disguise paths. Raw non-UTF-8
# bytes 0x80-0x9F are left alone because they are also UTF-8 continuation bytes.
sanitize() {
  LC_ALL=C sed -e 's/\xc2[\x80-\x9f\xad]/?/g' -e 's/\xd8\x9c/?/g' -e 's/\xe1\xa0\x8e/?/g' \
    -e 's/\xe2\x80[\x8b-\x8f\xa8-\xae]/?/g' -e 's/\xe2\x81[\xa0-\xa4\xa6-\xa9]/?/g' \
    -e 's/\xef\xb8[\x80-\x8f]/?/g' -e 's/\xef\xbb\xbf/?/g' | LC_ALL=C tr '\000-\010\013-\037\177' '?'
}
# Single-line fields (titles, URLs) additionally lose embedded newlines so they cannot forge packet lines.
oneline() { sanitize | awk 'NR > 1 { printf "?" } { printf "%s", $0 }'; }
if [ -t 1 ]; then HI=$'\e[1;31m'; BO=$'\e[1m'; NO=$'\e[0m'; else HI=''; BO=''; NO=''; fi

cleanup() {
  [ -n "$TMP" ] && rm -rf "$TMP"
  if [ "$MERGED" = 1 ] || [ "$HELP" = 1 ]; then :
  elif [ "$MERGE_STARTED" = 1 ]; then printf 'Not merged by this run as far as it knows: gh pr merge was interrupted or failed; check the PR on GitHub before retrying.\n' >&2
  else printf 'Not merged.\n' >&2; fi
}

parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      -h|--help) HELP=1; usage; exit 0 ;;
      --codex) CODEX=1 ;;
      --repo) [ $# -ge 2 ] || die "--repo needs OWNER/NAME"; REPO=$2; shift ;;
      --repo=*) REPO=${1#--repo=} ;;
      -*) die "unknown option: $1" ;;
      *) [ -z "$PR" ] || die "only one PR number allowed"; PR=$1 ;;
    esac
    shift
  done
  [[ $PR =~ ^[1-9][0-9]*$ ]] || { usage >&2; die "a PR number is required"; }
  if [ -n "$REPO" ]; then valid_repo "$REPO" || die "invalid --repo: $REPO"; fi
}

# GitHub owner: alphanumerics and single hyphens; repository: alphanumerics . _ - but not "." or "..".
valid_repo() {
  [[ $1 =~ ^[A-Za-z0-9](-?[A-Za-z0-9]){0,38}/[A-Za-z0-9._-]{1,100}$ ]] && [[ ${1#*/} != . && ${1#*/} != .. ]]
}

# OWNER/NAME from a github.com URL: https://[user@]github.com/O/N[.git], ssh://git@github.com[:port]/O/N[.git],
# [git@]github.com:O/N[.git]. Prints nothing for anything else.
repo_from_url() {
  local url=${1%/}; url=${url%.git}
  if [[ $url =~ ^(https://([^/@]+@)?|ssh://([^/@]+@)?)github\.com(:[0-9]+)?/([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)$ ]]; then
    printf '%s/%s' "${BASH_REMATCH[5]}" "${BASH_REMATCH[6]}"
  elif [[ $url =~ ^([^/@:]+@)?github\.com:([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)$ ]]; then
    printf '%s/%s' "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
  fi
}

# The repository this gate protects: $LAND_REPO, else OWNER/NAME from the primary worktree's
# configured origin URL (https://github.com/O/N[.git], git@github.com:O/N[.git],
# ssh://git@github.com/O/N[.git]). --repo overrides it and is shown prominently.
resolve_repo() {
  local url origin_repo
  url=$(git -C "$TOP" config --get remote.origin.url 2>/dev/null || true)
  origin_repo=$(repo_from_url "$url")
  if [ -n "${LAND_REPO:-}" ]; then DEFAULT_REPO=$LAND_REPO; else DEFAULT_REPO=$origin_repo; fi
  if [ -z "$DEFAULT_REPO" ]; then
    [ -n "$REPO" ] || die "cannot determine the GitHub repository: origin is not a github.com URL. Set LAND_REPO=OWNER/NAME or pass --repo OWNER/NAME"
    DEFAULT_REPO=$REPO
  fi
  valid_repo "$DEFAULT_REPO" || die "invalid repository name: $DEFAULT_REPO"
  [ -n "$REPO" ] || REPO=$DEFAULT_REPO
  if [ "$REPO" != "$DEFAULT_REPO" ]; then
    say "${HI}!!! NON-DEFAULT REPOSITORY: $REPO (default is $DEFAULT_REPO) !!!${NO}"
  fi
  # Objects are fetched from origin only when origin is (or may be) $REPO; a known different
  # GitHub repository at origin (a fork, a mirror) means fetching from $REPO's own URL instead.
  FETCH_REMOTE=origin
  if [ -n "$origin_repo" ] && [ "$origin_repo" != "$REPO" ]; then
    FETCH_REMOTE="https://github.com/$REPO.git"
    say "origin is $origin_repo; fetching PR objects from $FETCH_REMOTE"
  fi
}

# Trust only the primary worktree's copy of this script.
locate_self() {
  local self top gitdir common
  self=$(readlink -f "${BASH_SOURCE[0]}")
  top=$(git -C "$(dirname "$self")" rev-parse --show-toplevel 2>/dev/null) || die "land.sh is not inside a git repository"
  gitdir=$(git -C "$top" rev-parse --path-format=absolute --git-dir)
  common=$(git -C "$top" rev-parse --path-format=absolute --git-common-dir)
  [ "$gitdir" = "$common" ] || die "run land.sh from the primary worktree, not a linked worktree ($top)"
  [ "$self" = "$(readlink -f "$top/scripts/land.sh")" ] || die "land.sh must run as <primary worktree>/scripts/land.sh"
  SELF=$self
  TOP=$top
}

# ...and only if it is byte-identical to main on GitHub, at the exact main commit used for everything else.
check_self() {
  local blob remote
  MAIN_SHA=$(main_sha)
  blob=$(git -C "$TOP" hash-object --no-filters "$SELF")
  if ! remote=$(gh api "repos/$REPO/contents/scripts/land.sh?ref=$MAIN_SHA" 2>"$TMP/err" </dev/null | jq -r '.sha // empty'); then
    if grep -q 'HTTP 404' "$TMP/err"; then
      die "scripts/land.sh is not on $REPO main ($MAIN_SHA) yet. Bootstrap rule: the PR that adds land.sh is reviewed and merged by the owner in GitHub's web UI. (A 404 can also mean $REPO is misspelled or not accessible to gh.)"
    fi
    die "could not read scripts/land.sh on $REPO main: $(sanitize <"$TMP/err")"
  fi
  [ -n "$remote" ] || die "could not read scripts/land.sh on $REPO main: no blob SHA in the API response"
  [ "$blob" = "$remote" ] || die "this land.sh ($blob) differs from $REPO main (${remote:-unknown}). Run 'git pull --ff-only' on main in the primary worktree and retry."
}

main_sha() {
  local sha
  sha=$(gh api "repos/$REPO/commits/main" </dev/null | jq -r '.sha // empty') || die "could not read $REPO main"
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || die "unexpected main SHA from GitHub"
  printf '%s' "$sha"
}

pr_json() { gh pr view "$PR" -R "$REPO" --json "$1" </dev/null >"$TMP/$2" || die "gh pr view $PR failed"; }
field() { jq -r "$1" "$TMP/pr.json"; }

# PR state checks shared by the first read and the pre-merge re-check. $1 = json file, $2 = label.
check_pr_state() {
  local f=$1 ci
  [ "$(jq -r .state "$f")" = OPEN ] || die "PR #$PR is $(jq -r .state "$f" | oneline), not OPEN$2"
  [ "$(jq -r .isDraft "$f")" = false ] || die "PR #$PR is a draft$2"
  [ "$(jq -r .baseRefName "$f")" = main ] || die "PR #$PR targets '$(jq -r .baseRefName "$f" | oneline)', not main$2"
  ci=$(jq -r '[.statusCheckRollup[]? | select(.workflowName == "CI" and .name == "verify")]
    | if length == 0 then "missing"
      elif all(.status == "COMPLETED" and .conclusion == "SUCCESS") then "SUCCESS"
      else map("\(.status)/\(.conclusion)") | join(", ") end' "$f")
  [ "$ci" = SUCCESS ] || die "CI / verify is not green ($(printf '%s' "$ci" | oneline))$2; no result is a fail"
}

read_pr() {
  git fetch --quiet --no-tags "$FETCH_REMOTE" main || die "git fetch $FETCH_REMOTE main failed"
  git fetch --quiet --no-tags "$FETCH_REMOTE" "refs/pull/$PR/head" || die "git fetch $FETCH_REMOTE refs/pull/$PR/head failed"
  pr_json number,state,isDraft,baseRefName,headRefOid,body,title,url,statusCheckRollup pr.json
  check_pr_state "$TMP/pr.json" ''
  HEAD_SHA=$(field .headRefOid)
  [[ $HEAD_SHA =~ ^[0-9a-f]{40}$ ]] || die "unexpected head SHA for PR #$PR"
  git cat-file -e "$HEAD_SHA^{commit}" 2>/dev/null || die "PR head $HEAD_SHA not present after fetching from $FETCH_REMOTE; is that $REPO?"
  git cat-file -e "$MAIN_SHA^{commit}" 2>/dev/null || die "GitHub main $MAIN_SHA not present after fetching from $FETCH_REMOTE; is that $REPO?"
  # PR body with CR and HTML comments removed; template placeholders count as empty.
  jq -r '.body // "" | gsub("\r"; "") | gsub("<!--[\\s\\S]*?-->"; "")' "$TMP/pr.json" >"$TMP/body"
}


check_current() {
  local behind
  behind=$(gh api "repos/$REPO/compare/$MAIN_SHA...$HEAD_SHA" </dev/null | jq -r '.behind_by') || die "compare API failed"
  if [ "$behind" != 0 ]; then
    say "Branch is behind main by $(printf '%s' "$behind" | sanitize) commit(s). Update it with:"
    say "  gh pr update-branch $PR -R $REPO"
    die "PR #$PR is not up to date with main (wait for CI on the updated head, then re-run)"
  fi
}

# Print body section $1: inline text after "Name:" plus following lines, skipping leading
# blanks. Ends at a heading, or at a blank line after content unless $2=heading and the
# section opened with a markdown heading.
section() {
  awk -v n="$(tr '[:upper:]' '[:lower:]' <<<"$1")" -v mode="$2" '
    { l = tolower($0) }
    !on && l ~ ("^#+[[:space:]]*" n ":?[[:space:]]*$") { on = 1; hd = 1; next }
    !on && l ~ ("^[[:space:]]*[-*_]*[[:space:]]*" n "[*_]*:") {
      on = 1; sub(/^[^:]*:[*_]*/, ""); if ($0 ~ /[^[:space:]]/) { print; got = 1 }; next }
    !on { next }
    /^[[:space:]]*#/ { exit }
    /^[[:space:]]*$/ { if (got && !(hd && mode == "heading")) exit; if (got) print; next }
    { print; got = 1 }' "$TMP/body"
}

parse_globs() {
  local line tok
  while IFS= read -r line; do
    line=$(sed -E 's/^[[:space:]]*[-*+][[:space:]]+//' <<<"$line")
    for tok in ${line//,/ }; do   # word-split only; globbing is off below
      tok=${tok//\`/}
      [ -n "$tok" ] && GLOBS+=("$tok")
    done
  done < <(section 'Allowed paths' para)
}

in_scope() {
  local g
  for g in "${GLOBS[@]}"; do
    if [[ $g == */ ]]; then [[ $1 == $g* ]] && return 0
    else [[ $1 == $g ]] && return 0; fi
  done
  return 1
}

# Pattern lists share the gate-files.txt format: one bash pattern per line, "#" comments.
read_patterns() { # file -> prints trimmed, non-comment, non-empty lines
  grep -v '^[[:space:]]*#' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | grep -v '^$' || true
}

# Gate patterns come from main's exact commit, never from the PR or the working tree.
load_gate_list() {
  git show "$MAIN_SHA:scripts/gate-files.txt" >"$TMP/gate-files.txt" 2>/dev/null \
    || die "scripts/gate-files.txt is missing on main; cannot classify gate files"
  mapfile -t GATE_PATTERNS < <(read_patterns "$TMP/gate-files.txt")
  [ ${#GATE_PATTERNS[@]} -gt 0 ] || die "scripts/gate-files.txt on main lists no patterns"
}

# ui-paths.txt decides which changes need an approved brief and a checked preview. It is
# required on main so that a missing list fails closed; an empty list disables the UI gate.
load_ui_list() {
  git show "$MAIN_SHA:scripts/ui-paths.txt" >"$TMP/ui-paths.txt" 2>/dev/null \
    || die "scripts/ui-paths.txt is missing on main; cannot classify UI changes (an empty list disables the UI gate)"
  mapfile -t UI_PATTERNS < <(read_patterns "$TMP/ui-paths.txt")
}

# risky-paths.txt only drives the --codex hint and the Codex file selection; it is optional.
load_risky_list() {
  if git show "$MAIN_SHA:scripts/risky-paths.txt" >"$TMP/risky-paths.txt" 2>/dev/null; then
    mapfile -t RISKY_PATTERNS < <(read_patterns "$TMP/risky-paths.txt")
  else
    rm -f "$TMP/risky-paths.txt"
  fi
}

match_any() { # path pattern...
  local p=$1 g; shift
  for g in "$@"; do [[ $p == $g ]] && return 0; done
  return 1
}
is_gate() { match_any "$1" "${GATE_PATTERNS[@]}"; }
is_ui() { [ ${#UI_PATTERNS[@]} -gt 0 ] && match_any "$1" "${UI_PATTERNS[@]}"; }
wants_codex() { { [ ${#RISKY_PATTERNS[@]} -gt 0 ] && match_any "$1" "${RISKY_PATTERNS[@]}"; } || is_gate "$1"; }

classify() {
  local meta p line special='' hint=0 om nm
  BASE=$(git merge-base "$MAIN_SHA" "$HEAD_SHA") || die "no merge base between main and PR head"
  git diff --no-renames --raw -z "$BASE" "$HEAD_SHA" >"$TMP/raw"
  [ -s "$TMP/raw" ] || die "PR #$PR changes nothing"
  parse_globs
  : >"$TMP/in"; : >"$TMP/out"; : >"$TMP/gate"; : >"$TMP/ui"
  # -z --raw records: ":oldmode newmode oldsha newsha status" NUL path NUL (exact path bytes)
  while IFS= read -r -d '' meta && IFS= read -r -d '' p; do
    line="  ${meta##* }  ${p//$'\n'/?}"   # sanitize() handles other controls when printed
    om=${meta:1:6} nm=${meta:8:6}
    if [ "$om" != "$nm" ] && [ "$om" != 000000 ] && [ "$nm" != 000000 ]; then line+="  (mode $om -> $nm)"; fi
    case " ${meta:1:13} " in *' 120000 '*|*' 160000 '*) special+="$line"$'\n' ;; esac
    if [ ${#GLOBS[@]} -gt 0 ] && in_scope "$p"; then say "$line" >>"$TMP/in"; else say "$line" >>"$TMP/out"; fi
    if is_gate "$p"; then GATE=1; GATE_PATHS+=("$p"); say "$line" >>"$TMP/gate"; fi
    if is_ui "$p"; then UI=1; say "$line" >>"$TMP/ui"; fi
    if wants_codex "$p"; then hint=1; fi
  done <"$TMP/raw"
  if [ -n "$special" ]; then
    printf '%s' "$special" | sanitize >&2
    die "PR adds, changes or removes a symlink or submodule"
  fi
  if [ "$CODEX" = 0 ] && [ "$hint" = 1 ]; then
    say "Hint: these changes touch risky paths (scripts/risky-paths.txt) or gate files; re-run with --codex for a Codex review."
  fi
}

# The newest successful deployment status for the head commit. Any deployment on the SHA counts,
# including ones a same-repository workflow could create; the owner must still open and judge it.
find_preview() {
  local ids id url env
  PREVIEW='No preview built from this exact commit'
  ids=$(gh api "repos/$REPO/deployments?sha=$HEAD_SHA" 2>/dev/null </dev/null | jq -r '.[]?.id') || return 0
  for id in $ids; do
    [[ $id =~ ^[0-9]+$ ]] || continue
    url=$(gh api "repos/$REPO/deployments/$id/statuses" 2>/dev/null </dev/null \
      | jq -r 'first(.[]? | select(.state == "success")) | "\(.environment // "?")\t\(.environment_url // "")"') || continue
    env=${url%%$'\t'*}; url=${url#*$'\t'}
    if [ -n "$url" ]; then PREVIEW="Preview ($(oneline <<<"$env")): $(oneline <<<"$url")"; return 0; fi
  done
}

check_ui() {
  PREVIEW='No UI change'
  [ "$UI" = 1 ] || return 0
  BRIEF=$(grep -Eim1 '^[[:space:]*_-]*approved brief[*_]*:[*_]*[[:space:]]*[^[:space:]]*[[:alnum:]]' "$TMP/body" \
    | sed -E 's/^[[:space:]*_-]*[Aa]pproved [Bb]rief[*_]*:[*_]*[[:space:]]*//') \
    || die "UI changed but the PR body has no 'Approved brief:' line with real content"
  find_preview
}

# Runs main's exact codex-review.sh and siblings, never the working tree's or the PR's copy.
run_codex() {
  local dir="$TMP/main-scripts" f out outcome rc=0
  [ "$CODEX" = 1 ] || return 0
  { say '## Scope'; section Scope heading; say; say '## Allowed paths'; section 'Allowed paths' para; } \
    | sanitize >"$TMP/contract.md"
  mkdir "$dir"
  if ! git show "$MAIN_SHA:scripts/codex-review.sh" >"$dir/codex-review.sh" 2>/dev/null; then
    CODEX_RESULT='Codex review did not run (scripts/codex-review.sh is not on main)'; say "$CODEX_RESULT"; return 0
  fi
  chmod +x "$dir/codex-review.sh"
  for f in codex-exclude.txt codex-review-contract.md risky-paths.txt; do
    git show "$MAIN_SHA:scripts/$f" >"$dir/$f" 2>/dev/null || rm -f "$dir/$f"
  done
  cp "$TMP/gate-files.txt" "$dir/gate-files.txt"
  out=$(mktemp -d "${TMPDIR:-/tmp}/land-codex-$PR-XXXXXX")
  "$dir/codex-review.sh" --repo-root "$TOP" --base "$BASE" --head "$HEAD_SHA" --pr "$PR" \
    --contract "$TMP/contract.md" --out "$out" </dev/null || rc=$?
  case $rc in
    0) if [ -s "$out/outcome" ]; then
         outcome=$(head -n 1 "$out/outcome" | oneline)
         CODEX_RESULT="Codex review: $outcome (details in $out)"
       else
         CODEX_RESULT="Codex review: finished (no outcome recorded; see $out)"
       fi ;;
    1) die "blocked by unresolved Codex findings (see $out)" ;;
    2) CODEX_RESULT="Codex review did not run (exit 2); continuing without it"; say "$CODEX_RESULT" ;;
    *) die "codex-review.sh failed unexpectedly (exit $rc); fix it on main or re-run without --codex" ;;
  esac
}

group() {
  say "$1"
  if [ -s "$2" ]; then sanitize <"$2"; else say '  (none)'; fi
}

print_packet() {
  if [ "$GATE" = 1 ]; then
    say "${BO}==== Gate file diffs (full) ====${NO}"
    git -c color.ui=never --literal-pathspecs diff --no-color --no-renames --no-ext-diff --no-textconv "$BASE" "$HEAD_SHA" -- "${GATE_PATHS[@]}" | sanitize
  fi
  say "${BO}==== Review packet ====${NO}"
  say "Title:    $(field .title | oneline)"
  say "URL:      $(field .url | oneline)"
  say "Repo:     $REPO"
  say "Base:     main (merge-base $BASE)"
  say "Head SHA: $HEAD_SHA"
  say "Main SHA: $MAIN_SHA"
  say "CI:       CI / verify COMPLETED SUCCESS"
  if [ ${#GLOBS[@]} -eq 0 ]; then
    say "${HI}!!! No Allowed paths declared in the PR body: every path is unscoped !!!${NO}"
  else
    say "Allowed paths: $(printf '%s ' "${GLOBS[@]}" | sanitize)"
  fi
  group 'In declared scope:' "$TMP/in"
  group "${HI}OUTSIDE declared scope (owner decides):${NO}" "$TMP/out"
  group 'Gate files:' "$TMP/gate"
  group 'UI:' "$TMP/ui"
  [ "$UI" = 1 ] && say "Approved brief: $(oneline <<<"$BRIEF")"
  say "$PREVIEW"
  say "$CODEX_RESULT"
}

ask() {
  local answer
  printf '%s' "$1" >&3
  read -r -u 3 answer || die "no confirmation (EOF)"
  [ "$answer" = "$2" ] || die "confirmation did not match '$2'"
}

confirm() {
  local want=$PR
  [ "$REPO" = "$DEFAULT_REPO" ] || want="$REPO#$PR"
  if ! { exec 3<>/dev/tty; } 2>/dev/null; then die "no terminal: land.sh needs an interactive owner"; fi
  ask "Type $want to merge (anything else aborts): " "$want"
  if [ "$GATE" = 1 ]; then ask "Gate files changed. Type 'gate' to accept their full diffs: " gate; fi
  if [ "$UI" = 1 ]; then ask "UI changed. Check the preview, then type 'preview checked': " 'preview checked'; fi
}

recheck_and_merge() {
  local head main
  pr_json headRefOid,state,isDraft,baseRefName,statusCheckRollup recheck.json
  head=$(jq -r .headRefOid "$TMP/recheck.json")
  [ "$head" = "$HEAD_SHA" ] || die "PR head changed since review ($HEAD_SHA -> $(oneline <<<"$head")); re-run"
  check_pr_state "$TMP/recheck.json" ' (changed since review; re-run)'
  main=$(main_sha)
  [ "$main" = "$MAIN_SHA" ] || die "main moved since review ($MAIN_SHA -> $main); re-run"
  MERGE_STARTED=1
  gh pr merge "$PR" -R "$REPO" --squash --match-head-commit "$HEAD_SHA" </dev/null || die "gh pr merge failed"
  MERGED=1
  say "Merged PR #$PR at $HEAD_SHA into $REPO main (with a merge queue, gh reports success on enqueue; confirm on GitHub)."
}

main() {
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  parse_args "$@"
  exec </dev/null   # only fd 3 (/dev/tty) may supply the owner's answers
  set -f            # PR-supplied globs must never expand against the filesystem
  TMP=$(mktemp -d)
  locate_self
  resolve_repo
  check_self
  cd "$TOP"
  read_pr
  load_gate_list
  load_ui_list
  load_risky_list
  check_current
  classify
  check_ui
  run_codex
  print_packet
  confirm
  recheck_and_merge
}

main "$@"; exit
