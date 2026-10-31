#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/codex-smoke.sh --owner-approved \
    --isolation-root PATH --repo PATH --home PATH --codex-home PATH \
    --stub-bin PATH --codex-bin PATH [--native --model-call-approved] -- CODEX_ARGS...

Runs one explicitly approved Codex smoke command with isolated HOME/CODEX_HOME,
a disposable clean repository with no remotes, a harmless gh stub, and a scrubbed
environment. The declaration is a procedural guardrail, not authenticated owner consent.
A Codex binary outside the disposable root is native mode and additionally requires
both native/model-call flags and matching CODEX_SMOKE_*_APPROVED=1 environment declarations.
EOF
}

die() {
  printf 'codex-smoke: %s\n' "$*" >&2
  exit 2
}

need_value() {
  [ "$#" -ge 2 ] || die "$1 requires a value"
}

owner_approved=0
native=0
model_call_approved=0
isolation_root=
repo=
isolated_home=
codex_home=
stub_bin=
codex_bin=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --owner-approved) owner_approved=1; shift ;;
    --native) native=1; shift ;;
    --model-call-approved) model_call_approved=1; shift ;;
    --isolation-root) need_value "$@"; isolation_root=$2; shift 2 ;;
    --repo) need_value "$@"; repo=$2; shift 2 ;;
    --home) need_value "$@"; isolated_home=$2; shift 2 ;;
    --codex-home) need_value "$@"; codex_home=$2; shift 2 ;;
    --stub-bin) need_value "$@"; stub_bin=$2; shift 2 ;;
    --codex-bin) need_value "$@"; codex_bin=$2; shift 2 ;;
    --) shift; break ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown runner option: $1" ;;
  esac
done
codex_args=("$@")

[ "$owner_approved" -eq 1 ] || die 'explicit owner approval is required (--owner-approved)'
[ -n "$isolation_root" ] || die '--isolation-root is required'
[ -n "$repo" ] || die '--repo is required'
[ -n "$isolated_home" ] || die '--home is required'
[ -n "$codex_home" ] || die '--codex-home is required'
[ -n "$stub_bin" ] || die '--stub-bin is required'
[ -n "$codex_bin" ] || die '--codex-bin is required'
[ "${#codex_args[@]}" -gt 0 ] || die 'Codex arguments are required after --'

for value in "$isolation_root" "$repo" "$isolated_home" "$codex_home" "$stub_bin" "$codex_bin"; do
  [[ "$value" == /* ]] || die "all boundary paths must be absolute: $value"
done

canonical_dir() {
  [ -d "$1" ] || die "required directory does not exist: $1"
  realpath -e -- "$1" || die "cannot resolve directory: $1"
}
canonical_file() {
  [ -f "$1" ] || die "required file does not exist: $1"
  realpath -e -- "$1" || die "cannot resolve file: $1"
}
inside() {
  [[ "$1" == "$2"/* ]]
}

isolation_root=$(canonical_dir "$isolation_root")
repo=$(canonical_dir "$repo")
isolated_home=$(canonical_dir "$isolated_home")
codex_home=$(canonical_dir "$codex_home")
stub_bin=$(canonical_dir "$stub_bin")
codex_bin=$(canonical_file "$codex_bin")

marker="$isolation_root/.codex-smoke-disposable"
[ -f "$marker" ] && [ ! -L "$marker" ] || die "isolation root lacks a regular .codex-smoke-disposable marker"
for pair in "repo:$repo" "home:$isolated_home" "CODEX_HOME:$codex_home" "stub bin:$stub_bin"; do
  label=${pair%%:*}
  value=${pair#*:}
  inside "$value" "$isolation_root" || die "$label must be inside the isolation root"
done
[ "$isolated_home" != "$codex_home" ] || die 'HOME and CODEX_HOME must be separate isolated directories'

for arg in "${codex_args[@]}"; do
  case "$arg" in
    --dangerously-bypass-approvals-and-sandbox|danger-full-access|--sandbox=danger-full-access)
      die "Codex sandbox bypass is prohibited in smoke tests"
      ;;
  esac
done

real_git=$(command -v git) || die 'git is required'
real_git=$(realpath -e -- "$real_git") || die 'cannot resolve git executable'
top=$($real_git -C "$repo" rev-parse --show-toplevel 2>/dev/null) || die 'repo is not a Git working tree'
top=$(realpath -e -- "$top") || die 'cannot resolve repository top level'
[ "$top" = "$repo" ] || die 'repo must name the disposable repository top level exactly'
common=$($real_git -C "$repo" rev-parse --git-common-dir 2>/dev/null) || die 'cannot resolve repository Git directory'
[[ "$common" == /* ]] || common="$repo/$common"
common=$(realpath -e -- "$common") || die 'cannot resolve repository Git directory'
inside "$common" "$isolation_root" || die 'repository Git metadata must be inside the isolation root (linked external worktrees are refused)'
[ -z "$($real_git -C "$repo" remote)" ] || die 'disposable repository must not have Git remotes'
[ -z "$($real_git -C "$repo" status --porcelain=v1 --untracked-files=all)" ] || die 'disposable repository must be clean'

[ -f "$stub_bin/gh" ] && [ -x "$stub_bin/gh" ] && [ ! -L "$stub_bin/gh" ] \
  || die 'an executable regular harmless gh stub is required in --stub-bin'

if inside "$codex_bin" "$isolation_root"; then
  [ "$native" -eq 0 ] || die 'fixture Codex binaries inside the isolation root must not use --native'
  [ "$model_call_approved" -eq 0 ] || die 'fixture Codex binaries do not use --model-call-approved'
else
  [ "$native" -eq 1 ] && [ "$model_call_approved" -eq 1 ] \
    || die 'a Codex binary outside the isolation root requires native activation approval and separate model-call approval'
  [ "${CODEX_SMOKE_NATIVE_APPROVED:-}" = 1 ] && [ "${CODEX_SMOKE_MODEL_CALL_APPROVED:-}" = 1 ] \
    || die 'native execution requires separate owner approval declarations: CODEX_SMOKE_NATIVE_APPROVED=1 and CODEX_SMOKE_MODEL_CALL_APPROVED=1'
fi

mkdir -p -- \
  "$isolated_home/.config" "$isolated_home/.cache" "$isolated_home/.local/share" \
  "$isolation_root/tmp" "$isolation_root/gh-config"
: > "$isolation_root/gitconfig"

child_path="$stub_bin:${PATH:-/usr/bin:/bin}"
(
  cd "$repo"
  exec env -i \
    HOME="$isolated_home" \
    CODEX_HOME="$codex_home" \
    XDG_CONFIG_HOME="$isolated_home/.config" \
    XDG_CACHE_HOME="$isolated_home/.cache" \
    XDG_DATA_HOME="$isolated_home/.local/share" \
    GH_CONFIG_DIR="$isolation_root/gh-config" \
    TMPDIR="$isolation_root/tmp" \
    PATH="$child_path" \
    GIT_CONFIG_GLOBAL="$isolation_root/gitconfig" \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_TERMINAL_PROMPT=0 \
    GIT_ASKPASS=/bin/false \
    LC_ALL=C \
    "$codex_bin" "${codex_args[@]}"
)
