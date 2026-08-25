# CreateOS sandbox networking

This document records how CreateOS private networks behave. Every statement
below is measured on live sandboxes with the `createos` CLI, not read from a
document. The measurements are dated 2026-08-24.

## Why this document exists

An earlier attempt to run the hosted end-to-end suite on the CreateOS backend
failed. Two sandboxes on the same private network could not reach each other.
The team recorded this as a CreateOS platform bug. It was not a platform bug.
The cause was an egress allowlist in onecli's own backend. See "Root cause"
below.

## The topology

Each sandbox gets one `eth0` with a `/31` point-to-point link to its host.
Everything else leaves through the default route.

```
   sandbox poc-a                          sandbox poc-b
  +----------------+                     +----------------+
  | eth0           |                     | eth0           |
  | 10.0.56.194/31 |                     | 10.0.16.60/31  |
  +-------+--------+                     +-------+--------+
          | default via 10.0.56.195              | default via 10.0.16.61
          v                                      v
  +---------------------------------------------------------+
  |                    CreateOS host fabric                  |
  |   1. private-network membership check   (src, dst) pair  |
  |   2. per-sandbox egress allowlist       (dst host:port)  |
  +---------------------------------------------------------+
```

A private network is not an extra interface. No second IP appears inside the
guest. The fabric decides which peers a sandbox can reach.

## The two rules

A packet from sandbox A to sandbox B passes only if BOTH rules pass:

1. **Membership.** A and B must share a private network.
2. **Egress.** If A has a non-empty egress allowlist, B's `host:port` must be
   a rule in that list.

Rule 2 is the one that surprised the team. The egress allowlist is NOT
bypassed for private-network peers.

## Measured results

| Case | A egress | Same network | ICMP | TCP |
|---|---|---|---|---|
| baseline | empty | yes | pass | pass |
| isolation | empty | no | blocked | blocked |
| live attach | empty | attached while running | pass | pass |
| **the trap** | `api.anthropic.com` | yes | blocked | blocked |
| fix, exact IP | `+ 10.0.16.60` | yes | pass | pass |
| fix, CIDR | `+ 10.0.0.0/8` | yes | pass | pass |
| fix, host:port | `10.0.16.60:8080` | yes | pass on 8080, blocked on 9999 | |

Facts that follow from the table:

- `createos sandbox network attach` takes effect at once. A restart is not
  necessary.
- An egress rule accepts a bare IP, a CIDR block, and a `host:port` pair.
- A `host:port` rule is port-scoped. Other ports on the same peer stay
  blocked.

## Egress rule forms

Only ONE rule form actually scopes to a port. The others are accepted
without complaint and then open every port on the host.

| Rule form | Accepted | What it really allows |
|---|---|---|
| `IP:8080` | yes | port 8080 only. Correct. |
| `IP` | yes | **every port** |
| `IP/32` | yes | **every port** |
| `IP:8080-8081` | yes | **every port**, not the range |
| `IP:*` | yes | **every port** |
| `example.com` | yes | that host only. `example.org` stays blocked. |

Two rules for one host coexist correctly: `IP:8080` plus `IP:9000` allows
8080 and 9000 and blocks 8081.

**Always emit `host:port`.** A bare IP or a `/32` looks tighter than it is.
A port range or a `*` looks like it scopes and does not. This is why
`deriveEgress` builds `hostname:port` for both the proxy and the control
channel.

Other facts:

- DNS is exempt. A sandbox resolves any name even when the allowlist holds
  one host. Only the TCP connection is filtered.
- A bare IP rule allows ICMP as well as TCP.
- `firewall set <box>` with no rules is rejected. It is neither allow-all nor
  deny-all, and the existing list stays unchanged.
- `firewall clear <box>` restores full reachability, peers and internet both.

## Join the network at create time, never by a later attach

`createos sandbox network attach` works for a sandbox with an EMPTY egress
list. It does not work correctly for a sandbox that has one.

