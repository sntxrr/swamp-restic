import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  analyze,
  daysSince,
  humanBytes,
  isRepositoryStep,
  report,
  type RepositoryState,
  type RungEvidence,
} from "./restic_readiness.ts";

const NOW = Date.parse("2026-08-08T00:00:00Z");

function evidence(over: Partial<RungEvidence> = {}): RungEvidence {
  return {
    passed: true,
    inconclusive: false,
    ranAt: "2026-08-07T00:00:00Z",
    provenance: "this-run",
    detail: null,
    ...over,
  };
}

function repoState(over: Partial<RepositoryState> = {}): RepositoryState {
  return {
    name: "heron-debian",
    scanned: true,
    reachable: true,
    failureReason: null,
    dormant: false,
    snapshotCount: 43,
    latestSnapshotTime: "2026-08-07T00:01:00Z",
    latestSnapshotAgeHours: 24,
    stale: false,
    maxStaleDays: 2,
    hostnames: ["host.example.net"],
    hostnameDrift: false,
    missingPaths: [],
    scopeDrift: false,
    writerVersions: [],
    repositoryFormatVersion: 2,
    totalSizeBytes: 1_000_000,
    rungs: {
      "check": evidence(),
      "read-data": evidence(),
      "dump": evidence(),
      "restore": evidence(),
    },
    unlock: null,
    ...over,
  };
}

const OPTS = { standingRecordsReadable: true };
const codes = (fs: { code: string }[]) => fs.map((f) => f.code);

// ---------------------------------------------------------------------------
// The headline finding
// ---------------------------------------------------------------------------

Deno.test("a fully proven repository produces no findings", () => {
  const { findings } = analyze([repoState()], OPTS);
  assertEquals(findings, []);
});

Deno.test("a repository with no restore on record is critical", () => {
  const s = repoState({ rungs: { "check": evidence() } });
  const { findings } = analyze([s], OPTS);
  const f = findings.find((f) => f.code === "restore-never-proven");
  assert(f, "restore-never-proven did not fire");
  assertEquals(f.severity, "critical");
});

Deno.test("day one fires restore-never-proven for every repository", () => {
  // The expected state of a real estate on first run, and the reason this
  // report exists. If this ever stops being the default outcome for an
  // unexercised fleet, the report has started reassuring instead of measuring.
  const fleet = ["a", "b", "c"].map((n) => repoState({ name: n, rungs: {} }));
  const { findings } = analyze(fleet, OPTS);
  assertEquals(
    findings.filter((f) => f.code === "restore-never-proven").length,
    3,
  );
});

Deno.test("a restore proven in a PRIOR run is not reported as never proven", () => {
  // Rungs 3 and 5 move real data and are deliberately not nightly. A report
  // that only looked at this execution would fire critical findings six nights
  // out of seven, which is an alarm nobody keeps.
  const s = repoState({
    rungs: {
      "check": evidence(),
      "read-data": evidence({ provenance: "standing-record" }),
      "restore": evidence({ provenance: "standing-record" }),
    },
  });
  const { findings } = analyze([s], OPTS);
  assertEquals(codes(findings), []);
});

Deno.test("a FAILED restore is distinct from a missing one", () => {
  const s = repoState({
    rungs: { "restore": evidence({ passed: false, detail: "target full" }) },
  });
  const { findings } = analyze([s], OPTS);
  assert(codes(findings).includes("restore-failing"));
  assert(!codes(findings).includes("restore-never-proven"));
});

// ---------------------------------------------------------------------------
// Never report an unexamined repository as healthy
// ---------------------------------------------------------------------------

Deno.test("a repository whose step never scanned is reported, not omitted", () => {
  const { findings } = analyze([repoState({ scanned: false })], OPTS);
  assertEquals(codes(findings), ["repo-unreachable"]);
});

Deno.test("an unreachable repository short-circuits the ladder findings", () => {
  // Every downstream check needs data this scan could not gather. Emitting
  // "never verified" about a repository we could not even open would bury the
  // one finding that matters under noise.
  const s = repoState({ reachable: false, failureReason: "wrong-password" });
  const { findings } = analyze([s], OPTS);
  assertEquals(codes(findings), ["repo-unreachable"]);
});

Deno.test("check failures are critical but lock conflicts are not", () => {
  const failing = repoState({
    name: "a",
    rungs: { "check": evidence({ passed: false, detail: "3 errors" }) },
  });
  const locked = repoState({
    name: "b",
    rungs: {
      "check": evidence({
        passed: false,
        inconclusive: true,
        detail: "already-locked",
      }),
      "read-data": evidence(),
      "restore": evidence(),
    },
  });
  const a = analyze([failing], OPTS).findings;
  const b = analyze([locked], OPTS).findings;
  assertEquals(a.find((f) => f.code === "check-failing")?.severity, "critical");
  assertEquals(
    b.find((f) => f.code === "check-inconclusive")?.severity,
    "low",
  );
  assert(!codes(b).includes("check-failing"), "a lock conflict read as failure");
});

