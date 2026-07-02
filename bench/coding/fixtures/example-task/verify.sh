#!/usr/bin/env bash
set -euo pipefail
test "$(cat output.txt 2>/dev/null)" = "done"
