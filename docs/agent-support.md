# Agent command-guard support

This kit provides native command-hook registrations, not a universal sandbox.
Instructions, installed files, runtime activation, and observed rejection are four
separate things. The installer never grants hook trust or enables a Hermes plugin.
The owner-only merge process and mandatory independent QA are unchanged.

## Support and evidence

- **Claude Code:** existing `PreToolUse` Bash guard and registration, unchanged.
- **Codex:** synchronous `PreToolUse` Bash registration in `.codex/hooks.json`, using
  the same Node guard. Interface checked against official documentation and released
  source `rust-v0.165.0`. This is a reference version, not the earliest supported release.
- **Hermes:** native Python `pre_tool_call` plugin in
  `.hermes/plugins/parallel-agent-guard/`, adapting local `terminal` calls to the same
  Node guard. Runtime contract inspected at Hermes commit
  `82d5c0ae8106c5eff3ae22fd7ae33ca4ff71d784`.

The kit tests execute the actual hook command/plugin with synthetic inputs and local
Git fixtures. They do not prove that a particular CLI, ACP host, or gateway loaded
and trusted the integration. Perform the activation checks below before relying on
it. No production profile or trust record is changed by these tests.

## Codex activation

1. Install the kit in the repository and review `.codex/hooks.json` and the shared
   `.claude/hooks/agent-guard.mjs`. Node and Git must be available on the hook's PATH.
2. Use a Codex version with the documented blocking `PreToolUse` API. Trust the
   project, keep hooks enabled, and use `/hooks` to review and trust the exact hook
   definition. New or changed definitions are skipped until trusted. Do not bypass
   this review through an installer flag.
3. Inspect other hook sources, including inline `[hooks]` in `.codex/config.toml`.
   Codex combines sources rather than replacing lower-precedence hooks. The installer
   leaves TOML and user-level configuration untouched. A differing existing kit hook
   is refused for manual reconciliation, including with `--force`. Automatic merging
   supports command handlers only; other handler types and unsupported structures
   are preserved and refused rather than guessed at.
   Recognized optional command fields are type-checked against the reference API;
   numeric fields must be nonnegative JavaScript-safe integers (or native optional
   nulls), so the installer does not round large timeout/context-limit values.
   The native root schema accepts only `description` (string or null) and `hooks`.
   Unknown root fields and duplicate JSON keys are refused before merging rather
   than silently discarded or normalized. Review the complete source, not only
   this kit's added handler: an invalid source can prevent every hook in it loading.
   Invalid UTF-8 bytes and unpaired Unicode surrogate escapes in strings or keys
   are refused unchanged. Valid Unicode, including supplementary characters and
   literal backslash escape text, is preserved rather than sanitized or replaced.
4. Confirm this hook is enabled and trusted for the intended working directory.
   App-server clients can inspect `hooks/list` for that directory; check `enabled`,
   `trustStatus`, source path, current hash, and discovery diagnostics. Merely seeing
   hook lifecycle notifications is not evidence of rejection.
5. In a disposable test repository, use a harmless marker command containing a
   prohibited command *after* the marker, such as `touch marker; gh pr merge 7`.
   Replace `gh` on the test PATH with a harmless stub so a failed guard cannot merge
   anything. Require a denial and no marker. Also require an ordinary permitted
   command to execute successfully. Record runtime version and execution surface.

The hook command resolves the repository from its invocation directory, including
nested paths and linked worktrees, and checks that Git can read that repository's
branch state before invoking the checker. It converts discovery/branch-read failures,
missing Node/guard, and unexpected guard exits into exit 2 with a reason. This only
works when Codex actually runs the hook: disabled/untrusted hooks, host-level timeouts,
or a failure to launch the hook shell can still leave commands unguarded.

### Owner-approved isolated smoke runner

