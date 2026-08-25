import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RunnerEvent,
  RunnerWorkItem,
  SandboxStartPayload,
  WorkItem,
} from "@onecli/agent-protocol";
import type { RunnerConfig } from "./config";
import type { ControlPlaneClient } from "./control-plane";
import { ImageUnavailableError } from "./backend/types";
import { createFakeBackend, type FakeBackend } from "./backend/fake";
import { createRunner, payloadHash, type Runner } from "./runner";
import type { RunnerWsServer } from "./ws/server";

/**
 * The runner loop against the fake backend — no daemon, no images, no
 * privileges. These are the laws that decide whether an agent's computer
 * behaves: start/stop, recreate-vs-restart on a credential change, capacity,
 * failure reporting, and reconcile (which IS the teardown path).
 */

const config: RunnerConfig = {
  token: "rnr_test",
  controlPlaneUrl: "http://localhost:10256",
  name: "test runner",
  backend: "fake",
  agentImage: "onecli-agent:test",
  sandboxNetwork: "onecli-sandboxes",
  networkInternal: true,
  wsPort: 8484,
  advertisedHost: "runner",
  maxSandboxes: 2,
  limits: { memoryMb: 1024, cpus: 1, pids: 256 },
  reconcileSeconds: 60,
  dockerSocket: "/var/run/docker.sock",
  sandboxExtraHosts: [],
  orphanReap: true,
  orphanGraceSeconds: 3600,
  createos: {
    baseUrl: "",
    apiKey: "",
    network: "onecli-sandboxes",
    homesDir: "/var/lib/onecli/homes",
    shape: "",
    extraEgress: [],
    autoPauseSeconds: 0,
  },
};

const payload = (overrides: Partial<SandboxStartPayload> = {}): SandboxStartPayload => ({
  env: {
    HTTPS_PROXY: "http://x:aoc_token@gateway:10255",
    ANTHROPIC_API_KEY: "placeholder",
  },
  files: [{ containerPath: "/tmp/onecli-gateway-ca.pem", content: "PEM-BODY" }],
  model: "claude-opus-5",
  harness: "jcode",
  instructions: "Be useful.",
  agentName: "Ada",
  warnings: [],
  ...overrides,
});

const startItem = (
  sandboxId = "sb-1",
  overrides: Partial<SandboxStartPayload> = {},
): RunnerWorkItem => ({
  kind: "sandbox.start",
  sandboxId,
  agentId: "ag-1",
  payload: payload(overrides),
});

let backend: FakeBackend;
let posted: RunnerEvent[];
let queued: RunnerWorkItem[];
let expectedSandboxIds: string[];
let issuedTokens: string[];
/** sandboxId → what the runner pushed down its control channel. */
let delivered: Map<string, WorkItem[]>;
/** Sandboxes with a live channel; anything else has no connection. */
let connected: Set<string>;
let controlPlane: ControlPlaneClient;
let wsServer: RunnerWsServer;
let runner: Runner;

beforeEach(() => {
  backend = createFakeBackend();
  posted = [];
  queued = [];
  expectedSandboxIds = [];
  issuedTokens = [];
  delivered = new Map();
  connected = new Set();

  controlPlane = {
    register: async () => ({ runnerId: "r-1" }),
    pollWork: async () => queued.splice(0, queued.length),
    postEvents: async (events) => {
      posted.push(...events);
    },
    heartbeat: async () => {},
    listSandboxIds: async () => expectedSandboxIds,
    // Default: everything asked about exists (nothing is an orphan), so the
    // sweep is inert unless a test arms it. orphan-sweep.test.ts overrides.
    checkSandboxIds: async () => [],
    toolCall: async () => ({ ok: true, result: null }),
    memoryWrite: async () => ({ ok: true }),
    fetchAttachment: async () => Buffer.alloc(0),
  };

  wsServer = {
    issueToken: (sandboxId) => {
      const token = `boot-${sandboxId}-${issuedTokens.length}`;
      issuedTokens.push(token);
      return token;
    },
    revokeToken: () => {},
    awaitingConnection: () => false,
    connection: (sandboxId) =>
      connected.has(sandboxId)
        ? {
            sandboxId,
            send: (item: WorkItem) => {
              delivered.set(sandboxId, [...(delivered.get(sandboxId) ?? []), item]);
            },
          }
        : undefined,
    listen: async () => {},
    close: async () => {},
  };

  runner = createRunner({ config, backend, controlPlane, wsServer });
});

