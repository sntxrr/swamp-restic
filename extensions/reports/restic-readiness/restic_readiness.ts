/**
 * restic fleet restore-readiness report.
 *
 * A workflow-scope report that reads what every `@sntxrr/restic/repository`
 * step in a fleet run wrote and answers one question: **which of these backups
 * is actually known to be restorable, and how recently was that shown?**
 *
 * **Why workflow scope.** One model instance owns one repository — credentials
 * are per-repository, and swamp holds a model's lock for the whole duration of
 * a method, so eighteen repositories behind one instance would serialise into
 * hours. That means the fleet's evidence is spread across eighteen models, and
 * a method-scope report can only ever see the resources its own execution
 * wrote. `context.stepExecutions` is the only seam where they can be joined.
 *
 * **The headline finding is an absence.** Every other report in this family
 * finds things that are wrong. This one mostly finds things that were never
 * checked, because that is the actual state of most backup estates: the fleet
 * this was built for had run `restic check` nightly for years and had never
 * once run `--read-data` or executed a single restore. A rung that has never
 * run is therefore a finding in its own right, and `restore-never-proven` is
 * expected to fire for every repository on day one.
 *
 * **Honesty rules, inherited from the B2 suite and sharpened here.**
 *
 *  - A repository that was never scanned is never reported as healthy. Steps
 *    are reconciled against `stepExecutions`, which lists failed steps too, so
 *    a repository whose scan died cannot vanish from the fleet — the failure
 *    mode where "we could not look" renders identically to "we looked and it
 *    was fine".
 *  - Dormant repositories are excluded from staleness and the excluded count is
 *    ALWAYS printed. A deliberately powered-off host and a silently broken one
 *    look identical to restic, and reporting every dormant repository as a
 *    failure is how an operator learns to ignore the alarm.
 *  - "Not proven in this run" is never printed as "never proven". Rungs 3 and 5
 *    cost real money and are not expected in every run, so this report reads
 *    each repository's standing record as well as this run's output, and labels
 *    which one it used. If the standing record cannot be read at all, it says
 *    so once, loudly, instead of accusing the whole fleet.
 *
 * @module
 */

/**
 * What a report returns — swamp's documented `ReportResult` shape.
 *
 * Declared and applied to `execute` deliberately. Without it TypeScript infers
 * a union of the early-return skip object and the full result, and every
 * `out.json.<field>` access in a test fails to compile — which is how
 * `b2-hygiene`'s tests silently never ran at all while passing under
 * `--no-check`.
 */
export type ReportResult = {
  markdown: string;
  json: Record<string, unknown>;
};

/** Severity ordering used for sorting and for the summary counts. */
export const SEVERITY_ORDER = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const;
export type Severity = typeof SEVERITY_ORDER[number];

/** One finding about one repository. */
export type Finding = {
  severity: Severity;
  /** Stable kebab-case identifier, safe to alert or filter on. */
  code: string;
  /** The repository this is about. */
  subject: string;
  /** What is true. */
  detail: string;
  /** What it costs or risks, in concrete terms. */
  impact: string;
};

/** Where a rung's evidence came from. The distinction is load-bearing. */
export type Provenance = "this-run" | "standing-record" | "none";

/** What is known about one rung for one repository. */
export type RungEvidence = {
  passed: boolean;
  inconclusive: boolean;
  ranAt: string | null;
  provenance: Provenance;
  detail: string | null;
};

/** The stable instance name each rung writes, per CONVENTIONS §2. */
const RUNG_INSTANCE: Record<string, string> = {
  "check": "validation-check",
  "read-data": "validation-read-data",
  "dump": "validation-dump",
  "restore": "validation-restore",
};

