# `@onecli/runner`

The daemon that gives a hosted agent a computer: it registers with the control
plane, long-polls for work, and starts, parks, and reaps agent sandboxes.

It is **outbound-only** — it holds no ports the outside world can reach, so a
laptop, a homelab, or a VPC behind NAT all work with no ingress, no tunnel, and
no TLS termination story. It also never touches the database: the migrations
one-shot owns migrations, the api every read.

## The shape

```
control plane  ──(runner long-polls: work in, events out)──  runner
                                                               │  docker socket
                                                               ▼
                                                       agent sandbox
                                                     (internal network)
                                                               │
                                                     the gateway, only
```

Three pieces:

- **`backend/`** — the `SandboxBackend` seam. `docker/` is the only place a
  container runtime is named; `fake.ts` is an in-memory implementation the
  whole loop is tested against. A new substrate (Fly, k8s, microVMs) is a new
  module plus one line in `index.ts`.
- **`ws/`** — the control channel a sandbox's supervisor dials, authenticated
  by a single-use bootstrap token minted per spawn.
- **`runner.ts`** — the loop: poll → execute → report, plus the reconcile pass
  that destroys anything the control plane no longer knows about (which is how
  deleting an agent reaches the compute plane).

## Running it locally

`pnpm dev` runs it, along with web, api and the gateway:

```bash
pnpm agent:build   # once — builds the sandbox image the runner spawns
pnpm dev           # web :10254  api :10256  gateway :10255  runner :8484
```

(With Docker off, `pnpm dev` runs everything else and says the runner was
skipped; without the image built, it offers the one-time build right there —
declining still runs everything else.)

The host-shaped settings a non-container runner needs — the advertised host a
sandbox dials back on, a routable sandbox network, the image tag — are built
into the `pnpm dev` launcher as defaults, so your own `.env` still wins. The
dev `RUNNER_TOKEN` is minted once into `.env`, because the api-server and the
runner must present the same value.

