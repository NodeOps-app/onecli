#!/usr/bin/env node
/**
 * Build the agent rootfs template the CreateOS backend spawns from.
 *
 * This is `pnpm agent:build` for the other substrate, and it cannot simply
 * send `docker/agent.Dockerfile` — that file is a 7-stage, multi-COPY build,
 * and CreateOS's builder validates the Dockerfile at submit time
 * (fc internal/builder/dockerfile.go):
 *
 *   - exactly ONE `FROM`, and only from `nodeops/sandbox:debian` or `:alpine`
 *   - `COPY` and `ADD` are rejected outright — there is no build context
 *   - `CMD` / `ENTRYPOINT` are rejected; a bare-metal sandbox boots its own
 *     init, so an image entrypoint (`tini`, in the Docker image) is dead
 *     weight rather than something to replicate
 *   - 5 GB final rootfs, 10 minute build timeout
 *
 * So this generates a DIFFERENT Dockerfile: one `FROM`, then `RUN` steps that
 * perform the same three things the multi-stage build did — install Node,
 * clone this repo and build the supervisor, vendor the checksum-verified
 * jcode runtime — using only the instructions CreateOS allows (FROM, RUN,
 * ENV, ARG, USER). The build pod has ordinary internet access; the
 * per-sandbox egress allowlist applies to sandboxes, not builds.
 *
 *   pnpm agent:template [name] [git-ref]
 *
 * `git-ref` (default `main`) is what the template's build step clones —
 * pass the branch under test, e.g. `feat/createos-sandbox-backend`.
 */
import { createClient } from "@nodeops-createos/sandbox";

const baseUrl = process.env.RUNNER_CREATEOS_BASE_URL ?? process.env.CREATEOS_SANDBOX_BASE_URL;
const apiKey = process.env.RUNNER_CREATEOS_API_KEY ?? process.env.CREATEOS_SANDBOX_API_KEY;

if (!baseUrl || !apiKey) {
  console.error(
    "Set RUNNER_CREATEOS_BASE_URL and RUNNER_CREATEOS_API_KEY before building a template.",
  );
  process.exit(2);
}

const [requestedName, gitRef] = process.argv.slice(2);
// Immutable by name: the control plane keeps the latest READY template per
// name, and running sandboxes hold a resolved id. A new agent build takes a
// new name so a rebuild can never change what an existing sandbox spawned from.
const name = requestedName ?? `onecli-agent-${Date.now()}`;
const ref = gitRef ?? "main";

// Same jcode pin as docker/agent.Dockerfile — kept in sync by hand; both are
// the ONE place jcode's version and checksums are named.
const JCODE_VERSION = "v0.71.1";
const JCODE_SHA256 = {
  amd64: "fb2af63f1df5aecc6e9185d1f88be5ec634578d30081af7db68486bc8283f76b",
  arm64: "bbd3bcd62cf67f89b7923960cda0fd8cc2129f6347d5e9904b7506e46c884d86",
};

// Identical to docker/agent-entrypoint.sh. Embedded rather than fetched: the
// template build has no COPY, and fetching this one small file over the
// network for every build is not worth a second source of truth to keep in
// sync — this literal IS the sync point, kept byte-for-byte with the file.
const ENTRYPOINT_SH = `#!/bin/sh
set -e

# Entrypoint for the agent sandbox image (docker/agent.Dockerfile).
#
# Rootless CA trust: the gateway's MITM CA arrives as a mounted file (the
# container-config payload names it in NODE_EXTRA_CA_CERTS). Inside the
# sandbox every TLS handshake presents the gateway's certificate — egress is
# gateway-only (§3.4) — so this one CA is the only trust anyone needs:
# - NODE_EXTRA_CA_CERTS: the supervisor's Node runtime (set by the payload).
# - SSL_CERT_FILE: the jcode runtime (rustls-native-certs honors it; verified).
# - CURL_CA_BUNDLE / GIT_SSL_CAINFO: the agent's common tools.
# System-store installation (update-ca-certificates, needs root) arrives with
# step 3's runner-controlled spawn.
CA_FILE="\${NODE_EXTRA_CA_CERTS:-/tmp/onecli-gateway-ca.pem}"
if [ -f "$CA_FILE" ]; then
  export SSL_CERT_FILE="$CA_FILE"
  export CURL_CA_BUNDLE="$CA_FILE"
  export GIT_SSL_CAINFO="$CA_FILE"
else
  echo "agent-entrypoint: no CA file at $CA_FILE — TLS through the gateway will fail" >&2
fi

exec node apps/sandbox-supervisor/dist/index.mjs
`;