describe("start", () => {
  it("provisions a home, creates the container, and starts it", async () => {
    queued.push(startItem());
    await runner.tick(0);

    const record = backend.sandboxes.get("sb-1");
    expect(record?.running).toBe(true);
    expect(record?.spec.homeRef).toBe("fake-home-sb-1");
    expect(record?.spec.image).toBe("onecli-agent:test");
    expect(record?.spec.limits).toEqual(config.limits);
  });

  it("delivers the CA file into the sandbox, never as a mount", async () => {
    queued.push(startItem());
    await runner.tick(0);

    expect(backend.sandboxes.get("sb-1")?.spec.files).toEqual([
      { containerPath: "/tmp/onecli-gateway-ca.pem", content: "PEM-BODY" },
    ]);
  });

  it("passes the agent's model, harness, brief and NAME as environment", async () => {
    // The name rides along because the sandbox states its own identity — an
    // unnamed agent falls back on whatever the harness calls itself.
    queued.push(startItem());
    await runner.tick(0);

    expect(backend.sandboxes.get("sb-1")?.spec.env).toMatchObject({
      AGENT_MODEL: "claude-opus-5",
      AGENT_HARNESS: "jcode",
      AGENT_INSTRUCTIONS: "Be useful.",
      AGENT_NAME: "Ada",
    });
  });

  it("gives the sandbox a single-use control-channel token and its runner URL", async () => {
    queued.push(startItem());
    await runner.tick(0);

    const env = backend.sandboxes.get("sb-1")?.spec.env ?? {};
    expect(env.RUNNER_WS_URL).toBe("ws://runner:8484");
    expect(env.SANDBOX_WS_TOKEN).toBe(issuedTokens[0]);
    expect(env.SANDBOX_ID).toBe("sb-1");
  });

  it("reports starting with the refs, and NOT running (that is the supervisor's word)", async () => {
    queued.push(startItem());
    await runner.tick(0);

    expect(posted.map((event) => event.kind)).toEqual(["sandbox.status", "sandbox.status"]);
    expect(posted.every((event) => "status" in event && event.status === "starting")).toBe(true);
    expect(posted.some((event) => "containerRef" in event && event.containerRef)).toBe(true);
  });

  it("reports failed when the backend cannot create the container", async () => {
    backend.failNext("create");
    queued.push(startItem());
    await runner.tick(0);

    const last = posted.at(-1);
    expect(last).toMatchObject({
      kind: "sandbox.status",
      status: "failed",
      // The generic classification — the control plane's copy map treats
      // anything it does not recognize the same way.
      reasonCode: "start_failed",
    });
  });

  it("classifies a missing image as image_unavailable", async () => {
    backend.failNext(
      "create",
      new ImageUnavailableError("onecli-agent:test", "pull failed: not found"),
    );
    queued.push(startItem());
    await runner.tick(0);

    expect(posted.at(-1)).toMatchObject({
      kind: "sandbox.status",
      status: "failed",
      reasonCode: "image_unavailable",
    });
  });

  it("reports failed — not a crashed tick — when the daemon dies before create", async () => {
    // The pre-try hole this guards: `listSandboxes` used to run OUTSIDE the
    // failure reporting, so a dead daemon threw out of the whole tick,
    // nothing was posted, and the sandbox sat `starting` until the 300s
    // stale claim instead of `failed` with a reason.
    backend.failNext("list", new Error("connect ENOENT /var/run/docker.sock"));
    queued.push(startItem());
    await runner.tick(0);

    expect(posted.at(-1)).toMatchObject({
      kind: "sandbox.status",
      sandboxId: "sb-1",
      status: "failed",
      reasonCode: "start_failed",
    });
  });

  it("refuses to exceed its concurrent-sandbox cap", async () => {
    queued.push(startItem("sb-1"), startItem("sb-2"));
    await runner.tick(0);
    posted.length = 0;

    queued.push(startItem("sb-3"));
    await runner.tick(0);

    expect(posted.at(-1)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("capacity"),
      reasonCode: "at_capacity",
    });
    expect(backend.sandboxes.has("sb-3")).toBe(false);
  });
});

