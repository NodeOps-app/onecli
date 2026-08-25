import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CreateosSandboxApiError,
  CreateosSandboxNotFoundError,
  CreateosSandboxValidationError,
  type CreateosSandboxClient,
  type CreateSandboxRequest,
  type Sandbox,
  type SandboxView,
  type Shape,
} from "@nodeops-createos/sandbox";
import { ImageUnavailableError, type SandboxSpec } from "../types";
import {
  createCreateosBackend,
  deriveEgress,
  MAX_ARCHIVE_BYTES,
  pickShape,
  renderEnvFile,
} from "./createos-backend";
import { buildLabels, decodeLabel, MANAGED_KEY } from "./labels";

/**
 * The CreateOS backend against a modelled control plane.
 *
 * The fake is deliberately not a stub that returns 0 for everything: it
 * models the two behaviours the backend's correctness actually rests on —
 * that `envs` comes back as KEYS only (the label channel), and that a VM's
 * files do not survive its destruction (the reason a home store exists).
 * A tar in moves bytes into the VM's home; a tar out moves them back.
 */

const SHAPES: Shape[] = [
  { id: "s-1vcpu-256mb", vcpu: 1, mem_mib: 256, default_disk_mib: 1024 },
  { id: "s-1vcpu-2gb", vcpu: 1, mem_mib: 2048, default_disk_mib: 4096 },
  { id: "s-4vcpu-8gb", vcpu: 4, mem_mib: 8192, default_disk_mib: 8192 },
];

const ARCHIVE_PATH = "/tmp/onecli-home.tar.zst";

/**
 * The SDK's error classes carry the real `Response` so callers can branch on
 * a status code, which is exactly what the backend does for a name conflict.
 */
const apiError = <T extends CreateosSandboxApiError>(
  Kind: new (message: string, response: Response) => T,
  status: number,
  message: string,
): T => new Kind(message, new Response(null, { status }));

interface FakeVm {
  view: SandboxView;
  /** Absolute guest path → contents. Dies with the VM, like a real one. */
  files: Map<string, Buffer>;
  /** What `/workspace` holds. Only tar moves it in or out. */
  home: Buffer | null;
  commands: string[];
}

