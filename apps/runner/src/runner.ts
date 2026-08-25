import { createHash } from "node:crypto";
import {
  MAX_SANDBOX_CHECK_IDS,
  TURN_FAILURE_CODES,
  type RunnerCapabilities,
  type RunnerEvent,
  type RunnerWorkItem,
  type SandboxStartFailureReason,
  type SandboxStartPayload,
} from "@onecli/agent-protocol";
import type { RunnerConfig } from "./config";
import { installationFingerprint } from "./installation";
import { attachmentPartFrames, verifyPulledAttachment } from "./attachments";
import { ControlPlaneError, type ControlPlaneClient } from "./control-plane";
import { ImageUnavailableError, type SandboxBackend } from "./backend/types";
import type { RunnerWsServer } from "./ws/server";
import { log } from "./log";

/**
 * The runner loop (plans/hosted-agents-v2.md step 3).
 *
 * Three behaviors, in order of importance:
 *
 * 1. **Poll is the clock** (§3.3). There is no scheduler anywhere; the runner
 *    long-polls, executes what it is given, and reports back.
 * 2. **Reconcile is the truth** (and the teardown path). What the control
 *    plane says this runner should host is authoritative; anything labeled as
 *    ours and absent from that list is destroyed — container and volume. This
 *    is how deleting an agent reaches the compute plane, and it is crash-safe
 *    by construction: a runner that died mid-delete cleans up on next boot.
 * 3. **Starts are idempotent.** A start for a sandbox whose payload hash is
 *    unchanged just starts the existing container; a changed payload (a
 *    regenerated token) recreates it. Both paths converge on "the container
 *    matches the payload the control plane last handed us".
 */

/** How long a work poll asks the server to hold. */
const POLL_WAIT_SECONDS = 25;
const POLL_LIMIT = 5;
const HEARTBEAT_MS = 30_000;
/** Backoff bounds when the control plane is unreachable. */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/**
 * Identifies a spawn payload — recorded as a container label so an operator
 * (and any future differ) can tell at a glance whether a running sandbox was
 * built from the credentials the control plane holds now.
 *
 * It is deliberately NOT used to skip recreation: the control channel's
 * bootstrap token is single-use, so every start replaces the container.
 */
export const payloadHash = (payload: SandboxStartPayload): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        env: Object.entries(payload.env).sort(),
        // Paths and modes only — NOT contents. A credential stub carries a
        // freshly-stamped timestamp on every build (it must look recently
        // refreshed to the tool that reads it), so hashing its bytes would
        // make the payload look changed on every dispatch. Real credential
        // changes still move the hash: they change `env`.
        files: payload.files.map((file) => [file.containerPath, file.mode ?? null]).sort(),
        model: payload.model ?? null,
        effort: payload.effort ?? null,
        harness: payload.harness ?? null,
        instructions: payload.instructions ?? null,
      }),
    )
    .digest("hex");

/**
 * Keep the sandbox's control channel OFF the proxy.
 *
 * The bootstrap payload sets `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` so that
 * every byte the agent sends goes through the gateway — which is the product.
 * But the supervisor's own socket to its runner is host-local infrastructure,
 * not agent egress: proxying it sends a WebSocket upgrade for an internal host
 * to the gateway, and the channel simply never opens (observed live).
 *
 * §3.4 names two legal destinations from a sandbox — the gateway and its
 * runner — so exempting the runner is the rule, not a hole in it. The network
 * remains the enforcement: everything else still has nowhere to go.
 */
export const noProxyForRunner = (
  advertisedHost: string,
  payloadEnv: Record<string, string>,
): Record<string, string> => {
  const existing = payloadEnv.NO_PROXY ?? payloadEnv.no_proxy ?? "";
  const hosts = existing
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!hosts.includes(advertisedHost)) hosts.push(advertisedHost);
  const value = hosts.join(",");
  // Both spellings: tools differ on which they read.
  return { NO_PROXY: value, no_proxy: value };
};

export interface RunnerDeps {
  config: RunnerConfig;
  backend: SandboxBackend;
  controlPlane: ControlPlaneClient;
  wsServer: RunnerWsServer;
}

export interface Runner {
  /** Register + prepare the backend. Returns the assigned runner id. */
  start(): Promise<string>;
  /** One poll→execute cycle. Exposed so tests drive it deterministically. */
  tick(wait?: number): Promise<void>;
  /** One reconcile pass against the control plane's sandbox list. */
  reconcile(): Promise<void>;
  /**
   * The container this runner most recently spawned for a sandbox (step 10),
   * or undefined if none. Used to stamp process.state events — a supervisor
   * connection can only exist if THIS process minted its token after
   * spawning the container, so the entry is always present before any frame
   * could arrive.
   */
  containerRefOf(sandboxId: string): string | undefined;
  /** The long-running loop: poll forever until `stop()`. */
  run(): Promise<void>;
  stop(): Promise<void>;
}

