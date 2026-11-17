#!/usr/bin/env bash
# Publish the "independent-qa" commit status on one PR's current head commit, from the report in
# its current body. Visibility only: the status says a structurally valid PASS report for that
# exact head was present when checked. It is not authentication and not a merge barrier;
# scripts/land.sh stays the owner's gate. Run from trusted default-branch code only.
set -euo pipefail

CONTEXT=independent-qa
# Fixed descriptions: PR text never reaches a status, argv or the log.
DESC_PENDING='Checking the independent QA report on this exact head'
DESC_SUCCESS='Structurally valid PASS report for this exact head (not authentication)'
DESC_FAILURE='No valid PASS report for this exact head; see CONTRIBUTING.md'

usage() {
  cat <<'EOF'
Usage: scripts/independent-qa-status.sh OWNER/NAME PR#

Re-reads the PR from the GitHub API, posts a pending "independent-qa" status on its head
commit, validates the report with scripts/independent-qa.jq beside this script, re-reads the
PR and posts success or failure only if the head and body are unchanged. Needs gh with a
token allowed to read the PR and write commit statuses (GH_TOKEN).
Exit 0 after publishing success or failure; nonzero when nothing final was published.
EOF
}

die() { printf 'independent-qa-status: REFUSED: %s\n' "$*" >&2; exit 1; }

valid_repo() {
  [[ $1 =~ ^[A-Za-z0-9](-?[A-Za-z0-9]){0,38}/[A-Za-z0-9._-]{1,100}$ ]] && [[ ${1#*/} != . && ${1#*/} != .. ]]
}

[ $# -eq 1 ] && { [ "$1" = -h ] || [ "$1" = --help ]; } && { usage; exit 0; }
[ $# -eq 2 ] || { usage >&2; die "expected OWNER/NAME and a PR number"; }
REPO=$1 PR=$2
valid_repo "$REPO" || die "invalid repository name"
[[ $PR =~ ^[1-9][0-9]{0,9}$ ]] || die "invalid PR number"

RULES=$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")
[ -f "$RULES/independent-qa.jq" ] || die "scripts/independent-qa.jq is missing beside this script"
jq -n -L "$RULES" 'include "independent-qa"; empty' >/dev/null 2>&1 || die "scripts/independent-qa.jq does not compile"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Read the PR now, never from the triggering event. $1 = output file. Refuses unless the
# response is a JSON object for this PR with a lowercase 40-hex head SHA and a string or
# null body; prints the head SHA.
read_pr() {
  local f=$1 head
  gh api "repos/$REPO/pulls/$PR" </dev/null >"$f" || die "could not read PR #$PR from the GitHub API"
  jq -e --argjson pr "$PR" '
    type == "object" and .number == $pr
    and (.state | type == "string") and (.base | type == "object") and (.base.ref | type == "string")
    and (.body == null or (.body | type == "string"))
    and (.head | type == "object") and (.head.sha | type == "string" and test("\\A[0-9a-f]{40}\\z"))
  ' "$f" >/dev/null 2>&1 || die "unexpected PR data from the GitHub API"
  head=$(jq -r .head.sha "$f") || die "unexpected PR data from the GitHub API"
  [[ $head =~ ^[0-9a-f]{40}$ ]] || die "unexpected head SHA from the GitHub API"
  printf '%s' "$head"
}

# A link to this run when the Actions environment provides a plausible one.
TARGET=()
if [[ ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ && ${GITHUB_SERVER_URL:-} =~ ^https://[A-Za-z0-9.-]+$ ]]; then
  TARGET=(-f "target_url=$GITHUB_SERVER_URL/$REPO/actions/runs/$GITHUB_RUN_ID")
fi

post() { # sha state description
  gh api --method POST "repos/$REPO/statuses/$1" -f "state=$2" -f "context=$CONTEXT" \
    -f "description=$3" "${TARGET[@]+"${TARGET[@]}"}" </dev/null >/dev/null \
    || die "could not post the $2 $CONTEXT status on $1"
}

HEAD_SHA=$(read_pr "$TMP/pr.json")
# A failed pending post leaves any earlier status on this SHA in place, possibly a success.
post "$HEAD_SHA" pending "$DESC_PENDING"

# jq -e: 0 = valid PASS; 1 = false, 4 = no report, 5 = report not JSON (all a failure);
# anything else is an error in this check, which publishes nothing final.
rc=0
jq -e -L "$RULES" --arg head "$HEAD_SHA" '
  include "independent-qa";
  .state == "open" and .base.ref == "main" and ([qa_report | qa_pass($head)] == [true])
' "$TMP/pr.json" >/dev/null 2>&1 || rc=$?
case $rc in
  0) STATE=success DESC=$DESC_SUCCESS ;;
  1|4|5) STATE=failure DESC=$DESC_FAILURE ;;
  *) die "the report check itself failed (jq exit $rc); status left pending" ;;
esac

# Publish only what still describes the PR: a new head or body gets its own run.
NEW_HEAD=$(read_pr "$TMP/recheck.json")
[ "$NEW_HEAD" = "$HEAD_SHA" ] || die "PR head changed during the check; status left pending on $HEAD_SHA"
jq -e -s '.[0].body == .[1].body and .[0].state == .[1].state and .[0].base.ref == .[1].base.ref' \
  "$TMP/pr.json" "$TMP/recheck.json" >/dev/null 2>&1 \
  || die "PR body, state or base changed during the check; status left pending on $HEAD_SHA"
post "$HEAD_SHA" "$STATE" "$DESC"
printf 'independent-qa-status: posted %s on %s\n' "$STATE" "$HEAD_SHA"