Measured: a sandbox created first and attached afterwards had every
peer-targeted rule fail, including the explicitly allowlisted port. Traffic
returned only after `firewall clear`. The same sandbox recreated with
`--network` at create time worked at once, and repeatedly.

**onecli must pass the network in the create call.** Never create first and
attach after.

## Isolation holds structurally, not just by policy

A sandbox is never Layer-2 adjacent to another sandbox. Its only neighbour on
the `/31` link is the fabric router. A test tried to bridge two isolated
networks through a sandbox that was a member of both:

- `ip route add <target> via <dual-homed-peer>` was rejected by the guest
  kernel itself: `Nexthop has invalid gateway`.
- Forcing it with `onlink` was accepted, but the packet went nowhere. ARP for
  the peer stayed `FAILED` and `arping` got no reply.
- `net.ipv4.ip_forward` is off by default. The sysctl is permitted, but
  turning it on changed nothing, because the traffic never reached the
  dual-homed sandbox at all.

A sandbox that joins two networks still gets ONE `eth0` and ONE IP. Both
networks list it under that same address. Multi-network membership is
resolved upstream in the fabric.

This matters for onecli: two customers' agent sandboxes on different networks
cannot reach each other, and no guest-side misconfiguration changes that.

## Scale and performance

Measured with six sandboxes on one network, all 30 directed pairs reachable:

- **Spawn time depends on shape.** `s-1vcpu-1gb` took 0.6 to 3.3 seconds.
  `s-8vcpu-16gb` took 24 to 32 seconds. A spawn timeout must allow for the
  larger figure.
- **Peer latency depends on placement.** Peers on the same host answered in
  1.3 ms. Peers on another host took 38 to 43 ms. The private network hides
  the difference, so an IP address does not tell you which case you have.
- **Throughput** between two `s-8vcpu-16gb` sandboxes was 65.7 MB/s.

## Nothing about an IP address is stable

| Event | IP | Network membership | Firewall rules |
|---|---|---|---|
| pause, then resume | **changes** | survives | survive |
| fork | new IP | **not inherited** | not inherited |
| running process | — | — | survives pause/resume and fork |

Firewall rules are IP literals. They do not track a peer's identity. So when
a peer sandbox is paused and resumed, every rule that named its old IP goes
stale without any error. The traffic simply times out.

**The rule for onecli:** never cache a sandbox IP across a pause, a resume,
or a fork. Read it again from `createos sandbox network show`, and re-issue
`firewall set` with the fresh value.

This applies to the runner too. A spawned sandbox holds an allowlist that
names the runner's IP at spawn time. If the runner moves, sandboxes that
wake later cannot reach it. Re-assert the allowlist on wake, or give the
runner a stable address.

## A parked VM leaves a half-open control channel

This one cost a full debugging session. Record it.

When the runner parks an agent, it pauses the VM. The VM stops answering,
but its WebSocket to the runner sends no FIN. The runner keeps that socket
and goes on believing the supervisor is connected. Measured: the socket
stayed in the map for the whole run and never closed on its own.

Two failures followed, both silent:

- Every turn dispatched to that agent went into a socket nobody reads. The
  turn never settled and the test timed out.
- The reconcile that recovers a stranded sandbox asks whether a control
  channel exists. It was told yes. It did nothing.

A microVM differs from a container here. A container that stops closes its
socket. A paused microVM is frozen, so nothing closes anything.

The fix is a heartbeat. The runner pings an idle channel every 10 seconds
and terminates a peer that misses two pings. `connection()` also refuses a
socket that is not `OPEN`. See `apps/runner/src/ws/server.ts`.

Each channel now carries a sequence number in its connect and close logs.
During a wake the old VM and the new one overlap, so the sandbox id alone
cannot say which socket an event belongs to. Read the `seq` field first
when reading these logs.

## Spawn time is not a constant

A spawn is not a container start. Measured spawn times ranged from 0.6
seconds to 97 seconds for the same shape and template, decided by host
placement. Two spawns plus a park do not reliably fit in a 120-second test
timeout.

