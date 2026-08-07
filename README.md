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

## Status

`@sntxrr/restic-repository` is built and **live-verified** against a real
repository: 51 tests, quality 14/14, every guard mutation-tested. The fleet
workflow and the `readiness` findings report are designed (PRD §8–9) and not yet
built.

## License

MIT
