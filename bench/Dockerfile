FROM oven/bun:1-slim

# Python (for Harbor / Terminal-Bench scoring) lives INSIDE the image so it never
# touches the host — the "no machine clutter" guarantee. Suites are cloned at
# pinned commits into gitignored bench/suites/ at run time, not baked in.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates python3 python3-venv python3-pip python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

ENV VIRTUAL_ENV=/opt/bench-venv
ENV PATH="/opt/bench-venv/bin:$PATH"
RUN python3 -m venv "$VIRTUAL_ENV"

WORKDIR /bench
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

ENTRYPOINT ["bun", "run"]
CMD ["coding/run.ts"]