`RUNNER_NETWORK_INTERNAL=false` (the launcher's dev default) is a
**development-only** setting:
it lets the sandbox reach a gateway running on the host. In any real deployment
it stays `true` — an `internal` network with the gateway dual-homed onto it is
what makes gateway-only egress a boundary rather than a suggestion.

The runner has no file watcher on purpose. Restarting it makes the control
plane fail every in-flight turn (the sandbox's control channel dies with the
process, and its bootstrap token was single-use), so a save mid-conversation
would end the conversation. Restart it by hand when you change it.

The full-stack version of this (build → up → create a hosted agent → watch it
start) lives in `apps/hosted-e2e` — the black-box suite that spawns a real
gateway, api-server, this runner, and real sandbox containers per test, plus a
cold-`docker compose up` smoke lane. The hand-run `dev/*.sh` proof scripts
that used to live here were removed: nothing ran them, so four of the six had
silently rotted — the automated suite is the only form of this worth keeping.

## In compose

The runner is the stack's opt-in fifth service. It stays out of a plain
`docker compose up` until the install's `.env` says otherwise:

```
COMPOSE_PROFILES=runner
```

`install.sh` provisions `RUNNER_TOKEN` and `DOCKER_GID` regardless, so
enabling it is that one line.

## Configuration

Every address is configuration with a local default. The ones that matter:

| Variable                      | Default                  | What it does                                          |
| ----------------------------- | ------------------------ | ----------------------------------------------------- |
| `RUNNER_TOKEN`                | _(required)_             | Its credential, and the registration anchor           |
| `RUNNER_CONTROL_PLANE_URL`    | `http://localhost:10256` | Where it polls                                        |
| `RUNNER_BACKEND`              | `docker`                 | `docker`, `createos` or `fake` — config, never detection |
| `RUNNER_AGENT_IMAGE`          | `onecli-agent:dev`       | The sandbox base image                                |
| `RUNNER_SANDBOX_NETWORK`      | `onecli-sandboxes`       | The isolated network sandboxes join                   |
| `RUNNER_NETWORK_INTERNAL`     | `true`                   | `true` = that network has NO route out (dev-only off) |
| `RUNNER_ADVERTISED_HOST`      | `runner`                 | How a sandbox addresses this runner's channel         |
| `RUNNER_MAX_SANDBOXES`        | `4`                      | Concurrency cap, also reported to placement           |
| `RUNNER_RECONCILE_SECONDS`    | `60`                     | How often orphans are reaped                          |
| `RUNNER_ORPHAN_REAP`          | `true`                   | The stale-label sweep (below); `false` = log only     |
| `RUNNER_ORPHAN_GRACE_SECONDS` | `3600`                   | Minimum age before a stale-label object may be reaped |

Sandbox resource limits: `RUNNER_SANDBOX_MEMORY_MB` (2048),
`RUNNER_SANDBOX_CPUS` (1), `RUNNER_SANDBOX_PIDS` (512). On plain Linux, where
`host.docker.internal` does not resolve inside a container,
`RUNNER_SANDBOX_EXTRA_HOSTS=host.docker.internal:host-gateway` adds it to every
sandbox's `/etc/hosts` (dev setups where the gateway runs on the host).

## The CreateOS backend

`RUNNER_BACKEND=createos` puts each sandbox in a Firecracker microVM instead of
a local container. Nothing above the seam changes — not the api, not the
supervisor, not the image.

```
 ┌─ onecli infra ──────────┐   ┌─ CreateOS ──────────────────┐
 │  api ◄── long-poll ─────┼───┼── runner (no docker)        │
 │  gateway ◄── TLS ───────┼───┼── agent VMs ──┐             │
 └─────────────────────────┘   │      overlay ─┘             │
                               └─────────────────────────────┘
```

The runner runs as a CreateOS sandbox itself, on the same overlay network as
the agents. That is what keeps its control channel private: overlay membership
is an eBPF `(src, dst)` pair allowlist, so a sandbox reaches the runner with no
public port and no VPN on anybody's laptop. Traffic OUT still goes only to the
gateway, now by per-VM iptables allowlist rather than by an unroutable network.

Three things work differently, and all three are deliberate:

- **The egress allowlist is derived, never configured.** It is read from the
  `HTTPS_PROXY` the control plane already put in the spawn payload, so it can
  never drift from the proxy the agent was told to use. A payload with no
  parseable proxy is refused rather than defaulting to open.
- **The env arrives as a file.** CreateOS caps a persistent env value at 4096
  bytes and `AGENT_INSTRUCTIONS` can exceed it. A side effect is that the
  single-use channel token never reaches the CreateOS database at all.
- **Homes are archived, not mounted.** A microVM takes no volume, and the
  runner recreates the VM on every start anyway. The home is captured at stop
  and restored at create, `tar` through `zstd`, capped at 500 MB compressed by
  the files endpoint. This backend therefore reports `snapshot` durability: a
  VM lost without a stop loses what it wrote since its start.

| Variable                            | Default                  | What it does                              |
| ----------------------------------- | ------------------------ | ----------------------------------------- |
| `RUNNER_CREATEOS_BASE_URL`          | _(required)_             | CreateOS control plane                    |
| `RUNNER_CREATEOS_API_KEY`           | _(required)_             | Its credential                            |
| `RUNNER_CREATEOS_NETWORK`           | `onecli-sandboxes`       | Overlay network; created if absent        |
| `RUNNER_CREATEOS_HOMES_DIR`         | `/var/lib/onecli/homes`  | Where homes live — MUST be durable        |
| `RUNNER_CREATEOS_SHAPE`             | _(auto)_                 | Empty = smallest shape meeting the limits |
| `RUNNER_CREATEOS_EXTRA_EGRESS`      | _(none)_                 | Extra `host:port` rules, added to the derived one |
| `RUNNER_CREATEOS_AUTO_PAUSE_SECONDS`| `0`                      | `0` = never; otherwise 60–86400           |

`RUNNER_CREATEOS_HOMES_DIR` is the one that bites. A runner redeploy recreates
the runner's own VM, so without a durable disk mounted there, that single event
erases every agent's home at once.

`RUNNER_AGENT_IMAGE` names a CreateOS template rather than a Docker tag. Build
one with `pnpm agent:template <rootfs-tarball-url>`; see that script's header
for why the agent Dockerfile cannot be submitted directly.

## Sizing

A sandbox is a real container with real limits, so a host's ceiling is
arithmetic, not vibes:

```
RUNNER_MAX_SANDBOXES × RUNNER_SANDBOX_MEMORY_MB  +  the base stack
```

The default 4 × 2 GiB means a host should have **~10 GiB free** beyond
postgres, the gateway, the api, and the web app before raising the cap. CPU is
softer (1 vCPU per sandbox is a share, not a reservation), and each home
volume grows with whatever the agent keeps on disk.

**Held-awake boxes are the number to respect.** A sandbox observing live
background work — a running process, an armed watch — never parks, so it holds
its slot _permanently_, not just at peak: size `RUNNER_MAX_SANDBOXES` to what
the host can hold **all the time**, not to peak concurrency. The platform
bounds this with a per-runner ceiling — `max(1, RUNNER_MAX_SANDBOXES − 1)` by
default, overridable with `MAX_HELD_AWAKE_SANDBOXES` on the api — evicting the
longest-idle held box over the ceiling (its watches report "the process was
lost" honestly), so background work can never wedge the whole host. Operators
can read the per-runner count beside the ceiling on `GET /v1/runners`.

## Orphan reaping

Reconcile destroys anything **this** runner's label owns that the control
plane no longer knows — that is how deleting an agent reaches the compute
plane. Objects labeled by a runner id that no longer exists (a control-plane
database reset, a rotated runner registration) are invisible to that loop, so
a second sweep handles them: every container and volume **this installation**
created whose sandbox id exists **nowhere** in the control plane, and which is
older than `RUNNER_ORPHAN_GRACE_SECONDS`, is removed. The control plane is
asked first and any failure aborts the sweep with zero destruction;
`RUNNER_ORPHAN_REAP=false` turns it into detection-and-logging only.

The sweep is **safe on a shared Docker daemon**: every object is stamped with
an installation fingerprint (a hash of the runner token — stable across a
database reset, different per install), and the sweep only ever reaps objects
bearing its own. Two OneCLI installs on one host, or the e2e suite running
beside a live dev stack, never touch each other's containers or volumes.

## Tests

`pnpm --filter @onecli/runner test` — the whole loop runs against the fake
backend and a recording HTTP transport, so no daemon, image, or privilege is
needed.
