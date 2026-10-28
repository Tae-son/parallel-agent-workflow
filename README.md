# parallel-agent-workflow

An owner-only merge gate and a set of guardrails for repositories where several AI coding
agents (Claude Code, Codex, or anything that runs shell commands) work in parallel on feature
branches while one human owns `main`.

It was extracted from a production project where it coordinated multiple agents for weeks.
Everything here is plain Bash and Node; there are no dependencies to install.

## What it gives you

| Piece | What it does |
| --- | --- |
| `scripts/land.sh` | The merge gate. Verifies a pull request against GitHub's `main` (CI green on the exact head commit, up to date, no symlinks or submodules), prints a review packet (paths outside the declared scope, gate-file diffs in full, preview link for UI changes), and squash-merges only after the owner types the PR number at the terminal. Re-checks that nothing moved immediately before merging. Refuses to run unless it is byte-identical to the copy on GitHub's `main`. |
| `scripts/agents-status.sh` | Read-only overview of every Git worktree: branch, age, ahead/behind, dirty and untracked paths, PR state, path overlaps between agents, and the work-in-progress limit. Agents run it before starting. |
| `.claude/hooks/agent-guard.mjs` | Claude Code `PreToolUse` hook that blocks the common forms of pushing to `main`, force-pushing, merging, writing through `gh api`, and running the owner-only scripts, even inside `bash -c`, `$(...)`, `sudo`, `timeout`, and friends. |
| `.githooks/pre-push` | Second layer: blocks any push whose destination ref is `main`, including `other:main`. |
| `scripts/codex-review.sh` | Optional, advisory cross-model review. Sends only risky files, only after the owner has paged the exact payload and typed `send N`, and never treats silence as approval. |
| `.github/workflows/ci.yml` | The `CI / verify` check that the gate requires. |
| `.github/pull_request_template.md` | The PR body fields the gate parses: `Approved brief:` and `Allowed paths:`. |
| `CONTRIBUTING.md` | The rules agents and owners follow. |
| `tests/` | 230+ tests that drive the real scripts against hermetic temporary repositories with stubbed `gh` and `codex`. Nothing leaves the machine. |

## Quick start

Install into an existing repository:

```bash
git clone https://github.com/Tae-son/parallel-agent-workflow.git
parallel-agent-workflow/install.sh --owner YOUR_GITHUB_LOGIN /path/to/your/repo
```

The installer copies files into the repository's working tree, never overwrites an existing
file unless you pass `--force`, refuses to write through symlinks, merges the Claude hook
into an existing `.claude/settings.json`, and sets `core.hooksPath=.githooks` in that clone
unless another hooks path is already configured or you pass `--no-hooks-path`. It commits
and pushes nothing. `--no-tests` skips the test files; `--help` lists the options.

Then, in your repository:

1. Edit `scripts/gate-files.txt`, `scripts/ui-paths.txt`, `scripts/risky-paths.txt`,
   `scripts/codex-exclude.txt` and `scripts/codex-review-contract.md` for your project.
2. Make `npm run verify` mean "the checks that must pass before merge". The installed
   workflow runs `npm ci && npm run verify` with npm caching, so it expects a `package.json`
   and `package-lock.json`; adapt it for pnpm, yarn or a non-Node project. The gate requires
   the check named `CI / verify` on the exact head commit. Include
   `node --test tests/*.test.mjs` so the kit keeps testing itself.
3. Commit on a branch and open a pull request. **Bootstrap rule:** the PR that first adds
   `scripts/land.sh` is reviewed and merged by the owner in GitHub's web UI. From then on
   every merge goes through `scripts/land.sh <PR#>` from the primary checkout of `main`.
4. In every clone: `git config core.hooksPath .githooks`.

Run the kit's own tests any time with `npm test` (Node 20 or newer, Git, `jq`, `gh` and
util-linux `script` for the terminal-driven tests).

## How a change flows

```text
owner writes a brief (scope + Allowed paths)
  -> agent works in its own worktree and branch from fresh origin/main
  -> agent runs scripts/agents-status.sh, checks for overlaps, stops on conflict
  -> agent pushes its branch and opens a PR using the template (never merges)
  -> CI / verify runs on the head commit
  -> owner runs scripts/land.sh <PR#> in their own terminal
       refuses unless CI green, up to date, no symlinks/submodules
       prints: in-scope, OUT-OF-SCOPE, gate files (full diff), UI files, preview
       optional --codex: advisory second opinion, each payload approved before sending
       owner types the PR number (+ "gate", + "preview checked" when those apply)
       re-checks head and main, then squash-merges
```

## Configuration

All lists use the same format: one bash pattern per line, matched against the repo-relative
path with `[[ path == pattern ]]` (so `*` also matches `/`), `#` comments. `land.sh` reads
them from `main`'s exact commit, never from the working tree or the PR, so a PR cannot
reclassify itself.

| File | Purpose |
| --- | --- |
| `scripts/gate-files.txt` | Files that define the checks, the gate or the build. Changes print in full and need the owner to type `gate`. Required. |
| `scripts/ui-paths.txt` | Changes that need an `Approved brief:` in the PR body and a typed `preview checked`. Required on `main`; an empty list disables the UI gate. |
| `scripts/risky-paths.txt` | Files that trigger the `--codex` hint and are sent for review. Optional. |
| `scripts/codex-exclude.txt` | Files never sent to Codex. |
| `scripts/codex-review-contract.md` | Your project's invariants, appended to every review payload. |

Repository detection: `land.sh` targets `OWNER/NAME` from `LAND_REPO` if set, otherwise from
the primary worktree's `origin` URL on github.com. `--repo` overrides it and is shown in red.

Environment: `ALLOW_MAIN_PUSH=1` is the documented emergency override for the pre-push hook.
`CODEX_BIN` points at the Codex CLI if it is not on `PATH`.

## What it is not

These are guardrails, not a security boundary. A determined process can evade the Claude
hook (it lists its known gaps in its header) and any clone can omit the Git hook. GitHub
branch protection or rulesets remain the enforced layer; use them when your plan allows.
`land.sh` protects only merges that go through it, and nothing stops a merge made from
GitHub's web page. See [docs/design.md](docs/design.md) for the threat model and the
reasoning behind each rule.

## License

MIT. See [LICENSE](LICENSE).