// ---------------------------------------------------------------------------
// Dormancy — excluded, but never silently
// ---------------------------------------------------------------------------

Deno.test("a dormant repository is excluded from staleness but still counted", () => {
  const s = repoState({ dormant: true, stale: false, latestSnapshotAgeHours: 900 });
  const { findings, dormantExcluded } = analyze([s], OPTS);
  assertEquals(dormantExcluded, ["heron-debian"]);
  assert(!codes(findings).includes("repo-stale"));
  const info = findings.find((f) => f.code === "repo-dormant-declared");
  assert(info, "the exclusion was silent — 'found none' now hides 'left some out'");
  assertEquals(info.severity, "info");
});

Deno.test("a stale non-dormant repository is high severity", () => {
  const s = repoState({ stale: true, latestSnapshotAgeHours: 240 });
  const { findings } = analyze([s], OPTS);
  assertEquals(findings.find((f) => f.code === "repo-stale")?.severity, "high");
});

// ---------------------------------------------------------------------------
// Drift — the two defects the baseline drill actually found
// ---------------------------------------------------------------------------

Deno.test("backup-scope drift names the missing paths", () => {
  const s = repoState({ scopeDrift: true, missingPaths: ["/root", "/var/lib/docker"] });
  const { findings } = analyze([s], OPTS);
  const f = findings.find((f) => f.code === "backup-scope-drift");
  assert(f);
  assertStringIncludes(f.detail, "/root");
  assertStringIncludes(f.detail, "/var/lib/docker");
});

Deno.test("hostname drift fires only when there is more than one identity", () => {
  const drifted = repoState({
    hostnameDrift: true,
    hostnames: ["old.example.net", "new.example.net"],
  });
  const steady = repoState();
  assert(codes(analyze([drifted], OPTS).findings).includes("hostname-drift"));
  assert(!codes(analyze([steady], OPTS).findings).includes("hostname-drift"));
});

Deno.test("an empty repository is orphaned, not stale", () => {
  const s = repoState({ snapshotCount: 0, stale: true });
  const { findings } = analyze([s], OPTS);
  assert(codes(findings).includes("repo-orphaned"));
  assert(!codes(findings).includes("repo-stale"), "an empty repo double-reported");
});

// ---------------------------------------------------------------------------
// The deliberately dormant finding
// ---------------------------------------------------------------------------

Deno.test("restic-version-floor cannot fire without a version source", () => {
  // PRD §9: every snapshot on this fleet omits program_version, so the writing
  // version is not derivable. The finding is gated rather than left to look
  // implemented — a finding that CANNOT fire reads as a check that passed.
  const s = repoState({ writerVersions: [], repositoryFormatVersion: 2 });
  const { findings } = analyze([s], OPTS);
  assert(!codes(findings).includes("restic-version-floor"));
});

Deno.test("restic-version-floor fires once a version source exists", () => {
  const s = repoState({
    writerVersions: ["0.12.1"],
    repositoryFormatVersion: 2,
  });
  const { findings } = analyze([s], OPTS);
  const f = findings.find((f) => f.code === "restic-version-floor");
  assert(f, "the finding is unreachable even with data — it is decoration");
  assertEquals(f.severity, "low");
});

// ---------------------------------------------------------------------------
// Wording changes when the standing record is unreadable
// ---------------------------------------------------------------------------

Deno.test("'never proven' becomes 'not in this run' when history is unreadable", () => {
  const s = repoState({ rungs: {} });
  const honest = analyze([s], { standingRecordsReadable: false }).findings;
  const f = honest.find((f) => f.code === "restore-never-proven");
  assert(f);
  assertStringIncludes(f.detail, "could not be read");
  const confident = analyze([s], OPTS).findings
    .find((f) => f.code === "restore-never-proven");
  assertStringIncludes(confident!.detail, "has ever been recorded");
});

// ---------------------------------------------------------------------------
// Step discovery
// ---------------------------------------------------------------------------

Deno.test("a step is discovered by the spec it wrote", () => {
  assert(isRepositoryStep({ dataHandles: [{ specName: "repository" }] }));
  assert(isRepositoryStep({ dataHandles: [{ specName: "validation" }] }));
  assert(!isRepositoryStep({ dataHandles: [{ specName: "bucket" }] }));
});