const createFakeClient = () => {
  const vms = new Map<string, FakeVm>();
  const networks: Array<{ id: string; name: string; created_at: string }> = [];
  let counter = 0;
  /** Set by a test to make the next createSandbox throw. */
  let createFailure: Error | null = null;

  const handle = (vm: FakeVm): Sandbox => {
    const sandbox = {
      get id() {
        return vm.view.id;
      },
      get status() {
        return vm.view.status;
      },
      get data() {
        return vm.view;
      },
      files: {
        async upload(path: string, data: BodyInit) {
          const bytes =
            typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data as Uint8Array);
          vm.files.set(path, bytes);
        },
        async download(path: string) {
          const found = vm.files.get(path);
          if (!found) {
            throw apiError(CreateosSandboxNotFoundError, 404, `no such file: ${path}`);
          }
          return found.buffer.slice(
            found.byteOffset,
            found.byteOffset + found.byteLength,
          ) as ArrayBuffer;
        },
      },
      async runCommand(cmd: string, args: string[]) {
        // The real control plane rejects every exec against a paused VM.
        // Modelling it is the only way a test can catch a wake path that
        // forgets to resume first.
        if (vm.view.status === "paused") {
          throw apiError(
            CreateosSandboxValidationError,
            409,
            "sandbox is paused, expected running",
          );
        }
        const script = args[args.length - 1] ?? "";
        vm.commands.push(script);
        // Model the only two commands whose EFFECT the backend depends on.
        if (script.includes("tar -x")) {
          vm.home = vm.files.get(ARCHIVE_PATH) ?? null;
        }
        if (script.includes("tar -c")) {
          if (!vm.home) {
            return {
              result: { stdout: "", stderr: "", exit_code: 0 },
              exec_ms: 1,
            };
          }
          vm.files.set(ARCHIVE_PATH, vm.home);
        }
        return { result: { stdout: "", stderr: "", exit_code: 0 }, exec_ms: 1 };
      },
      async pause() {
        vm.view = { ...vm.view, status: "paused" };
        return sandbox;
      },
      async resume() {
        vm.view = { ...vm.view, status: "running" };
        return sandbox;
      },
      async destroy() {
        vm.view = { ...vm.view, status: "destroyed" };
        // The whole VM goes, files included. This is the point.
        vm.files.clear();
        vm.home = null;
        return { id: vm.view.id, status: "destroyed" as const };
      },
    };
    return sandbox as unknown as Sandbox;
  };

  const client = {
    async whoami() {
      return { user_id: "u_test" };
    },
    async listShapes() {
      return SHAPES;
    },
    networks: {
      async list() {
        return networks;
      },
      async create({ name }: { name: string }) {
        const network = {
          id: `net_${networks.length + 1}`,
          name,
          created_at: new Date().toISOString(),
        };
        networks.push(network);
        return network;
      },
    },
    async createSandbox(request: CreateSandboxRequest) {
      if (createFailure) {
        const planted = createFailure;
        createFailure = null;
        throw planted;
      }
      counter += 1;
      const id = `sb_${counter}`;
      const vm: FakeVm = {
        view: {
          id,
          status: "running",
          ingress_enabled: false,
          vcpu: 1,
          mem_mib: 2048,
          disk_mib: 4096,
          created_at: new Date().toISOString(),
          ...(request.name && { name: request.name }),
          egress: request.egress ?? [],
          // The control plane returns env KEYS, never values.
          envs: Object.keys(request.envs ?? {}),
          rootfs: request.rootfs ?? "",
          shape: request.shape,
        },
        files: new Map(),
        home: null,
        commands: [],
      };
      vms.set(id, vm);
      return handle(vm);
    },
    async getSandbox(id: string) {
      const vm = vms.get(id);
      if (!vm) throw apiError(CreateosSandboxNotFoundError, 404, `no sandbox ${id}`);
      return handle(vm);
    },
    async listSandboxes() {
      return [...vms.values()].map(handle);
    },
  };

  return {
    client: client as unknown as CreateosSandboxClient,
    vms,
    networks,
    failNextCreate(error: Error) {
      createFailure = error;
    },
  };
};

const spec = (overrides: Partial<SandboxSpec> = {}): SandboxSpec => ({
  sandboxId: "11111111-2222-3333-4444-555555555555",
  image: "onecli-agent-template",
  env: {
    HTTPS_PROXY: "http://x:aoc_token@gateway.example.com:10255",
    RUNNER_WS_URL: "ws://10.0.4.92:10256",
    SANDBOX_WS_TOKEN: "single-use",
  },
  files: [{ containerPath: "/tmp/ca.pem", content: "CERT", mode: 0o600 }],
  homeRef: "",
  limits: { memoryMb: 2048, cpus: 1, pids: 512 },
  payloadHash: "hash-one",
  ...overrides,
});

describe("labels", () => {
  it("round-trips every value through the env-key channel", () => {
    const labels = buildLabels({
      sandboxId: "11111111-2222-3333-4444-555555555555",
      runnerId: "runner-a",
      installationId: "inst-a",
      payloadHash: "hash-one",
    });
    const keys = Object.keys(labels);

    expect(keys).toContain(MANAGED_KEY);
    expect(decodeLabel(keys, "sandbox")).toBe("11111111-2222-3333-4444-555555555555");
    expect(decodeLabel(keys, "runner")).toBe("runner-a");
    expect(decodeLabel(keys, "installation")).toBe("inst-a");
    expect(decodeLabel(keys, "payload")).toBe("hash-one");
  });

  it("survives the env-key character rule", () => {
    // fc's envKeyRe. A uuid's hyphens are why the values are hex-encoded.
    const keys = Object.keys(
      buildLabels({
        sandboxId: "11111111-2222-3333-4444-555555555555",
        runnerId: "r-1",
        installationId: "i-1",
        payloadHash: "h-1",
      }),
    );
    for (const key of keys) expect(key).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  });

  it("reports an unreadable label as absent, never as a guess", () => {
    expect(decodeLabel(["ONECLI_SBX_zznothex"], "sandbox")).toBeNull();
    expect(decodeLabel([], "sandbox")).toBeNull();
  });
});