Any timeout that assumed container speed must be raised for this backend.

## Name resolution does not work

The CLI prints "Other sandboxes on this network can now reach this one by
name" after an attach. This is not true today. The sandbox resolver at
`169.254.20.10` answers public names but holds no sandbox records.

Names tested, all `NXDOMAIN`: `poc-b`, `poc-b.poc-net`, `poc-b.internal`,
`poc-b.sandbox`, `poc-b.createos`, the raw sandbox id, and the sandbox id
with the network suffix.

Use member IP addresses from `createos sandbox network show <net>`. A
sandbox IP changes when the sandbox is paused and resumed, so read the IP at
spawn time. Do not cache it.

## Root cause of the earlier failure

`deriveEgress` in `apps/runner/src/backend/createos/createos-backend.ts`
built the allowlist from `HTTPS_PROXY` only. The agent supervisor also opens
a WebSocket back to the runner at `RUNNER_WS_URL`, which is a different port.
That port was never allowlisted.

The code comment stated that private-network membership is evaluated before
the egress chain, so the control channel needed no rule. The table above
shows the opposite. The sandbox started, joined the network, and then dropped
its own control-channel packets.

The fix adds `RUNNER_WS_URL` to the derived allowlist. `deriveEgress` now
refuses a spawn payload that carries no `RUNNER_WS_URL`, because such a
sandbox boots and never reaches the runner.

## How to reproduce the measurements

```bash
createos sandbox network create poc-net
createos sandbox create --shape s-1vcpu-1gb --name poc-a --rootfs debian:13 --network poc-net
createos sandbox create --shape s-1vcpu-1gb --name poc-b --rootfs debian:13 --network poc-net
createos sandbox network show poc-net          # read both member IPs

createos sandbox exec poc-b -- sh -c 'echo ok > /tmp/index.html; busybox httpd -p 8080 -h /tmp'
createos sandbox exec poc-a -- sh -c 'curl -sS --max-time 8 http://<B_IP>:8080/'

# Now break it the way the backend broke it:
createos sandbox firewall set poc-a api.anthropic.com
createos sandbox exec poc-a -- sh -c 'curl -sS --max-time 8 http://<B_IP>:8080/'   # times out

# And fix it:
createos sandbox firewall set poc-a api.anthropic.com <B_IP>:8080
createos sandbox exec poc-a -- sh -c 'curl -sS --max-time 8 http://<B_IP>:8080/'   # ok
```

The `debian:13` rootfs has no `ping`, no `nc`, and no `python3`. It does have
`busybox` and `curl`. Use `busybox ping` and `busybox httpd`.

`createos sandbox exec` needs a `--` separator and a shell when the command
contains shell syntax: `createos sandbox exec <box> -- sh -c '<script>'`.
A background process started by `exec` survives after that `exec` returns.

`createos sandbox network detach` needs its `--yes` flag BEFORE the
positional arguments. `detach <net> <box> --yes` fails and asks for `--yes`,
which is already there. Write `detach --yes <net> <box>`.

## Open items for the CreateOS team

1. **A port range and a `*` in an egress rule silently open every port.**
   `IP:8080-8081` and `IP:*` are accepted with no error and then allow all
   ports. An operator who writes a range believes the sandbox is scoped to
   two ports. It is scoped to none. This is a security gap, not a cosmetic
   one. Either enforce the form or reject it.
2. **`network attach` after create breaks egress enforcement for that peer.**
   A sandbox attached after creation drops traffic to the peer even on an
   explicitly allowlisted port. Only `firewall clear` restores it. Joining
   at create time works.
3. **Name resolution does not exist.** The CLI prints "Other sandboxes on
   this network can now reach this one by name" after an attach. No such
   records are served. Either implement them or correct the message.
4. **`network detach` needs `--yes` before its positional arguments.**
   Putting it after gives the error "pass --yes to confirm detach" while
   `--yes` is present on the line.
