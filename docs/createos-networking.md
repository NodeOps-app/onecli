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

## Open item for the CreateOS team

Name resolution inside a private network is advertised by the CLI but not
implemented. Either implement the records or correct the CLI message.