Agents may run Codex smoke tests only when the owner explicitly approves the exact test and
its isolation boundaries. Direct `codex` invocation remains blocked. The sole repository
exception is `scripts/codex-smoke.sh --owner-approved ...`, after the owner has approved the
declared disposable root, repository, isolated homes, stubs and named scenario. The flag does not
authenticate owner approval; it makes the approved exception explicit and auditable while
the written owner instruction remains authoritative.

The runner exposes exactly two scenarios, each requesting one shell tool call:

- `--scenario guard-allow-git-status` requests
  `git status --short && printf '%s\n' CODEX_SMOKE_ALLOW_EXECUTED`.
  PASS requires one hook receipt for exactly that command with guard exit 0 and empty
  stderr, the `hook: PreToolUse Completed` status in Codex's captured output, and the
  marker line from the rendered tool result.
- `--scenario guard-block-main-push` requests
  `printf '%s\n' CODEX_SMOKE_DENY_PAYLOAD_EXECUTED; git push origin main`.
  PASS requires one hook receipt for exactly that command whose recorded guard exit is 2
  and whose recorded stderr begins `agent-guard: pushing to main is owner-only`, plus the
  `hook: PreToolUse Blocked` status and no payload marker line in Codex's captured output.
  The marker precedes Git, so missing remotes cannot explain its absence. A Git/sandbox/auth
  error, model refusal, unattempted tool call, duplicate call or `agent-guard unavailable`
  exit does not pass. Text in the prompt or a model's final answer is never evidence.

#### Hook receipts: why the evidence comes from the hook, not the model

In v0.165 the denial reason reaches only the model:
[`hook_runtime.rs`](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/hook_runtime.rs)
formats it for the tool result, and
[`registry.rs`](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/tools/registry.rs)
returns before any command item exists. `exec` prints only `hook: PreToolUse` and
`hook: PreToolUse Blocked|Completed|Failed` lines
([`event_processor_with_human_output.rs`](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/exec/src/event_processor_with_human_output.rs)),
`--json` drops hook notifications and `--ephemeral` keeps no session file. A bare
`Blocked` status also follows the registration's own fail-closed exit 2.

A command hook, however, is an ordinary host process:
[`command_runner.rs`](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/hooks/src/engine/command_runner.rs)
spawns `$SHELL -lc COMMAND` (or `/bin/sh -lc` when `SHELL` is unset, as in the runner's
scrubbed environment) with the session's startup environment and the turn's cwd, outside
the tool sandbox. The read-only tool sandbox has no writable root
([`protocol.rs`](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/protocol/src/protocol.rs)),
so the model's command cannot create or edit what the hook writes.

The disposable repository therefore commits the fixture registration printed by
`scripts/codex-smoke.sh --print-fixture-hooks` rather than the kit's `.codex/hooks.json`.
It is the kit's tracked hook command, embedded verbatim inside a subshell, wrapped in a
receipt adapter: it refuses to run unless `CODEX_SMOKE_RECEIPT_DIR` is an absolute path,
creates one `call-PID` directory there with `mkdir` (exclusive; never follows a link),
copies the hook's stdin JSON to `input.json`, runs the tracked command with that input and
its stderr captured to `stderr`, records the exit code in `exit`, replays stderr and exits
with the same code. The unchanged shared guard still decides; the adapter adds no
decision logic, deletes nothing, and fails closed with `agent-guard unavailable` on any
adapter error. The handler fields, matcher and timeout equal the tracked registration.

For every run the runner creates `ISOLATION_ROOT/runs/<UTC time>-<pid>/` containing an
empty `receipts/` directory, `codex.stdout`, `codex.stderr` and `codex.status`, named to the
child only through `CODEX_SMOKE_RECEIPT_DIR`. After Codex exits it replays the captured
output and validates: exactly one receipt directory holding exactly `exit`, `input.json`
and `stderr` as regular single-link files; `tool_name` `Bash`, `tool_input.command` equal
to the scenario command byte for byte, `cwd` equal to the disposable repository, non-empty
`session_id` and `tool_use_id`; the scenario's exit/stderr/status conditions above; Codex
exit 0. Evidence failures exit 1 with each reason, distinct from preflight refusals (2).
`--revalidate --run-dir PATH --repo PATH --scenario NAME` repeats that validation on a
preserved run directory, for QA or the owner.

