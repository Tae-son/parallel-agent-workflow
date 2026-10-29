# parallel-agent-workflow

An owner-only merge gate and a set of guardrails for repositories where several AI coding
agents (Claude Code, Codex, or anything that runs shell commands) work in parallel on feature
branches while one human owns `main`.

It was extracted from a production project where it coordinated multiple agents for weeks.
The core is plain Bash and Node. The optional Hermes adapter uses Python's standard
library as well. No npm or pip packages are added.
[Native agent support](docs/agent-support.md) distinguishes
installed hooks from active guards and documents the runtime-specific gaps.

## What it gives you

| Piece | What it does |
| --- | --- |
| `scripts/land.sh` | The merge gate. Verifies a pull request against GitHub's `main` (CI green on the exact head commit, up to date, no symlinks or submodules), prints a review packet (paths outside the declared scope, gate-file diffs in full, preview link for UI changes), and squash-merges only after the owner types the PR number at the terminal. Re-checks that nothing moved immediately before merging. Refuses to run unless it is byte-identical to the copy on GitHub's `main`. |
| `scripts/agents-status.sh` | Read-only overview of every Git worktree: branch, age, ahead/behind, dirty and untracked paths, PR state, path overlaps between agents, and the work-in-progress limit. Agents run it before starting. |
| `.claude/hooks/agent-guard.mjs` | Claude Code `PreToolUse` hook that blocks the common forms of pushing to `main`, force-pushing, merging, writing through `gh api`, and running the owner-only scripts, even inside `bash -c`, `$(...)`, `sudo`, `timeout`, and friends. |
| `.codex/hooks.json` | Codex native synchronous Bash pre-tool registration using the same checker. Requires owner-reviewed project/hook trust; does not intercept later stdin or fix missing per-command working-directory metadata. |
| `.hermes/plugins/parallel-agent-guard/` | Hermes native pre-tool plugin adapting local terminal calls to the shared checker. Requires separate activation; arbitrary Python, process stdin and remote execution are not equivalent to guarded terminal calls. |
| `AGENTS.md` | Short router read at session start by Codex, OpenCode and other agents, and by Claude Code when the repository has no `CLAUDE.md`: points to `CONTRIBUTING.md` and the skill and states the hard rules. The installer leaves an existing `AGENTS.md` alone unless `--force`, and never edits `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md`; it notes when your `AGENTS.md` needs the kit's rules merged in, or when one of those files exists and does not import `AGENTS.md` (Claude Code then reads it instead). It only checks the repository itself, not a `CLAUDE.md` in a parent directory. |
| `.claude/skills/parallel-agent-workflow/SKILL.md` | Agent skill that walks an assigned task from brief to pull request (resume, brief, preflight, build, verify, PR), with the points where the agent must stop and ask. It sequences `CONTRIBUTING.md` rather than restating it. An identical copy in `.agents/skills/` serves Codex; OpenCode reads either. Edit both copies together; `install.sh` notes when they differ. Guidance only: it can fail to load, so enforcement stays in the hooks and the gate. |
| `.githooks/pre-push` | Second layer: blocks any push whose destination ref is `main`, including `other:main`. |
| `scripts/codex-review.sh` | Optional, advisory cross-model review. Sends only risky files, only after the owner has paged the exact payload and typed `send N`, and never treats silence as approval. |
| `.github/workflows/ci.yml` | The `CI / verify` check that the gate requires. |
| `.github/pull_request_template.md` | The PR body fields the gate parses: `Approved brief:`, `Allowed paths:`, and the exact-commit `independent-qa` report. |
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
into an existing `.claude/settings.json`, merges the Codex registration without granting
trust, stages the Hermes plugin without enabling it, and sets `core.hooksPath=.githooks` in that clone
unless another hooks path is already configured or you pass `--no-hooks-path`. It commits
and pushes nothing. `--no-tests` skips the test files; `--help` lists the options. It exits
with status 2 when it finished but had to refuse some paths, so scripts can notice a
partial install; the report lists every path it added, updated, skipped or refused.
Conflicting or malformed Codex hook definitions are left unchanged and reported as
refused even with `--force`. Existing `.codex/config.toml` and live agent profiles are
never edited. Complete the separate [activation checks](docs/agent-support.md) before
relying on either new integration.

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

Run the kit's own tests any time with `npm test`. Requirements, for the tests and for the
scripts themselves: Linux with bash 5, GNU coreutils, sed, awk and grep, Git 2.40 or newer,
`jq`, the GitHub CLI `gh`, Node 20 or newer, Python 3 (`python3`) for Hermes adapter
tests, and util-linux `script` for the terminal-driven tests.

## How a change flows

```text
owner writes a brief (scope + Allowed paths)
  -> agent works in its own worktree and branch from fresh origin/main
  -> agent runs scripts/agents-status.sh, checks for overlaps, stops on conflict
  -> agent pushes its branch and opens a PR using the template (never merges)
  -> CI / verify runs on the head commit
  -> separate QA session tests the brief and records evidence on the exact head
       FAIL/BLOCKED -> builder fixes, verifies and pushes -> QA retests the new head
  -> owner runs scripts/land.sh <PR#> in their own terminal
       refuses unless CI green, independent QA PASS, up to date, no symlinks/submodules
       prints: in-scope, OUT-OF-SCOPE, gate files (full diff), UI files, preview
       optional --codex: advisory second opinion, each payload approved before sending
       owner types the PR number (+ "gate", + "preview checked" when those apply)
       re-checks head, main and the entire PR body, then squash-merges
```

## Configuration

Independent QA is mandatory, not the optional Codex opinion. The builder/orchestrator starts
a separate session; this kit does not launch a model or require a particular provider. QA
tests acceptance criteria and failure cases, records commands/observations/limitations in the
PR body, and leaves fixes to the builder. Every new commit requires QA revalidation. Missing
access or an untested requirement is BLOCKED. See [the report contract and fix/retest loop](CONTRIBUTING.md#independent-qa).

The gate validates declared evidence, not its truth or the identity behind a shared account.
The owner still judges independence and coverage. Existing open PRs need reports after the
updated gate lands on `main`; update the primary checkout before using it.

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
GitHub's web page. The preview link it prints is whatever successful deployment exists for
the head commit, which a workflow in the same repository could have created, so the owner
still has to open it and judge it. With a merge queue enabled, `gh pr merge` reports success
when the PR is enqueued, not when it lands. See [docs/design.md](docs/design.md) for the
threat model and the reasoning behind each rule.

## License

MIT. See [LICENSE](LICENSE).
