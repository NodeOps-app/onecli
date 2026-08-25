import {
  createClient,
  CreateosSandboxNotFoundError,
  CreateosSandboxValidationError,
  type CreateosSandboxClient,
  type CreateSandboxRequest,
  type Sandbox,
  type SandboxView,
  type Shape,
} from "@nodeops-createos/sandbox";
import {
  ImageUnavailableError,
  type ContainerRef,
  type HomeRef,
  type ManagedObject,
  type SandboxBackend,
  type SandboxLimits,
  type SandboxSnapshot,
  type SandboxSpec,
} from "../types";
import { createHomeStore, type HomeStore } from "./homes";
import { buildLabels, decodeLabel, isManaged } from "./labels";
import { log } from "../../log";

/**
 * The CreateOS sandbox backend — the seam's second real substrate.
 *
 * Where the Docker backend puts a container on an `internal` network with no
 * route off the host, this one puts a Firecracker microVM on a CreateOS
 * overlay network. The two security properties survive the move, but they are
 * enforced by different machinery, so both are stated here:
 *
 * 1. **Egress is still gateway-only** (§3.4), now by allowlist rather than by
 *    routing. Every sandbox is created with `egress` pinned to the gateway's
 *    host and port, DERIVED from the proxy URL the control plane already put
 *    in the spawn payload. There is no configuration to get wrong and no
 *    default that opens it: a payload without a parseable proxy is refused.
 *    CreateOS enforces the list in the host kernel (iptables per-VM chain),
 *    so an agent that unsets its own proxy env still reaches nothing.
 * 2. **The runner is reached over the overlay, not the internet.** Two VMs
 *    that do not share a network cannot reach each other at all, regardless
 *    of what either one's egress list says. But shared membership is only
 *    half the requirement: the egress allowlist is NOT bypassed for overlay
 *    peers. A sandbox with a non-empty `egress` drops peer traffic unless the
 *    peer's `host:port` is a rule. Both halves must hold, so `RUNNER_WS_URL`
 *    is derived into the allowlist next to the proxy. Measured on live
 *    sandboxes; see `docs/createos-networking.md`.
 *
 * The container hardening the Docker backend spells out (`CapDrop: ALL`,
 * `no-new-privileges`, `PidsLimit`) has no counterpart here, and needs none.
 * Those flags stop a process from climbing out to a SHARED host kernel. A
 * microVM runs its own kernel and its own process table, so the boundary is
 * the virtualization, not a capability set.
 *
 * What does NOT survive the move is Docker's env map. CreateOS caps a
 * persistent env value at 4096 bytes and the whole map at 64 keys, and
 * `AGENT_INSTRUCTIONS` alone can exceed that. So the spawn payload's env is
 * written into the guest as a FILE and sourced at start. Two things fall out
 * of that, both good: no size limit applies, and the single-use control-channel
 * token never reaches the CreateOS control plane's database at all.
 */

/** Guest paths this backend owns. Nothing else is written outside the home. */
const GUEST_DIR = "/etc/onecli";
const ENV_FILE = `${GUEST_DIR}/agent.env`;
const START_FILE = `${GUEST_DIR}/start.sh`;
const ARCHIVE_PATH = "/tmp/onecli-home.tar.zst";
/** Mirrors the Docker backend's HOME_MOUNT and the image's VOLUME. */
const HOME_MOUNT = "/workspace";
/** The unprivileged user the agent image creates and runs as. */
const AGENT_USER = "node";
/** WORKDIR in docker/agent.Dockerfile, where the entrypoint script lives. */
const APP_DIR = "/app";

/**
 * The control plane's `BodyLimit` for `/v1/sandboxes/:id/files`
 * (fc internal/control/main.go:408). A home archive past this can be written
 * to the store but never restored into a VM, so the harvest refuses it while
 * the previous archive is still intact.
 */
export const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;

/** CreateOS caps a user-facing VM name at 22 characters (DNS-label rules). */
const NAME_PREFIX = "onecli-";
const NAME_BODY = 22 - NAME_PREFIX.length;

