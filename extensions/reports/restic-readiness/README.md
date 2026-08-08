# `@sntxrr/restic/readiness`

A **workflow-scope** report that answers one question about a restic fleet:
**which of these backups is actually known to be restorable, and how recently
was that shown?**

## Why it is workflow-scope

One model instance owns one repository — credentials are per-repository, and
swamp holds a model's lock for the whole duration of a method, so eighteen
repositories behind a single instance would serialise into hours. The fleet's
evidence is therefore spread across eighteen models, and a method-scope report
can only ever see the resources its own execution wrote.

`context.stepExecutions` is the only seam where several models' outputs can be
joined, which is what makes this a workflow report rather than a method one —
the same reason `@sntxrr/b2/fleet-hygiene` is.

## Attach it

Workflow-scope reports attach in the **workflow** YAML, not on a model
definition:

```yaml
reports:
  require:
    - "@sntxrr/restic/readiness"
```

`require` rather than merely available, and no step should set
`allowFailure: true`. A readiness report that silently drops the repositories
whose steps died still renders as a complete assessment.

## What it produces

A repository table and a ranked findings list:

| Finding                  | Severity | Fires when                                            |
| ------------------------ | -------- | ----------------------------------------------------- |
| `restore-never-proven`   | critical | No successful restore on record                       |
| `restore-failing`        | critical | The most recent restore drill failed                  |
| `check-failing`          | critical | `restic check` reported errors, or `--read-data` failed |
| `repo-unreachable`       | high     | The scan failed, or restic could not open the repository |
| `repo-stale`             | high     | Newest snapshot past the threshold, and not dormant   |
| `data-never-verified`    | high     | No `--read-data` result on record                     |
| `backup-scope-drift`     | high     | The latest snapshot lacks a declared path             |
| `hostname-drift`         | medium   | Snapshots carry more than one hostname                |
| `repo-orphaned`          | medium   | Reachable and credentialled, but holds no snapshots   |
| `unlock-failed`          | medium   | A stale-lock removal was attempted and failed         |
| `check-inconclusive`     | low      | A lock conflict or timeout — never counted as failure |
| `restic-version-floor`   | low      | A recorded writer version cannot open the repo format |
| `repo-dormant-declared`  | info     | Excluded from staleness — always counted, never silent |

On day one, `restore-never-proven` fires for **every** repository. That is the
correct output, and it is the reason this exists.

## Honesty rules

These are the parts most worth reading before trusting the output.

**A repository that was never scanned is never reported as healthy.** Steps are
reconciled against `stepExecutions`, which lists failed steps too, so a
repository whose scan died is reported as `repo-unreachable` rather than
dropping out of the fleet count. `fleetScanComplete` in the JSON is false
whenever that happened. A total that quietly shrinks to only the repositories
that worked is the failure this guard exists to prevent.

**"Not proven in this run" is never printed as "never proven."** Rungs 3 and 5
move real data and are deliberately not run nightly, so for any rung this run
did not exercise the report reads the repository's standing record — the latest
snapshot of a stable instance name such as `validation-restore` — and labels the
row `prior run`. If the standing record cannot be read at all,
`standingRecordsReadable` is false, the report says so once at the top, and the
findings reword themselves from "never" to "not in this run". Without that, a
fleet whose restores are weekly would be accused of never restoring, six nights
out of seven.

**Dormant repositories are excluded from staleness and always counted.** A
deliberately powered-off host and a silently broken one look identical to
restic. Every exclusion is emitted as an `info` finding, so "found none" can
never be confused with "left some out".

**A lock conflict is not a failure.** `check-inconclusive` is deliberately
distinct from `check-failing`; a timeout or a conflicting lock says nothing
about repository health, and reporting a healthy repository as broken is its own
harm.

**`restic-version-floor` is designed but dormant.** Every snapshot on the fleet
this was built for omits `program_version`, so the writing restic version is not
derivable. The finding is gated on a non-empty `writerVersions` rather than left
to look implemented and never fire — a finding that *cannot* fire reads as a
check that passed, which is worse than an absent one.

## Usage

One step per repository, because one model instance owns one repository. The
steps are independent and run in parallel — eighteen instances validate
concurrently where a single looping instance would serialise behind one lock.

```yaml
# workflows/restic-fleet-readiness.yaml
name: restic-fleet-readiness
reports:
  require:
    - "@sntxrr/restic/readiness"
jobs:
  - name: validate
    steps:
      - name: freshness-heron
        task:
          type: model_method
          modelIdOrName: restic-heron
          methodName: scan
        dependsOn: []
        # Never true. A repository whose scan silently vanished reads as a
        # repository with no findings, which is the one output this must
        # never produce.
        allowFailure: false
      - name: structure-heron
        task:
          type: model_method
          modelIdOrName: restic-heron
          methodName: check
        dependsOn:
          - step: freshness-heron
            condition:
              type: succeeded
        allowFailure: false
```

Then run it and read the report:

```bash
swamp workflow validate restic-fleet-readiness
swamp workflow run restic-fleet-readiness
swamp report get @sntxrr/restic/readiness \
  --workflow restic-fleet-readiness --json
```

Rungs 3 and 5 cost egress, so they do not belong in the nightly job. Give them
their own workflow on a slower schedule and let this report pick their results
up from the standing record — the table marks those rows `prior run`.

## Sample output

```
# restic fleet restore-readiness

**0 of 3 repositories have a proven restore.**

Repositories examined: 3 · scanned successfully: 3 · reachable: 3 · declared dormant: 1

| Repository        | Latest snapshot | Restore proven | Read-data | Size     |
| ----------------- | --------------- | -------------- | --------- | -------- |
| heron-debian      | 1.0d ago        | **never**      | **never** | 1.67 GiB |
| mallard-ubuntu    | 12.4d ago       | **never**      | **never** | 4.58 GiB |
| teal-debian (dormant) | 91.2d ago   | **never**      | **never** | 0.38 GiB |

Findings: 6 — 3 critical, 3 high, 0 medium, 0 low, 1 info
```

That is the expected day-one output, not a malfunction.

## What this does not do

It never calls restic and never touches a repository — it only reads resources
the steps already wrote, so it costs nothing and cannot mutate. It does not
decide *when* to run a rung; that is the workflow's job. And it does not
remediate: a finding that retention looks wrong is an ansible change, because
the ansible restic role owns the write path and keeps owning it.

## Reading the JSON

`repositoriesExamined`, `repositoriesScanned`, `restoresProven` and
`dormantExcluded` are the numbers to alert on. Never read a finding count as
complete unless **`fleetScanComplete` is true**, and never read
`restore-never-proven` literally unless **`standingRecordsReadable` is true`**.

## License

MIT
