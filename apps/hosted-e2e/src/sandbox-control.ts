import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";
import {
  createClient,
  CreateosSandboxApiError,
  CreateosSandboxNotFoundError,
  type Sandbox,
} from "@nodeops-createos/sandbox";
import { fetchWithContentLength, pickShape } from "@onecli/runner/backend/createos";
import { buildLabels, decodeLabel } from "@onecli/runner/backend/createos/labels";
import type { HostedE2EConfig } from "./env.js";
import { containerNameFor, dockerExec, dockerKill, volumeNameFor } from "./docker.js";

const exec = promisify(execFile);

/**
 * Backend-neutral sandbox control for what a TEST must do from OUTSIDE the
 * runner: write a file into a sandbox, probe it's alive, kill one abruptly,
 * or plant a stale-label orphan for the sweep to find. Every export
 * dispatches on `config.backend`; the docker branch is the pre-existing
 * `docker` CLI behavior, unchanged.
 */

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const createosClient = (config: HostedE2EConfig) =>
  createClient({
    baseUrl: config.createos.baseUrl,
    apiKey: config.createos.apiKey,
    fetch: fetchWithContentLength,
  });

/** Find the live CreateOS VM labeled with this platform sandbox id — the
 * env-key label channel labels.ts defines (there is no docker-style name). */
const findCreateosSandbox = async (
  config: HostedE2EConfig,
  sandboxId: string,
): Promise<Sandbox> => {
  const client = createosClient(config);
  const all = await client.listSandboxes();
  const match = all.find(
    (sandbox) => decodeLabel(sandbox.data.envs ?? [], "sandbox") === sandboxId,
  );
  if (!match) {
    throw new Error(`no CreateOS sandbox is labeled with sandbox id ${sandboxId}`);
  }
  return match;
};

/**
 * A CreateOS pause is not instant. A VM caught midway answers every exec with
 * `409 sandbox is pausing; resume first`, and settles a moment later. Docker
 * has no such limbo — a container is up or it is not — so a test written
 * against docker has no reason to expect it. Ride the transient state out
 * rather than making every caller know about it.
 */
const PAUSING_RETRY_MS = 15_000;