describe("deriveEgress", () => {
  const WS = "ws://10.0.4.92:10256";

  it("pins the allowlist to the gateway from the payload", () => {
    expect(
      deriveEgress({ HTTPS_PROXY: "http://x:tok@gateway.example.com:10255", RUNNER_WS_URL: WS }),
    ).toEqual(["gateway.example.com:10255", "10.0.4.92:10256"]);
  });

  it("defaults the port from the scheme", () => {
    expect(
      deriveEgress({
        HTTPS_PROXY: "https://gw.example.com",
        RUNNER_WS_URL: "wss://ctl.example.com",
      }),
    ).toEqual(["gw.example.com:443", "ctl.example.com:443"]);
  });

  it("refuses a payload with no proxy rather than allowing all egress", () => {
    expect(() => deriveEgress({ RUNNER_WS_URL: WS })).toThrow(/unrestricted egress/);
  });

  // The overlay does not bypass the egress chain: without this rule the
  // sandbox boots and silently never reaches the runner.
  it("refuses a payload with no control-channel URL", () => {
    expect(() => deriveEgress({ HTTPS_PROXY: "http://gw:1" })).toThrow(/RUNNER_WS_URL/);
  });

  it("refuses a wildcard rule, which CreateOS reads as allow-all", () => {
    expect(() => deriveEgress({ HTTPS_PROXY: "http://gw:1", RUNNER_WS_URL: WS }, ["*"])).toThrow(
      /allow-all/,
    );
  });
});

describe("pickShape", () => {
  it("picks the smallest shape that meets the configured limits", () => {
    expect(pickShape(SHAPES, { memoryMb: 2048, cpus: 1, pids: 0 }).id).toBe("s-1vcpu-2gb");
    expect(pickShape(SHAPES, { memoryMb: 128, cpus: 1, pids: 0 }).id).toBe("s-1vcpu-256mb");
  });

  it("falls back to the largest shape rather than failing the start", () => {
    expect(pickShape(SHAPES, { memoryMb: 999_999, cpus: 1, pids: 0 }).id).toBe("s-4vcpu-8gb");
  });
});

describe("renderEnvFile", () => {
  it("quotes values so a shell sources them verbatim", () => {
    expect(renderEnvFile({ A: "it's here" })).toBe(`A='it'\\''s here'\n`);
  });

  it("refuses a name a shell would not accept", () => {
    expect(() => renderEnvFile({ "BAD-NAME": "x" })).toThrow(/POSIX identifier/);
  });
});