export interface CreateosBackendOptions {
  /** Initial owner label; replaced by `identify()` after registration. */
  runnerId: string;
  /** This installation's fingerprint — see the Docker backend's LABEL_INSTALLATION. */
  installationId: string;
  /** CreateOS control-plane base URL. */
  baseUrl: string;
  apiKey: string;
  /** Overlay network the runner and every sandbox share. Created if absent. */
  network: string;
  /** Directory holding one archive per agent home. Must be durable. */
  homesDir: string;
  /** Explicit shape id. Empty = pick the smallest shape meeting `limits`. */
  shape?: string;
  /** Extra `host:port` egress entries, added to the derived gateway rule. */
  extraEgress?: string[];
  /** Pause an idle sandbox after this many seconds. 0 = never. */
  autoPauseSeconds?: number;
  /** Injectable for tests — the real one talks to the CreateOS API. */
  client?: CreateosSandboxClient;
  /** Injectable for tests. */
  homes?: HomeStore;
}

/** Shell-quote one value for safe interpolation into a `sh -c` script. */
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** POSIX-portable env-var name. Anything else is not a name we will source. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Render the spawn payload's env as a file the guest sources.
 *
 * Values are shell-quoted, and keys are CHECKED rather than quoted — a key is
 * a bare word on the left of `=`, so there is no quoting that makes a
 * malformed one safe. The payload is composed by the control plane, so a bad
 * key is a bug rather than an attack, but this file is sourced by a shell
 * inside the sandbox and that makes it a trust boundary worth guarding.
 */
export const renderEnvFile = (env: Record<string, string>): string => {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY.test(key)) {
      throw new Error(
        `spawn payload carries an env name that is not a POSIX identifier, and it cannot be written to a sourced file: ${JSON.stringify(key)}`,
      );
    }
    lines.push(`${key}=${quote(value)}`);
  }
  return `${lines.join("\n")}\n`;
};

/**
 * Where the agent's traffic must go, taken from the payload rather than from
 * configuration.
 *
 * The control plane already decided the gateway's address and put it in
 * `HTTPS_PROXY` (container-config-service.ts). Reading it back here means the
 * allowlist can never drift from the proxy the agent was told to use, and
 * there is no "allow all" default anyone can leave in place by accident.
 */
const authorityOf = (raw: string, what: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `spawn payload's ${what} is unparseable, so the egress allowlist cannot be derived — refusing to create a sandbox with unrestricted egress`,
    );
  }
  const secure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  return `${parsed.hostname}:${parsed.port || (secure ? "443" : "80")}`;
};

export const deriveEgress = (
  env: Record<string, string>,
  extra: readonly string[] = [],
): string[] => {
  const raw = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  if (!raw) {
    throw new Error(
      "spawn payload carries no proxy URL, so the sandbox's egress allowlist cannot be derived — refusing to create a sandbox with unrestricted egress",
    );
  }
  const ws = env.RUNNER_WS_URL;
  if (!ws) {
    throw new Error(
      "spawn payload carries no RUNNER_WS_URL, so the control channel cannot be allowlisted — the sandbox would start and never reach the runner",
    );
  }
  const rules = [authorityOf(raw, "proxy URL"), authorityOf(ws, "RUNNER_WS_URL"), ...extra];
  // `*` anywhere means allow-all to CreateOS's rule parser, which would
  // silently undo the whole boundary. An operator who wants that must not get
  // it by typo.
  if (rules.some((rule) => rule.includes("*"))) {
    throw new Error(
      'an egress rule contains "*", which CreateOS reads as allow-all — refusing to disable the gateway boundary',
    );
  }
  return rules;
};

/**
 * The smallest catalog shape that satisfies the runner's configured limits.
 *
 * The limits stay meaningful rather than being silently ignored: an operator
 * who set RUNNER_SANDBOX_MEMORY_MB gets at least that much. Falling back to
 * the largest shape rather than throwing keeps a catalog change from taking
 * the runner down.
 */
