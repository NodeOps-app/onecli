import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { HomeRef, ManagedObject } from "../types";

/**
 * THE HOME STORE for the CreateOS backend (§3.9).
 *
 * A CreateOS VM is disposable in a way a Docker container is not. The runner
 * already destroys and recreates the sandbox on EVERY start, not only after a
 * park — the WebSocket bootstrap token is single-use, so a VM that connected
 * once can never authenticate again (runner.ts:278). CreateOS cannot patch a
 * sandbox's env after create either, so there is no way to hand a live VM a
 * fresh token. Every start is therefore a new VM, and the agent's files have
 * to live somewhere the VM is not.
 *
 * That somewhere is this directory, on the runner's own filesystem, holding
 * one compressed archive per agent. The backend restores it into a fresh VM
 * at create and harvests it back at stop.
 *
 * Deployment note, not a code concern: the runner's own disk must be durable.
 * A redeploy of the runner recreates the runner's VM too, and without a
 * mounted disk under this path that single event erases every agent's home at
 * once. The runner sandbox mounts an S3-backed CreateOS disk here.
 *
 * Why an archive rather than a file sync: CreateOS's `push`/`upload` is the
 * same `PUT /v1/sandboxes/:id/files` call the SDK makes, so it is this, and
 * its own help recommends piping tar for a directory. The CLI's `sb sync` is
 * a different tool — it installs an SSH key, starts sshd in the guest, and
 * runs mutagen as a live two-way daemon. That needs an SSH door into a VM
 * running untrusted model output, a mutagen binary on the runner, and it
 * mirrors continuously where the runner needs one capture at stop.
 *
 * ponytail: one archive per agent on a local path. Direct S3 object writes
 * become worth it at a second concurrent runner — two runners cannot safely
 * share one filesystem, while one object per agent has no such conflict.
 */

/** Sidecar identity file. The filesystem cannot hold the labels the sweep needs. */
const META_FILE = "meta.json";
/** The harvested archive. Absent until the agent's first stop. */
export const ARCHIVE_FILE = "home.tar.zst";

interface HomeMeta {
  sandboxId: string;
  runnerId: string;
  installationId: string;
  /** RFC 3339. The sweep refuses to reap what it cannot age. */
  createdAt: string;
}

export interface HomeStore {
  provision(
    sandboxId: string,
    owner: { runnerId: string; installationId: string },
  ): Promise<HomeRef>;
  destroy(ref: HomeRef): Promise<void>;
  list(): Promise<Array<{ sandboxId: string; ref: HomeRef }>>;
  listManaged(): Promise<ManagedObject[]>;
  /** The stored archive, or null when this agent has never been stopped. */
  readArchive(ref: HomeRef): Promise<Buffer | null>;
  writeArchive(ref: HomeRef, bytes: Buffer): Promise<void>;
  /** The home directory for a sandbox id, whether or not it exists yet. */
  refFor(sandboxId: string): HomeRef;
}

const readMeta = async (directory: string): Promise<HomeMeta | null> => {
  try {
    const raw = await readFile(join(directory, META_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const meta = parsed as Partial<HomeMeta>;
    if (!meta.sandboxId) return null;
    return {
      sandboxId: meta.sandboxId,
      runnerId: meta.runnerId ?? "",
      installationId: meta.installationId ?? "",
      createdAt: meta.createdAt ?? "",
    };
  } catch {
    // A home with no readable identity is never reaped, so an unreadable
    // meta file is reported as absent rather than raised.
    return null;
  }
};

export const createHomeStore = (root: string): HomeStore => {
  const refFor = (sandboxId: string): HomeRef => join(root, sandboxId);

  const directories = async (): Promise<string[]> => {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      // The root is created on first provision; an absent root simply holds
      // no homes yet.
      return [];
    }
  };

  return {
    refFor,

    async provision(sandboxId, owner) {
      const ref = refFor(sandboxId);
      await mkdir(ref, { recursive: true });
      const meta: HomeMeta = {
        sandboxId,
        runnerId: owner.runnerId,
        installationId: owner.installationId,
        createdAt: new Date().toISOString(),
      };
      // Only on first provision. Rewriting it on every start would reset
      // createdAt, and the sweep's grace period would never elapse.
      const existing = await readMeta(ref);
      if (!existing) {
        await writeFile(join(ref, META_FILE), JSON.stringify(meta), {
          mode: 0o600,
        });
      }
      return ref;
    },

    async destroy(ref) {
      await rm(ref, { recursive: true, force: true });
    },

    async list() {
      const names = await directories();
      const homes = await Promise.all(
        names.map(async (name) => {
          const meta = await readMeta(join(root, name));
          return meta ? { sandboxId: meta.sandboxId, ref: join(root, name) } : null;
        }),
      );
      return homes.filter((home): home is { sandboxId: string; ref: HomeRef } => home !== null);
    },

    async listManaged() {
      const names = await directories();
      const objects = await Promise.all(
        names.map(async (name) => {
          const directory = join(root, name);
          const meta = await readMeta(directory);
          const createdMs = meta?.createdAt ? Date.parse(meta.createdAt) : NaN;
          return {
            kind: "home",
            ref: directory,
            sandboxId: meta?.sandboxId ?? null,
            runnerId: meta?.runnerId || null,
            installationId: meta?.installationId || null,
            createdAt: Number.isNaN(createdMs) ? null : new Date(createdMs),
          } satisfies ManagedObject;
        }),
      );
      return objects;
    },

    async readArchive(ref) {
      try {
        return await readFile(join(ref, ARCHIVE_FILE));
      } catch {
        return null;
      }
    },

    async writeArchive(ref, bytes) {
      await mkdir(ref, { recursive: true });
      // Written beside the live archive and renamed, so a crash mid-write
      // leaves the previous home intact rather than a truncated one.
      const temporary = join(ref, `${ARCHIVE_FILE}.partial`);
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, join(ref, ARCHIVE_FILE));
    },
  };
};

/** Bytes currently stored for a home, for logging. Zero when absent. */
export const archiveSize = async (ref: HomeRef): Promise<number> => {
  try {
    return (await stat(join(ref, ARCHIVE_FILE))).size;
  } catch {
    return 0;
  }
};
