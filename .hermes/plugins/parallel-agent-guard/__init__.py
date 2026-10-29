"""Project-only adapter for the unchanged Claude Bash guard, not containment.

Install contract: keep this directory at <repo>/.hermes/plugins/parallel-agent-guard
and the policy at <repo>/.claude/hooks/agent-guard.mjs. Project discovery requires
HERMES_ENABLE_PROJECT_PLUGINS=1 and Hermes process cwd at that repository root;
Hermes does not search ancestors. Copying files does not activate a running agent.
Profile/bundled installations deliberately register nothing. No profile is edited.

Only native terminal calls are covered, including background launches. Raw Python,
execute_code subprocesses, MCP tools, process write/submit, commands hidden inside
scripts and the existing guard's parser gaps remain unprotected. Scope is the
effective starting cwd, not shell text that later enters another repository.
Unknown runtime/cwd and nonlocal backends block while this project hook is loaded:
host Git cannot safely evaluate remote branch state. This is version-bound to the
Hermes terminal state APIs identified below, not a general sandbox.
"""

import json
from pathlib import Path
import shutil
import subprocess


_ROOT = Path(__file__).resolve().parents[3]


def _git_common_dir(directory):
    """Read Git's local layout only; no Git config, shell or payload execution."""
    directory = Path(directory).resolve()
    for parent in (directory, *directory.parents):
        marker = parent / ".git"
        if marker.is_dir():
            return marker.resolve()
        if marker.is_file():
            text = marker.read_text().strip()
            if not text.startswith("gitdir: "):
                raise ValueError("invalid Git worktree marker")
            gitdir = (parent / text[8:]).resolve()
            common = gitdir / "commondir"
            return (gitdir / common.read_text().strip()).resolve() if common.is_file() else gitdir
    return None


def _terminal_location(args, task_id):
    from tools import terminal_tool
    from tools.approval import get_current_session_key

    config = terminal_tool._get_env_config()
    # Match _plan_execution then _resolve_command_cwd at Hermes commit
    # 82d5c0ae8106c5eff3ae22fd7ae33ca4ff71d784. session_id is NOT the cwd key.
    default = (terminal_tool.resolve_task_overrides(task_id).get("cwd")
               or terminal_tool.get_session_cwd(task_id) or config["cwd"])
    session_key = get_current_session_key(default="") or (task_id or "")
    cwd = args.get("workdir") or terminal_tool.get_session_cwd(session_key) or default
    return config["env_type"], cwd


def _block(message):
    return {"action": "block", "message": "parallel-agent-guard: " + message}


def pre_tool_call(tool_name, args, task_id=None, session_id=None, **kwargs):
    if tool_name != "terminal":
        return None
    try:
        backend, cwd = _terminal_location(args if isinstance(args, dict) else {}, task_id)
    except Exception:
        # Hermes dispatch can ignore a raised callback exception. Return a veto,
        # without leaking runtime/config contents in the diagnostic.
        return _block("cannot resolve terminal runtime state; command was not run")
    try:
        if backend != "local":
            return _block("unsupported or unknown terminal backend; local backend required")
        if not isinstance(cwd, str) or not cwd or "\0" in cwd or not Path(cwd).is_absolute():
            return _block("terminal cwd must be a known absolute directory; supply workdir")
        if not Path(cwd).is_dir():
            return _block("terminal cwd directory is unavailable; supply an existing workdir")
        common = _git_common_dir(_ROOT)
        if common is None:
            return _block("project Git scope is unavailable")
        if _git_common_dir(cwd) != common:
            return None
        if not isinstance(args, dict):
            return _block("malformed terminal payload: expected an argument object")
        command = args.get("command")
        if not isinstance(command, str) or not command.strip() or "\0" in command:
            return _block("malformed terminal payload: command must be a nonempty string without NUL")
        if args.get("workdir") is not None and not isinstance(args["workdir"], str):
            return _block("malformed terminal payload: workdir must be a string")
        node = shutil.which("node")
        if not node:
            return _block("required node executable is missing")
        git = shutil.which("git")
        if not git:
            return _block("required git executable is missing")
        guard = _ROOT / ".claude/hooks/agent-guard.mjs"
        if not guard.is_file():
            return _block("required .claude/hooks/agent-guard.mjs is missing")
        # The existing policy treats failed branch lookups as unknown. Do not
        # silently permit a scoped command when Git itself is broken/unusable.
        branch = subprocess.run(
            [git, "-C", cwd, "branch", "--show-current"],
            text=True, capture_output=True, timeout=2, cwd=cwd,
        )
        if branch.returncode != 0:
            return _block("git could not inspect the scoped repository; command was not run")
        # The supplied command is ONLY JSON data on stdin, never shell input.
        result = subprocess.run(
            [node, str(guard)],
            input=json.dumps({"tool_name": "Bash", "tool_input": {"command": command}, "cwd": cwd}),
            text=True, capture_output=True, timeout=5, cwd=cwd,
        )
        if result.returncode == 0:
            return None
        if result.returncode == 2:
            return _block(result.stderr.strip() or "guard denied the command")
        return _block("guard evaluation failed; command was not run")
    except subprocess.TimeoutExpired:
        return _block("guard evaluation timed out; command was not run")
    except Exception:
        return _block("guard evaluation failed (scope, dependency or launch error); command was not run")


def register(ctx):
    # A profile copy must not infer that the user's home is a kit repository.
    # Profile-wide installation is intentionally unsupported by this project adapter.
    if ctx.manifest.source == "project":
        ctx.register_hook("pre_tool_call", pre_tool_call)