export const pickShape = (shapes: readonly Shape[], limits: SandboxLimits): Shape => {
  if (shapes.length === 0) {
    throw new Error("the CreateOS shape catalog is empty, so no sandbox size can be chosen");
  }
  const bySize = [...shapes].sort((a, b) => a.mem_mib - b.mem_mib || a.vcpu - b.vcpu);
  const fits = bySize.find(
    (shape) => shape.mem_mib >= limits.memoryMb && shape.vcpu >= limits.cpus,
  );
  if (fits) return fits;
  const largest = bySize[bySize.length - 1]!;
  log("warn", "no CreateOS shape meets the configured limits; using the largest", {
    wantedMemoryMb: limits.memoryMb,
    wantedCpus: limits.cpus,
    shape: largest.id,
  });
  return largest;
};

/** The launcher written into every guest. Sources the env, then drops privilege. */
const startScript = (): string =>
  [
    "#!/bin/sh",
    "set -e",
    "# Written by the onecli CreateOS backend. The spawn payload's env lives in",
    "# a file rather than the VM's env map: CreateOS caps a persistent env",
    "# value at 4096 bytes, and AGENT_INSTRUCTIONS can exceed it.",
    `set -a`,
    `. ${ENV_FILE}`,
    `set +a`,
    `cd ${APP_DIR}`,
    "# The image declares USER node and the entrypoint expects to be it. A",
    "# CreateOS exec starts as root, so the drop happens here instead.",
    `exec su -s /bin/sh ${AGENT_USER} -c ${quote(`cd ${APP_DIR} && exec ./agent-entrypoint.sh`)}`,
  ].join("\n");

