import base64
import json
import re
from pathlib import Path

from websockets.sync.client import connect

from terminal_bench.agents.base_agent import AgentResult, BaseAgent
from terminal_bench.agents.failure_mode import FailureMode
from terminal_bench.terminal.tmux_session import TmuxSession

# Ask the real typeclaw agent (over its TUI websocket) to PLAN the shell commands
# for a task, then run them in the terminal-bench task container. typeclaw itself
# runs in its own container, so we use it purely as the planner and execute the
# commands here — the only way to score its output against tb's task filesystem.
PLAN_PROMPT = """You are given a task to solve in a Linux terminal. Do NOT run \
anything yourself. Output ONLY a fenced ```bash code block containing the exact \
shell commands, in order, that would solve it. No prose.

Task:
{instruction}"""

_FENCE = re.compile(r"```(?:bash|sh)?\s*\n(.*?)```", re.DOTALL)


class TypeclawAgent(BaseAgent):
    @staticmethod
    def name() -> str:
        return "typeclaw"

    def __init__(self, ws_token: str, ws_host: str = "127.0.0.1", ws_port: int = 8973, **kwargs):
        super().__init__(**kwargs)
        self._ws_url = f"ws://{ws_host}:{ws_port}?token={ws_token}"

    def perform_task(
        self,
        instruction: str,
        session: TmuxSession,
        logging_dir: Path | None = None,
    ) -> AgentResult:
        try:
            reply = self._ask_typeclaw(PLAN_PROMPT.format(instruction=instruction))
        except Exception:
            return AgentResult(failure_mode=FailureMode.UNKNOWN_AGENT_ERROR)

        script = self._extract_script(reply)
        if not script:
            return AgentResult(failure_mode=FailureMode.FATAL_LLM_PARSE_ERROR)

        # Deliver the whole plan as one base64 blob decoded into a file, then run
        # it. Sending lines individually breaks on heredocs/multi-line blocks —
        # the shell enters a continuation prompt and tmux's wait signal never
        # fires (900s timeout). base64 sidesteps all quoting/newline hazards.
        blob = base64.b64encode(script.encode()).decode()
        session.send_keys(
            [f"echo {blob} | base64 -d > /tmp/tb_solve.sh && bash /tmp/tb_solve.sh", "Enter"],
            block=True,
        )

        return AgentResult(failure_mode=FailureMode.NONE)

    def _ask_typeclaw(self, prompt: str) -> str:
        chunks: list[str] = []
        with connect(self._ws_url, open_timeout=15) as ws:
            _wait_for(ws, "connected")
            ws.send(json.dumps({"type": "prompt", "text": prompt}))
            while True:
                message = json.loads(ws.recv(timeout=600))
                kind = message.get("type")
                if kind == "text_delta":
                    chunks.append(message.get("delta", ""))
                elif kind in ("done", "error"):
                    break
        return "".join(chunks)

    @staticmethod
    def _extract_script(reply: str) -> str:
        blocks = _FENCE.findall(reply)
        return (blocks[0] if blocks else reply).strip()


def _wait_for(ws, kind: str) -> None:
    while True:
        message = json.loads(ws.recv(timeout=30))
        if message.get("type") == kind:
            return
