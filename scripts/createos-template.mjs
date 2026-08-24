#!/usr/bin/env node
/**
 * Build the agent rootfs template the CreateOS backend spawns from.
 *
 * This is `pnpm agent:build` for the other substrate, and it cannot simply
 * send `docker/agent.Dockerfile`. CreateOS bakes a rootfs with rootless
 * buildah and validates the Dockerfile at submit time, which rules out almost
 * everything that file does (fc internal/builder/dockerfile.go):
 *
 *   - exactly ONE `FROM`, and only from `nodeops/sandbox:debian` or `:alpine`
 *   - `COPY` and `ADD` are rejected outright — there is no build context
 *   - `CMD` / `ENTRYPOINT` are rejected; a bare-metal sandbox boots its own
 *     PID 1, so an image entrypoint would never run anyway
 *   - 5 GB final rootfs, 10 minute build timeout
 *
 * So the agent arrives over the network instead of over a build context: CI
 * exports the already-built agent image as a filesystem tarball, and the
 * template's single `RUN` unpacks it. The build pod has ordinary internet
 * access — the per-sandbox egress allowlist applies to sandboxes, not builds.
 *
 *   pnpm agent:template <rootfs-tarball-url> [name]
 *
 * The tarball is produced by `docker export` of the agent image. Until the
 * release workflow publishes one, pass any URL serving that artifact.
 */
import { createClient } from "@nodeops-createos/sandbox";

const baseUrl = process.env.RUNNER_CREATEOS_BASE_URL ?? process.env.CREATEOS_SANDBOX_BASE_URL;
const apiKey = process.env.RUNNER_CREATEOS_API_KEY ?? process.env.CREATEOS_SANDBOX_API_KEY;

const [artifactUrl, requestedName] = process.argv.slice(2);

if (!baseUrl || !apiKey) {
  console.error(
    "Set RUNNER_CREATEOS_BASE_URL and RUNNER_CREATEOS_API_KEY before building a template.",
  );
  process.exit(2);
}
if (!artifactUrl) {
  console.error(
    "Usage: pnpm agent:template <rootfs-tarball-url> [name]\n\n" +
      "The tarball is `docker export` of the agent image, zstd-compressed.",
  );
  process.exit(2);
}

// Immutable by name: the control plane keeps the latest READY template per
// name, and running sandboxes hold a resolved id. A new agent build takes a
// new name so a rebuild can never change what an existing sandbox spawned from.
const name = requestedName ?? `onecli-agent-${Date.now()}`;

/**
 * `/etc/hostname`, `/etc/hosts` and `/etc/resolv.conf` stay as the base image
 * wrote them. The exported tarball carries whatever Docker generated for the
 * container it came from, and those three would break DNS inside the VM.
 */
const dockerfile = `FROM nodeops/sandbox:debian
# Everything the agent needs already lives in the exported image: the Node
# runtime, the supervisor bundle, node_modules, the pinned jcode, and the
# entrypoint script. zstd is added here because the CreateOS backend carries
# the agent's home in and out as a compressed archive on every start and stop.
RUN apt-get update \\
  && apt-get install -y --no-install-recommends ca-certificates curl zstd \\
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL ${JSON.stringify(artifactUrl)} \\
  | tar -x -I zstd -C / \\
    --exclude=./etc/hostname --exclude=./etc/hosts --exclude=./etc/resolv.conf
# The image runs as \`node\` and the backend's launcher drops to it. The user
# arrives with the tarball's /etc/passwd; this only covers a base that already
# defines it.
RUN id -u node >/dev/null 2>&1 || useradd -m -u 1000 node
RUN test -x /app/agent-entrypoint.sh \\
  && test -x /opt/jcode/jcode \\
  && command -v zstd >/dev/null
`;

const client = createClient({ baseUrl, apiKey });

console.log(`Building CreateOS template "${name}"`);
const template = await client.templates.create({ name, dockerfile });

// The build is asynchronous and the control plane keeps the full log only on
// failure. Streaming it is the only way to see why a build failed.
let status = "";
for await (const event of client.templates.followLogs(template.id)) {
  if (event.line) console.log(event.line);
  if (event.final) status = event.status ?? "";
}

if (status !== "ready") {
  const built = await client.templates.get(template.id);
  if (built.status !== "ready") {
    console.error(`\nTemplate build ${built.status}. See the log above.`);
    process.exit(1);
  }
}

console.log(`\nTemplate ready.\n\n  RUNNER_AGENT_IMAGE=${name}\n`);