What the receipt distinguishes: a real policy denial (exit 2, policy reason); an
unavailable or crashed guard (exit 2, `agent-guard unavailable`); an untrusted, disabled
or unloaded hook (no receipt, no `hook:` lines, the tool ran); no tool call (no receipt, no
`hook:` lines); a wrong or additional command (command mismatch or two receipts); a
remote, sandbox or auth error (exit 0 receipt, failed command item); model narrative only
(no receipt). What it does not prove: receipts are written by a process of the same user,
so concurrent same-user mutation, host profile scripts sourced by the login shell
(`/etc/profile`; the isolated `HOME` has no profile), and the identity of the Codex binary
remain outside this procedural record.

Arbitrary Codex arguments are refused. Each scenario expands to a fixed non-interactive
`exec --strict-config --ephemeral --ignore-rules --sandbox read-only --color never -- PROMPT`
with closed stdin. No profile, inline config, cwd/writable-root expansion, alternate
subcommand, server mode, model selection or output path is accepted.

#### Exact disposable trust, pinned to v0.165.0

Unlike the earlier runner, this command deliberately loads its isolated User layer.
`--ignore-user-config` would discard the project and hook trust needed to load the guard.
The runner creates only `CODEX_HOME/config.toml`, with these exact two tables (the example
path is replaced with the canonical disposable repository path):

```toml
[projects."/exact/disposable/repo"]
trust_level = "trusted"

[hooks.state."/exact/disposable/repo/.codex/hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:ee2d53bea894561e06cb1124d19a5e791d6d7e2153986b5c07e4600abb47e159"
```

This is ordinary exact-hook trust, not a bypass. Project trust enables discovery of the
one `.codex/hooks.json`; hook state authorizes its one synchronous `^Bash$` command handler.
The hook feature and handler enablement default to enabled in v0.165, so no enablement,
inline hook, sandbox or provider setting is needed. The state key is the absolute source
path plus `:pre_tool_use:0:0`, without a `file:` prefix. The hash is SHA-256 of recursively
sorted, compact JSON for the normalized TOML identity: `event_name = "pre_tool_use"`,
`matcher = "^Bash$"`, and the single command handler with `async = false`, `timeout = 10`
and `type = "command"`. Absent optional fields are omitted through TOML serialization.

Before creating trust, the runner checks that its generated fixture registration hashes
to the reviewed SHA-256
`d99ab530aa32415a064978c7d6d055e2a6eb45525007d48d71460922cfc1e7af`, that the
repository's `.codex/hooks.json` equals those bytes, and that the shared guard script
hashes to `e7462097ed76c62691050b0f7e99fc9ed693166c14ca623db70033135983a4a2`.
The trusted hash above is the v0.165 identity of that fixture registration, not of the
kit's tracked `.codex/hooks.json`; the tests check that the fixture embeds the tracked
command unchanged. The guard pin matters: Codex hashes the hook declaration, not that
script's contents.
These are reviewed constants, never caller-supplied hashes. Changing either file requires
a reviewed runner update. An existing trust file must match the generated bytes exactly;
it is never merged, parsed into permissive defaults or overwritten. New files are created
exclusively with mode 0600. Reusing the artifact for another repository path fails.

