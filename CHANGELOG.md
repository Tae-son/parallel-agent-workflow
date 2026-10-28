# Changelog

## 0.1.0 (2026-10-28)

First standalone release, extracted from a private project where it had been running as the
merge and coordination layer for several parallel coding agents.

- `scripts/land.sh`: owner-only squash-merge gate (CI green on the exact head, up to date with
  `main`, no symlinks or submodules, gate-file diffs shown in full, UI changes need an approved
  brief and a checked preview, typed confirmation, re-check before merge, self-check against the
  copy on GitHub `main`).
- `scripts/codex-review.sh`: optional, owner-approved, advisory cross-model review of risky files.
- `scripts/agents-status.sh`: read-only overview of every worktree, PR state, path overlaps and
  the work-in-progress limit.
- `.claude/hooks/agent-guard.mjs`: Claude Code `PreToolUse` hook that blocks the common forms of
  pushing to `main`, force-pushing, merging, writing through `gh api`, and running the owner-only
  scripts.
- `.githooks/pre-push`: blocks any push whose destination is `main`.
- CI workflow, pull-request template, CODEOWNERS and CONTRIBUTING.
- `install.sh`: copies the kit into another repository without overwriting existing files.

Changes from the private version: the repository is detected from the `origin` URL (or
`LAND_REPO`) instead of being hard-coded; UI and risky paths moved from the scripts into
`scripts/ui-paths.txt` and `scripts/risky-paths.txt`, read from `main` like `gate-files.txt`;
the pre-push override is `ALLOW_MAIN_PUSH`; the Codex state directory is `land-gate`; the
Codex binary is found on `PATH` or via `CODEX_BIN`.

Hardening found by adversarial review during extraction: the pre-merge re-check now also
compares base branch, draft flag and the CI result; PR objects are fetched from the target
repository when `origin` is a different GitHub repository; `land.sh` is verified against the
same `main` commit used for everything else; more invisible Unicode code points are
sanitised and single-line fields lose embedded newlines; the Approved brief is printed and
must contain real content; executable-bit changes are shown; gate-file diffs ignore colour
settings; unexpected `codex-review.sh` exit codes refuse instead of continuing; repository
names are validated; gate-file diffs use `--text` so a planted NUL cannot hide a diff behind
"Binary files differ"; pattern lists survive NUL or invalid bytes; git runs with hooks
disabled and the primary worktree must be checked out at `main`; submodule entries are
listed regardless of `diff.ignoreSubmodules`; origin hosts match case-insensitively; the
installer refuses symlinks, hard links, non-regular files and nested repositories, writes
atomically and records only successful writes, never changes an existing local
`core.hooksPath`, ignores inherited `GIT_CONFIG` and `CDPATH`, merges or refuses malformed
`.claude/settings.json` without aborting, and exits 2 after a partial install.