const execRidingOutAPause = async (
  sandbox: Sandbox,
  args: string[],
): Promise<{ exit_code: number; stderr: string }> => {
  const deadline = Date.now() + PAUSING_RETRY_MS;
  for (;;) {
    try {
      const { result } = await sandbox.runCommand("sh", args);
      return result;
    } catch (error) {
      const pausing =
        error instanceof CreateosSandboxApiError &&
        error.statusCode === 409 &&
        /pausing/.test(String(error.message));
      if (!pausing || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
};

/** Write a file into a running sandbox — what the memory harvester watches. */
export const writeFileInSandbox = async (
  config: HostedE2EConfig,
  sandboxId: string,
  path: string,
  contents: string,
): Promise<void> => {
  const script = `mkdir -p ${posix.dirname(path)} && printf '%s' ${shellQuote(contents)} > ${path}`;
  if (config.backend === "docker") {
    await dockerExec(containerNameFor(sandboxId), ["sh", "-c", script]);
    return;
  }
  const sandbox = await findCreateosSandbox(config, sandboxId);
  const result = await execRidingOutAPause(sandbox, ["-c", script]);
  if (result.exit_code !== 0) {
    throw new Error(`writeFileInSandbox failed inside ${sandboxId}: ${result.stderr}`);
  }
};

/** Whether a sandbox is up and will run a trivial command right now. */
export const sandboxReachable = async (
  config: HostedE2EConfig,
  sandboxId: string,
): Promise<boolean> => {
  if (config.backend === "docker") {
    return dockerExec(containerNameFor(sandboxId), ["true"]).then(
      () => true,
      () => false,
    );
  }
  try {
    const sandbox = await findCreateosSandbox(config, sandboxId);
    if (sandbox.status !== "running") return false;
    const result = await execRidingOutAPause(sandbox, ["-c", "true"]);
    return result.exit_code === 0;
  } catch {
    return false;
  }
};

/**
 * An abrupt kill — SIGKILL on docker, a hard destroy on CreateOS — never a
 * graceful stop/pause. THROWS if there was nothing to kill: a swallowed
 * failure here would let a "killed mid-turn" test pass without ever killing
 * anything, which is exactly how this test used to pass vacuously.
 */
export const killSandboxHard = async (
  config: HostedE2EConfig,
  sandboxId: string,
): Promise<void> => {
  if (config.backend === "docker") {
    await dockerKill(containerNameFor(sandboxId));
    return;
  }
  const sandbox = await findCreateosSandbox(config, sandboxId);
  await sandbox.destroy();
};

/** One planted stale-label orphan, plus what `orphanExists` needs to find it
 * again after a sweep. */
export interface PlantedOrphan {
  readonly sandboxId: string;
  readonly ref: string;
}

export interface PlantOrphanOptions {
  readonly sandboxId: string;
  readonly runnerId: string;
  readonly installationId: string;
  readonly agentImage: string;
}

/**
 * Plant a fake orphan the way a KILLED prior runner would have left one
 * behind: platform-labeled objects with no live runner attached. Docker gets
 * a created-never-started container plus its home volume, labeled exactly
 * as docker-backend.ts labels a real one. CreateOS gets a REAL sandbox
 * carrying the same env-key label channel createos-backend.ts's own sweep
 * reads (labels.ts) — there is no separate "volume" object to plant there.
 */
export const plantOrphan = async (
  config: HostedE2EConfig,
  opts: PlantOrphanOptions,
): Promise<PlantedOrphan> => {
  if (config.backend === "docker") {
    const container = containerNameFor(opts.sandboxId);
    const volume = volumeNameFor(opts.sandboxId);
    const labels = [
      "--label=sh.onecli.managed=1",
      `--label=sh.onecli.sandbox-id=${opts.sandboxId}`,
      `--label=sh.onecli.runner-id=${opts.runnerId}`,
      `--label=sh.onecli.installation=${opts.installationId}`,
    ];
    await exec("docker", ["volume", "create", ...labels, volume]);
    await exec("docker", ["create", `--name=${container}`, ...labels, opts.agentImage, "true"]);
    return { sandboxId: opts.sandboxId, ref: container };
  }

  const client = createosClient(config);
  const networks = await client.networks.list();
  const networkId =
    networks.find((network) => network.name === config.createos.network)?.id ??
    (await client.networks.create({ name: config.createos.network })).id;
  const shapes = await client.listShapes();
  const sandbox = await client.createSandbox({
    shape: pickShape(shapes, { memoryMb: 256, cpus: 1, pids: 512 }).id,
    networks: [{ id: networkId }],
    envs: buildLabels({
      sandboxId: opts.sandboxId,
      runnerId: opts.runnerId,
      installationId: opts.installationId,
      payloadHash: "orphan",
    }),
  });
  return { sandboxId: opts.sandboxId, ref: sandbox.id };
};

/** Whether a planted orphan (docker: container OR its home volume; createos:
 * the VM) is still present — false only once every part of it is gone. */
export const orphanExists = async (
  config: HostedE2EConfig,
  orphan: PlantedOrphan,
): Promise<boolean> => {
  if (config.backend === "docker") {
    const containerGone = await exec("docker", ["inspect", orphan.ref]).then(
      () => false,
      () => true,
    );
    const volumeGone = await exec("docker", [
      "volume",
      "inspect",
      volumeNameFor(orphan.sandboxId),
    ]).then(
      () => false,
      () => true,
    );
    return !(containerGone && volumeGone);
  }
  const client = createosClient(config);
  try {
    const sandbox = await client.getSandbox(orphan.ref);
    return (
      sandbox.status !== "destroyed" &&
      sandbox.status !== "destroying" &&
      sandbox.status !== "failed"
    );
  } catch (error) {
    if (error instanceof CreateosSandboxNotFoundError) return false;
    throw error;
  }
};