/** Ceiling on the registration backoff — long enough to stop log spam, short
 *  enough that a control plane coming up is picked straight back up. */
const REGISTER_RETRY_CAP_MS = 10_000;

/**
 * Register, waiting out a control plane that is not up yet.
 *
 * The runner and the api start together — compose gates it with
 * `depends_on: service_healthy`, `pnpm dev` gates it with nothing — and the
 * runner reliably wins that race by a few hundred milliseconds. Exiting there
 * meant one crashed process took the whole dev session down, because a task
 * runner stops every task when one fails.
 *
 * ONLY a transport failure waits. A control plane that ANSWERS and refuses — a
 * wrong or missing `RUNNER_TOKEN`, which comes back 401 — is a
 * misconfiguration that retrying would hide, so it still throws and the
 * process still exits saying so. `ControlPlaneError` is exactly the "we got a
 * response" case; anything else means we never reached it.
 *
 * Wrapped around the REGISTER call alone, not around `start()`: `start()` also
 * binds the control-channel socket, and retrying that raises
 * ERR_SERVER_ALREADY_LISTEN forever instead of recovering.
 */
const registerWithRetry = async (
  controlPlane: ControlPlaneClient,
  controlPlaneUrl: string,
  name: string,
  capabilities: RunnerCapabilities,
): Promise<{ runnerId: string }> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await controlPlane.register(name, capabilities);
    } catch (error) {
      if (error instanceof ControlPlaneError) throw error;
      const waitMs = Math.min(2 ** (attempt - 1) * 500, REGISTER_RETRY_CAP_MS);
      // The URL and the error, because "still booting" and "you typo'd
      // RUNNER_CONTROL_PLANE_URL" otherwise print the same line forever. Past
      // a minute of this it is no longer a startup race, so say so louder.
      log(attempt > 10 ? "error" : "warn", "control plane unreachable; waiting to register", {
        attempt,
        waitMs,
        url: controlPlaneUrl,
        error: String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
};

export const createRunner = ({ config, backend, controlPlane, wsServer }: RunnerDeps): Runner => {
  let running = false;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let reconcileTimer: NodeJS.Timeout | undefined;
  // sandboxId → the container ref we spawned for it (step 10). Populated the
  // instant a container is created, cleared when it is stopped or reaped, so
  // it is authoritative for any supervisor frame that can reach us.
  const sandboxContainers = new Map<string, string>();

  const capabilities = (): RunnerCapabilities => ({
    maxSandboxes: config.maxSandboxes,
    backend: backend.id,
    homeDurability: backend.homeDurability,
    // This build parses `turn.message` — the control plane's steer arm is
    // gated on the advertisement, because an unknown work kind would poison
    // a whole poll batch on a runner that predates it.
    steerMessages: true,
    // This build pulls attachment bytes and streams them ahead of the turn.
    // Dispatch composes the manifest + context note only when this is
    // advertised, so an older runner's turns simply ship bare.
    attachments: true,
  });

  const report = async (events: RunnerEvent[]): Promise<void> => {
    try {
      await controlPlane.postEvents(events);
    } catch (error) {
      // Events are advisory: the control plane's stale-claim window recovers a
      // sandbox whose status never arrived, so a failed report must not take
      // the runner down.
      log("warn", "failed to report events", { error: String(error) });
    }
  };

  const startSandbox = async (
    item: Extract<RunnerWorkItem, { kind: "sandbox.start" }>,
  ): Promise<RunnerEvent[]> => {
    const hash = payloadHash(item.payload);
    // Built incrementally so the catch appends `failed` after whatever
    // progress was already reported — and EVERYTHING that can touch the
    // daemon runs inside the try. The first list and the home provisioning
    // used to sit outside it: a daemon dead exactly there threw out of the
    // whole tick, reported nothing, and left the sandbox `starting` until
    // the 300s stale claim instead of `failed` with a reason.
    const events: RunnerEvent[] = [];

    try {
      const existing = (await backend.listSandboxes()).find(
        (snapshot) => snapshot.sandboxId === item.sandboxId,
      );

      // Capacity is enforced here as well as at placement: the runner is the
      // only party that knows what it is actually holding right now.
      if (!existing) {
        const live = (await backend.listSandboxes()).filter((snapshot) => snapshot.running).length;
        if (live >= config.maxSandboxes) {
          events.push({
            kind: "sandbox.status",
            sandboxId: item.sandboxId,
            status: "failed",
            error: `runner at capacity (${config.maxSandboxes} sandboxes)`,
            // `satisfies` binds the literal to the shared vocabulary — the
            // wire field is an open string, so a typo here would otherwise
            // compile clean and silently degrade to the generic copy.
            reasonCode: "at_capacity" satisfies SandboxStartFailureReason,
          });
          return events;
        }
      }

      const homeRef =
        (await backend.listHomes()).find((home) => home.sandboxId === item.sandboxId)?.ref ??
        (await backend.provisionHome(item.sandboxId));

      events.push({
        kind: "sandbox.status",
        sandboxId: item.sandboxId,
        status: "starting",
        homeRef,
      });

      let containerRef = existing?.containerRef;

      // Recreate on ANY start of an existing container, not only when the
      // payload changed. The control-channel bootstrap token is single-use and
      // baked into the container's environment, so a container that has
      // already connected once can never authenticate again — starting it
      // instead of replacing it produces a sandbox that runs but can never
      // report, and the control plane re-dispatches it forever. Recreating is
      // cheap (the durable home volume is untouched) and it is the only
      // way the woken sandbox gets a live credential.
      if (existing) {
        await backend.stopSandbox(existing.containerRef);
        await backend.removeSandbox(existing.containerRef);
        sandboxContainers.delete(item.sandboxId);
        containerRef = undefined;
      }

      if (!containerRef) {
        await backend.wakeHome(homeRef);
        const bootstrapToken = wsServer.issueToken(item.sandboxId);
        containerRef = await backend.createSandbox({
          sandboxId: item.sandboxId,
          image: config.agentImage,
          env: {
            ...item.payload.env,
            ...noProxyForRunner(config.advertisedHost, item.payload.env),
            ...(item.payload.model && { AGENT_MODEL: item.payload.model }),
            ...(item.payload.effort && { AGENT_EFFORT: item.payload.effort }),
            ...(item.payload.harness && {
              AGENT_HARNESS: item.payload.harness,
            }),
            ...(item.payload.instructions && {
              AGENT_INSTRUCTIONS: item.payload.instructions,
            }),
            ...(item.payload.agentName && {
              AGENT_NAME: item.payload.agentName,
            }),
            SANDBOX_ID: item.sandboxId,
            RUNNER_WS_URL: `ws://${config.advertisedHost}:${config.wsPort}`,
            SANDBOX_WS_TOKEN: bootstrapToken,
          },
          files: item.payload.files,
          homeRef,
          limits: config.limits,
          payloadHash: hash,
        });
      } else {
        await backend.wakeHome(homeRef);
      }

      // Record the container BEFORE start: the supervisor cannot connect (and
      // so cannot emit a process.state frame) until it boots inside this
      // container, and its token was minted just above — the map is populated
      // before any frame could arrive.
      sandboxContainers.set(item.sandboxId, containerRef);

      await backend.startSandbox(containerRef);

      for (const warning of item.payload.warnings) {
        log("warn", "provisioning warning", {
          sandboxId: item.sandboxId,
          warning,
        });
      }

      // `running` is reported by the supervisor connecting (supervisor.ready),
      // not here: a container that starts but whose supervisor never comes up
      // is not a working agent.
      events.push({
        kind: "sandbox.status",
        sandboxId: item.sandboxId,
        status: "starting",
        containerRef,
        homeRef,
      });
    } catch (error) {
      // Safe for a token that was never issued (the daemon died before the
      // mint) — revoke is a keyed delete, not a handle.
      wsServer.revokeToken(item.sandboxId);
      log("error", "sandbox start failed", {
        sandboxId: item.sandboxId,
        error: String(error),
      });
      // Classified HERE — the runner is the only party that saw the typed
      // error. The control plane maps the code to user-facing copy; the raw
      // string is the operator trail. Typed against the shared vocabulary so
      // a typo cannot silently degrade to the generic copy.
      const reasonCode: SandboxStartFailureReason =
        error instanceof ImageUnavailableError ? "image_unavailable" : "start_failed";
      events.push({
        kind: "sandbox.status",
        sandboxId: item.sandboxId,
        status: "failed",
        error: String(error),
        reasonCode,
      });
    }

    return events;
  };

  const stopSandbox = async (
    item: Extract<RunnerWorkItem, { kind: "sandbox.stop" }>,
  ): Promise<RunnerEvent[]> => {
    const snapshot = (await backend.listSandboxes()).find(
      (candidate) => candidate.sandboxId === item.sandboxId,
    );
    const ref = snapshot?.containerRef ?? item.containerRef;

    // Nothing to stop is the desired end state, not an error.
    if (!ref) {
      return [
        {
          kind: "sandbox.status",
          sandboxId: item.sandboxId,
          status: "stopped",
        },
      ];
    }

    try {
      await backend.stopSandbox(ref);
      // The container is gone — its process rows are now stale by definition
      // (the control plane's lost sweep will terminalize them).
      sandboxContainers.delete(item.sandboxId);
      const home = (await backend.listHomes()).find(
        (candidate) => candidate.sandboxId === item.sandboxId,
      );
      if (home) await backend.parkHome(home.ref);
      return [
        {
          kind: "sandbox.status",
          sandboxId: item.sandboxId,
          status: "stopped",
        },
      ];
    } catch (error) {
      log("error", "sandbox stop failed", {
        sandboxId: item.sandboxId,
        error: String(error),
      });
      return [
        {
          kind: "sandbox.status",
          sandboxId: item.sandboxId,
          status: "failed",
          error: String(error),
        },
      ];
    }
  };

  /**
   * Per-sandbox delivery chains: a turn with attachments PULLS bytes before
   * its frames go out, and that async work must neither stall the tick loop
   * (other sandboxes' lifecycle) nor let two deliveries to the SAME sandbox
   * interleave their frames. A settled chain removes itself so the map never
   * grows past the live sandboxes.
   */
  const deliveryChains = new Map<string, Promise<void>>();
  const enqueueDelivery = (sandboxId: string, task: () => Promise<void>): void => {
    const previous = deliveryChains.get(sandboxId) ?? Promise.resolve();
    const next = previous.then(task).catch((error: unknown) => {
      log("warn", "sandbox delivery task failed", {
        sandboxId,
        error: String(error),
      });
    });
    deliveryChains.set(sandboxId, next);
    void next.finally(() => {
      if (deliveryChains.get(sandboxId) === next) {
        deliveryChains.delete(sandboxId);
      }
    });
  };

  /**
   * Hand a turn to its sandbox and return at once. Deliberately NOT awaited:
   * a turn can run for minutes, and `tick` executes items serially, so
   * awaiting one would stall every other sandbox's lifecycle behind it. The
   * turn's progress comes back asynchronously over the control channel.
   *
   * A turn with an attachments manifest first pulls each file's bytes from
   * the control plane and streams them as `attachment.part` frames, THEN
   * sends the turn frame — the same-socket ordering plus the supervisor's
   * sync-queue apply is the whole "files are on disk before the turn starts"
   * guarantee. A failed pull degrades to delivering the turn without that
   * file (the agent's read fails honestly; the context note said what was
   * expected). Steers/aborts that overtake this async delivery are safe by
   * the supervisor's own machinery (steer inbox, pending aborts).
   */
  const deliverTurn = (item: Extract<RunnerWorkItem, { kind: "turn.deliver" }>): RunnerEvent[] => {
    const connection = wsServer.connection(item.sandboxId);
    if (!connection) {
      // The sandbox is not connected. Say so rather than dropping the turn —
      // silence would leave it dispatched until the stale sweep.
      log("warn", "turn delivered to a sandbox with no live channel", {
        sandboxId: item.sandboxId,
        turnId: item.turnId,
      });
      return [
        {
          kind: "turn.finished",
          sandboxId: item.sandboxId,
          conversationId: item.conversationId,
          turnId: item.turnId,
          status: "failed",
          // Raw prose stays for an old control plane; a new one maps the
          // CODE to its canonical copy — and, for a turn that never started,
          // revives it invisibly instead of failing it at all.
          error: "The agent was restarting. Send the message again.",
          errorCode: TURN_FAILURE_CODES.agentRestarted,
        },
        // Correct the control plane's view in the same breath. It still reads
        // `running` — that belief is why this turn was dispatched here at all
        // — and a `running` sandbox is never re-started, so without this the
        // agent stays unreachable until the next reconcile tick. Reporting it
        // now means the user's retry lands on the ordinary wake path instead
        // of failing again.
        {
          kind: "sandbox.status",
          sandboxId: item.sandboxId,
          status: "stopped",
        },
      ];
    }

    const sendTurnFrame = (target: typeof connection) => {
      target.send({
        kind: "turn.deliver",
        turnId: item.turnId,
        conversationId: item.conversationId,
        message: item.message,
        ...(item.resumeSessionRef && {
          resumeSessionRef: item.resumeSessionRef,
        }),
        // Delivery-only memory context (step 8) — forwarded verbatim; the
        // supervisor concatenates, the transcript never sees it.
        ...(item.context && { context: item.context }),
        ...(item.attachments && item.attachments.length > 0 && { attachments: item.attachments }),
      });
    };

    if (!item.attachments || item.attachments.length === 0) {
      sendTurnFrame(connection);
      return [];
    }

    const manifest = item.attachments;
    enqueueDelivery(item.sandboxId, async () => {
      /**
       * The channel died before this turn could be handed over. Correct the
       * control plane's view exactly like the synchronous no-channel branch
       * above — it still reads `running`, and a `running` sandbox is never
       * re-started, so staying quiet would strand the turn until the stale
       * sweep. ONE exit point for every mid-delivery loss.
       */
      const reportChannelLoss = () =>
        report([
          {
            kind: "turn.finished",
            sandboxId: item.sandboxId,
            conversationId: item.conversationId,
            turnId: item.turnId,
            status: "failed",
            error: "The agent was restarting. Send the message again.",
            errorCode: TURN_FAILURE_CODES.agentRestarted,
          },
          {
            kind: "sandbox.status",
            sandboxId: item.sandboxId,
            status: "stopped",
          },
        ]);

      for (const entry of manifest) {
        try {
          const bytes = await controlPlane.fetchAttachment(entry.id);
          if (!verifyPulledAttachment(entry, bytes)) {
            log("warn", "attachment bytes failed verification; skipped", {
              attachmentId: entry.id,
              turnId: item.turnId,
            });
            continue;
          }
          // The connection captured above may have died mid-pull; re-resolve
          // so frames never go to a closed socket (send would throw and the
          // chain's catch would eat the remaining files).
          const live = wsServer.connection(item.sandboxId);
          if (!live) {
            log("warn", "sandbox channel closed mid attachment delivery", {
              sandboxId: item.sandboxId,
              turnId: item.turnId,
            });
            await reportChannelLoss();
            return;
          }
          for (const frame of attachmentPartFrames(item.turnId, entry, bytes)) {
            live.send(frame);
          }
        } catch (error) {
          log("warn", "attachment pull failed; turn delivers without it", {
            attachmentId: entry.id,
            turnId: item.turnId,
            error: String(error),
          });
        }
      }
      const live = wsServer.connection(item.sandboxId);
      if (!live) {
        await reportChannelLoss();
        return;
      }
      sendTurnFrame(live);
    });
    return [];
  };

  const abortTurn = (item: Extract<RunnerWorkItem, { kind: "turn.abort" }>): RunnerEvent[] => {
    const connection = wsServer.connection(item.sandboxId);
    if (!connection) {
      // Nothing is running it, so it is already as stopped as it can be.
      return [
        {
          kind: "turn.finished",
          sandboxId: item.sandboxId,
          conversationId: item.conversationId,
          turnId: item.turnId,
          status: "aborted",
        },
      ];
    }
    connection.send({
      kind: "turn.abort",
      turnId: item.turnId,
      conversationId: item.conversationId,
    });
    return [];
  };

  /**
   * Steer a mid-run follow-up down the control channel. No channel is a
   * strict NO-OP, deliberately unlike deliverTurn's corrective events: a
   * steer's recovery lives control-plane-side (the target turn strand-fails
   * and the follow-up is PROMOTED into an ordinary queued turn), so a
   * synthetic failure here would terminalize a message that is about to run
   * anyway — and a `stopped` report would knock a healthy-but-reconnecting
   * sandbox into a needless respawn cycle.
   */
  const steerMessage = (item: Extract<RunnerWorkItem, { kind: "turn.message" }>): RunnerEvent[] => {
    const connection = wsServer.connection(item.sandboxId);
    if (!connection) {
      log("info", "steer skipped — no live channel; promotion will cover it", {
        sandboxId: item.sandboxId,
        turnId: item.turnId,
      });
      return [];
    }
    connection.send({
      kind: "turn.message",
      turnId: item.turnId,
      targetTurnId: item.targetTurnId,
      conversationId: item.conversationId,
      message: item.message,
    });
    return [];
  };

  /**
   * Fan a home sync's parts down the sandbox's control channel, in
   * order, on the one socket — which is the whole ordering guarantee. No
   * channel is a strict NO-OP, deliberately unlike deliverTurn's corrective
   * events: the sync is self-healing by generations (the un-acked claim
   * re-arms after its paced window, and a parked sandbox re-materializes at
   * its next boot), while reporting `stopped` here would knock a
   * healthy-but-reconnecting sandbox into a needless respawn cycle.
   */
  const syncHome = (item: Extract<RunnerWorkItem, { kind: "skills.changed" }>): RunnerEvent[] => {
    const connection = wsServer.connection(item.sandboxId);
    if (!connection) {
      log("info", "home sync skipped — no live channel", {
        sandboxId: item.sandboxId,
        generation: item.generation,
      });
      return [];
    }
    item.parts.forEach((part, index) => {
      connection.send({
        kind: "skills.changed",
        generation: item.generation,
        part: index + 1,
        of: item.parts.length,
        files: part.files,
        ...(part.prune && { prune: part.prune }),
        ...(part.instructions !== undefined && {
          instructions: part.instructions,
        }),
        ...(part.agentName !== undefined && { agentName: part.agentName }),
      });
    });
    return [];
  };

  const execute = async (item: RunnerWorkItem): Promise<RunnerEvent[]> => {
    switch (item.kind) {
      case "sandbox.start":
        return await startSandbox(item);
      case "sandbox.stop":
        return await stopSandbox(item);
      case "turn.deliver":
        return deliverTurn(item);
      case "turn.abort":
        return abortTurn(item);
      case "turn.message":
        return steerMessage(item);
      case "skills.changed":
        return syncHome(item);
      default: {
        const unreachable: never = item;
        throw new Error(`unhandled work item: ${JSON.stringify(unreachable)}`);
      }
    }
  };

  /**
   * Dead-but-expected containers already reported, keyed by containerRef —
   * ONE report per corpse. The control plane's stopped-guard (`stopped`
   * applies only over running/stopping) makes duplicates inert anyway, but a
   * deliberately-parked sandbox is also dead-with-no-channel, and without the
   * dedupe every reconcile tick would re-report every parked container
   * forever. Bounded by the containers this process ever observes.
   */
  const reportedDead = new Set<string>();

  /** Set at registration; the sweep refuses to run without it — before
   * `identify()` every managed object would look foreign. */
  let registeredRunnerId: string | undefined;

  /** This installation's fingerprint — the sweep reaps only objects bearing
   * it, so a co-located install's objects are never candidates. */
  const myInstallationId = installationFingerprint(config.token);

  /**
   * THE STALE-LABEL ORPHAN SWEEP (step 13). The owned loops above reap what
   * carries THIS runner's label; objects labeled by a runner id that no
   * longer exists — a control-plane reset minted a fresh id, a rotated
   * token — are invisible to them forever. This sweep enumerates EVERY
   * platform-labeled container and volume, and destroys the ones whose
   * sandbox id the control plane says exists nowhere, in that order:
   * authority first, destruction second, never on a partial answer.
   *
   * Safety fences, each load-bearing:
   *  - a DIFFERENT installation's objects are skipped (the installation-id
   *    fence): listManaged enumerates the whole daemon, so on a shared host
   *    two installs would otherwise see each other's live objects as orphans
   *    (their runner ids differ and their sandbox ids are unknown to each
   *    other's control plane) and destroy them. The fingerprint is a hash of
   *    the runner token — stable across a database reset (so the SAME
   *    install's dead-runner-id objects are still reaped) and different per
   *    install. An absent label (a pre-fix object) is treated as foreign;
   *  - my own runner label is skipped (the expected-set loops own it);
   *  - unidentifiable (no sandbox-id label) and unageable (no timestamp)
   *    objects are logged, never deleted;
   *  - a grace window (default 1h) spares mid-spawn siblings and freshly
   *    created objects whose rows are still landing;
   *  - the existence check protects live siblings by construction — their
   *    Sandbox rows exist before their objects do;
   *  - any check failure (an older control plane 404s the endpoint, a
   *    transport blip) aborts the whole sweep with zero destruction;
   *  - RUNNER_ORPHAN_REAP=false detects and logs, deletes nothing.
   */
  const sweepStaleOrphans = async (): Promise<void> => {
    const myId = registeredRunnerId;
    if (!myId) return;

    let managed;
    try {
      managed = await backend.listManaged();
    } catch (error) {
      log("warn", "orphan sweep could not list managed objects", {
        error: String(error),
      });
      return;
    }

    const graceBefore = Date.now() - config.orphanGraceSeconds * 1000;
    const candidates = managed.flatMap((object) => {
      // A different install (or a pre-fix object with no installation label)
      // is NEVER this sweep's business — its liveness lives in another
      // control plane we cannot ask.
      if (object.installationId !== myInstallationId) return [];
      if (object.runnerId === myId) return [];
      if (!object.sandboxId) {
        log("warn", "unidentifiable managed object (no sandbox-id label)", {
          kind: object.kind,
          ref: object.ref,
        });
        return [];
      }
      if (!object.createdAt) {
        log("warn", "unageable managed object (no creation timestamp)", {
          kind: object.kind,
          ref: object.ref,
        });
        return [];
      }
      if (object.createdAt.getTime() >= graceBefore) return [];
      return [
        {
          kind: object.kind,
          ref: object.ref,
          sandboxId: object.sandboxId,
          runnerId: object.runnerId,
        },
      ];
    });
    if (candidates.length === 0) return;

    const uniqueIds = [...new Set(candidates.map((object) => object.sandboxId))];
    const missing = new Set<string>();
    try {
      for (let i = 0; i < uniqueIds.length; i += MAX_SANDBOX_CHECK_IDS) {
        const batch = uniqueIds.slice(i, i + MAX_SANDBOX_CHECK_IDS);
        for (const id of await controlPlane.checkSandboxIds(batch)) {
          missing.add(id);
        }
      }
    } catch (error) {
      log("warn", "orphan sweep aborted before any destruction", {
        error: String(error),
      });
      return;
    }

    for (const object of candidates) {
      if (!missing.has(object.sandboxId)) continue;
      if (!config.orphanReap) {
        log("warn", "stale-label orphan detected (reap disabled, would reap)", {
          kind: object.kind,
          ref: object.ref,
          sandboxId: object.sandboxId,
          labeledRunnerId: object.runnerId,
        });
        continue;
      }
      log("warn", "reaping stale-label orphan", {
        kind: object.kind,
        ref: object.ref,
        sandboxId: object.sandboxId,
        labeledRunnerId: object.runnerId,
      });
      try {
        if (object.kind === "sandbox") {
          await backend.stopSandbox(object.ref);
          await backend.removeSandbox(object.ref);
        } else {
          await backend.destroyHome(object.ref);
        }
      } catch (error) {
        log("warn", "failed to reap stale-label orphan", {
          kind: object.kind,
          ref: object.ref,
          error: String(error),
        });
      }
    }
  };

  const reconcile = async (): Promise<void> => {
    const expected = new Set(await controlPlane.listSandboxIds());
    const unreachable: RunnerEvent[] = [];
    const seen = new Set<string>();

    for (const snapshot of await backend.listSandboxes()) {
      seen.add(snapshot.sandboxId);
      if (expected.has(snapshot.sandboxId)) {
        /**
         * RUNNING BUT UNREACHABLE — report it, don't leave it stranded.
         *
         * The control-channel token is single-use and lives in this process's
         * memory, so a supervisor that lost its channel across a runner
         * restart can never re-authenticate: the container runs, the control
         * plane still reads `running`, and every turn dispatched to it fails
         * "sandbox was not reachable" — forever, because a `running` sandbox
         * is never re-started.
         *
         * Saying `stopped` is simply the truth from the control plane's point
         * of view, and it rejoins the ordinary wake path: the next message
         * flips it to `unprovisioned` and the start arm recreates the
         * container with a fresh token. No new recovery machinery.
         *
         * `awaitingConnection` is what keeps this from fighting a start: a
         * sandbox that has been handed a token but has not dialled in yet is
         * mid-boot, not stranded.
         */
        const channelless =
          !wsServer.connection(snapshot.sandboxId) &&
          !wsServer.awaitingConnection(snapshot.sandboxId);
        if (snapshot.running && channelless) {
          log("warn", "sandbox is running but has no control channel", {
            sandboxId: snapshot.sandboxId,
          });
          unreachable.push({
            kind: "sandbox.status",
            sandboxId: snapshot.sandboxId,
            status: "stopped",
          });
        } else if (!snapshot.running && channelless && !reportedDead.has(snapshot.containerRef)) {
          /**
           * DEAD BUT EXPECTED — the double-death shape: the container died
           * while THIS PROCESS was down (host reboot, docker restart), so the
           * channel close was never observed and no unhealthy/stopped report
           * ever fired. The control plane may still read `running` with a
           * turn in flight; left alone that turn waits out the whole ceiling.
           * Saying `stopped` once is the truth: the strand law then fails or
           * revives the in-flight turns, and a sandbox that was parked
           * DELIBERATELY absorbs the report as a no-op (the status guard).
           */
          reportedDead.add(snapshot.containerRef);
          log("warn", "sandbox container is dead with no channel; reporting", {
            sandboxId: snapshot.sandboxId,
          });
          unreachable.push({
            kind: "sandbox.status",
            sandboxId: snapshot.sandboxId,
            status: "stopped",
          });
        }
        continue;
      }
      log("info", "reaping orphaned sandbox", {
        sandboxId: snapshot.sandboxId,
      });
      try {
        await backend.stopSandbox(snapshot.containerRef);
        await backend.removeSandbox(snapshot.containerRef);
        sandboxContainers.delete(snapshot.sandboxId);
      } catch (error) {
        log("warn", "failed to reap sandbox container", {
          sandboxId: snapshot.sandboxId,
          error: String(error),
        });
      }
    }

    /**
     * VANISHED — this runner started it, the control plane still expects it,
     * and the backend has no record of it at all.
     *
     * The loop above can only judge a sandbox the backend still lists, so it
     * covers "running but unreachable" and "dead but expected" and nothing
     * else. A docker container that is killed still exists to be inspected,
     * so that was always enough. A CreateOS VM that is destroyed is simply
     * gone, and an in-flight turn against it would otherwise wait out the
     * whole ceiling with no report of any kind.
     *
     * Only sandboxes THIS process started are judged here. A sandbox the
     * control plane expects but that was never created belongs to the start
     * arm, not to reconcile, and `awaitingConnection` keeps a box that is
     * mid-boot from being declared gone.
     */
    for (const [sandboxId, containerRef] of sandboxContainers) {
      if (seen.has(sandboxId) || !expected.has(sandboxId)) continue;
      if (wsServer.awaitingConnection(sandboxId)) continue;
      if (reportedDead.has(containerRef)) continue;
      reportedDead.add(containerRef);
      log("warn", "sandbox vanished from the backend; reporting", {
        sandboxId,
        containerRef,
      });
      unreachable.push({
        kind: "sandbox.status",
        sandboxId,
        status: "stopped",
      });
    }

    // Volumes are reaped separately: a sandbox whose container was already
    // removed still leaves its (durable, deliberately persistent) home.
    for (const home of await backend.listHomes()) {
      if (expected.has(home.sandboxId)) continue;
      log("info", "reaping orphaned home", {
        sandboxId: home.sandboxId,
      });
      try {
        await backend.destroyHome(home.ref);
      } catch (error) {
        log("warn", "failed to reap home", {
          sandboxId: home.sandboxId,
          error: String(error),
        });
      }
    }

    if (unreachable.length > 0) await report(unreachable);

    // Last, so the owned truth settles first — and its internal try/catch
    // discipline means a sweep problem can never fail reconcile (or boot).
    await sweepStaleOrphans();
  };

  const tick = async (wait = POLL_WAIT_SECONDS): Promise<void> => {
    const items = await controlPlane.pollWork(wait, POLL_LIMIT);
    for (const item of items) {
      // Serialized on purpose: docker operations on one host contend, and a
      // burst of parallel image pulls is how a laptop falls over.
      await report(await execute(item));
    }
  };

  return {
    async start() {
      await backend.prepare();
      await wsServer.listen();

      const { runnerId } = await registerWithRetry(
        controlPlane,
        config.controlPlaneUrl,
        config.name,
        capabilities(),
      );
      registeredRunnerId = runnerId;
      log("info", "registered with control plane", {
        runnerId,
        backend: backend.id,
      });

      // Before ANY object is created or matched: the backend labels with the
      // control plane's stable id, so a restart still recognizes its own
      // containers and volumes (a per-process id would leak them silently).
      backend.identify(runnerId);

      await reconcile();

      heartbeatTimer = setInterval(() => {
        controlPlane.heartbeat(capabilities()).catch((error: unknown) => {
          log("warn", "heartbeat failed", { error: String(error) });
        });
      }, HEARTBEAT_MS);
      heartbeatTimer.unref?.();

      reconcileTimer = setInterval(() => {
        reconcile().catch((error: unknown) => {
          log("warn", "reconcile failed", { error: String(error) });
        });
      }, config.reconcileSeconds * 1000);
      reconcileTimer.unref?.();

      return runnerId;
    },

    tick,
    reconcile,
    containerRefOf: (sandboxId) => sandboxContainers.get(sandboxId),

    async run() {
      running = true;
      let backoff = RETRY_MIN_MS;
      while (running) {
        try {
          await tick();
          backoff = RETRY_MIN_MS;
        } catch (error) {
          if (!running) break;
          log("warn", "poll cycle failed", {
            error: String(error),
            retryInMs: backoff,
          });
          await sleep(backoff);
          backoff = Math.min(backoff * 2, RETRY_MAX_MS);
        }
      }
    },

    async stop() {
      running = false;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (reconcileTimer) clearInterval(reconcileTimer);
      await wsServer.close();
      // Sandboxes are deliberately left running: a stopped runner is a
      // restart, and parked-or-running are both safe states for a container
      // whose control plane will reconcile it on the next boot.
    },
  };
};