describe("every start hands the sandbox a live control-channel credential", () => {
  it("RECREATES a parked container on wake, with a fresh bootstrap token", async () => {
    // The token is single-use and baked into the container's environment, so
    // restarting the same container would leave a sandbox that runs but can
    // never authenticate — and the control plane would re-dispatch it forever.
    queued.push(startItem());
    await runner.tick(0);
    const firstRef = backend.sandboxes.get("sb-1")?.containerRef;
    const firstToken = backend.sandboxes.get("sb-1")?.spec.env.SANDBOX_WS_TOKEN;

    await backend.stopSandbox(firstRef!);
    queued.push(startItem());
    await runner.tick(0);

    const record = backend.sandboxes.get("sb-1");
    expect(record?.containerRef).not.toBe(firstRef);
    expect(record?.spec.env.SANDBOX_WS_TOKEN).not.toBe(firstToken);
    expect(record?.running).toBe(true);
  });

  it("recreates the container when the payload changed (a rotated token)", async () => {
    queued.push(startItem());
    await runner.tick(0);
    const firstRef = backend.sandboxes.get("sb-1")?.containerRef;

    queued.push(
      startItem("sb-1", {
        env: {
          HTTPS_PROXY: "http://x:aoc_ROTATED@gateway:10255",
          ANTHROPIC_API_KEY: "placeholder",
        },
      }),
    );
    await runner.tick(0);

    expect(backend.sandboxes.get("sb-1")?.containerRef).not.toBe(firstRef);
    expect(backend.sandboxes.get("sb-1")?.spec.env.HTTPS_PROXY).toContain("aoc_ROTATED");
  });

  it("keeps the SAME home across a recreate (the durable disk)", async () => {
    queued.push(startItem());
    await runner.tick(0);

    queued.push(startItem("sb-1", { instructions: "Changed brief." }));
    await runner.tick(0);

    expect(backend.sandboxes.get("sb-1")?.spec.homeRef).toBe("fake-home-sb-1");
    expect(backend.homes.size).toBe(1);
  });

  it("hashes payloads stably regardless of key order", () => {
    const a = payload({ env: { A: "1", B: "2" } });
    const b = payload({ env: { B: "2", A: "1" } });
    expect(payloadHash(a)).toBe(payloadHash(b));
  });

  it("ignores file CONTENT, which is re-stamped on every build", () => {
    // A credential stub carries a fresh timestamp each time it is composed;
    // hashing its bytes would make every payload look changed.
    const a = payload({
      files: [{ containerPath: "/home/node/.codex/auth.json", content: "t=1" }],
    });
    const b = payload({
      files: [{ containerPath: "/home/node/.codex/auth.json", content: "t=2" }],
    });
    expect(payloadHash(a)).toBe(payloadHash(b));
  });

  it("still moves when a real credential changes (it lives in env)", () => {
    const a = payload({
      env: { HTTPS_PROXY: "http://x:aoc_one@gateway:10255" },
    });
    const b = payload({
      env: { HTTPS_PROXY: "http://x:aoc_two@gateway:10255" },
    });
    expect(payloadHash(a)).not.toBe(payloadHash(b));
  });
});

