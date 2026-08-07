# PRD — restic Restore-Validation Suite

**Lead-owned.** Scope authority. For implementation detail, `CONVENTIONS.md`
wins.

Companion to [`swamp-backblaze`](https://github.com/sntxrr/swamp-backblaze),
which landed first and inventories the B2 estate these repositories live in.

---

## 1. Why

The homelab backs up 15 hosts nightly with restic into per-host Backblaze B2
buckets. The `restic` role in `~/git/ansible-server-setup` runs, at 00:00 local
on every host, in one process:

```
restic backup <paths> --exclude-file=/etc/restic-excludes.conf
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --keep-yearly 3 --prune
restic check
```

That is a real backup system and it works. What it does **not** do is prove the
backups can be restored:

- `restic check` with no `--read-data` verifies **structure only** — index,
  trees and pack metadata coherence. It never downloads a pack, so it cannot see
  bitrot or silent corruption in the stored data. Nothing in the fleet has ever
  run `--read-data` or `--read-data-subset`.
- **No restore has ever been executed.** `restic restore` appears in zero files
  in the ansible repo. `restic_restore_dir` (`/opt/restic/restores`) is created
  empty on every host and never used again.
- Verification runs **on the host being backed up**, using that host's own
  credentials and cache. It therefore cannot distinguish "the repository is
  intact" from "this host can still reach its own repository" — and it proves
  nothing about recovery after the host is gone, which is the only scenario that
  matters for the six off-site VPS hosts that have no other copy.
- Failure signalling is systemd `OnFailure=` → SMTP. There is no staleness
  alarm: a host whose timer silently stops backing up produces **no signal at
  all**, because a unit that never runs never fails.

The driving goal is one sentence: **if the backups cannot be restored, then I do
not have backups.** This suite exists to convert that from an assumption into a
measured, dated, queryable fact.

### The gap is already demonstrated, not hypothetical

A read-only drill from a neutral host on 2026-08-07 (see §7) found, on the first
repository examined:

- The set of backed-up **paths silently changed twice**. For most of the
  repository's history only one of the three configured paths was captured; the
  full set has been backed up for **10 days**. Every snapshot older than that
  restores an incomplete host, and nothing anywhere reports this.
- The **hostname recorded in snapshots changed and changed back**, splitting one
  repository's history across two identities — invisible to any check that does
  not compare snapshots to each other.

Both are the kind of defect that a structural `check` passes cleanly.

## 2. Scope

**In:** read-only validation of restic repositories from a **neutral host**,
structured as a cost-ordered ladder (§4), plus the reconciliation and findings
report that ranks what is unproven.

**Out — deliberately, and this is the load-bearing boundary:**

- **`backup`, `forget`, `prune`, `init`, `key` management.** The ansible role
  owns the write path and keeps owning it. Two systems mutating the same
  repositories on overlapping schedules is a way to lose backups, not to
  validate them. This suite must never be able to destroy what it is checking.
- **Retention policy changes.** A finding may report that retention looks wrong;
  remediation is an ansible change.
- **The B2 control plane.** Buckets, keys and lifecycle rules belong to
  `@sntxrr/b2-*`. This suite consumes that inventory, it does not duplicate it.

The one mutation permitted anywhere in the suite is `unlock`, gated behind an
explicit acknowledgement, because a stale lock left by a killed process is the
one failure a read-only tool cannot route around.

## 3. Design stance

Inherited from the B2 suite and re-validated here:

**Decompose by object domain, not by command.** One model owns one restic
repository. Its methods are the ladder rungs. A flat wrapper of restic's ~30
subcommands would not be a factory and would not compose.

**One model instance per repository.** Credentials are per-repository and there
is no runtime vault-read API for models, so credentials arrive as
`globalArguments` resolved from the vault — which already implies one instance
per repository. The per-instance lock makes that mandatory rather than merely
tidy: swamp holds a model's lock for the whole duration of a method, including
awaited subprocess time, and a read-data check on a large repository runs for
minutes. Eighteen repositories validated by one looping instance would serialise
into hours under a single lock; eighteen instances run in parallel.

**Cross-repository work is a workflow, and cross-model analysis is a report.** A
method-scope report can only ever read its own execution's data; the workflow
report context is the only seam where several models' outputs can be joined.
Fleet reconciliation is therefore a workflow-scope report, exactly as
`@sntxrr/b2/fleet-hygiene` is.

**The suite runs where the hosts are not.** Validation executes on an always-on
Mac mini that is not in the backup fleet and not in the ansible inventory. That
is not incidental — a restore that succeeds on a _different_ machine, on a
_different_ architecture and OS, using only credentials from 1Password, is the
only kind that proves host-loss recovery. It also means the validator runs an
upstream restic binary independent of what the fleet's distro packages ship
(§6).

## 4. The validation ladder

Rungs are ordered by cost. Each writes its own resource so a report can rank
what has and has not been proven, and each is independently runnable.

| # | Rung          | Method    | Proves                                                                                                                        | Cost                 |
| - | ------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1 | **Freshness** | `scan`    | The repository is reachable, decryptable, and has a recent snapshot; records paths, hostnames, sizes, repo format             | ~free                |
| 2 | **Structure** | `check`   | Index, trees and pack metadata are coherent — what the fleet already does nightly, but from outside                           | cheap, metadata only |
| 3 | **Data**      | `verify`  | Pack _contents_ match their hashes — the bitrot check nothing has ever run                                                    | egress ∝ subset size |
| 4 | **Canary**    | `dump`    | A known small file streams out of the latest snapshot with the expected content: decryption and the data path work end to end | one file             |
| 5 | **Restore**   | `restore` | A scoped subtree materialises on a foreign machine and passes `--verify`                                                      | egress ∝ subtree     |

Rungs 3 and 5 are the ones that carry real cost and real proof. Rung 3 uses
restic's deterministic `n/t` partition form so that the whole repository is
covered over a rotation (`1/7` … `7/7`) rather than repeatedly re-reading a
random tenth. Rung 5 is scoped to a subtree with a byte cap by default (§5).

**A rung that has never run is a finding.** The headline finding of the whole
suite is `restore-never-proven`, and on day one it fires for every repository.

## 5. Guards and constraints

- **`--no-lock` is mandatory on every read.** `restic check` takes an
  **exclusive** lock, and has in every restic version. A validator that locks a
  repository at the wrong moment does not merely fail — it makes the owning
  host's nightly `backup` fail. The suite must never be able to break the
  backups it exists to protect. This is the single most important rule in the
  suite and is expanded in `CONVENTIONS.md` §3.
- **Maintenance-window avoidance.** `check --no-lock` concurrent with another
  host's `forget --prune` can report false-positive errors. Validation runs
  outside the nightly window, and a run that overlaps must be able to say so
  rather than reporting corruption.
- **Restore is capped and scoped.** Default: one configured subtree, with a
  `maxRestoreBytes` guard checked _before_ any data moves, mirroring
  `b2-transfer`'s `maxTransferBytes`. The neutral host has ~129 GiB free and the
  largest repository holds 42.7 GiB current; an unguarded full-fleet restore
  drill does not fit and must fail closed, cheaply.
- **Read-only credentials.** Validation authenticates with B2 keys scoped to
  `listBuckets,readBuckets,listFiles,readFiles` — minted per bucket via
  `@sntxrr/b2/key`. The existing per-host keys carry `writeFiles` **and**
  `deleteFiles` and never expire; a validation suite holding delete rights over
  the backup it is validating is an unnecessary standing risk.
- **Dormant is not stale.** A deliberately powered-off host and a silently
  broken one look **identical** to restic — same API, same absent snapshots.
  Reporting every dormant repository as a failure trains the operator to ignore
  the alarm, which is the failure mode this suite exists to prevent. Dormancy is
  declared per repository; dormant repositories are excluded from staleness and
  the excluded count is **always** printed, so "found none" can never be
  confused with "left some out". This is the same rule, in the same shape, as
  `@sntxrr/b2/transfer`'s in-progress-versus-abandoned upload distinction.

## 6. Version reality

The fleet installs restic from distro apt with no pinning, so versions differ
per host. Debian 12 ships 0.14.0; Ubuntu 24.04 ships 0.16.4. That matters
because the features this suite depends on landed later:

| Feature                                                                 | Needs                         |
| ----------------------------------------------------------------------- | ----------------------------- |
| `check --json`                                                          | 0.18.0                        |
| `restore --json`                                                        | 0.16.0                        |
| Exit codes 10 / 11 / 12 (missing repo / lock conflict / wrong password) | 0.17.0–0.17.1                 |
| `--retry-lock`                                                          | 0.16.0                        |
| `restore --verify`                                                      | 0.9.2 — universally available |

The neutral host therefore runs the **upstream binary** (0.19.1), not a distro
package. A newer restic reads older repositories without issue; the reverse is
not true, and repository format v2 (default since 0.14.0) cannot be opened at
all by restic ≤ 0.13. Constraining the _backup_ side to distro packages is fine;
constraining the _validator_ is not. Recording each repository's format version
and the writing restic version is itself part of rung 1, because a version floor
is a restorability constraint.

## 7. Baseline established 2026-08-07

Before any code was written, the ladder was executed by hand against one live
repository from the neutral host, to establish that every rung is achievable and
to capture real response shapes rather than assumed ones:

- `snapshots --json` — 43 snapshots, oldest 311 days, newest 0 days.
- `stats --json --mode raw-data` — repository format **v2**, compression ratio
  2.55.
- `check --json --no-lock` — 40s, `num_errors: 0`, no lock left behind.
- `check --json --read-data-subset` — verified in both `10%` and `1/7` forms.
- `dump latest <canary>` — expected content returned.
- `restore latest:<subtree> --verify --json` — **1,719 files / 254,231,900 bytes
  restored and verified in 32.5 seconds** on a foreign OS and architecture.

That last line is the first proven restore in the history of this fleet, and it
is the thing the suite exists to produce on a schedule instead of by hand.

The same drill also surfaced the two defects in §1 and one typing trap worth
recording here because it would otherwise become a wrong assertion: restic's
`files_restored` counts directories and symlinks, not just regular files, and
does not equal a `find -type f` count of the restored tree.

## 8. Models

| Model                       | Dir                  | `scan` emits                                                            | Intent methods                                         |
| --------------------------- | -------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| `@sntxrr/restic/repository` | `restic-repository/` | `repository/<name>` aggregate; `snapshot/<short_id>` in `detailed` mode | `check`, `verify`, `dump`, `restore`, `unlock` (gated) |

Three specs: `repository` (rung 1), `validation` (one per rung 2-5), and
`maintenance` - a record of the one mutation the suite performs. `unlock` writes
`maintenance`, never `validation`, and is deliberately absent from the `rung`
enum: it proves nothing about restorability, and a readiness report iterating
rungs would otherwise invent an `unlock-never-proven` finding. An alarm that
cannot mean anything is worse than no alarm - the same reasoning that makes
`restic-version-floor` designed-but-not-derivable in section 9.

| Report                     | Dir                 | Scope    | Reads                                                             |
| -------------------------- | ------------------- | -------- | ----------------------------------------------------------------- |
| `@sntxrr/restic/readiness` | `restic-readiness/` | workflow | every repository model's rung output, joined by the spec it wrote |

`scan` defaults to **aggregate** mode. A repository holds tens to hundreds of
snapshots and emitting each as a resource across 18 repositories is thousands of
resources for a question — "is this fresh, and does it cover what it should" —
that the aggregate answers. Per-snapshot emission is opt-in, following
`b2-files`' precedent that the default must be the cheap one.

## 9. Findings the readiness report produces

Grounded in what the baseline drill actually observed, not speculation:

| Finding                 | Severity | Fires when                                                                         |
| ----------------------- | -------- | ---------------------------------------------------------------------------------- |
| `restore-never-proven`  | critical | No successful rung-5 restore on record                                             |
| `check-failing`         | critical | `num_errors > 0`, or `suggest_repair_index`                                        |
| `repo-stale`            | high     | Latest snapshot older than the threshold, and not declared dormant                 |
| `data-never-verified`   | high     | No rung-3 read-data result on record                                               |
| `backup-scope-drift`    | high     | Latest snapshot's `paths` ≠ the declared expected paths                            |
| `repo-unreachable`      | high     | Credentials or network fail                                                        |
| `hostname-drift`        | medium   | One repository's snapshots carry more than one hostname                            |
| `repo-orphaned`         | medium   | Repository and credentials exist; no host writes to it                             |
| `restic-version-floor`  | low      | Repository format needs a restic newer than a host runs — **see the caveat below** |
| `repo-dormant-declared` | info     | Excluded from staleness — always counted, never silent                             |

`restic-version-floor` is recorded as **designed but not derivable**: all 43
snapshots in the baseline repository omit `program_version` entirely, so the
writing restic version cannot be read from snapshot metadata on this fleet. The
field is captured honestly as an empty set rather than inferred, and the finding
will not fire until a version source exists. A finding that can never fire is
worse than an absent one, so it is called out here rather than left to look
implemented.

## 10. Definition of done (per extension)

Inherited from the B2 suite unchanged, because every item earned its place
there:

1. `deno check` and `deno test` pass — **verified by exit status, not by reading
   the test count.** A suite that aborts at type-check reports no failures.
2. Registers: `swamp model type search restic --json` lists the type.
3. Read-only smoke test against a live repository succeeds.
4. `swamp extension fmt --check` clean; `quality` ≥ 14/15.
5. Adversarial Review Gate report written, every dimension adjudicated, and the
   gate **re-run immediately before publish** — it binds to a content hash and a
   carried-forward "gate clean" is worthless.
6. README documents the restic version floor and B2 capabilities each method
   needs.
7. No secret — repository password, B2 application key, or `authorizationToken`
   — appears in any resource snapshot, log line, or **process argument list**;
   asserted by a test. `ps` is world-readable.
8. Mutation testing: at least one deliberate mutation per guard is shown to fail
   the suite. A green suite proves nothing until a mutation is shown to break
   it.
9. Pre-publish secret audit: extract every real repository, bucket and host name
   from live output and grep both the tracked tree **and** the exact
   shipped-file list. `example-` prefixing is not sanitisation when the
   remainder is the real name.
