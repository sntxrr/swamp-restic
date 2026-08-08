/**
 * Mechanical verification for @sntxrr/restic-readiness.
 *
 * Executed, not read:
 *
 *   deno test --allow-all reviews/mechanical-verification-readiness.ts
 *
 * A report writes no resources, so the four schema-oriented checks do not apply
 * in their usual form. What replaces them is the property this report lives or
 * dies by: **it must never render an incomplete assessment as a complete one.**
 * Every check below is a way for that to fail silently — a repository dropping
 * out of the fleet count, an exclusion going unprinted, a prior-run gap being
 * reported as a permanent one. Each is the same defect shape the B2 suite hit
 * repeatedly, and none of them fails loudly on its own.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  analyze,
  isRepositoryStep,
  report,
  type RepositoryState,
} from "../extensions/reports/restic-readiness/restic_readiness.ts";

const OPTS = { standingRecordsReadable: true };

function state(over: Partial<RepositoryState> = {}): RepositoryState {
  return {
    name: "heron-debian",
    scanned: true,
    reachable: true,
    failureReason: null,
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
    rungs: {},
    unlock: null,
    ...over,
  };
}

// deno-lint-ignore no-explicit-any
function ctx(steps: any[], snapshots: Record<string, unknown>) {
  return {
    scope: "workflow",
    stepExecutions: steps,
    logger: { info: () => {}, warn: () => {} },
    dataRepository: {
      getContent: (
        _t: string,
        _m: string,
        name: string,
      ): Promise<Uint8Array | null> => {
        const snap = snapshots[name];
        return Promise.resolve(
          snap ? new TextEncoder().encode(JSON.stringify(snap)) : null,
        );
      },
    },
  };
}

// ---------------------------------------------------------------------------
// #1 Completeness — an unexamined fleet is never a clean fleet
// ---------------------------------------------------------------------------

Deno.test("MECH#1 every step in the run is represented in the fleet count", async () => {
  const steps = [
    {
      stepName: "a",
      modelType: "@sntxrr/restic/repository",
      modelId: "m1",
      status: "succeeded",
      dataHandles: [{ name: "r1", specName: "repository", version: 1 }],
    },
    // Failed before writing anything. Spec-based discovery alone goes blind
    // here, and this is exactly the repository that must not disappear.
    {
      stepName: "b",
      modelType: "@sntxrr/restic/repository",
      modelId: "m2",
      status: "failed",
      dataHandles: [],
    },
  ];
  const out = await report.execute(ctx(steps, {
    r1: { repositoryName: "heron-debian", reachable: true, snapshotCount: 1 },
  }));
  assertEquals(out.json.repositoriesExamined, 2, "a repository vanished");
  assertEquals(out.json.repositoriesScanned, 1);
  assertEquals(
    out.json.fleetScanComplete,
    false,
    "a partial fleet reported itself complete",
  );
});

Deno.test("MECH#1 a completeness flag exists for every partial-assessment mode", async () => {
  const out = await report.execute(ctx([{
    stepName: "a",
    modelType: "@sntxrr/restic/repository",
    modelId: "m1",
    status: "succeeded",
    dataHandles: [{ name: "r1", specName: "repository", version: 1 }],
  }], { r1: { repositoryName: "x", reachable: true, snapshotCount: 1 } }));
  // Both must be present and boolean. A consumer alerting on findings needs a
  // way to know the finding list was computed over everything.
  for (const flag of ["fleetScanComplete", "standingRecordsReadable"]) {
    assertEquals(
      typeof out.json[flag],
      "boolean",
      `${flag} is missing — an incomplete run cannot be detected`,
    );
  }
});

// ---------------------------------------------------------------------------
// #2 Exclusions are never silent
// ---------------------------------------------------------------------------

Deno.test("MECH#2 every dormant exclusion is emitted as a finding", () => {
  const fleet = [
    state({ name: "a", dormant: true }),
    state({ name: "b", dormant: true }),
    state({ name: "c" }),
  ];
  const { findings, dormantExcluded } = analyze(fleet, OPTS);
  assertEquals(dormantExcluded.length, 2);
  assertEquals(
    findings.filter((f) => f.code === "repo-dormant-declared").length,
    dormantExcluded.length,
    "an exclusion was counted but never printed — 'found none' now hides " +
      "'left some out'",
  );
});

Deno.test("MECH#2 dormancy suppresses staleness and nothing else", () => {
  const s = state({
    dormant: true,
    stale: false,
    scopeDrift: true,
    missingPaths: ["/etc"],
    hostnameDrift: true,
    hostnames: ["a", "b"],
  });
  const codes = analyze([s], OPTS).findings.map((f) => f.code);
  assert(!codes.includes("repo-stale"));
  assert(
    codes.includes("backup-scope-drift"),
    "dormancy silenced a finding that has nothing to do with staleness",
  );
  assert(codes.includes("hostname-drift"));
});

// ---------------------------------------------------------------------------
// #3 Absence of proof is never proof — and never overstated either
// ---------------------------------------------------------------------------

Deno.test("MECH#3 an unexercised fleet fires the headline finding for all of it", () => {
  const fleet = ["a", "b", "c", "d"].map((n) => state({ name: n }));
  const { findings } = analyze(fleet, OPTS);
  assertEquals(
    findings.filter((f) => f.code === "restore-never-proven").length,
    4,
  );
  assertEquals(
    findings.filter((f) => f.code === "data-never-verified").length,
    4,
  );
});

Deno.test("MECH#3 wording distinguishes 'never' from 'not in this run'", () => {
  const s = state();
  const confident = analyze([s], OPTS).findings
    .find((f) => f.code === "restore-never-proven")!;
  const hedged = analyze([s], { standingRecordsReadable: false }).findings
    .find((f) => f.code === "restore-never-proven")!;
  assert(
    confident.detail !== hedged.detail,
    "the report says 'never proven' even when it could not read the history",
  );
});

Deno.test("MECH#3 no finding claims a number the data did not supply", () => {
  // A repository scanned but with a null age must not render a fabricated one.
  const s = state({ stale: true, latestSnapshotAgeHours: null });
  const f = analyze([s], OPTS).findings.find((f) => f.code === "repo-stale")!;
  assert(
    !/\bNaN\b|undefined|null days/.test(f.detail),
    `fabricated or malformed number in: ${f.detail}`,
  );
});

// ---------------------------------------------------------------------------
// #4 Finding codes are a stable alerting surface
// ---------------------------------------------------------------------------

Deno.test("MECH#4 every finding code is kebab-case and every severity is known", () => {
  const fleet = [
    state({ name: "a" }),
    state({ name: "b", scanned: false }),
    state({ name: "c", reachable: false }),
    state({ name: "d", dormant: true }),
    state({ name: "e", stale: true }),
    state({ name: "f", snapshotCount: 0 }),
    state({ name: "g", scopeDrift: true, missingPaths: ["/etc"] }),
    state({ name: "h", hostnameDrift: true, hostnames: ["x", "y"] }),
    state({ name: "i", writerVersions: ["0.12.0"] }),
    state({ name: "j", unlock: { succeeded: false, locksRemoved: null } }),
  ];
  const { findings } = analyze(fleet, OPTS);
  assert(findings.length > 0);
  const known = new Set(["critical", "high", "medium", "low", "info"]);
  for (const f of findings) {
    assert(/^[a-z][a-z0-9-]*$/.test(f.code), `bad code: ${f.code}`);
    assert(known.has(f.severity), `bad severity: ${f.severity}`);
    assert(f.subject.length > 0, `finding with no subject: ${f.code}`);
    assert(
      f.detail.length > 0 && f.impact.length > 0,
      `empty prose: ${f.code}`,
    );
  }
});

Deno.test("MECH#4 findings are ordered most severe first", () => {
  const fleet = [
    state({ name: "a", dormant: true }),
    state({ name: "b", stale: true }),
    state({ name: "c" }),
  ];
  const order = ["critical", "high", "medium", "low", "info"];
  const seen = analyze(fleet, OPTS).findings.map((f) =>
    order.indexOf(f.severity)
  );
  assertEquals(
    [...seen].sort((x, y) => x - y),
    seen,
    "a critical finding could be buried below an info one",
  );
});

// ---------------------------------------------------------------------------
// #5 The report is read-only and cannot touch a repository
// ---------------------------------------------------------------------------

Deno.test("MECH#5 the report declares no write surface", () => {
  assertEquals(report.scope, "workflow");
  // deno-lint-ignore no-explicit-any
  const r = report as any;
  for (const forbidden of ["writeResource", "createFileWriter", "methods"]) {
    assertEquals(r[forbidden], undefined, `report exposes ${forbidden}`);
  }
});

Deno.test("MECH#5 a context with no data repository cannot crash the run", async () => {
  // A report that throws takes the workflow's summary with it. Reading a
  // snapshot must degrade to "not scanned", never to an exception.
  const out = await report.execute({
    scope: "workflow",
    stepExecutions: [{
      stepName: "a",
      modelType: "@sntxrr/restic/repository",
      modelId: "m1",
      status: "succeeded",
      dataHandles: [{ name: "r1", specName: "repository", version: 1 }],
    }],
    logger: { info: () => {} },
    dataRepository: {
      getContent: () => Promise.reject(new Error("datastore down")),
    },
  });
  assertEquals(out.json.repositoriesExamined, 1);
  assertEquals(out.json.repositoriesScanned, 0);
  assertEquals(out.json.fleetScanComplete, false);
});

// ---------------------------------------------------------------------------
// #6 Step discovery survives renaming
// ---------------------------------------------------------------------------

Deno.test("MECH#6 discovery keys on specs and modelType, never on step name", () => {
  // A step name is a label the workflow author picks. Renaming one must not
  // make a repository invisible to the audit.
  assert(isRepositoryStep({
    stepName: "something-completely-different",
    dataHandles: [{ specName: "repository" }],
  }));
  assert(isRepositoryStep({
    stepName: "renamed-again",
    dataHandles: [],
    modelType: "@sntxrr/restic/repository",
  }));
  assert(
    !isRepositoryStep({
      stepName: "freshness-heron",
      dataHandles: [{ specName: "bucket" }],
      modelType: "@sntxrr/b2/account",
    }),
  );
});
