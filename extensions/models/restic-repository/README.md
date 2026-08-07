# @sntxrr/restic-repository

Validate one [restic](https://restic.net) repository **from a neutral host**.

A nightly `restic check` on the machine being backed up proves the repository's
metadata is coherent and that this host can still reach its own bucket. It does
not prove the data is intact, and it proves nothing about recovery after the
host is gone. This model closes that gap: it runs somewhere else, using only
credentials from a vault, and it measures whether a restore actually works.

**It is strictly read-only.** Every restic write command — `backup`, `forget`,
`prune`, `init`, `key`, `copy`, `repair` — is refused at the runner, and every
invocation passes `--no-lock`. Both are enforced in code and asserted by
mutation-tested cases, because the failure mode is severe: `restic check` takes
an **exclusive** lock, so a validator that locks a repository at the wrong
moment does not merely fail, it makes the owning host's nightly backup fail.

## The validation ladder

Each method is one rung, ordered by cost. Each writes a `validation` resource so
a report can rank what has and has not been proven.

| Rung | Method    | Proves                                                                 | Cost             |
| ---- | --------- | ---------------------------------------------------------------------- | ---------------- |
| 1    | `scan`    | Reachable, decryptable, recent; records paths, hostnames, size, format | ~free            |
| 2    | `check`   | Index, trees and pack metadata are coherent                            | metadata only    |
| 3    | `verify`  | Pack _contents_ match their hashes — the bitrot check                  | egress ∝ subset  |
| 4    | `dump`    | A known file streams out with the expected content                     | one file         |
| 5    | `restore` | A subtree materialises on a foreign machine and passes `--verify`      | egress ∝ subtree |

Plain `check` **never downloads a pack**, so it cannot detect bitrot. Only
`verify` can. Do not read a passing `check` as proof the data is intact — it is
proof the metadata is coherent, which is a different fact.

## Setup

```bash
swamp model create @sntxrr/restic-repository heron-backups \
  --global-arg 'repository=s3:s3.us-west-002.backblazeb2.com/heron-debian' \
  --global-arg 'password=${{ vault.get(onepassword, restic-heron-debian/restic-password) }}' \
  --global-arg 'accessKeyId=${{ vault.get(onepassword, restic-heron-debian/keyID) }}' \
  --global-arg 'secretAccessKey=${{ vault.get(onepassword, restic-heron-debian/applicationKey) }}' \
  --global-arg 'cacheDir=/var/tmp/restic-cache/heron-debian' \
  --global-arg 'expectedPaths=["/etc","/root","/var/lib/docker"]'
```

**One model instance per repository.** Credentials are per-repository, and swamp
holds a model's lock for a method's entire duration including subprocess time —
a read-data check runs for minutes, so many repositories under one instance
would serialise into hours. Separate instances run in parallel.

## Methods

### `scan` — rung 1

```bash
swamp model method run heron-backups scan
swamp model method run heron-backups scan --input mode=detailed
```

Writes one `repository` resource. In `detailed` mode it also emits one
`snapshot` resource each (capped by `maxSnapshots`, default 200); the default is
`aggregate` because a repository holds tens to hundreds of snapshots.

Records, among other things:

- `latestSnapshotAgeHours` and `stale`
- `missingPaths` / `scopeDrift` — expected paths absent from the **latest**
  snapshot. A repository's `paths` genuinely change over its life, and a restore
  from a snapshot taken before a path was added silently yields an incomplete
  host. Nothing else reports this.
- `hostnames` / `hostnameDrift` — more than one hostname means the machine was
  renamed, splitting the history for anything that filters by `--host`.
- `repositoryFormatVersion`, `writerVersions` — a version floor is a
  restorability constraint.

An unreachable repository is **recorded, not thrown**: a thrown error writes no
resource and a fleet report then cannot see the repository at all.

### `check` — rung 2, and `verify` — rung 3

```bash
swamp model method run heron-backups check
swamp model method run heron-backups verify --input subset=1/7
```

`subset` accepts restic's `n/t` (deterministic partition, `t` ≤ 256), `x%`, or a
byte size such as `500M`. **Prefer `n/t`** and rotate `1/7` … `7/7`: a random
10% every night re-reads the same tenth by chance and never converges on full
coverage, while the partition form covers the whole repository across a week.

A lock conflict, cancellation or timeout is recorded as `inconclusive`, never as
a failure — recording one as "check failed" reports a healthy repository as
broken.

### `dump` — rung 4

```bash
swamp model method run heron-backups dump \
  --input path=/etc/hostname \
  --input expectedSha256=<hash>
```

Streams one known file and hashes the raw **bytes** (decoding a possibly-binary
canary as UTF-8 before hashing would corrupt the comparison). With
`expectedSha256` the rung fails on any mismatch.

### `restore` — rung 5

```bash
swamp model method run heron-backups restore \
  --input path=/etc \
  --input target=/var/tmp/drills/heron-debian
```

The size ceiling (`maxRestoreBytes`, default 1 GiB) is measured with a **dry-run
restore** and enforced **before any data moves**, so a refused drill costs
nothing. It is deliberately not measured with `restic stats`: `stats` rejects
the `<snapshot>:<subfolder>` selector and then exits 0 reporting
`total_size: 0`, which would make the ceiling pass for any size at all. If the
size cannot be measured the restore is **refused**, because an unmeasurable size
must never read as a safe one. Raise it **per run** with
`--input maxRestoreBytes=<n>` rather than permanently on the model.

`itemsRestored` is restic's own count and includes directories and symlinks — it
is not a count of regular files on disk.

### `unlock` — the one permitted mutation

```bash
swamp model method run heron-backups unlock --input allowUnlock=true
```

Removes only **stale** locks (older than 30 minutes). `unlock --remove-all` is
deliberately unavailable: it deletes locks held by running backups.

The acknowledgement is read in `execute`, not in a pre-flight check, because
swamp never passes method inputs to checks — a check gating on `allowUnlock`
would reject `--input allowUnlock=true` and force the flag to be armed
permanently on the model definition, firing on the safe configuration and
passing on the dangerous one.

## restic version requirements

Run an **upstream** restic on the validating host, not a distro package. The
features this model relies on landed late, and Debian 12 ships 0.14.0 while
Ubuntu 24.04 ships 0.16.4:

| Feature                                      | Needs         |
| -------------------------------------------- | ------------- |
| `check --json` (rungs 2 and 3)               | **0.18.0**    |
| `restore --json` (rung 5)                    | 0.16.0        |
| Exit codes 10 / 11 / 12 for classification   | 0.17.0–0.17.1 |
| `restore --verify`                           | 0.9.2         |
| `restore --dry-run` (the restore size guard) | **0.17.0**    |

Below 0.17.0 every failure collapses to exit 1; the model falls back to matching
restic's stderr prose, but classification is less reliable. A newer restic reads
older repositories without issue — the reverse is not true, and repository
format v2 (default since 0.14.0) cannot be opened at all by restic ≤ 0.13. Point
`resticBinary` at the upstream build.

## B2 capabilities required

Only read capabilities: `listBuckets`, `readBuckets`, `listFiles`, `readFiles`.

A validation key must **not** carry `writeFiles` or `deleteFiles`. The model
cannot issue a restic write command, but a key that cannot delete is a stronger
guarantee than a model that chooses not to.

## Secrets

`password` and `secretAccessKey` are `sensitive` and must be wired from a vault,
never inline. They reach restic through the subprocess **environment** only —
never argv, which is world-readable via `ps`. The runner refuses to execute if a
credential appears in the argument list, builds the child environment with
`clearEnv` so nothing else leaks in, and redacts credentials out of captured
stderr before it can reach a resource snapshot.

## Set `cacheDir`

restic writes a local cache. Across many repositories it adds up, and under
`clearEnv` the default has nothing useful to inherit. Give each instance its own
path.
