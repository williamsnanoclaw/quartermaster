# The agent runs here and nowhere else.
#
# The container IS the sandbox. Because the boundary is real, Codex runs
# unrestricted inside it — no approval prompts, no path allowlists, full shell.
# That is deliberate: an agent that has to beg for permission to read a file
# cannot solve real problems. What it cannot do is reach your machine.
FROM node:24-bookworm-slim

ARG CODEX_VERSION=0.147.0

# Enough of a userland that the agent can actually work a problem.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep jq less python3 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@${CODEX_VERSION} && npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json* ./
# --ignore-scripts because `prepare` builds the host CLI with tsc, which is a
# devDependency and has no business running here. `npm ci` when there is a
# lockfile, so a rebuild gets the versions that were tested.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --ignore-scripts --no-audit --no-fund; \
    else \
      npm install --omit=dev --ignore-scripts --no-audit --no-fund; \
    fi

# Node 24 strips TypeScript types natively, so the runtime ships as source.
# Edit agent/, restart, done — no build step between you and the agent.
COPY src/protocol.ts ./src/protocol.ts
COPY src/runtime ./src/runtime
# Normally shadowed by a read-only bind mount of the host's agent/. Baked in so
# the image still runs standalone, e.g. for debugging with `docker run`.
COPY agent ./agent

ENV CODEX_HOME=/workspace/.codex \
    TEMPER_WORKSPACE=/workspace \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

# /app stays root-owned and read-only to the agent. The runtime under /app is
# what enforces the effect gate; the agent runs as `temper` with a full shell,
# so if it could write there it could simply edit the gate out.
RUN useradd -m -u 1001 temper \
    && mkdir -p /workspace \
    && chown -R temper:temper /workspace
USER temper
VOLUME /workspace

ENTRYPOINT ["node", "/app/src/runtime/main.ts"]