describe("stop", () => {
  it("stops the container but keeps the home (sleep, not delete)", async () => {
    queued.push(startItem());
    await runner.tick(0);
    posted.length = 0;

    queued.push({ kind: "sandbox.stop", sandboxId: "sb-1" });
    await runner.tick(0);

    expect(backend.sandboxes.get("sb-1")?.running).toBe(false);
    expect(backend.homes.get("sb-1")).toBe("fake-home-sb-1");
    expect(posted).toEqual([{ kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" }]);
  });

  it("treats a stop for an unknown sandbox as already stopped", async () => {
    queued.push({ kind: "sandbox.stop", sandboxId: "sb-ghost" });
    await runner.tick(0);

    expect(posted).toEqual([{ kind: "sandbox.status", sandboxId: "sb-ghost", status: "stopped" }]);
  });
});

describe("reconcile (the teardown path)", () => {
  it("destroys a sandbox the control plane no longer knows about", async () => {
    queued.push(startItem("sb-doomed"));
    await runner.tick(0);
    expect(backend.sandboxes.has("sb-doomed")).toBe(true);

    expectedSandboxIds = [];
    await runner.reconcile();

    expect(backend.sandboxes.has("sb-doomed")).toBe(false);
    expect(backend.homes.has("sb-doomed")).toBe(false);
  });

  it("leaves a sandbox the control plane still expects", async () => {
    queued.push(startItem("sb-keep"));
    await runner.tick(0);

    expectedSandboxIds = ["sb-keep"];
    await runner.reconcile();

    expect(backend.sandboxes.has("sb-keep")).toBe(true);
    expect(backend.homes.has("sb-keep")).toBe(true);
  });

  it("reaps an orphaned home whose container is already gone", async () => {
    await backend.provisionHome("sb-leftover");
    expectedSandboxIds = [];

    await runner.reconcile();

    expect(backend.homes.has("sb-leftover")).toBe(false);
  });

  it("runs on start, so a crashed runner cleans up on next boot", async () => {
    await backend.provisionHome("sb-crashed");
    expectedSandboxIds = [];

    await runner.start();

    expect(backend.homes.has("sb-crashed")).toBe(false);
    await runner.stop();
  });
});

describe("a sandbox that is running but unreachable", () => {
  // The control-channel token is single-use and lives in the runner's memory,
  // so a supervisor that lost its channel across a runner restart can never
  // re-authenticate. Left alone, the container runs, the control plane still
  // reads `running`, and every turn fails "not reachable" — forever, because
  // a `running` sandbox is never re-started.

  it("reports it as stopped so the normal wake path can recover it", async () => {
    queued.push(startItem("sb-1"));
    await runner.tick(0);
    expectedSandboxIds = ["sb-1"];
    posted.length = 0;
    // No live channel and no token outstanding = stranded, not booting.

    await runner.reconcile();

    expect(posted).toEqual([{ kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" }]);
  });

  it("says NOTHING about a sandbox that is still dialling in", async () => {
    // A freshly-created sandbox holds a token and has not connected yet.
    // Reporting it stopped would fight its own start.
    queued.push(startItem("sb-1"));
    await runner.tick(0);
    expectedSandboxIds = ["sb-1"];
    posted.length = 0;
    wsServer.awaitingConnection = () => true;

    await runner.reconcile();

    expect(posted).toEqual([]);
  });

  it("reports a sandbox that vanished from the backend entirely", async () => {
    // A killed docker container still exists to be inspected, so reconcile
    // could always find it. A destroyed microVM is simply gone and never
    // appears in listSandboxes() again. Walking only the backend's list
    // therefore misses it, and an in-flight turn against it would wait out
    // the whole ceiling with no report of any kind.
    queued.push(startItem("sb-1"));
    await runner.tick(0);
    await backend.removeSandbox(backend.sandboxes.get("sb-1")!.containerRef);
    expectedSandboxIds = ["sb-1"];
    posted.length = 0;

    await runner.reconcile();

    expect(posted).toEqual([{ kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" }]);

    // Once, then quiet — the same discipline the dead-but-expected path keeps.
    posted.length = 0;
    await runner.reconcile();
    expect(posted).toEqual([]);
  });

  it("says nothing about a sandbox with a live channel", async () => {
    queued.push(startItem("sb-1"));
    await runner.tick(0);
    expectedSandboxIds = ["sb-1"];
    posted.length = 0;
    connected.add("sb-1");

    await runner.reconcile();

    expect(posted).toEqual([]);
  });

  it("reports a DEAD expected container once — then stays quiet", async () => {
    // The double-death shape: the container died while the runner itself was
    // down (a host reboot), so the channel close was never observed and no
    // report ever fired — the control plane may still read `running` with a
    // turn in flight, which would otherwise wait out the whole ceiling. One
    // `stopped` report is the truth; a sandbox that was parked DELIBERATELY
    // absorbs the same report as a no-op (the control plane's status guard),
    // so the dedupe below exists only to stop per-tick churn.
    // MUTATION-PROOF: delete the dead-but-expected arm and the first expect
    // fails; delete the reportedDead dedupe and the second one does.
    queued.push(startItem("sb-1"));
    await runner.tick(0);
    const ref = backend.sandboxes.get("sb-1")?.containerRef;
    await backend.stopSandbox(ref!);
    expectedSandboxIds = ["sb-1"];
    posted.length = 0;

    await runner.reconcile();
    expect(posted).toEqual([{ kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" }]);

    posted.length = 0;
    await runner.reconcile();
    expect(posted).toEqual([]);
  });
});

describe("registration", () => {
  it("declares the backend's real capabilities", async () => {
    const register = vi.fn(async () => ({ runnerId: "r-1" }));
    const spy = createRunner({
      config,
      backend,
      controlPlane: { ...controlPlane, register },
      wsServer,
    });

    await spy.start();

    expect(register).toHaveBeenCalledWith("test runner", {
      maxSandboxes: 2,
      backend: "fake",
      homeDurability: "resident",
      // The steer-dispatch gate: the control plane only hands `turn.message`
      // to runners that said they can parse it (an unknown kind poisons a
      // whole poll batch on an older build).
      steerMessages: true,
      // Same gate for attachment manifests: only an advertising runner is
      // told about files, because only it can pull the bytes.
      attachments: true,
    });
    await spy.stop();
  });

  it("prepares the backend before registering", async () => {
    await runner.start();
    expect(backend.prepared()).toBe(true);
    await runner.stop();
  });
});

describe("the control channel must not be proxied", () => {
  it("exempts the runner host from the sandbox's proxy env", async () => {
    queued.push(startItem());
    await runner.tick(0);

    const env = backend.sandboxes.get("sb-1")?.spec.env ?? {};
    expect(env.NO_PROXY).toBe("runner");
    expect(env.no_proxy).toBe("runner");
    // The gateway proxy itself is untouched — all agent egress still goes there.
    expect(env.HTTPS_PROXY).toContain("gateway:10255");
  });

  it("APPENDS to a NO_PROXY the payload already set, never clobbers it", async () => {
    queued.push(
      startItem("sb-1", {
        env: {
          HTTPS_PROXY: "http://x:aoc_token@gateway:10255",
          NO_PROXY: "localhost,127.0.0.1",
        },
      }),
    );
    await runner.tick(0);

    expect(backend.sandboxes.get("sb-1")?.spec.env.NO_PROXY).toBe("localhost,127.0.0.1,runner");
  });

  it("does not duplicate the host when it is already exempt", async () => {
    queued.push(
      startItem("sb-1", {
        env: { HTTPS_PROXY: "http://x:t@gateway:10255", NO_PROXY: "runner" },
      }),
    );
    await runner.tick(0);

    expect(backend.sandboxes.get("sb-1")?.spec.env.NO_PROXY).toBe("runner");
  });
});

describe("turn delivery", () => {
  const turnItem = (
    overrides: Partial<Extract<RunnerWorkItem, { kind: "turn.deliver" }>> = {},
  ): RunnerWorkItem => ({
    kind: "turn.deliver",
    sandboxId: "sb-1",
    conversationId: "cv-1",
    turnId: "t-1",
    message: "what is in this repo?",
    ...overrides,
  });

  it("hands the turn straight down the sandbox's control channel", async () => {
    connected.add("sb-1");
    queued.push(turnItem());
    await runner.tick(0);

    expect(delivered.get("sb-1")).toEqual([
      {
        kind: "turn.deliver",
        turnId: "t-1",
        conversationId: "cv-1",
        message: "what is in this repo?",
      },
    ]);
  });

  it("passes the resume ref through when the conversation has one", async () => {
    connected.add("sb-1");
    queued.push(turnItem({ resumeSessionRef: "sess-abc" }));
    await runner.tick(0);

    expect(delivered.get("sb-1")?.[0]).toMatchObject({
      resumeSessionRef: "sess-abc",
    });
  });

  it("forwards the memory context verbatim — and omits the key when absent", async () => {
    connected.add("sb-1");
    queued.push(turnItem({ context: "[Your memory — index]" }), turnItem());
    await runner.tick(0);

    const [withContext, without] = delivered.get("sb-1") ?? [];
    expect(withContext).toMatchObject({ context: "[Your memory — index]" });
    expect(without).not.toHaveProperty("context");
  });

  it("reports NOTHING on a successful delivery — progress comes back later", async () => {
    // The turn's outcome arrives over the control channel, asynchronously. An
    // event here would race the real one.
    connected.add("sb-1");
    queued.push(turnItem());
    await runner.tick(0);

    expect(posted).toEqual([]);
  });

  it("does not wait for the turn — the next work item runs immediately", async () => {
    // A turn can run for minutes and `tick` executes items serially, so an
    // awaited delivery would stall every other sandbox's lifecycle behind it.
    connected.add("sb-1");
    queued.push(turnItem(), startItem("sb-2"));
    await runner.tick(0);

    expect(backend.sandboxes.get("sb-2")?.running).toBe(true);
  });

  it("FAILS the turn when the sandbox has no live channel", async () => {
    // Silence would leave it dispatched until the control plane's stale sweep;
    // the user would watch a spinner for fifteen minutes.
    queued.push(turnItem());
    await runner.tick(0);

    expect(posted[0]).toMatchObject({
      kind: "turn.finished",
      sandboxId: "sb-1",
      turnId: "t-1",
      status: "failed",
      // Coded so a NEW control plane can revive a never-started turn
      // invisibly (and write canonical copy otherwise); the raw prose stays
      // for old ones.
      errorCode: "agent_restarted",
    });
    // And the sandbox is corrected to `stopped` in the same breath, so the
    // user's retry wakes it rather than failing against the same dead channel.
    expect(posted[1]).toEqual({
      kind: "sandbox.status",
      sandboxId: "sb-1",
      status: "stopped",
    });
    expect(delivered.has("sb-1")).toBe(false);
  });

  it("forwards an abort to the running sandbox", async () => {
    connected.add("sb-1");
    queued.push({
      kind: "turn.abort",
      sandboxId: "sb-1",
      conversationId: "cv-1",
      turnId: "t-1",
    });
    await runner.tick(0);

    expect(delivered.get("sb-1")).toEqual([
      { kind: "turn.abort", turnId: "t-1", conversationId: "cv-1" },
    ]);
    expect(posted).toEqual([]);
  });

  it("treats an abort for an unreachable sandbox as already aborted", async () => {
    queued.push({
      kind: "turn.abort",
      sandboxId: "sb-gone",
      conversationId: "cv-1",
      turnId: "t-1",
    });
    await runner.tick(0);

    expect(posted).toEqual([
      {
        kind: "turn.finished",
        sandboxId: "sb-gone",
        conversationId: "cv-1",
        turnId: "t-1",
        status: "aborted",
      },
    ]);
  });

  it("delivers to the right sandbox when several are connected", async () => {
    connected.add("sb-1");
    connected.add("sb-2");
    queued.push(turnItem({ sandboxId: "sb-2", turnId: "t-2" }));
    await runner.tick(0);

    expect(delivered.has("sb-1")).toBe(false);
    expect(delivered.get("sb-2")?.[0]).toMatchObject({ turnId: "t-2" });
  });
});

describe("object ownership survives a restart", () => {
  it("adopts the control plane's stable id before touching anything", async () => {
    // A per-process id would make a restarted runner blind to the volumes it
    // created before — they would leak with nothing able to see them.
    const seen: Array<string | undefined> = [];
    const watching = createRunner({
      config,
      backend,
      controlPlane: {
        ...controlPlane,
        listSandboxIds: async () => {
          seen.push(backend.owner());
          return [];
        },
      },
      wsServer,
    });

    await watching.start();

    // The boot reconcile already ran under the registered id.
    expect(seen).toEqual(["r-1"]);
    expect(backend.owner()).toBe("r-1");
    await watching.stop();
  });
});

describe("home sync fan-out", () => {
  const syncItem = (
    overrides: Partial<Extract<RunnerWorkItem, { kind: "skills.changed" }>> = {},
  ): RunnerWorkItem => ({
    kind: "skills.changed",
    sandboxId: "sb-1",
    generation: 4,
    parts: [
      { files: [{ path: ".agents/skills/deploy/SKILL.md", content: "# one" }] },
      {
        files: [{ path: "memory/index.md", content: "# Memory index" }],
        prune: [".agents/skills/deploy/SKILL.md", "memory/index.md"],
        instructions: "Be brief.",
        agentName: "andy",
      },
    ],
    ...overrides,
  });

  it("fans the parts out in order with part/of stamps and returns nothing", async () => {
    connected.add("sb-1");
    queued.push(syncItem());
    await runner.tick(0);

    const frames = delivered.get("sb-1") ?? [];
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      kind: "skills.changed",
      generation: 4,
      part: 1,
      of: 2,
    });
    expect(frames[0]).not.toHaveProperty("prune");
    expect(frames[1]).toMatchObject({
      kind: "skills.changed",
      part: 2,
      of: 2,
      instructions: "Be brief.",
      agentName: "andy",
    });
    expect(posted).toEqual([]);
  });

  it("no channel is a strict NO-OP — no frames, ZERO events", async () => {
    // The deliverTurn arm reports corrective events here; the sync arm must
    // not (a healthy-but-reconnecting sandbox would be knocked into a
    // respawn cycle). The mutation that copies deliverTurn's arm dies here.
    queued.push(syncItem());
    await runner.tick(0);

    expect(delivered.get("sb-1")).toBeUndefined();
    expect(posted).toEqual([]);
  });

  it("a batch executes serially: sync frames land before the turn frame", async () => {
    connected.add("sb-1");
    queued.push(syncItem(), {
      kind: "turn.deliver",
      sandboxId: "sb-1",
      conversationId: "cv-1",
      turnId: "t-1",
      message: "use the skill",
    });
    await runner.tick(0);

    const kinds = (delivered.get("sb-1") ?? []).map((frame) => frame.kind);
    expect(kinds).toEqual(["skills.changed", "skills.changed", "turn.deliver"]);
  });
});