/** Parse a resource snapshot's bytes into an object, or null if unreadable. */
async function readSnapshot(
  // deno-lint-ignore no-explicit-any
  context: any,
  // deno-lint-ignore no-explicit-any
  step: any,
  handle: { name: string; version?: number },
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await context.dataRepository.getContent(
      step.modelType,
      step.modelId,
      handle.name,
      handle.version,
    );
    if (!raw) return null;
    return JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Collect every snapshot a step wrote under one spec name. */
async function readSpec(
  // deno-lint-ignore no-explicit-any
  context: any,
  // deno-lint-ignore no-explicit-any
  step: any,
  specName: string,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const handles = (step.dataHandles ?? []) as Array<
    { name: string; specName?: string; version?: number }
  >;
  for (const h of handles.filter((h) => h.specName === specName)) {
    const snap = await readSnapshot(context, step, h);
    if (snap) out.push(snap);
  }
  return out;
}

/**
 * Read a repository's STANDING record for one rung — the latest snapshot of a
 * stable instance name, whether or not this run wrote it.
 *
 * This is what makes "never proven" distinguishable from "not proven tonight".
 * Rungs 3 and 5 move real data and are deliberately not run every night, so a
 * report that only looked at this execution would fire `restore-never-proven`
 * at a fleet whose restores are merely weekly — an alarm that is wrong six
 * nights out of seven, which is an alarm nobody keeps.
 *
 * Returns null when there is no record OR when the datastore declines the read.
 * The caller must not treat those two as the same thing, which is why the
 * caller tracks whether ANY standing read succeeded.
 */
async function readStandingRecord(
  // deno-lint-ignore no-explicit-any
  context: any,
  // deno-lint-ignore no-explicit-any
  step: any,
  instanceName: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await context.dataRepository.getContent(
      step.modelType,
      step.modelId,
      instanceName,
    );
    if (!raw) return null;
    return JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Is this step one of the repository-validation models? */
export function isRepositoryStep(step: unknown): boolean {
  // deno-lint-ignore no-explicit-any
  const s = step as any;
  const handles = (s?.dataHandles ?? []) as Array<{ specName?: string }>;
  if (
    handles.some((h) =>
      h.specName === "repository" || h.specName === "validation" ||
      h.specName === "snapshot" || h.specName === "maintenance"
    )
  ) {
    return true;
  }
  // Spec-based discovery cannot be the only signal. A step that FAILED wrote no
  // snapshots at all, and a repository whose scan died is precisely the one
  // that must not disappear from the fleet count — "we could not look" would
  // otherwise render exactly like "we looked and it was fine". modelType is the
  // extension's published type string, not a label the workflow author picks.
  return String(s?.modelType ?? "").endsWith("/restic/repository");
}

/** Coerce to a finite number, or null. Absent is never zero. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Coerce to a non-empty string, or null. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Coerce to a string array, dropping anything that is not a string. */
function strArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

/** Days between an ISO timestamp and now, or null if unparseable. */
export function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (now - t) / 86_400_000;
}

/** Render bytes with a unit that does not flatten small values to 0.00. */
export function humanBytes(bytes: number | null): string {
  if (bytes === null) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // Scale precision to magnitude: a fixed 2dp renders 155 B as 0.00 GiB, which
  // is a zero in a table whose every row is greater than zero by construction.
  const dp = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(i === 0 ? 0 : dp)} ${units[i]}`;
}

/** One repository's joined state, as the report understands it. */
export type RepositoryState = {
  name: string;
  /**
   * The model instance the step ran against, when the run reported one.
   *
   * Kept separately from `name` because when a step fails before writing
   * anything the two are the only identities available, and only this one can
   * be pasted back into a command to reproduce the failure. Optional so
   * hand-built test state stays terse.
   */
  modelName?: string | null;
  scanned: boolean;
  reachable: boolean | null;
  failureReason: string | null;
  dormant: boolean;
  snapshotCount: number | null;
  latestSnapshotTime: string | null;
  latestSnapshotAgeHours: number | null;
  stale: boolean;
  maxStaleDays: number | null;
  hostnames: string[];
  hostnameDrift: boolean;
  missingPaths: string[];
  scopeDrift: boolean;
  writerVersions: string[];
  repositoryFormatVersion: number | null;
  totalSizeBytes: number | null;
  rungs: Record<string, RungEvidence>;
  unlock: { succeeded: boolean; locksRemoved: number | null } | null;
};

/**
 * Turn joined repository state into findings.
 *
 * Pure and exported so it can be tested directly against hand-built state,
 * without a workflow context. Every finding code here is grounded in something
 * the baseline drill actually observed, not speculation — see PRD §9.
 */
export function analyze(
  repos: RepositoryState[],
  opts: { standingRecordsReadable: boolean },
): { findings: Finding[]; dormantExcluded: string[] } {
  const findings: Finding[] = [];
  const dormantExcluded: string[] = [];

  for (const r of repos) {
    if (!r.scanned) {
      // The step's error text is deliberately NOT quoted here, because a report
      // cannot see it: `stepExecutions` carries jobName, stepName, modelName,
      // modelType, methodName, status, dataHandles, methodArgs, modelId and
      // globalArgs — and no error field. Nor can the model be relied on to have
      // left the reason behind: a vault expression is resolved UPSTREAM of
      // execute, so a missing 1Password item kills the step before any code
      // runs that could write a reachable:false snapshot. Observed 2026-08-17,
      // when `restic-mallard-debian` failed with
      //   Item "restic-mallard-debian" not found in vault "<vault>"
      // and left nothing behind at all.
      //
      // So rather than pretend to a reason it does not have, the finding names
      // the one command that WILL print it.
      const how = r.modelName
        ? `Run \`swamp model @'@sntxrr/restic/repository' method run scan ${r.modelName}\` ` +
          "to see the underlying error."
        : "Run this repository's scan method directly to see the underlying error.";
      findings.push({
        severity: "high",
        code: "repo-unreachable",
        subject: r.name,
        detail:
          "This repository's step did not complete, so nothing about it was " +
          "measured in this run. The step failed before writing any snapshot, " +
          "which is what a credential or vault-resolution failure looks like — " +
          "those happen before the model runs, so no reason is recorded. " +
          how,
        impact:
          "A repository that could not be examined is not a repository known " +
          "to be healthy. It is reported rather than omitted precisely so a " +
          "failed look cannot read as a clean bill.",
      });
      continue;
    }

    if (r.reachable === false) {
      findings.push({
        severity: "high",
        code: "repo-unreachable",
        subject: r.name,
        detail: `restic could not open the repository: ${
          r.failureReason ?? "unknown reason"
        }.`,
        impact:
          "Credentials, network or the repository itself are broken. Until " +
          "this is fixed, nothing else can be verified and the backup should " +
          "be assumed unrestorable.",
      });
      // Every remaining check needs data this scan could not gather.
      continue;
    }

    if (r.dormant) dormantExcluded.push(r.name);

    // --- freshness -------------------------------------------------------
    if (r.snapshotCount === 0) {
      findings.push({
        severity: "medium",
        code: "repo-orphaned",
        subject: r.name,
        detail:
          "The repository exists and its credentials work, but it holds no " +
          "snapshots at all.",
        impact:
          "Something is paying to store an empty repository, and any host " +
          "that believes it is backing up here is not. Derived from an empty " +
          "snapshot list, which is the only orphan signal restic can give.",
      });
    } else if (r.stale && !r.dormant) {
      const days = r.latestSnapshotAgeHours !== null
        ? (r.latestSnapshotAgeHours / 24).toFixed(1)
        : "?";
      findings.push({
        severity: "high",
        code: "repo-stale",
        subject: r.name,
        detail:
          `The newest snapshot is ${days} days old, past the ${r.maxStaleDays}-day ` +
          "threshold declared for this repository.",
        impact:
          "The backup timer has stopped and nothing else would have said so — " +
          "a systemd unit that never runs never fails, so there is no alarm " +
          "on this path at all.",
      });
    }

    // --- scope and identity drift ---------------------------------------
    if (r.scopeDrift && r.missingPaths.length > 0) {
      findings.push({
        severity: "high",
        code: "backup-scope-drift",
        subject: r.name,
        detail: `The latest snapshot does not contain ${
          r.missingPaths.map((p) => `\`${p}\``).join(", ")
        }, which this repository is declared to cover.`,
        impact:
          "A restore from this repository silently yields an incomplete host. " +
          "This is invisible to `restic check`, which verifies structure and " +
          "has no idea what the host was supposed to contain.",
      });
    }

    if (r.hostnameDrift) {
      findings.push({
        severity: "medium",
        code: "hostname-drift",
        subject: r.name,
        detail: `Snapshots carry more than one hostname: ${
          r.hostnames.join(", ")
        }.`,
        impact:
          "One repository's history is split across two identities, so any " +
          "restore or retention filtered by `--host` silently sees only part " +
          "of it.",
      });
    }

    // --- the ladder ------------------------------------------------------
    const check = r.rungs["check"];
    if (check && check.provenance !== "none" && !check.passed) {
      if (check.inconclusive) {
        findings.push({
          severity: "low",
          code: "check-inconclusive",
          subject: r.name,
          detail: `The structural check did not complete: ${
            check.detail ?? "inconclusive"
          }.`,
          impact:
            "A lock conflict or a timeout says nothing about repository " +
            "health. Recorded so the gap is visible, NOT as a failure — " +
            "reporting a healthy repository as broken is its own harm.",
        });
      } else {
        findings.push({
          severity: "critical",
          code: "check-failing",
          subject: r.name,
          detail: `\`restic check\` reported errors: ${
            check.detail ?? "see the validation resource"
          }.`,
          impact:
            "The repository's index or tree structure is damaged. Restores " +
            "may fail outright. This is the one finding here that means the " +
            "backup is already broken rather than merely unproven.",
        });
      }
    }

    const readData = r.rungs["read-data"];
    if (!readData || readData.provenance === "none") {
      findings.push({
        severity: "high",
        code: "data-never-verified",
        subject: r.name,
        detail: opts.standingRecordsReadable
          ? "No `--read-data` result exists for this repository."
          : "No `--read-data` result was produced in this run, and the " +
            "standing record could not be read (see the caveat above).",
        impact: "Plain `check` never downloads a pack, so bitrot and silent " +
          "corruption in the stored data have never been looked for here. " +
          "A passing `check` is proof the metadata is coherent, which is a " +
          "different fact from the data being intact.",
      });
    } else if (!readData.passed && !readData.inconclusive) {
      findings.push({
        severity: "critical",
        code: "check-failing",
        subject: r.name,
        detail: `\`--read-data\` verification failed: ${
          readData.detail ?? "pack contents did not match their hashes"
        }.`,
        impact:
          "Stored pack contents do not match their hashes. This is bitrot or " +
          "corruption in the data itself, which no structural check would " +
          "ever have surfaced.",
      });
    }

    const restore = r.rungs["restore"];
    if (!restore || restore.provenance === "none") {
      findings.push({
        severity: "critical",
        code: "restore-never-proven",
        subject: r.name,
        detail: opts.standingRecordsReadable
          ? "No successful restore has ever been recorded for this repository."
          : "No successful restore was recorded in this run, and the standing " +
            "record could not be read (see the caveat above).",
        impact:
          "Everything else on the ladder proves the repository is readable. " +
          "Only a restore proves it is restorable, on a machine that is not " +
          "the one that made the backup. Until this fires clean, this is a " +
          "hopeful assumption rather than a backup.",
      });
    } else if (!restore.passed && !restore.inconclusive) {
      findings.push({
        severity: "critical",
        code: "restore-failing",
        subject: r.name,
        detail: `The most recent restore drill failed: ${
          restore.detail ?? "see the validation resource"
        }.`,
        impact:
          "A restore was attempted and did not succeed. This is the strongest " +
          "possible signal that the backup cannot be relied on.",
      });
    }

    // --- version floor ---------------------------------------------------
    // Designed, and deliberately dormant. PRD §9: every snapshot on the fleet
    // this was built for omits `program_version` entirely, so the writing
    // restic version cannot be read from snapshot metadata. The finding is
    // gated on a non-empty writerVersions rather than left to look implemented
    // and never fire — a finding that CANNOT fire is worse than an absent one,
    // because it reads as a check that passed.
    if (r.writerVersions.length > 0 && r.repositoryFormatVersion !== null) {
      if (r.repositoryFormatVersion >= 2) {
        const tooOld = r.writerVersions.filter((v) =>
          /^0\.(?:[0-9]|1[0-3])\./.test(v)
        );
        if (tooOld.length > 0) {
          findings.push({
            severity: "low",
            code: "restic-version-floor",
            subject: r.name,
            detail:
              `The repository is format v${r.repositoryFormatVersion}, but ` +
              `snapshots record restic ${tooOld.join(", ")} writing to it.`,
            impact:
              "Repository format v2 cannot be opened at all by restic 0.13 or " +
              "older. A version floor is a restorability constraint: the " +
              "binary available during a recovery has to be new enough.",
          });
        }
      }
    }

    // --- the one mutation ------------------------------------------------
    if (r.unlock && !r.unlock.succeeded) {
      findings.push({
        severity: "medium",
        code: "unlock-failed",
        subject: r.name,
        detail: "A stale-lock removal was attempted and failed.",
        impact:
          "A stale lock left by a killed process blocks the owning host's " +
          "nightly backup, and this is the one failure a read-only validator " +
          "cannot route around.",
      });
    }
  }

  // Dormant repositories are ALWAYS counted, never silently dropped. This is
  // the same rule, in the same shape, as b2-transfer's in-progress-versus-
  // abandoned upload distinction: an exclusion nobody can see is a lie by
  // omission, and "found none" must never be confusable with "left some out".
  for (const name of dormantExcluded) {
    findings.push({
      severity: "info",
      code: "repo-dormant-declared",
      subject: name,
      detail:
        "Declared dormant, so it is excluded from the staleness check. It is " +
        "still validated and still counted.",
      impact:
        "A deliberately powered-off host and a silently broken one look " +
        "identical to restic. Declaring dormancy is what keeps the staleness " +
        "alarm meaningful for every other repository.",
    });
  }

  const rank = (s: Severity) => SEVERITY_ORDER.indexOf(s);
  findings.sort((a, b) =>
    rank(a.severity) - rank(b.severity) || a.code.localeCompare(b.code) ||
    a.subject.localeCompare(b.subject)
  );
  return { findings, dormantExcluded };
}

