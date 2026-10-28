#!/usr/bin/env bash
# agents-status.sh: read-only overview of every git worktree of this repo, for
# coordinating parallel agents. Shows branch, last-commit age, ahead/behind vs
# origin/main, committed/dirty/untracked paths, PR state, path overlaps between
# non-main worktrees and the WIP count. It never checks out, stashes, adds or
# writes the index (`git --no-optional-locks status`). Only --fetch touches
# remote-tracking refs (git fetch origin).
#
# Usage: bash scripts/agents-status.sh [--fetch]
set -euo pipefail
export LC_ALL=C # consistent sort/comm ordering

WIP_LIMIT=3
BASE=origin/main
fetch=0
for arg in "$@"; do
  case "$arg" in
    --fetch) fetch=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "agents-status: unknown argument: $arg" >&2; exit 64 ;;
  esac
done

top=$(git rev-parse --show-toplevel)
if (( fetch )); then git -C "$top" fetch --quiet origin; fi
has_base=0
git -C "$top" rev-parse --verify --quiet "$BASE^{commit}" >/dev/null && has_base=1

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Collect worktrees from porcelain output (skip bare entries).
wts=() branches=()
while IFS= read -r line; do
  case "$line" in
    "worktree "*) wts+=("${line#worktree }"); branches+=("(detached)") ;;
    "branch "*) branches[${#branches[@]}-1]=${line#branch refs/heads/} ;;
    bare) branches[${#branches[@]}-1]="(bare)" ;;
  esac
done < <(git -C "$top" worktree list --porcelain)

print_list() { # label file
  local n; n=$(grep -c . "$2" || true)
  echo "  $1 ($n):"
  if (( n )); then sed 's/^/    /' "$2"; fi
}

pr_state() { # branch
  local out
  command -v gh >/dev/null 2>&1 || { echo unknown; return; }
  local t=(); command -v timeout >/dev/null 2>&1 && t=(timeout 20)
  if out=$(cd "$top" && GH_PROMPT_DISABLED=1 "${t[@]}" gh pr list --head "$1" --state all --limit 5 \
      --json number,state,isDraft \
      --jq '.[] | "#\(.number) \(.state)\(if .isDraft then " (draft)" else "" end)"' 2>/dev/null); then
    [[ -n $out ]] && echo "${out//$'\n'/, }" || echo none
  else
    echo unknown
  fi
}

if (( has_base )); then
  echo "Base: $BASE @ $(git -C "$top" rev-parse --short "$BASE")$( (( fetch )) || echo ' (not fetched; use --fetch to refresh)')"
else
  echo "Base: $BASE not found; ahead/behind and committed paths unavailable"
fi

active=()
for i in "${!wts[@]}"; do
  wt=${wts[$i]} br=${branches[$i]}
  [[ $br == "(bare)" ]] && continue
  echo
  echo "== $br  $wt"
  if [[ ! -d $wt ]]; then echo "  (directory missing; see git worktree prune)"; continue; fi
  : >"$tmp/$i.committed"; : >"$tmp/$i.dirty"; : >"$tmp/$i.untracked"
  echo "  last commit: $(git -C "$wt" log -1 --format='%cr (%h %s)' 2>/dev/null || echo 'none')"
  if (( has_base )); then
    counts=$(git -C "$wt" rev-list --left-right --count "$BASE...HEAD" 2>/dev/null || echo '? ?')
    read -r behind ahead <<<"$counts"
    echo "  vs $BASE: $ahead ahead, $behind behind"
    if mb=$(git -C "$wt" merge-base "$BASE" HEAD 2>/dev/null); then
      git -C "$wt" diff --name-only "$mb" HEAD >"$tmp/$i.committed"
    fi
  fi
  # Porcelain v1 -z: "XY path\0", renames/copies add "\0origpath".
  while IFS= read -r -d '' ent; do
    xy=${ent:0:2}
    if [[ $xy == '??' ]]; then echo "${ent:3}" >>"$tmp/$i.untracked"; else echo "${ent:3}" >>"$tmp/$i.dirty"; fi
    if [[ $xy == R* || $xy == C* ]]; then IFS= read -r -d '' _orig || true; fi
  done < <(git --no-optional-locks -C "$wt" status --porcelain -z --untracked-files=all)
  if [[ $br == "(detached)" ]]; then echo "  PR: n/a (detached HEAD)"; else echo "  PR: $(pr_state "$br")"; fi
  print_list committed "$tmp/$i.committed"
  print_list dirty "$tmp/$i.dirty"
  print_list untracked "$tmp/$i.untracked"
  sort -u "$tmp/$i.committed" "$tmp/$i.dirty" "$tmp/$i.untracked" >"$tmp/$i.all"
  if [[ $br != main ]]; then active+=("$i"); fi
done

echo
echo "Overlaps (non-main worktrees; committed + dirty + untracked paths):"
if (( ${#active[@]} < 2 )); then echo "  none (fewer than two non-main worktrees)"; fi
for ((a = 0; a < ${#active[@]}; a++)); do
  for ((b = a + 1; b < ${#active[@]}; b++)); do
    x=${active[$a]} y=${active[$b]}
    common=$(comm -12 "$tmp/$x.all" "$tmp/$y.all" | paste -sd, - | sed 's/,/, /g')
    echo "  ${branches[$x]} <-> ${branches[$y]}: ${common:-none}"
  done
done

echo
n=${#active[@]}
if (( n > WIP_LIMIT )); then
  echo "WIP: $n active non-main worktrees (limit $WIP_LIMIT) -- WARNING: over the limit; finish or remove a worktree before starting another"
else
  echo "WIP: $n active non-main worktrees (limit $WIP_LIMIT)"
fi