const dockerfile = `FROM nodeops/sandbox:debian

RUN apt-get update \\
  && apt-get install -y --no-install-recommends curl ca-certificates git ripgrep zstd gnupg \\
  && rm -rf /var/lib/apt/lists/*

# Node 22 via NodeSource, not apt: Debian's own nodejs package version tracks
# the release, not a pinned major — this repo's engines field needs >=22.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \\
  && apt-get install -y --no-install-recommends nodejs \\
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# A full-workspace install (1170 packages across 15 projects) plus the
# upload/pack step that follows it does not fit CreateOS's 10-minute build
# timeout — proved by running it: the build itself completed and committed
# cleanly, but the template was still marked failed with ext4_size_bytes: 0,
# because the timeout landed on the pack/upload step right after. turbo
# prune is docker/agent.Dockerfile's own answer to this, reused here for the
# same reason: install only what @onecli/sandbox-supervisor needs.
RUN git clone --depth 1 --branch ${ref} https://github.com/NodeOps-app/onecli /repo
WORKDIR /repo
RUN corepack pnpm dlx turbo@2.8.11 prune @onecli/sandbox-supervisor --docker
WORKDIR /repo/out/full
# corepack resolves the exact pinned version from package.json's
# packageManager field on its own — nothing to pin here.
#
# --no-frozen-lockfile, not --frozen: turbo's pruned package.json does not
# carry the root's pnpm.overrides, so pnpm sees that as lockfile drift and a
# frozen install refuses it (ERR_PNPM_LOCKFILE_CONFIG_MISMATCH), confirmed
# by running it. Acceptable for a template build, which needs a WORKING
# install, not CI's exact-lockfile guarantee — revisit if this ever becomes
# the release pipeline rather than a proof build.
RUN corepack pnpm install --no-frozen-lockfile
RUN corepack pnpm build --filter=@onecli/sandbox-supervisor
RUN echo "node-linker=hoisted" >> .npmrc

# Relocate to /app: the guest-side path the runner's launcher and
# docker/agent-entrypoint.sh both assume (backend/createos/createos-backend.ts
# APP_DIR). /repo — the full, unpruned clone — is no longer needed.
WORKDIR /
RUN mv /repo/out/full /app && rm -rf /repo
WORKDIR /app

ARG TARGETARCH=amd64
ARG JCODE_VERSION=${JCODE_VERSION}
RUN case "$TARGETARCH" in \\
      amd64) ASSET="jcode-linux-x86_64"; SHA=${JSON.stringify(JCODE_SHA256.amd64)};; \\
      arm64) ASSET="jcode-linux-aarch64"; SHA=${JSON.stringify(JCODE_SHA256.arm64)};; \\
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1;; \\
    esac \\
  && curl -fsSL -o /tmp/jcode.tar.gz \\
    "https://github.com/1jehuang/jcode/releases/download/\${JCODE_VERSION}/\${ASSET}.tar.gz" \\
  && echo "\${SHA}  /tmp/jcode.tar.gz" | sha256sum -c - \\
  && mkdir -p /opt/jcode \\
  && tar -xzf /tmp/jcode.tar.gz -C /opt/jcode \\
  && for f in /opt/jcode/*; do \\
       case "$f" in \\
         "/opt/jcode/\${ASSET}"|"/opt/jcode/\${ASSET}.bin") ;; \\
         *) echo "unexpected file in jcode release: $f" >&2; exit 1;; \\
       esac; \\
     done \\
  && mv "/opt/jcode/\${ASSET}" /opt/jcode/jcode \\
  && chown -R root:root /opt/jcode \\
  && chmod 0755 /opt/jcode/* \\
  && rm /tmp/jcode.tar.gz
RUN JCODE_NO_AUTO_UPDATE=1 JCODE_NO_TELEMETRY=1 /opt/jcode/jcode --version | grep -F "jcode \${JCODE_VERSION} "

# No COPY: the entrypoint script arrives base64-encoded on the RUN command
# line instead. Byte-for-byte docker/agent-entrypoint.sh — see that file's
# own comments for why the CA handling looks the way it does.
RUN echo ${JSON.stringify(Buffer.from(ENTRYPOINT_SH, "utf8").toString("base64"))} | base64 -d > /app/agent-entrypoint.sh \\
  && chmod +x /app/agent-entrypoint.sh

RUN id -u node >/dev/null 2>&1 || useradd -m -u 1000 node
RUN mkdir -p /workspace && chown node:node /workspace

ENV NODE_ENV=production
ENV NO_COLOR=1
ENV FORCE_COLOR=0
ENV JCODE_NO_TELEMETRY=1
ENV JCODE_NO_AUTO_UPDATE=1
ENV NODE_OPTIONS=--enable-source-maps
ENV ONECLI_JCODE_BINARY=/opt/jcode/jcode

USER node
`;

const client = createClient({ baseUrl, apiKey });

console.log(`Building CreateOS template "${name}" from ${ref}`);
const template = await client.templates.create({ name, dockerfile });

// The build is asynchronous and the control plane keeps the full log only on
// failure. Streaming it is the only way to see why a build failed.
let status = "";
for await (const event of client.templates.followLogs(template.id)) {
  if (event.line) console.log(event.line);
  if (event.final) status = event.status ?? "";
}

if (status !== "ready") {
  const built = await client.templates.get(template.id, { include: "dockerfile" });
  if (built.status !== "ready") {
    console.error(`\nTemplate build ${built.status}. See the log above.`);
    process.exit(1);
  }
}

console.log(`\nTemplate ready.\n\n  RUNNER_AGENT_IMAGE=${name}\n`);