/** Render findings grouped by severity. */
export function renderFindingSections(findings: Finding[]): string[] {
  const lines: string[] = [];
  for (const sev of SEVERITY_ORDER) {
    const group = findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    lines.push(`## ${sev.toUpperCase()} (${group.length})`, "");
    for (const f of group) {
      lines.push(
        `### \`${f.code}\` — ${f.subject}`,
        "",
        f.detail,
        "",
        `**Why it matters:** ${f.impact}`,
        "",
      );
    }
  }
  return lines;
}

/**
 * The fleet restore-readiness report.
 *
 * Workflow-scope, so it sees every step. Repositories are identified by the
 * SPECS their steps wrote rather than by step or model name, because those are
 * labels a workflow author picks and this report should keep working when
 * someone renames one — with a `modelType` fallback for steps that failed
 * before writing anything.
 */
export const report = {
  name: "@sntxrr/restic/readiness",
  description:
    "Rank a restic fleet by what has actually been proven restorable. Joins every repository step in a workflow run — freshness, structural check, read-data verification, canary dump and restore drill — into one ranked findings list, where a rung that has never run is itself a finding. Read-only: it reads what the steps already wrote and never touches a repository.",
  scope: "workflow" as const,
  labels: ["audit", "backup", "restore", "validation", "disaster-recovery"],
  // deno-lint-ignore no-explicit-any
  execute: async (context: any): Promise<ReportResult> => {
    // deno-lint-ignore no-explicit-any
    const steps = (context.stepExecutions ?? []) as any[];
    const repoSteps = steps.filter(isRepositoryStep);

    if (repoSteps.length === 0) {
      return {
        markdown:
          "# restic fleet restore-readiness\n\nSkipped: no step in this workflow ran a `@sntxrr/restic/repository` method, so there is nothing to assess. A clean bill over a fleet that was never examined is the most dangerous output this report could produce.\n",
        json: { skipped: true, reason: "no-repository-steps", findings: [] },
      };
    }

    const now = Date.now();
    const states: RepositoryState[] = [];
    let standingReadAttempts = 0;
    let standingReadSuccesses = 0;

    // Group the steps by MODEL, not one repository per step.
    //
    // A fleet workflow runs several steps against the SAME model instance —
    // `scan` then `check`, and later `verify`/`restore` — and one model
    // instance owns exactly one repository (PRD §3), so modelId is the stable
    // key. Counting a repository per step reported 33 repositories for a fleet
    // of 18 on the first live run, which is the mirror of every mock-vs-reality
    // defect in this suite: the fixture had one step per repository, so no test
    // could have caught it.
    //
    // modelId rather than repositoryName because a step that FAILED before
    // writing anything has no repository name to join on, but still carries the
    // model it ran against — and that step is precisely the one that must not
    // vanish from the fleet.
    const byModel = new Map<string, typeof repoSteps>();
    for (const step of repoSteps) {
      const key = String(step?.modelId ?? step?.stepName ?? "unknown");
      const group = byModel.get(key);
      if (group) group.push(step);
      else byModel.set(key, [step]);
    }

    for (const group of byModel.values()) {
      const repoSnaps: Record<string, unknown>[] = [];
      const validations: Record<string, unknown>[] = [];
      const maintenance: Record<string, unknown>[] = [];
      for (const s of group) {
        repoSnaps.push(...await readSpec(context, s, "repository"));
        validations.push(...await readSpec(context, s, "validation"));
        maintenance.push(...await readSpec(context, s, "maintenance"));
      }
      // Any step in the group can name the repository. Failing that, prefer the
      // MODEL name over the step name.
      //
      // Both are last resorts, but they are not equally good. `modelName` is the
      // instance the workflow ran against — a stable repository identity, the
      // same string an operator would type to reproduce the failure. `stepName`
      // is a label the workflow author chose, and this workflow happens to use
      // two per repository ("freshness-x", "structure-x"), so falling back to it
      // rendered findings whose subject was a step in a report whose subjects
      // are otherwise repositories. Measured on the first live fleet run
      // (2026-08-17): `mallard-debian` was reported as `freshness-mallard-debian`.
      //
      // This is the same principle already applied to modelType in
      // isRepositoryStep: key on what the extension defines, not on what the
      // workflow author names things.
      const step = group[0];
      const repo = repoSnaps[0] ?? null;
      const modelName = str(step?.modelName);
      const name = str(repo?.repositoryName) ??
        str(validations[0]?.repositoryName) ??
        str(maintenance[0]?.repositoryName) ??
        modelName ??
        String(step?.stepName ?? "unknown-repository");

      const rungs: Record<string, RungEvidence> = {};
      for (const v of validations) {
        const rung = str(v.rung);
        if (!rung) continue;
        rungs[rung] = {
          passed: v.passed === true,
          inconclusive: v.inconclusive === true,
          ranAt: str(v.ranAt),
          provenance: "this-run",
          detail: str(v.failureReason) ?? str(v.detail),
        };
      }

      // For any rung this run did not exercise, fall back to the repository's
      // standing record. Rungs 3 and 5 cost real money and are deliberately not
      // nightly, so without this the report would accuse a fleet whose restores
      // are weekly of never having restored at all.
      for (const [rung, instance] of Object.entries(RUNG_INSTANCE)) {
        if (rungs[rung]) continue;
        standingReadAttempts++;
        const prior = await readStandingRecord(context, step, instance);
        if (prior === null) continue;
        standingReadSuccesses++;
        rungs[rung] = {
          passed: prior.passed === true,
          inconclusive: prior.inconclusive === true,
          ranAt: str(prior.ranAt),
          provenance: "standing-record",
          detail: str(prior.failureReason) ?? str(prior.detail),
        };
      }

      const unlockSnap = maintenance[0] ?? null;
      states.push({
        name,
        modelName,
        scanned: repo !== null,
        reachable: repo === null ? null : repo.reachable === true,
        failureReason: str(repo?.failureReason),
        dormant: repo?.dormant === true,
        snapshotCount: num(repo?.snapshotCount),
        latestSnapshotTime: str(repo?.latestSnapshotTime),
        latestSnapshotAgeHours: num(repo?.latestSnapshotAgeHours),
        stale: repo?.stale === true,
        maxStaleDays: num(repo?.maxStaleDays),
        hostnames: strArray(repo?.hostnames),
        hostnameDrift: repo?.hostnameDrift === true,
        missingPaths: strArray(repo?.missingPaths),
        scopeDrift: repo?.scopeDrift === true,
        writerVersions: strArray(repo?.writerVersions),
        repositoryFormatVersion: num(repo?.repositoryFormatVersion),
        totalSizeBytes: num(repo?.totalSizeBytes),
        rungs,
        unlock: unlockSnap
          ? {
            succeeded: unlockSnap.succeeded === true,
            locksRemoved: num(unlockSnap.locksRemoved),
          }
          : null,
      });
    }

    // If not one standing read ever succeeded, the datastore is not serving
    // prior instances to this report and EVERY "never proven" below is really
    // "not proven in this run". That difference is the whole meaning of the
    // headline finding, so it is stated once, at the top, rather than silently
    // changing what the findings mean.
    const standingRecordsReadable = standingReadAttempts === 0 ||
      standingReadSuccesses > 0;

    const { findings, dormantExcluded } = analyze(states, {
      standingRecordsReadable,
    });

    const scanned = states.filter((s) => s.scanned);
    const reachable = scanned.filter((s) => s.reachable === true);
    const proven = states.filter((s) => s.rungs["restore"]?.passed === true);
    const counts = Object.fromEntries(
      SEVERITY_ORDER.map((
        s,
      ) => [s, findings.filter((f) => f.severity === s).length]),
    );

    const lines: string[] = [
      "# restic fleet restore-readiness",
      "",
      `**${proven.length} of ${states.length} repositories have a proven restore.**`,
      "",
      `Repositories examined: ${states.length} · scanned successfully: ${scanned.length} · reachable: ${reachable.length} · declared dormant: ${dormantExcluded.length}`,
      "",
    ];

    if (states.length !== scanned.length) {
      lines.push(
        `> **${
          states.length - scanned.length
        } repository step(s) produced no scan.** Those repositories are counted and reported as \`repo-unreachable\` rather than omitted — a fleet total that quietly shrinks to only the repositories that worked is the failure this guard exists to prevent.`,
        "",
      );
    }

    if (!standingRecordsReadable) {
      lines.push(
        '> **Caveat: prior-run records could not be read.** Every rung below is judged only on what THIS run produced, so a repository whose restore was proven last week reads here as never proven. Treat `restore-never-proven` and `data-never-verified` as "not proven in this run" until this is resolved.',
        "",
      );
    }

    lines.push(
      "| Repository | Latest snapshot | Restore proven | Read-data | Size |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const s of [...states].sort((a, b) => a.name.localeCompare(b.name))) {
      const age = s.latestSnapshotAgeHours;
      const fresh = !s.scanned
        ? "not scanned"
        : s.reachable === false
        ? "unreachable"
        : age === null
        ? "no snapshots"
        : `${(age / 24).toFixed(1)}d ago`;
      const restoreCell = (() => {
        const r = s.rungs["restore"];
        if (!r || r.provenance === "none") return "**never**";
        if (!r.passed) return "**FAILED**";
        const d = daysSince(r.ranAt, now);
        const when = d === null ? "date unknown" : `${d.toFixed(0)}d ago`;
        return r.provenance === "standing-record"
          ? `yes (${when}, prior run)`
          : `yes (${when})`;
      })();
      const readCell = (() => {
        const r = s.rungs["read-data"];
        if (!r || r.provenance === "none") return "**never**";
        if (!r.passed) return r.inconclusive ? "inconclusive" : "**FAILED**";
        return r.provenance === "standing-record" ? "yes (prior run)" : "yes";
      })();
      lines.push(
        `| ${s.name}${
          s.dormant ? " _(dormant)_" : ""
        } | ${fresh} | ${restoreCell} | ${readCell} | ${
          humanBytes(s.totalSizeBytes)
        } |`,
      );
    }
    lines.push("");

    lines.push(
      `Findings: ${findings.length} — ${
        SEVERITY_ORDER.map((s) => `${counts[s]} ${s}`).join(", ")
      }`,
      "",
    );

    if (findings.length === 0) {
      lines.push(
        "No findings. Every examined repository is fresh, structurally sound, data-verified and has a proven restore.",
        "",
      );
    } else {
      lines.push(...renderFindingSections(findings));
    }

    return {
      markdown: lines.join("\n"),
      json: {
        repositoriesExamined: states.length,
        repositoriesScanned: scanned.length,
        repositoriesReachable: reachable.length,
        restoresProven: proven.length,
        dormantExcluded,
        // Named so a consumer cannot mistake a partial assessment for a total.
        // Every one of these must be true before a clean result means the
        // fleet is clean rather than merely unexamined.
        fleetScanComplete: states.length === scanned.length,
        standingRecordsReadable,
        counts,
        findings,
        repositories: states.map((s) => ({
          name: s.name,
          scanned: s.scanned,
          reachable: s.reachable,
          dormant: s.dormant,
          snapshotCount: s.snapshotCount,
          latestSnapshotTime: s.latestSnapshotTime,
          stale: s.stale,
          scopeDrift: s.scopeDrift,
          hostnameDrift: s.hostnameDrift,
          totalSizeBytes: s.totalSizeBytes,
          rungs: s.rungs,
        })),
      },
    };
  },
};
