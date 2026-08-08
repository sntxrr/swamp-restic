# swamp-restic

restic backup repositories as typed, queryable [swamp](https://swamp-club.com)
resources — and, more to the point, **proof that they can actually be
restored**.

Companion to [`swamp-backblaze`](https://github.com/sntxrr/swamp-backblaze),
which inventories the Backblaze B2 estate these repositories live in.

## Why

A homelab backs up 15 hosts nightly with restic. Every night each host runs
`backup`, then `forget --prune`, then `check`. That is a real backup system, and
it still does not prove the backups can be restored:

- `restic check` without `--read-data` verifies **structure only**. It never
  downloads a pack, so it cannot see bitrot. Nothing in the fleet had ever run
  `--read-data`.
- **No restore had ever been executed.** The restore directory was created empty
  on every host and never used again.
- Verification ran **on the host being backed up**, so it could not tell "the
  repository is intact" from "this host can still reach its own repository" —
  and proved nothing about recovery after the host is gone.
- A host whose timer silently stopped backing up produced **no signal at all**:
  a unit that never runs never fails.

The goal is one sentence: **if the backups cannot be restored, then I do not
have backups.**

## Design

Read-only, and structured as a cost-ordered **validation ladder**. Each rung is
a method, each writes its own resource, and a rung that has never run is itself
a finding:

| Rung      | Proves                                                            |
| --------- | ----------------------------------------------------------------- |
| `scan`    | Reachable and recent; records paths, hostnames, size, format      |
| `check`   | Index, trees and pack metadata are coherent                       |
| `verify`  | Pack _contents_ match their hashes — the bitrot check             |
| `dump`    | A known file streams out with the expected content                |
| `restore` | A subtree materialises on a foreign machine and passes `--verify` |

Two rules shape everything else:

**It runs where the hosts are not.** Validation executes on a machine that is
not in the backup fleet, on a different OS and architecture, using only
credentials from a vault. A restore that succeeds there is the only kind that
proves host-loss recovery.

**It can never break what it validates.** Every restic write command is refused
at the runner, and every invocation passes `--no-lock` — because `restic check`
takes an _exclusive_ lock, so a validator that locks a repository at the wrong
moment does not merely fail, it makes the owning host's nightly backup fail.

See [`PRD.md`](./PRD.md) for scope and [`CONVENTIONS.md`](./CONVENTIONS.md) for
the implementation contract and every live-verified restic trap.

## Extensions

| Extension                                                             | Purpose                                          |
| --------------------------------------------------------------------- | ------------------------------------------------ |
| [`@sntxrr/restic-repository`](./extensions/models/restic-repository/) | Validate one restic repository — the full ladder |

One model instance per repository. Credentials are per-repository and arrive as
`globalArguments` resolved from a vault, which already implies it; the
per-instance lock makes it mandatory, since a read-data check runs for minutes
and eighteen repositories behind one lock would serialise into hours.

## Credentials

Each instance takes a repository password and a B2 key pair, wired from a vault
— never inline.
[`@sntxrr/1password-connect`](https://github.com/sntxrr/swamp-1password-connect)
reads 1Password Connect over plain HTTP and so works headless, in cron, in
containers, and under `swamp serve`.

Validation keys should carry **only** `listBuckets`, `readBuckets`, `listFiles`
and `readFiles` — mint them per bucket with
[`@sntxrr/b2/key`](https://github.com/sntxrr/swamp-backblaze). A validation
suite holding delete rights over the backup it is validating is a standing risk
for no benefit.

Credentials reach restic through the environment only. A secret appearing in a
process argument is refused before the process spawns, because `ps` is
world-readable, and restic's stderr is redacted before it reaches a resource
snapshot or a log line.

## A note on cost

Rungs 1, 2 and 4 are effectively free. Rungs 3 and 5 move data and are billed as
B2 egress and class-B transactions, so both are bounded: `verify` uses restic's
deterministic `n/t` partition form to cover the whole repository over a rotation
rather than re-reading a random tenth, and `restore` is scoped to a subtree
under a byte ceiling enforced **before** any data moves. An unmeasurable size
fails closed — a refused drill costs nothing.

## restic version floor

The validator runs the upstream binary (0.19.1), not a distro package, because
the features it depends on landed late: `check --json` needs 0.18.0, exit codes
10/11/12 need 0.17.x, and the dry-run restore used to size a drill needs 0.17.0.
A newer restic reads older repositories; the reverse is not true. Constraining
the backup side to distro packages is fine — constraining the validator is not.

## Status

`@sntxrr/restic-repository` is **published** at `2026.08.07.2` (quality A, 100%,
repository verified) and **live-verified** against a real repository: 60 unit
tests plus 22 mechanical checks, every guard mutation-tested, adversarial review
gate clean. The fleet workflow and the `readiness` findings report are designed
(PRD §8–9) and not yet built.

## License

MIT