describe("createos backend", () => {
  let homesDir: string;
  let fake: ReturnType<typeof createFakeClient>;

  const backendFor = () =>
    createCreateosBackend({
      runnerId: "boot-id",
      installationId: "inst-a",
      baseUrl: "http://control",
      apiKey: "key",
      network: "onecli-sandboxes",
      homesDir,
      client: fake.client,
    });

  beforeEach(async () => {
    homesDir = await mkdtemp(join(tmpdir(), "onecli-homes-"));
    fake = createFakeClient();
  });

  afterEach(async () => {
    await rm(homesDir, { recursive: true, force: true });
  });

  it("creates the overlay network once and reuses it", async () => {
    const backend = backendFor();
    await backend.prepare();
    await backend.prepare();
    expect(fake.networks).toHaveLength(1);
    expect(fake.networks[0]?.name).toBe("onecli-sandboxes");
  });

  it("labels a sandbox so it can be found again", async () => {
    const backend = backendFor();
    await backend.prepare();
    backend.identify("runner-a");
    const home = await backend.provisionHome(spec().sandboxId);
    const ref = await backend.createSandbox(spec({ homeRef: home }));

    const snapshots = await backend.listSandboxes();
    expect(snapshots).toEqual([
      {
        sandboxId: spec().sandboxId,
        containerRef: ref,
        running: true,
        payloadHash: "hash-one",
      },
    ]);
  });

  it("hides another runner's sandboxes from the owned list", async () => {
    const backend = backendFor();
    await backend.prepare();
    backend.identify("runner-a");
    await backend.createSandbox(spec({ homeRef: await backend.provisionHome(spec().sandboxId) }));

    const other = backendFor();
    await other.prepare();
    other.identify("runner-b");
    expect(await other.listSandboxes()).toEqual([]);
    // But the sweep still sees it, which is how a stale label is reaped.
    const managed = await other.listManaged();
    expect(managed.some((object) => object.runnerId === "runner-a")).toBe(true);
  });

  it("pins egress to the gateway and joins the overlay", async () => {
    const backend = backendFor();
    await backend.prepare();
    backend.identify("runner-a");
    const ref = await backend.createSandbox(
      spec({ homeRef: await backend.provisionHome(spec().sandboxId) }),
    );

    const view = fake.vms.get(ref)!.view;
    expect(view.egress).toEqual(["gateway.example.com:10255", "10.0.4.92:10256"]);
  });

  it("keeps the single-use token out of the CreateOS env map", async () => {
    const backend = backendFor();
    await backend.prepare();
    backend.identify("runner-a");
    const ref = await backend.createSandbox(
      spec({ homeRef: await backend.provisionHome(spec().sandboxId) }),
    );

    const vm = fake.vms.get(ref)!;
    // The label channel only. The real env is a file inside the guest.
    expect(vm.view.envs?.some((key) => key.includes("SANDBOX_WS_TOKEN"))).toBe(false);
    const envFile = vm.files.get("/etc/onecli/agent.env")!.toString("utf8");
    expect(envFile).toContain("SANDBOX_WS_TOKEN='single-use'");
  });

  it("re-asserts /workspace ownership on every start, not only on restore", async () => {
    // CreateOS's own build-to-rootfs conversion resets /workspace to
    // root:root regardless of what the template baked in — found by
    // inspecting a live VM, not assumed. startSandbox must fix this even
    // when there is no archive to restore (an agent's first-ever start).
    const backend = backendFor();
    await backend.prepare();
    backend.identify("runner-a");
    const ref = await backend.createSandbox(
      spec({ homeRef: await backend.provisionHome(spec().sandboxId) }),
    );
    await backend.startSandbox(ref);
    expect(
      fake.vms.get(ref)!.commands.some((cmd) => /chown -R node:node \/workspace/.test(cmd)),
    ).toBe(true);
  });

  it("resumes a parked VM before starting it again", async () => {
    // stopSandbox parks a VM by pausing it. A wake then arrives with a paused
    // VM, and the real control plane 409s every exec against one. Without a
    // resume, the whole sleep-wake path fails.
    const backend = backendFor();
    await backend.prepare();
    backend.identify("runner-a");
    const ref = await backend.createSandbox(
      spec({ homeRef: await backend.provisionHome(spec().sandboxId) }),
    );
    await backend.startSandbox(ref);
    await backend.stopSandbox(ref);
    expect(fake.vms.get(ref)!.view.status).toBe("paused");

    await expect(backend.startSandbox(ref)).resolves.toBeUndefined();
    expect(fake.vms.get(ref)!.view.status).toBe("running");
  });

  it("carries the home across the destroy-and-recreate every start does", async () => {
    const backend = backendFor();
    await backend.prepare();
    backend.identify("runner-a");
    const sandboxId = spec().sandboxId;
    const home = await backend.provisionHome(sandboxId);

    const first = await backend.createSandbox(spec({ homeRef: home }));
    // The agent works: something lands in /workspace.
    fake.vms.get(first)!.home = Buffer.from("the agent's files");

    // The start path: stop, remove, create again.
    await backend.stopSandbox(first);
    await backend.removeSandbox(first);
    expect(fake.vms.get(first)!.home).toBeNull();

    const second = await backend.createSandbox(spec({ homeRef: home, payloadHash: "hash-two" }));
    expect(fake.vms.get(second)!.home?.toString("utf8")).toBe("the agent's files");
    expect(second).not.toBe(first);
  });

  it("stops the sandbox even when the home cannot be harvested", async () => {
    const backend = backendFor();
    await backend.prepare();
    backend.identify("runner-a");
    const ref = await backend.createSandbox(
      spec({ homeRef: await backend.provisionHome(spec().sandboxId) }),
    );
    const vm = fake.vms.get(ref)!;
    vm.home = Buffer.from("files");
    // A harvest that cannot run must not leave a live VM behind.
    vm.files.delete(ARCHIVE_PATH);
    const original = vm.files.set.bind(vm.files);
    vm.files.set = (path: string, bytes: Buffer) =>
      path === ARCHIVE_PATH ? vm.files : original(path, bytes);

    await backend.stopSandbox(ref);
    expect(vm.view.status).toBe("paused");
  });

  it("keeps the last good home when a new one is too big to ever restore", async () => {
    const backend = backendFor();
    await backend.prepare();
    backend.identify("runner-a");
    const home = await backend.provisionHome(spec().sandboxId);

    const first = await backend.createSandbox(spec({ homeRef: home }));
    fake.vms.get(first)!.home = Buffer.from("small and restorable");
    await backend.stopSandbox(first);
    await backend.removeSandbox(first);

    const second = await backend.createSandbox(spec({ homeRef: home }));
    // Past the files endpoint's BodyLimit: storing it would break every
    // future start of this agent AND destroy the archive that still works.
    fake.vms.get(second)!.home = Buffer.alloc(MAX_ARCHIVE_BYTES + 1, 7);
    await backend.stopSandbox(second);
    await backend.removeSandbox(second);

    const third = await backend.createSandbox(spec({ homeRef: home }));
    expect(fake.vms.get(third)!.home?.toString("utf8")).toBe("small and restorable");
  });

  it("treats a vanished sandbox as already stopped", async () => {
    const backend = backendFor();
    await backend.prepare();
    await expect(backend.stopSandbox("sb_gone")).resolves.toBeUndefined();
    await expect(backend.removeSandbox("sb_gone")).resolves.toBeUndefined();
  });

  it("classifies an unknown template as an unavailable image", async () => {
    const backend = backendFor();
    await backend.prepare();
    backend.identify("runner-a");
    fake.failNextCreate(
      apiError(CreateosSandboxValidationError, 400, "unknown rootfs: no-such-template"),
    );
    await expect(
      backend.createSandbox(spec({ homeRef: await backend.provisionHome(spec().sandboxId) })),
    ).rejects.toBeInstanceOf(ImageUnavailableError);
  });

  it("retries without a name when the name is taken", async () => {
    const backend = backendFor();
    await backend.prepare();
    backend.identify("runner-a");
    // 409 is fc's per-user unique-name violation.
    fake.failNextCreate(apiError(CreateosSandboxValidationError, 409, "name already in use"));
    const ref = await backend.createSandbox(
      spec({ homeRef: await backend.provisionHome(spec().sandboxId) }),
    );
    expect(fake.vms.get(ref)!.view.name).toBeUndefined();
  });

  it("destroys a VM it could not finish furnishing", async () => {
    const backend = backendFor();
    await backend.prepare();
    backend.identify("runner-a");
    await expect(
      backend.createSandbox(
        spec({
          homeRef: await backend.provisionHome(spec().sandboxId),
          env: { HTTPS_PROXY: "http://gw:1", RUNNER_WS_URL: "ws://gw:2", "BAD-NAME": "x" },
        }),
      ),
    ).rejects.toThrow(/POSIX identifier/);
    // Every VM the attempt created is gone, not left running and billing.
    for (const vm of fake.vms.values()) {
      expect(vm.view.status).toBe("destroyed");
    }
  });

  it("reports homes to the sweep with an identity and an age", async () => {
    const backend = backendFor();
    await backend.prepare();
    backend.identify("runner-a");
    await backend.provisionHome("home-only");

    const homes = (await backend.listManaged()).filter((object) => object.kind === "home");
    expect(homes).toHaveLength(1);
    expect(homes[0]?.sandboxId).toBe("home-only");
    expect(homes[0]?.runnerId).toBe("runner-a");
    expect(homes[0]?.installationId).toBe("inst-a");
    expect(homes[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("forgets a destroyed home", async () => {
    const backend = backendFor();
    await backend.prepare();
    backend.identify("runner-a");
    const ref = await backend.provisionHome("gone-soon");
    expect(await backend.listHomes()).toHaveLength(1);
    await backend.destroyHome(ref);
    expect(await backend.listHomes()).toEqual([]);
  });
});