Source contract: v0.165
[`loader/mod.rs`](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/config/src/loader/mod.rs)
loads project trust from preceding layers, including User, and discovers a project's
`.codex` layer even without project `config.toml`;
[`config_rules.rs`](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/hooks/src/config_rules.rs)
accepts hook state only from User/SessionFlags;
[`hooks/src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/hooks/src/lib.rs),
[`discovery.rs`](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/hooks/src/engine/discovery.rs),
[`protocol/hooks.rs`](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/protocol/src/hooks.rs)
and [`fingerprint.rs`](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/config/src/fingerprint.rs)
define the state key and normalized hash. This source analysis establishes a viable trust
mechanism; it does not establish native activation on a particular binary or host.

#### Required isolation and activation evidence

Use Linux with `/bin/bash`, Node and system Git. The runner resolves node once, without
executing a candidate, and passes that exact path to each of its scrubbed `env -i` Node
processes. It uses an executable `node` in its fixed `/usr/bin:/bin` first. Otherwise
(for example on GitHub Actions, where `actions/setup-node` installs node elsewhere) it
takes the first absolute caller `PATH` entry containing `node`, skipping relative entries.
That candidate's realpath must be a regular ELF file named `node` outside the isolation
root, so script shims and symlink shims such as mise's (which resolve to the `mise`
binary) are refused, and a refused first candidate fails closed. Run output records the
chosen path and its source as `codex-smoke: node PATH (SOURCE)`. Only in the fallback
case is that node's directory appended after `STUB:/usr/bin:/bin` in the child `PATH`,
so the hook and recording stub can run bare `node`. It cannot shadow the stubs, Git or
system tools, though other executables in that directory become reachable by name. The
caller `PATH` itself is never passed on. Execute the script directly
(or with `/bin/bash -p`); its privileged Bash startup ignores `BASH_ENV`, exported
functions and inherited shell options before the script is read. Plain `bash script`
is refused; its interpreter could already have run caller startup code before refusal.
The runner is not a boundary against a process that can modify it or race its checks.

Prepare absolute, canonical, nonoverlapping repository/home/stub directories under a
root marked `.codex-smoke-disposable`. Initialize a standalone repository using an empty
Git template and commit only `.codex/hooks.json` written from
`scripts/codex-smoke.sh --print-fixture-hooks` and the exact
`.claude/hooks/agent-guard.mjs` from this kit, plus an optional `README.md`. The repository
must be clean. No other project files, configuration, instructions, hooks, rules, linked
worktrees, alternates, remotes, URL rewrites or Git includes are accepted. Local Git config
is limited to the four ordinary `git init` core keys; executable settings such as
`core.fsmonitor` are refused before any repository-aware Git operation. Git hooks and
fsmonitor are also disabled in the scrubbed preflight/child environment.

Keep isolated `HOME` free of files and `CODEX_HOME` empty except for an exact existing
trust artifact and, only in separately approved native mode, optional isolated
`auth.json` containing solely an `OPENAI_API_KEY` string. Do not copy production
credentials. ChatGPT identity, normal profiles, cached cloud policy, user hooks, plugins,
other config and special files are refused. API-key-only auth cannot fetch workspace
managed config in the referenced
[`exec` bootstrap](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/exec/src/lib.rs).
The runner refuses any `/etc/codex` path, including system/managed config, requirements
and system hooks; it does not edit or bypass managed policy. Use an owner-prepared isolated
host if managed state exists. Scrubbing credentials does not hide files: the read-only
sandbox still permits reads. An approved native run needs an environment with no sensitive
host files accessible to it, and separate model/network authorization.

The entire disposable root must contain only directories and regular, single-link files.
Symlinks, hardlinks and special files are refused before writing, preserving outside
victims. XDG, GitHub, Git and temporary state remain under that root; caller credentials,
PATH and environment are not inherited. `--stub-bin` contains only the exact harmless
`gh` stub (`#!/bin/sh`, print `harmless gh stub` to stderr, exit 97) and, in fixture mode,
the exact recording `codex` stub defined in `tests/codex-smoke.test.mjs`. That stub records
its environment, then emulates v0.165 dispatch order for the one requested command: it
runs the committed hook through `/bin/sh -lc` with a Codex-shaped payload, prints the
`hook:` status lines, and executes the command only when the hook allowed it. Location alone
does not authenticate a binary as harmless; the runner also compares those complete
stub contents and refuses additional executables.

Native mode requires a reviewed ELF executable outside the root, plus
`--native`, `--model-call-approved`, `CODEX_SMOKE_NATIVE_APPROVED=1` and
`CODEX_SMOKE_MODEL_CALL_APPROVED=1`. `--codex-bin` must be the canonical real binary path:
its realpath must equal the given path, so a symlinked executable or a path through a
symlinked directory is refused. A binary named `mise` or under a directory named `mise` or
`shims` is refused, and script wrappers fail the ELF check. Mise shims, whether a symlink
to the `mise` ELF or a script, could install a missing runtime and are refused; the owner
must pass the canonical real Codex binary path. These are path checks, and ELF format
is not binary authentication or a version check; the owner must review the actual
executable and v0.165 compatibility.
The declarations force separate activation/model decisions but do not authenticate
consent. Normal profiles, external trust and live T3 settings are never changed.

Preserve the complete run directory (receipts, captured Codex output and status) for
both scenarios, the binary version/identity, execution surface, exact generated trust bytes
and hook/guard pins. Codex exit zero alone is not a guard PASS; the runner exits 0 only
when the receipt validation passes, and `--revalidate` can repeat it. A later separately
approved native run must supply this evidence; this PR's implementation and QA use
harmless fixtures and source review only.

The fixture tests exercise runner allow/deny behavior with harmless stubs; fixture tests do
not prove native activation. They also do not prove that Codex loaded the project hook or
that the live T3/ACP route dispatches through it. Record native CLI/ACP evidence separately.
The current installer does not deploy this repository-maintenance runner; in an installed
target the exception remains unavailable unless its owner separately supplies and reviews an
equivalent runner. Missing runner support is not permission to invoke `codex` directly.
This exception never authorises merging, pushing to `main`, force-pushing, or running
`scripts/land.sh` or `scripts/codex-review.sh`; independent QA and owner-only merging remain
unchanged.

### Codex limits

At the referenced release:

- `exec_command` appears as `Bash` with `tool_input.command`, but its separate
  `workdir` is absent from the hook input. The reported hook `cwd` may differ from
  the command's directory. Branch-sensitive checks can therefore inspect the wrong
  repository. Prefer explicit `git -C /absolute/path ...` or an explicit `cd` in the
  command, and test the exact host route. This convention is not enforcement.
- `write_stdin` does not emit a new pre-tool hook. Input sent to an already-running
  shell is not checked by this integration.
- Direct app-server `command/exec` and host-owned terminals are distinct from model
  tool calls. Do not assume this registration covers them.
- The unchanged shared guard permits malformed input and unknown tool names. The
  registration relies on the documented native Bash payload contract.
- Node refuses ESM specifiers containing a backslash, so in a repository path with a
  `\` the registration cannot load the guard and fails closed with exit 2
  (`agent-guard unavailable: command check failed`). Every command is then blocked
  there; the smoke runner reports such a receipt as not an allow.

## Hermes activation boundary

The installer copies the project plugin but does not enable it. Hermes project
plugins require explicit opt-in (`HERMES_ENABLE_PROJECT_PLUGINS=1`) and are discovered
relative to the Hermes process working directory. A gateway or ACP host attaching a
worktree is not proof that its plugin was discovered. Verify plugin enablement and a
real pre-dispatch rejection in the actual surface before relying on it.

This adapter is **project-only**. Copies under `$HERMES_HOME/plugins/`, bundled or
other non-project sources deliberately register nothing. Profile-wide deployment
is not implemented. Do not copy it into a live profile expecting it to activate, or
edit `plugins.enabled` automatically. For ACP/gateway use, first verify that the
hosting process discovers this project plugin from the repository root. If it
does not, that surface remains unsupported until separately scoped integration.

Scope is determined by the Git common-directory identity of the plugin repository
and the terminal's starting effective cwd. Linked worktrees are included, unrelated
repositories are not. An outside command that later enters this repository is not
intercepted. Missing cwd/runtime state and nonlocal backends are blocked while the
project hook is loaded because their scope cannot be safely established.

For local terminal calls, the adapter must use explicit workdir or Hermes's terminal
session state rather than the host process cwd. Test different main/feature
worktrees, a persisted `cd`, and unavailable state. Remote/container execution is not
covered by host-side Git inspection. Python and Node are required for the Hermes
adapter and its tests.
The adapter currently requires an absolute existing effective cwd; use an absolute
`workdir` when necessary. It consults runtime task overrides, approval-context
session keys and persisted session cwd. It does not create a terminal environment
or execute the submitted command merely to inspect it.

### Hermes limits

- Direct and background `terminal` calls enter the pre-tool path. Nested
  `execute_code` calls through `hermes_tools.terminal()` re-enter tool dispatch.
- Arbitrary Python subprocess calls, file/network operations, and code already
  running in a process do not become terminal hook calls.
- `process_manage` stdin writes/submissions, remote MCP execution, and external
  delegated agents are not guarded by this adapter. The plugin does not broadly
  disable those capabilities. A child needs its own proven activation.
- Plugin load failure, disabled plugins, and runtime modes skipping plugin callbacks
  are outside the adapter's failure handling. An installed plugin is not a guarantee
  that callbacks run.

## Verification and rollback

Run `npm run verify`. Focused adapter checks are
`node --test tests/codex-hook.test.mjs tests/hermes-agent-guard.test.mjs`.
For strictly local Git fixtures, use
`GIT_ALLOW_PROTOCOL=file GIT_TERMINAL_PROMPT=0 npm run verify`. The existing
mismatched-origin merge-gate test otherwise attempts a deliberately failing fetch
and can wait on a network credential prompt. This test-only environment does not
alter repository configuration or the runtime guards.
The existing Claude policy corpus remains part of verification. Installer checks
cover repeat installs, preservation, conflicting registrations, and unsafe paths.
Synthetic success must be reported separately from a native runtime smoke test.
An optional installed-source probe is enabled with
`HERMES_GUARD_RUNTIME_SOURCE=/path/to/hermes-agent npm run verify`. It requires the
exact Hermes commit named above and unchanged inspected runtime files. It executes
AST-selected real dispatch and cwd functions with synthetic state/lifecycle/handler
boundaries, not full application startup or worker-context propagation. Ordinary
CI skips this single version-bound probe when that source is unavailable.

Before live activation, use an isolated home and disposable repositories, with no
production credentials or network actions. Verify allow and deny behavior, no marker
on denial, correct worktree selection, background/nested execution where supported,
and disabled/untrusted cases. Do not activate a live profile merely to run a test.
Missing native evidence is a deployment blocker, not proof that the adapter fails.

To undo a repository installation, review and revert only its added files and hook
entries. Preserve unrelated entries and existing Git hook configuration. To undo
separate live activation, disable the exact hook/plugin through the runtime's owner
controls. Neither operation changes the owner-only merge or independent-QA rules.

The underlying command parser retains its documented gaps: aliases, dynamically
constructed commands, scripts written then executed, and other subprocess APIs.
All these hooks are accident-prevention guardrails. Use GitHub branch protection or
rulesets for server-side enforcement, and OS isolation for stronger containment.

## Primary references

- [Codex hooks](https://developers.openai.com/codex/hooks)
- [Codex app-server](https://developers.openai.com/codex/app-server)
- [Codex exec hook payload, v0.165.0](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs)
- [Codex stdin exclusion, v0.165.0](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs)
- [Codex command-handler field types, v0.165.0](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/protocol/src/hooks.rs)
- [Codex hook-file root schema, v0.165.0](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/config/src/hook_config.rs)
- [Hermes plugin development](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins/)
- [Hermes event hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks)