export const createCreateosBackend = (options: CreateosBackendOptions): SandboxBackend => {
  const client =
    options.client ?? createClient({ baseUrl: options.baseUrl, apiKey: options.apiKey });
  const homes = options.homes ?? createHomeStore(options.homesDir);

  // Mutable so registration's stable id replaces the boot-time placeholder
  // before anything is created — see `identify` on the seam.
  let owner = options.runnerId;
  /** Resolved once in prepare(); every create reuses them. */
  let networkId = "";
  let shapes: Shape[] = [];

  const envKeysOf = (view: SandboxView): string[] => view.envs ?? [];

  /** Terminal states hold no compute and must never look like a live sandbox. */
  const isAlive = (view: SandboxView): boolean =>
    view.status !== "destroyed" && view.status !== "destroying" && view.status !== "failed";

  const ensureNetwork = async (): Promise<string> => {
    const existing = await client.networks.list();
    const found = existing.find((network) => network.name === options.network);
    if (found) return found.id;
    const created = await client.networks.create({ name: options.network });
    log("info", "created CreateOS overlay network", {
      network: options.network,
      networkId: created.id,
    });
    return created.id;
  };

  /**
   * Run one script inside the guest and raise on a non-zero exit.
   *
   * `runCommand` does not go through a shell, so everything is wrapped in
   * `sh -c`. The image is Debian-based and `sh` is always present; `bash` is
   * deliberately not assumed.
   */
  const exec = async (sandbox: Sandbox, script: string, what: string) => {
    const response = await sandbox.runCommand("sh", ["-c", script]);
    const { exit_code: code, stderr, error } = response.result;
    if (code !== 0 || error) {
      throw new Error(
        `${what} failed inside sandbox ${sandbox.id} (exit ${code}): ${error ?? stderr.slice(0, 500)}`,
      );
    }
    return response.result;
  };

  const putFiles = async (sandbox: Sandbox, files: SandboxSpec["files"]): Promise<void> => {
    for (const file of files) {
      await sandbox.files.upload(file.containerPath, file.content);
    }
    // `files.upload` carries no mode, and the credential stubs are spawned
    // 0600 on purpose. Applied in one exec rather than one per file.
    const chmods = files
      .filter((file) => file.mode !== undefined)
      .map(
        (file) =>
          `chmod ${(file.mode as number).toString(8).padStart(4, "0")} ${quote(file.containerPath)}`,
      );
    if (chmods.length > 0) await exec(sandbox, chmods.join(" && "), "chmod");
  };

  /** Put the agent's stored files back into a freshly created VM. */
  const restoreHome = async (sandbox: Sandbox, homeRef: HomeRef): Promise<void> => {
    const archive = await homes.readArchive(homeRef);
    // Absent on an agent's very first start. Ownership on a workspace with
    // nothing to restore is `startSandbox`'s job, not this function's.
    if (!archive) return;
    await sandbox.files.upload(ARCHIVE_PATH, new Uint8Array(archive));
    // --no-same-owner: the archive was written by whatever uid ran in the
    // previous VM; the chown below is the authority, not the tar metadata.
    await exec(
      sandbox,
      [
        `mkdir -p ${HOME_MOUNT}`,
        `tar -x --no-same-owner -C ${HOME_MOUNT} -I zstd -f ${ARCHIVE_PATH}`,
        `rm -f ${ARCHIVE_PATH}`,
        `chown -R ${AGENT_USER}:${AGENT_USER} ${HOME_MOUNT}`,
      ].join(" && "),
      "home restore",
    );
    log("info", "restored agent home", {
      sandbox: sandbox.id,
      bytes: archive.byteLength,
    });
  };

  /**
   * Pull the agent's files out of a VM that is about to die.
   *
   * Called from `stopSandbox`, which the runner always runs before
   * `removeSandbox` — on the recreate path, the orphan sweep, and shutdown
   * alike. This is the ONLY point at which the home is captured, which is
   * exactly why this backend declares `snapshot` rather than `resident`: a VM
   * that dies without being stopped loses whatever it wrote since its start.
   *
   * ponytail: whole-home tar on every stop, cost linear in home size, with a
   * hard 500 MB ceiling from the files endpoint. An incremental sync earns
   * its complexity only if agents routinely approach that.
   */
  const harvestHome = async (sandbox: Sandbox): Promise<void> => {
    const sandboxId = decodeLabel(envKeysOf(sandbox.data), "sandbox");
    // Unlabeled means unidentifiable, and this backend never guesses which
    // home a VM belongs to.
    if (!sandboxId) return;
    const ref = homes.refFor(sandboxId);
    await exec(
      sandbox,
      `tar -c -C ${HOME_MOUNT} -I ${quote("zstd -3 -T0")} -f ${ARCHIVE_PATH} .`,
      "home harvest",
    );
    const bytes = await sandbox.files.download(ARCHIVE_PATH);
    // Refuse rather than store. An oversized archive uploads fine here but
    // fails every future restore, which would turn one big home into a
    // permanently unstartable agent — and overwrite the last good archive on
    // the way. Keeping the previous one is the recoverable outcome.
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error(
        `agent home is ${bytes.byteLength} bytes compressed, past the ${MAX_ARCHIVE_BYTES}-byte limit the CreateOS files endpoint accepts — the previous home was kept and this VM's newer files are lost`,
      );
    }
    await homes.writeArchive(ref, Buffer.from(bytes));
    log("info", "harvested agent home", {
      sandboxId,
      sandbox: sandbox.id,
      bytes: bytes.byteLength,
    });
  };

  /** A short, human-readable VM name. The labels carry the real identity. */
  const vmName = (sandboxId: string): string =>
    `${NAME_PREFIX}${sandboxId.replaceAll("-", "").slice(0, NAME_BODY)}`;

  const connect = async (ref: ContainerRef): Promise<Sandbox | null> => {
    try {
      return await client.getSandbox(ref);
    } catch (error) {
      // Already gone is the desired end state for every caller here.
      if (error instanceof CreateosSandboxNotFoundError) return null;
      throw error;
    }
  };

  const managedViews = async (): Promise<SandboxView[]> => {
    const all = await client.listSandboxes();
    return all
      .map((sandbox) => sandbox.data)
      .filter((view) => isAlive(view) && isManaged(envKeysOf(view)));
  };

  return {
    id: "createos",
    // Not `resident`: the home is captured at stop, so a VM lost without a
    // stop loses the writes since its last start. The platform declares that
    // window rather than hiding it (§3.9).
    homeDurability: "snapshot",

    identify(runnerId: string) {
      owner = runnerId;
    },

    async prepare() {
      // Fails fast and loudly on a bad key, rather than as a stream of 401s.
      await client.whoami();
      networkId = await ensureNetwork();
      shapes = await client.listShapes();
      log("info", "CreateOS backend ready", {
        network: options.network,
        networkId,
        shapes: shapes.length,
        homesDir: options.homesDir,
      });
    },

    async provisionHome(sandboxId) {
      return homes.provision(sandboxId, {
        runnerId: owner,
        installationId: options.installationId,
      });
    },

    async destroyHome(ref: HomeRef) {
      await homes.destroy(ref);
    },

    // The home is captured in `stopSandbox`, while the VM is still alive and
    // reachable. By the time the runner parks, there is nothing left to do —
    // and `wakeHome` cannot restore anything either, because it runs BEFORE
    // the VM that would receive the files exists (runner.ts:294).
    async parkHome() {},
    async wakeHome() {},

    async listHomes() {
      return homes.list();
    },

    async createSandbox(spec: SandboxSpec) {
      const request: CreateSandboxRequest = {
        shape: options.shape || pickShape(shapes, spec.limits).id,
        rootfs: spec.image,
        name: vmName(spec.sandboxId),
        networks: [{ id: networkId }],
        egress: deriveEgress(spec.env, options.extraEgress ?? []),
        // The label channel, and nothing else. The real env is a file.
        envs: buildLabels({
          sandboxId: spec.sandboxId,
          runnerId: owner,
          installationId: options.installationId,
          payloadHash: spec.payloadHash,
        }),
        ...(options.autoPauseSeconds && {
          auto_pause_after_seconds: options.autoPauseSeconds,
        }),
      };

      let sandbox: Sandbox;
      try {
        sandbox = await client.createSandbox(request);
      } catch (error) {
        // A rootfs the control plane does not know, or a template that failed
        // to build, is exactly the seam's `image_unavailable` — the runner
        // classifies the start failure from this type, never from a message.
        if (error instanceof CreateosSandboxValidationError) {
          // 409 is the per-user unique-name violation and nothing else — the
          // only conflict a create can raise (fc's insertSandboxWithName). It
          // happens when the previous VM for this agent is still winding down.
          // That must not wedge the agent until an operator intervenes: the
          // labels are the real identity, so drop the name and continue.
          if (error.statusCode === 409) {
            log("warn", "CreateOS rejected the VM name; creating unnamed", {
              sandboxId: spec.sandboxId,
              detail: error.message,
            });
            const unnamed: CreateSandboxRequest = { ...request };
            delete unnamed.name;
            sandbox = await client.createSandbox(unnamed);
          } else if (/rootfs|template/i.test(error.message)) {
            throw new ImageUnavailableError(spec.image, error.message);
          } else {
            throw error;
          }
        } else if (error instanceof CreateosSandboxNotFoundError) {
          throw new ImageUnavailableError(spec.image, error.message);
        } else {
          throw error;
        }
      }

      try {
        await exec(sandbox, `mkdir -p ${GUEST_DIR} && chmod 700 ${GUEST_DIR}`, "guest dir");
        // The payload's env, as a file. 0600 and root-owned: it carries the
        // single-use control-channel token and the gateway proxy credential,
        // and the agent runs as `node`.
        await sandbox.files.upload(ENV_FILE, renderEnvFile(spec.env));
        await sandbox.files.upload(START_FILE, startScript());
        await exec(sandbox, `chmod 600 ${ENV_FILE} && chmod 700 ${START_FILE}`, "guest file modes");
        // Files land BEFORE the first start, so the supervisor's very first
        // read already sees the CA — same rule as the Docker backend.
        await putFiles(sandbox, spec.files);
        await restoreHome(sandbox, spec.homeRef);
      } catch (error) {
        // A VM that was created but could not be furnished is not a sandbox,
        // and leaving it running bills for nothing and confuses reconcile.
        await sandbox.destroy().catch((cleanupError: unknown) => {
          log("warn", "failed to destroy a half-provisioned sandbox", {
            sandbox: sandbox.id,
            error: String(cleanupError),
          });
        });
        throw error;
      }

      return sandbox.id;
    },

    async startSandbox(ref) {
      const sandbox = await connect(ref);
      if (!sandbox) throw new Error(`sandbox ${ref} no longer exists`);
      // The template bakes /workspace as node:node (docker/agent.Dockerfile's
      // own rule), but CreateOS's own build-to-rootfs conversion resets it to
      // root:root — confirmed by inspecting a live VM, not assumed. Restoring
      // an archive already re-chowns it (restoreHome); a fresh VM with no
      // archive needs the same fix, so it runs here unconditionally instead
      // of only on the restore path.
      await exec(sandbox, `chown -R ${AGENT_USER}:${AGENT_USER} ${HOME_MOUNT}`, "home ownership");
      // A CreateOS VM is already booted by the time `createSandbox` returns;
      // there is no image ENTRYPOINT to trigger. Starting the sandbox means
      // starting the supervisor, detached — `runCommand` blocks until the
      // process exits, and the supervisor is meant to outlive this call.
      await exec(
        sandbox,
        `setsid ${START_FILE} >/var/log/onecli-agent.log 2>&1 </dev/null & exit 0`,
        "supervisor start",
      );
    },

    async stopSandbox(ref) {
      const sandbox = await connect(ref);
      // Nothing to stop is the desired end state, not an error.
      if (!sandbox) return;
      // Neither is an already-parked VM. The control plane refuses a second
      // pause outright ("409 sandbox is paused, expected running"), and the
      // wake path calls stopSandbox on the very VM it parked earlier, so
      // treating that 409 as a failure makes a parked agent impossible to
      // wake. Its home was already harvested by the pause that parked it.
      if (sandbox.status === "paused") return;
      if (sandbox.status === "running") {
        try {
          await harvestHome(sandbox);
        } catch (error) {
          // A failed harvest costs this agent its most recent files. It must
          // NOT also block the stop: a VM left running holds capacity and
          // keeps a live control channel the control plane thinks is gone.
          log("error", "failed to harvest an agent home before stopping", {
            sandbox: sandbox.id,
            error: String(error),
          });
        }
      }
      try {
        await sandbox.pause();
      } catch (error) {
        if (error instanceof CreateosSandboxNotFoundError) return;
        throw error;
      }
    },

    async removeSandbox(ref) {
      const sandbox = await connect(ref);
      if (!sandbox) return;
      try {
        await sandbox.destroy();
      } catch (error) {
        if (error instanceof CreateosSandboxNotFoundError) return;
        throw error;
      }
    },

    async listSandboxes(): Promise<SandboxSnapshot[]> {
      const views = await managedViews();
      return views.flatMap((view) => {
        const keys = envKeysOf(view);
        // Owner-scoped, matching the Docker backend: this list answers "what
        // am I holding", while `listManaged` answers "what exists here".
        if (decodeLabel(keys, "runner") !== owner) return [];
        const sandboxId = decodeLabel(keys, "sandbox");
        if (!sandboxId) return [];
        return [
          {
            sandboxId,
            containerRef: view.id,
            running: view.status === "running",
            payloadHash: decodeLabel(keys, "payload"),
          },
        ];
      });
    },

    async listManaged(): Promise<ManagedObject[]> {
      // EVERY platform-created object, any runner's label — deliberately not
      // owner-scoped, because a stale-label orphan is by definition someone
      // else's label. Overlay networks are never listed: the network is
      // shared and carries no runner id, exactly as the Docker backend
      // excludes its shared network.
      const views = await managedViews();
      const sandboxes: ManagedObject[] = views.map((view) => {
        const keys = envKeysOf(view);
        const createdMs = Date.parse(view.created_at);
        return {
          kind: "sandbox",
          ref: view.id,
          sandboxId: decodeLabel(keys, "sandbox"),
          runnerId: decodeLabel(keys, "runner"),
          installationId: decodeLabel(keys, "installation"),
          createdAt: Number.isNaN(createdMs) ? null : new Date(createdMs),
        };
      });
      return [...sandboxes, ...(await homes.listManaged())];
    },
  };
};
