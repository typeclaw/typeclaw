import base64
import os
import shlex
from pathlib import Path

from terminal_bench.agents.installed_agents.abstract_installed_agent import AbstractInstalledAgent
from terminal_bench.terminal.models import TerminalCommand

AGENT_DIR = "/opt/tc-agent"


def _b64(path: str) -> str:
    return base64.b64encode(Path(path).read_bytes()).decode()


class TypeclawNativeAgent(AbstractInstalledAgent):
    """Runs typeclaw's real tool loop inside each task container (read/run/iterate),
    unlike the websocket planner which one-shots blind commands from outside."""

    @staticmethod
    def name() -> str:
        return "typeclaw-native"

    @property
    def _env(self) -> dict[str, str]:
        # Ship the agent folder (model config + codex creds) and the runner into
        # the container as base64 env vars; the setup script decodes them.
        runner = Path(__file__).parent / "bench-runner.ts"
        return {
            "TC_CONFIG_B64": _b64(os.environ["TYPECLAW_CONFIG_PATH"]),
            "TC_SECRETS_B64": _b64(os.environ["TYPECLAW_SECRETS_PATH"]),
            "TC_RUNNER_B64": base64.b64encode(runner.read_bytes()).decode(),
        }

    @property
    def _install_agent_script_path(self) -> Path:
        return self._get_templated_script_path("typeclaw-setup.sh.j2")

    def _run_agent_commands(self, instruction: str) -> list[TerminalCommand]:
        # cd to the agent dir so config + auth resolve from cwd; pass the task
        # working dir (/app is the terminal-bench convention) + the instruction.
        escaped = shlex.quote(instruction)
        bun_bin = "${HOME}/.bun/bin"
        run = (
            f'export PATH="{bun_bin}:${{PATH}}"; '
            f"cd {AGENT_DIR} && "
            f"bun run {AGENT_DIR}/node_modules/typeclaw/bench-runner.ts /app {escaped}"
        )
        return [
            TerminalCommand(
                command=run,
                min_timeout_sec=0.0,
                max_timeout_sec=float("inf"),
                block=True,
                append_enter=True,
            ),
        ]