Deno.test("a FAILED step that wrote nothing is still discovered", () => {
  // Spec-based discovery alone goes blind exactly when a repository's scan
  // died, which is the repository that must not disappear from the fleet.
  assert(
    isRepositoryStep({
      dataHandles: [],
      status: "failed",
      modelType: "@sntxrr/restic/repository",
    }),
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

Deno.test("humanBytes never renders a non-zero size as 0.00", () => {
  // A fixed GiB format rendered five real buckets as 0.00 GiB in a b2 table
  // whose every row was greater than zero by construction.
  assertEquals(humanBytes(155), "155 B");
  assertEquals(humanBytes(4_600_000), "4.39 MiB");
  assertEquals(humanBytes(null), "unknown");
  assert(!humanBytes(1).startsWith("0"));
});

Deno.test("daysSince refuses to invent a number", () => {
  assertEquals(daysSince(null, NOW), null);
  assertEquals(daysSince("not-a-date", NOW), null);
  assertEquals(daysSince("2026-08-07T00:00:00Z", NOW), 1);
});

// ---------------------------------------------------------------------------
// execute — the workflow seam
// ---------------------------------------------------------------------------

function ctx(
  // deno-lint-ignore no-explicit-any
  steps: any[],
  snapshots: Record<string, unknown>,
  opts: { standingRecords?: Record<string, unknown>; throwOnStanding?: boolean } =
    {},
) {
  return {
    scope: "workflow",
    stepExecutions: steps,
    logger: { info: () => {}, warn: () => {} },
    dataRepository: {
      getContent: (
        _t: string,
        _m: string,
        name: string,
        version?: number,
      ): Promise<Uint8Array | null> => {
        // A read with no version is a standing-record read.
        const bag = version === undefined && opts.standingRecords &&
            name in opts.standingRecords
          ? opts.standingRecords
          : snapshots;
        if (version === undefined && opts.throwOnStanding && !(name in snapshots)) {
          return Promise.reject(new Error("datastore declined"));
        }
        const snap = (bag as Record<string, unknown>)[name];
        return Promise.resolve(
          snap ? new TextEncoder().encode(JSON.stringify(snap)) : null,
        );
      },
    },
  };
}

const SCAN_STEP = {
  stepName: "validate-heron",
  modelType: "@sntxrr/restic/repository",
  modelId: "m1",
  status: "succeeded",
  dataHandles: [
    { name: "heron-debian", specName: "repository", version: 1 },
    { name: "validation-check", specName: "validation", version: 1 },
  ],
};

const SNAPS = {
  "heron-debian": {
    repositoryName: "heron-debian",
    reachable: true,
    dormant: false,
    snapshotCount: 43,
    latestSnapshotTime: "2026-08-07T00:00:00Z",
    latestSnapshotAgeHours: 24,
    stale: false,
    maxStaleDays: 2,
    hostnames: ["host.example.net"],
    hostnameDrift: false,
    missingPaths: [],
    scopeDrift: false,
    writerVersions: [],
    repositoryFormatVersion: 2,
    totalSizeBytes: 1024,
  },
  "validation-check": {
    repositoryName: "heron-debian",
    rung: "check",
    passed: true,
    inconclusive: false,
    ranAt: "2026-08-07T01:00:00Z",
  },
};

Deno.test("execute skips cleanly when no repository step ran", async () => {
  const out = await report.execute(ctx([], {}));
  assertEquals(out.json.skipped, true);
  assertStringIncludes(out.markdown, "nothing to assess");
});

Deno.test("execute joins a repository's scan and rungs", async () => {
  const out = await report.execute(ctx([SCAN_STEP], SNAPS));
  assertEquals(out.json.repositoriesExamined, 1);
  assertEquals(out.json.repositoriesScanned, 1);
  assertEquals(out.json.fleetScanComplete, true);
  assertStringIncludes(out.markdown, "heron-debian");
  // No restore anywhere, so the headline finding must fire.
  assert(
    (out.json.findings as { code: string }[]).some((f) =>
      f.code === "restore-never-proven"
    ),
  );
});

Deno.test("execute reads a restore from the standing record", async () => {
  const out = await report.execute(
    ctx([SCAN_STEP], SNAPS, {
      standingRecords: {
        "validation-restore": {
          repositoryName: "heron-debian",
          rung: "restore",
          passed: true,
          inconclusive: false,
          ranAt: "2026-08-01T00:00:00Z",
        },
      },
    }),
  );
  const found = (out.json.findings as { code: string }[]).map((f) => f.code);
  assert(!found.includes("restore-never-proven"), "prior proof was ignored");
  assertEquals(out.json.restoresProven, 1);
  assertStringIncludes(out.markdown, "prior run");
});

Deno.test("a failed step keeps the fleet total honest", async () => {
  const failed = {
    stepName: "validate-mallard",
    modelType: "@sntxrr/restic/repository",
    modelId: "m2",
    status: "failed",
    dataHandles: [],
  };
  const out = await report.execute(ctx([SCAN_STEP, failed], SNAPS));
  assertEquals(out.json.repositoriesExamined, 2);
  assertEquals(out.json.repositoriesScanned, 1);
  assertEquals(
    out.json.fleetScanComplete,
    false,
    "a fleet that quietly shrank to the repositories that worked",
  );
  assertStringIncludes(out.markdown, "produced no scan");
});

Deno.test("an unreadable standing record is disclosed, not assumed", async () => {
  const out = await report.execute(
    ctx([SCAN_STEP], SNAPS, { throwOnStanding: true }),
  );
  assertEquals(out.json.standingRecordsReadable, false);
  assertStringIncludes(out.markdown, "prior-run records could not be read");
});
