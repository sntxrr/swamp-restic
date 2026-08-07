import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import {
  ageHours,
  classifyFailure,
  isInconclusive,
  lastMessageOfType,
  missingPaths,
  model,
  parseJsonLines,
  redactSecrets,
  repositoryName,
  RESTIC_EXIT,
  type ResticResult,
  runRestic,
  safeFragment,
} from "./restic_repository.ts";

const CREDS = {
  repository: "s3:s3.example.invalid/heron-debian",
  password: "test-repo-password",
  accessKeyId: "test-key-id",
  secretAccessKey: "test-secret-access-key",
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * A fake restic binary. Tests exercise the REAL subprocess boundary — argv
 * construction, --no-lock injection, env assembly, exit codes and parsing all
 * execute for real. Stubbing the parse step would test nothing.
 */
async function fakeRestic(
  script: string,
): Promise<{ path: string; cleanup: () => void }> {
  const dir = await Deno.makeTempDir({ prefix: "restic-test-" });
  const path = `${dir}/restic`;
  await Deno.writeTextFile(path, `#!/bin/sh\n${script}\n`);
  await Deno.chmod(path, 0o755);
  return { path, cleanup: () => Deno.removeSync(dir, { recursive: true }) };
}

interface Written {
  spec: string;
  instance: string;
  data: Record<string, unknown>;
}

/**
 * An ExecuteContext whose writeResource VALIDATES against the real resource
 * schema.
 *
 * A recording-only stub makes every schema bug invisible — this is mandatory
 * per CONVENTIONS.md §8, not advisory.
 */
function makeContext(
  globalArgs: Record<string, unknown>,
): { context: never; written: Written[] } {
  const written: Written[] = [];
  const resources = model.resources as Record<string, { schema: z.ZodType }>;
  const context = {
    globalArgs,
    logger: { info: () => {}, warn: () => {} },
    writeResource(
      spec: string,
      instance: string,
      data: Record<string, unknown>,
    ) {
      const definition = resources[spec];
      if (!definition) throw new Error(`unknown resource "${spec}"`);
      const parsed = definition.schema.safeParse(data);
      if (!parsed.success) {
        throw new Error(
          `resource written to "${spec}" failed validation: ` +
            JSON.stringify(parsed.error.issues),
        );
      }
      written.push({ spec, instance, data });
      return Promise.resolve({ name: instance });
    },
  };
  return { context: context as never, written };
}

function result(overrides: Partial<ResticResult> = {}): ResticResult {
  return {
    code: 0,
    stdout: "",
    stdoutBytes: new Uint8Array(),
    stderr: "",
    durationMs: 1,
    timedOut: false,
    ...overrides,
  };
}

// deno-lint-ignore no-explicit-any
const methods = model.methods as any;
// deno-lint-ignore no-explicit-any
const checks = model.checks as any;

/** Global arguments pointing at a fake restic binary. */
function globalsFor(
  binary: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...CREDS, resticBinary: binary, ...extra };
}

// ---------------------------------------------------------------------------
// THE SAFETY RULE — --no-lock (CONVENTIONS §3)
// ---------------------------------------------------------------------------

Deno.test("runRestic injects --no-lock when the caller omits it", async () => {
  const fake = await fakeRestic('echo "$@"');
  try {
    const out = await runRestic(CREDS, ["snapshots", "--json"], {
      binary: fake.path,
    });
    assertStringIncludes(out.stdout, "--no-lock");
  } finally {
    fake.cleanup();
  }
});

Deno.test("runRestic never emits --no-lock twice", async () => {
  const fake = await fakeRestic('echo "$@"');
  try {
    const out = await runRestic(CREDS, ["check", "--no-lock"], {
      binary: fake.path,
    });
    assertEquals(
      out.stdout.trim().split(/\s+/).filter((a) => a === "--no-lock").length,
      1,
    );
  } finally {
    fake.cleanup();
  }
});

Deno.test("every restic invocation a method makes carries --no-lock", async () => {
  // The rule that matters: an exclusive lock taken by this suite makes the
  // OWNING host's nightly backup fail. Assert it across real method paths.
  //
  // The log path is baked into the script rather than passed as an env var,
  // because clearEnv deliberately strips anything not explicitly allowed.
  const log = await Deno.makeTempFile();
  const fake = await fakeRestic(
    `echo "$@" >> ${log}\n` +
      'case "$1" in\n' +
      "  snapshots) echo '[]' ;;\n" +
      "  cat) echo '{\"version\":2}' ;;\n" +
      '  version) echo \'{"version":"0.19.1"}\' ;;\n' +
      '  check) echo \'{"message_type":"summary","num_errors":0,' +
      '"broken_packs":null,"suggest_repair_index":false,' +
      '"suggest_prune":false}\' ;;\n' +
      "esac",
  );
  try {
    const g = globalsFor(fake.path);
    await methods.scan.execute({}, makeContext(g).context);
    await methods.check.execute({}, makeContext(g).context);
    await methods.verify.execute({}, makeContext(g).context);

    const lines = (await Deno.readTextFile(log)).trim().split("\n")
      .filter((l) => l.length > 0);
    assert(lines.length >= 5, `expected several invocations, got ${lines}`);
    for (const line of lines) {
      assertStringIncludes(line, "--no-lock");
    }
  } finally {
    fake.cleanup();
    Deno.removeSync(log);
  }
});

// ---------------------------------------------------------------------------
// Read-only enforcement and secret hygiene
// ---------------------------------------------------------------------------

for (const command of ["backup", "forget", "prune", "init", "key", "copy"]) {
  Deno.test(`runRestic refuses the write command "${command}"`, async () => {
    await assertRejects(
      () => runRestic(CREDS, [command], { binary: "/bin/echo" }),
      Error,
      "read-only",
    );
  });
}

Deno.test("runRestic refuses a credential passed in argv", async () => {
  // ps is world-readable; a secret in argv leaks to every user on the host.
  await assertRejects(
    () => runRestic(CREDS, ["snapshots", CREDS.password], { binary: "/bin/e" }),
    Error,
    "world-readable",
  );
  await assertRejects(
    () =>
      runRestic(CREDS, ["stats", `--x=${CREDS.secretAccessKey}`], {
        binary: "/bin/e",
      }),
    Error,
    "world-readable",
  );
});

Deno.test("credentials travel in the environment, and argv stays clean", async () => {
  const fake = await fakeRestic('echo "ARGV:$*"; echo "PW:$RESTIC_PASSWORD"');
  try {
    const out = await runRestic(CREDS, ["snapshots"], { binary: fake.path });
    assertStringIncludes(out.stdout, `PW:${CREDS.password}`);
    assert(
      !out.stdout.split("\n")[0].includes(CREDS.password),
      "password must never appear in argv",
    );
  } finally {
    fake.cleanup();
  }
});

Deno.test("clearEnv keeps unrelated parent variables out of the subprocess", async () => {
  const fake = await fakeRestic('echo "LEAK:${UNRELATED_PARENT_VAR:-none}"');
  try {
    Deno.env.set("UNRELATED_PARENT_VAR", "should-not-propagate");
    const out = await runRestic(CREDS, ["snapshots"], { binary: fake.path });
    assertStringIncludes(out.stdout, "LEAK:none");
  } finally {
    Deno.env.delete("UNRELATED_PARENT_VAR");
    fake.cleanup();
  }
});

Deno.test("stderr is redacted before it can reach a resource", async () => {
  const fake = await fakeRestic('echo "boom $RESTIC_PASSWORD" >&2; exit 1');
  try {
    const out = await runRestic(CREDS, ["snapshots"], { binary: fake.path });
    assert(!out.stderr.includes(CREDS.password));
    assertStringIncludes(out.stderr, "[redacted]");
  } finally {
    fake.cleanup();
  }
});

Deno.test("no credential reaches a written resource, even when restic fails", async () => {
  const fake = await fakeRestic(
    'echo "auth failed for $AWS_SECRET_ACCESS_KEY / $RESTIC_PASSWORD" >&2; ' +
      "exit 12",
  );
  const { context, written } = makeContext(globalsFor(fake.path));
  try {
    await methods.scan.execute({}, context);
    const serialised = JSON.stringify(written);
    assert(!serialised.includes(CREDS.password), "password leaked");
    assert(!serialised.includes(CREDS.secretAccessKey), "secret key leaked");
    assertStringIncludes(String(written[0].data.failureDetail), "[redacted]");
  } finally {
    fake.cleanup();
  }
});

Deno.test("redactSecrets ignores empty secrets rather than redacting everything", () => {
  assertEquals(redactSecrets("hello", [""]), "hello");
  assertEquals(redactSecrets("a-b-a", ["a"]), "[redacted]-b-[redacted]");
});

// ---------------------------------------------------------------------------
// Parsing — shapes verified against a live 0.19.1 binary
// ---------------------------------------------------------------------------

Deno.test("parseJsonLines skips the progress-bar noise restic 0.19.0 leaks", () => {
  const messages = parseJsonLines(
    "[0:12] 43.21%  downloading\n" +
      '{"message_type":"status","percent_done":0.5}\n' +
      "not json at all\n" +
      '{"message_type":"summary","total_files":3}\n',
  );
  assertEquals(messages.length, 2);
  assertEquals(messages[1].message_type, "summary");
});

Deno.test("parseJsonLines tolerates an unknown message_type", () => {
  assertEquals(
    parseJsonLines('{"message_type":"invented_later","x":1}').length,
    1,
  );
});

Deno.test("parseJsonLines rejects a bare JSON array line", () => {
  assertEquals(parseJsonLines("[1,2,3]").length, 0);
});

Deno.test("lastMessageOfType returns the LAST summary, not the first", () => {
  const messages = parseJsonLines(
    '{"message_type":"summary","n":1}\n{"message_type":"summary","n":2}',
  );
  assertEquals(lastMessageOfType(messages, "summary")?.n, 2);
  assertEquals(lastMessageOfType(messages, "absent"), null);
});

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

Deno.test("classifyFailure maps restic 0.17.1+ exit codes", () => {
  assertEquals(
    classifyFailure(result({ code: RESTIC_EXIT.NO_REPOSITORY })),
    "repository-not-found",
  );
  assertEquals(
    classifyFailure(result({ code: RESTIC_EXIT.ALREADY_LOCKED })),
    "already-locked",
  );
  assertEquals(
    classifyFailure(result({ code: RESTIC_EXIT.WRONG_PASSWORD })),
    "wrong-password",
  );
  assertEquals(classifyFailure(result({ timedOut: true })), "timed-out");
});

Deno.test("classifyFailure falls back to prose for pre-0.17 binaries", () => {
  // Debian 12 ships 0.14.0, where every failure collapses to exit 1.
  assertEquals(
    classifyFailure(result({ code: 1, stderr: "Fatal: wrong password" })),
    "wrong-password",
  );
  assertEquals(
    classifyFailure(
      result({ code: 1, stderr: "repository is already locked by PID 1" }),
    ),
    "already-locked",
  );
  assertEquals(
    classifyFailure(result({ code: 1, stderr: "surprise" })),
    "error",
  );
});

Deno.test("a lock conflict is inconclusive, never a corruption finding", () => {
  assert(isInconclusive(result({ code: RESTIC_EXIT.ALREADY_LOCKED })));
  assert(isInconclusive(result({ code: RESTIC_EXIT.CANCELLED })));
  assert(isInconclusive(result({ timedOut: true })));
  assert(
    isInconclusive(
      result({ code: 1, stderr: "repository is already locked by PID 9" }),
    ),
  );
  // A genuine error must NOT be excused as inconclusive.
  assert(!isInconclusive(result({ code: 1, stderr: "pack 1a2b is damaged" })));
});

// ---------------------------------------------------------------------------
// Derived fields
// ---------------------------------------------------------------------------

Deno.test("repositoryName derives a stable name from a backend URL", () => {
  assertEquals(
    repositoryName("s3:s3.us-west-002.backblazeb2.com/heron-debian"),
    "heron-debian",
  );
  assertEquals(repositoryName("s3:host/mallard-ubuntu/"), "mallard-ubuntu");
  assertEquals(repositoryName("/local/path/kingfisher"), "kingfisher");
});

Deno.test("missingPaths reports expected paths absent from the latest snapshot", () => {
  // The live baseline repository went ["/etc"] -> ["/etc","/var/lib/docker"]
  // -> ["/etc","/root","/var/lib/docker"] over ten months. A restore from any
  // older snapshot silently yields an incomplete host.
  assertEquals(
    missingPaths(["/etc", "/root", "/var/lib/docker"], ["/etc"]),
    ["/root", "/var/lib/docker"],
  );
  assertEquals(missingPaths(["/etc"], ["/etc", "/root"]), []);
  assertEquals(missingPaths([], ["/etc"]), []);
});

Deno.test("ageHours handles a missing or unparseable timestamp", () => {
  const now = Date.parse("2026-08-07T12:00:00Z");
  assertEquals(ageHours("2026-08-07T00:00:00Z", now), 12);
  assertEquals(ageHours(null, now), null);
  assertEquals(ageHours("not-a-date", now), null);
});

Deno.test("safeFragment strips characters unsafe in an instance name", () => {
  assertEquals(safeFragment("Heron_Debian!"), "heron-debian");
  assertEquals(safeFragment("a".repeat(80)).length, 48);
});

Deno.test("safeFragment keeps a short name readable and unhashed", () => {
  // The ordinary case must not change: every existing instance is named after
  // a bucket well under the cap, and renaming one is a data migration.
  assertEquals(safeFragment("heron-debian"), "heron-debian");
  assertEquals(safeFragment("a".repeat(48)), "a".repeat(48));
});

Deno.test("safeFragment cannot collide two names sharing a long prefix", () => {
  // B2 bucket names run to 50 characters, so the 48-character cut is reachable
  // without exotic input. Truncation alone maps both of these onto one
  // instance name, and instance names share a flat namespace on disk — the
  // second scan would silently clobber the first, and one repository's
  // validation status would then be reported as another's.
  const a = safeFragment("backup-" + "x".repeat(40) + "-alpha");
  const b = safeFragment("backup-" + "x".repeat(40) + "-bravo");
  assert(a !== b, "two distinct repository names collapsed to one instance");
  assertEquals(a.length, 48);
  assertEquals(b.length, 48);
});

Deno.test("repositoryName disambiguates two long-tailed repository URLs", () => {
  const a = repositoryName("s3:s3.example.invalid/" + "b".repeat(49) + "1");
  const b = repositoryName("s3:s3.example.invalid/" + "b".repeat(49) + "2");
  assert(a !== b, "two repositories would share one instance name");
});

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

const SNAPSHOTS_FIXTURE = JSON.stringify([
  {
    time: "2026-08-01T00:01:00Z",
    tree: "aa",
    paths: ["/etc"],
    hostname: "heron1",
    username: "root",
    id: "1".repeat(64),
    short_id: "11111111",
  },
  {
    time: "2026-08-07T00:01:00Z",
    tree: "bb",
    parent: "aa",
    paths: ["/etc", "/root"],
    hostname: "heron",
    username: "root",
    id: "2".repeat(64),
    short_id: "22222222",
  },
]);

function scanScript(snapshots: string): string {
  return 'case "$1" in\n' +
    `  snapshots) cat <<'EOF'\n${snapshots}\nEOF\n  ;;\n` +
    '  cat) echo \'{"version":2,"id":"abc"}\' ;;\n' +
    '  version) echo \'{"version":"0.19.1"}\' ;;\n' +
    '  stats) echo \'{"total_size":100203257,' +
    '"total_uncompressed_size":255114219,"compression_ratio":2.54}\' ;;\n' +
    "esac";
}

Deno.test("scan records freshness, drift and format from a live-shaped response", async () => {
  const fake = await fakeRestic(scanScript(SNAPSHOTS_FIXTURE));
  const { context, written } = makeContext(
    globalsFor(fake.path, {
      expectedPaths: ["/etc", "/root", "/var/lib/docker"],
    }),
  );
  try {
    await methods.scan.execute({}, context);

    assertEquals(written.length, 1);
    assertEquals(written[0].spec, "repository");
    const data = written[0].data;
    assertEquals(data.reachable, true);
    assertEquals(data.snapshotCount, 2);
    assertEquals(data.latestSnapshotId, "22222222");
    assertEquals(data.repositoryFormatVersion, 2);
    assertEquals(data.resticVersion, "0.19.1");
    assertEquals(data.totalSizeBytes, 100203257);

    // Two hostnames in one repository means the machine was renamed.
    assertEquals(data.hostnames, ["heron", "heron1"]);
    assertEquals(data.hostnameDrift, true);

    // Scope drift is measured against the LATEST snapshot only.
    assertEquals(data.latestPaths, ["/etc", "/root"]);
    assertEquals(data.missingPaths, ["/var/lib/docker"]);
    assertEquals(data.scopeDrift, true);
  } finally {
    fake.cleanup();
  }
});

Deno.test("scan sorts by time rather than trusting restic's order", async () => {
  const reversed = JSON.stringify(JSON.parse(SNAPSHOTS_FIXTURE).reverse());
  const fake = await fakeRestic(scanScript(reversed));
  const { context, written } = makeContext(globalsFor(fake.path));
  try {
    await methods.scan.execute({}, context);
    assertEquals(written[0].data.latestSnapshotId, "22222222");
  } finally {
    fake.cleanup();
  }
});

Deno.test("scan RECORDS an unreachable repository instead of throwing", async () => {
  // A thrown error writes no resource, and the fleet report then cannot see
  // the repository at all — the "clean sweep reported as no sweep" failure.
  const fake = await fakeRestic('echo "Fatal: wrong password" >&2; exit 12');
  const { context, written } = makeContext(
    globalsFor(fake.path, { expectedPaths: ["/etc"] }),
  );
  try {
    const out = await methods.scan.execute({}, context);
    assertEquals(written.length, 1);
    assertEquals(written[0].data.reachable, false);
    assertEquals(written[0].data.failureReason, "wrong-password");
    assertEquals(out.dataHandles.length, 1);
  } finally {
    fake.cleanup();
  }
});

Deno.test("a dormant repository is excluded from staleness but still recorded", async () => {
  // A powered-off host and a silently broken one look IDENTICAL to restic.
  const old = JSON.stringify([{
    time: "2025-01-01T00:00:00Z",
    paths: ["/etc"],
    hostname: "kingfisher",
    id: "3".repeat(64),
    short_id: "33333333",
  }]);
  const fake = await fakeRestic(scanScript(old));
  try {
    const live = makeContext(globalsFor(fake.path));
    await methods.scan.execute({}, live.context);
    assertEquals(live.written[0].data.stale, true);

    const dormant = makeContext(globalsFor(fake.path, { dormant: true }));
    await methods.scan.execute({}, dormant.context);
    assertEquals(dormant.written[0].data.stale, false);
    // Excluded, never silent: the resource still exists and says why.
    assertEquals(dormant.written[0].data.dormant, true);
    assertEquals(dormant.written[0].data.snapshotCount, 1);
  } finally {
    fake.cleanup();
  }
});

Deno.test("detailed mode emits snapshots and aggregate mode does not", async () => {
  const fake = await fakeRestic(scanScript(SNAPSHOTS_FIXTURE));
  try {
    const aggregate = makeContext(globalsFor(fake.path));
    await methods.scan.execute({}, aggregate.context);
    assertEquals(
      aggregate.written.filter((w) => w.spec === "snapshot").length,
      0,
    );

    const detailed = makeContext(globalsFor(fake.path));
    const out = await methods.scan.execute(
      { mode: "detailed" },
      detailed.context,
    );
    assertEquals(
      detailed.written.filter((w) => w.spec === "snapshot").length,
      2,
    );
    assertEquals(out.dataHandles.length, 3);
  } finally {
    fake.cleanup();
  }
});

Deno.test("scan accepts a snapshot with no tags, summary or program_version", async () => {
  // A fleet running 0.14.0/0.16.4 omits all three. Typing them as required
  // fails validation on every real repository.
  const lean = JSON.stringify([{
    time: "2026-08-07T00:00:00Z",
    paths: ["/etc"],
    hostname: "heron",
    id: "4".repeat(64),
    short_id: "44444444",
  }]);
  const fake = await fakeRestic(scanScript(lean));
  const { context, written } = makeContext(globalsFor(fake.path));
  try {
    await methods.scan.execute({}, context);
    assertEquals(written[0].data.writerVersions, []);
  } finally {
    fake.cleanup();
  }
});

// ---------------------------------------------------------------------------
// check / verify
// ---------------------------------------------------------------------------

const CLEAN_CHECK = '{"message_type":"summary","num_errors":0,' +
  '"broken_packs":null,"suggest_repair_index":false,"suggest_prune":false}';

Deno.test("check accepts broken_packs: null, which is what a clean repo returns", async () => {
  // Typing broken_packs as an array fails on every healthy repository.
  const fake = await fakeRestic(`echo '${CLEAN_CHECK}'`);
  const { context, written } = makeContext(globalsFor(fake.path));
  try {
    await methods.check.execute({}, context);
    assertEquals(written[0].spec, "validation");
    assertEquals(written[0].instance, "validation-check");
    assertEquals(written[0].data.passed, true);
    assertEquals(written[0].data.brokenPacks, null);
    assertEquals(written[0].data.numErrors, 0);
    assertEquals(written[0].data.readDataSubset, null);
  } finally {
    fake.cleanup();
  }
});

Deno.test("verify passes the subset through and defaults to the n/t form", async () => {
  const fake = await fakeRestic(`echo "$@" >&2; echo '${CLEAN_CHECK}'`);
  try {
    const dflt = makeContext(globalsFor(fake.path));
    await methods.verify.execute({}, dflt.context);
    assertEquals(dflt.written[0].data.readDataSubset, "1/7");
    assertEquals(dflt.written[0].instance, "validation-read-data");

    const explicit = makeContext(globalsFor(fake.path));
    await methods.verify.execute({ subset: "3/7" }, explicit.context);
    assertEquals(explicit.written[0].data.readDataSubset, "3/7");
  } finally {
    fake.cleanup();
  }
});

Deno.test("check reports errors as a failure and throws", async () => {
  const fake = await fakeRestic(
    `echo '{"message_type":"summary","num_errors":2,` +
      `"broken_packs":["1a2b"],"suggest_repair_index":true,` +
      `"suggest_prune":false}'; echo "pack 1a2b broken" >&2; exit 1`,
  );
  const { context, written } = makeContext(globalsFor(fake.path));
  try {
    await assertRejects(() => methods.check.execute({}, context), Error);
    assertEquals(written[0].data.passed, false);
    assertEquals(written[0].data.inconclusive, false);
    assertEquals(written[0].data.numErrors, 2);
    assertEquals(written[0].data.brokenPacks, ["1a2b"]);
    assertEquals(written[0].data.suggestRepairIndex, true);
  } finally {
    fake.cleanup();
  }
});

Deno.test("a locked repository is recorded inconclusive and does NOT throw", async () => {
  const fake = await fakeRestic(
    'echo "repository is already locked by PID 1" >&2; exit 11',
  );
  const { context, written } = makeContext(globalsFor(fake.path));
  try {
    await methods.check.execute({}, context);
    assertEquals(written[0].data.passed, false);
    assertEquals(written[0].data.inconclusive, true);
    assertEquals(written[0].data.failureReason, "already-locked");
  } finally {
    fake.cleanup();
  }
});

// ---------------------------------------------------------------------------
// dump
// ---------------------------------------------------------------------------

Deno.test("dump hashes the canary bytes and never passes --json", async () => {
  const log = await Deno.makeTempFile();
  const fake = await fakeRestic(`echo "$@" >> ${log}; printf "heron"`);
  const { context, written } = makeContext(globalsFor(fake.path));
  try {
    await methods.dump.execute({ path: "/etc/hostname" }, context);
    assertEquals(String(written[0].data.canarySha256).length, 64);
    assertEquals(written[0].data.canaryBytes, 5);
    assertEquals(written[0].data.passed, true);
    assertEquals(written[0].instance, "validation-dump");

    // --json would corrupt the raw byte stream dump writes to stdout.
    const argv = await Deno.readTextFile(log);
    assert(!argv.includes("--json"), `dump must not use --json: ${argv}`);
  } finally {
    fake.cleanup();
    Deno.removeSync(log);
  }
});

Deno.test("dump fails on a canary hash mismatch", async () => {
  const fake = await fakeRestic('printf "unexpected-content"');
  const { context, written } = makeContext(globalsFor(fake.path));
  try {
    await assertRejects(
      () =>
        methods.dump.execute(
          { path: "/etc/hostname", expectedSha256: "0".repeat(64) },
          context,
        ),
      Error,
      "hash mismatch",
    );
    assertEquals(written[0].data.passed, false);
    assertEquals(written[0].data.failureReason, "canary-hash-mismatch");
  } finally {
    fake.cleanup();
  }
});

Deno.test("dump hashes bytes, so a binary canary is not corrupted by decoding", async () => {
  // A NUL-containing payload: decoding as UTF-8 before hashing would silently
  // alter the digest.
  const fake = await fakeRestic('printf "a\\000b"');
  const { context, written } = makeContext(globalsFor(fake.path));
  try {
    await methods.dump.execute({ path: "/bin/thing" }, context);
    assertEquals(written[0].data.canaryBytes, 3);
  } finally {
    fake.cleanup();
  }
});

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

const RESTORE_OK = '{"message_type":"status","percent_done":0.5}\n' +
  '{"message_type":"summary","seconds_elapsed":4,"total_files":1719,' +
  '"files_restored":1719,"total_bytes":254231900,"bytes_restored":254231900}';

Deno.test("the size guard measures with a dry run, never with stats", async () => {
  // LIVE-FOUND DEFECT. `restic stats` rejects the <snapshot>:<subfolder>
  // selector: it warns on stderr, then exits 0 with
  // {"total_size":0,"snapshots_count":0}. Measuring with stats made the
  // ceiling compare 0 > ceiling and pass for ANY size, so the guard was
  // inoperative for every subtree restore. A mock returning a real number
  // hid it completely.
  const log = await Deno.makeTempFile();
  const fake = await fakeRestic(
    `echo "$@" >> ${log}\n` +
      'case "$1" in\n' +
      '  stats) echo \'{"total_size":0,"snapshots_count":0}\' ;;\n' +
      '  restore) printf \'%s\\n\' \'{"message_type":"summary",' +
      '"total_files":1719,"files_restored":1719,' +
      '"total_bytes":254231900,"bytes_restored":254231900}\' ;;\n' +
      "esac",
  );
  const { context, written } = makeContext(globalsFor(fake.path));
  try {
    await methods.restore.execute(
      { path: "/etc", target: "/tmp/drill", maxRestoreBytes: 1e9 },
      context,
    );
    const argv = await Deno.readTextFile(log);
    assert(
      !argv.includes("stats"),
      `stats cannot size a subtree and must not be used: ${argv}`,
    );
    assertStringIncludes(argv, "--dry-run");
    // The estimate must be the real byte count, not the zero stats returns.
    assertEquals(written[0].data.estimatedBytes, 254231900);
  } finally {
    fake.cleanup();
    Deno.removeSync(log);
  }
});

Deno.test("restore FAILS CLOSED when the size cannot be measured", async () => {
  // An unmeasurable size must never read as a safe size — that is exactly
  // how the stats-based guard let everything through.
  const fake = await fakeRestic(
    'case "$1" in\n' +
      "  restore)\n" +
      '    if [ "$*" = "${*#--dry-run}" ]; then\n' +
      '      echo "REAL RESTORE SHOULD NOT RUN" >&2; exit 1\n' +
      "    fi\n" +
      '    echo \'{"message_type":"exit_error","code":1,' +
      '"message":"path nope: not found"}\'\n' +
      "  ;;\n" +
      "esac",
  );
  const { context, written } = makeContext(globalsFor(fake.path));
  try {
    await assertRejects(
      () =>
        methods.restore.execute(
          { path: "/nope", target: "/tmp/drill" },
          context,
        ),
      Error,
      "could not measure",
    );
    assertEquals(written[0].data.failureReason, "size-unmeasurable");
    assertEquals(written[0].data.estimatedBytes, null);
    assertEquals(written[0].data.bytesRestored, null);
  } finally {
    fake.cleanup();
  }
});

Deno.test("restore records restic's item count, not a regular-file count", async () => {
  // files_restored includes directories and symlinks. The live baseline
  // reported 1719 where the tree held 925 regular files.
  const fake = await fakeRestic(
    'case "$1" in\n' +
      `  restore) printf '%s\\n' '${RESTORE_OK}' ;;\n` +
      "esac",
  );
  const { context, written } = makeContext(globalsFor(fake.path));
  try {
    await methods.restore.execute(
      { path: "/etc", target: "/tmp/drill", maxRestoreBytes: 1e9 },
      context,
    );
    assertEquals(written[0].data.itemsRestored, 1719);
    assertEquals(written[0].data.bytesRestored, 254231900);
    assertEquals(written[0].data.verified, true);
    assertEquals(written[0].data.passed, true);
  } finally {
    fake.cleanup();
  }
});

Deno.test("restore refuses to exceed the ceiling BEFORE any data moves", async () => {
  const fake = await fakeRestic(
    'case "$1" in\n' +
      "  restore)\n" +
      '    if [ "$*" = "${*#--dry-run}" ]; then\n' +
      '      echo "REAL RESTORE SHOULD NOT RUN" >&2; exit 1\n' +
      "    fi\n" +
      '    echo \'{"message_type":"summary","total_files":9,' +
      '"files_restored":9,"total_bytes":5000000000,' +
      '"bytes_restored":5000000000}\'\n' +
      "  ;;\n" +
      "esac",
  );
  const { context, written } = makeContext(globalsFor(fake.path));
  try {
    await assertRejects(
      () =>
        methods.restore.execute({ path: "/", target: "/tmp/drill" }, context),
      Error,
      "ceiling",
    );
    assertEquals(written[0].data.failureReason, "exceeds-size-ceiling");
    // A refused drill must cost nothing: no restore was attempted.
    assertEquals(written[0].data.bytesRestored, null);
    assertEquals(written[0].data.estimatedBytes, 5000000000);
  } finally {
    fake.cleanup();
  }
});

Deno.test("the restore ceiling is raisable PER RUN, not only permanently", async () => {
  // Checks never receive method inputs, so this gate lives in execute. If it
  // were a pre-flight check the only way through would be arming the larger
  // ceiling on the model definition for good.
  const fake = await fakeRestic(
    'case "$1" in\n' +
      "  restore)\n" +
      '    if [ "$*" = "${*#--dry-run}" ]; then\n' +
      `      printf '%s\\n' '${RESTORE_OK}'\n` +
      "    else\n" +
      '      echo \'{"message_type":"summary","total_files":9,' +
      '"files_restored":9,"total_bytes":2000000000,' +
      '"bytes_restored":2000000000}\'\n' +
      "    fi\n" +
      "  ;;\n" +
      "esac",
  );
  try {
    const refused = makeContext(globalsFor(fake.path));
    await assertRejects(
      () =>
        methods.restore.execute(
          { path: "/etc", target: "/tmp/drill" },
          refused.context,
        ),
      Error,
      "ceiling",
    );

    const allowed = makeContext(globalsFor(fake.path));
    await methods.restore.execute(
      { path: "/etc", target: "/tmp/drill", maxRestoreBytes: 3e9 },
      allowed.context,
    );
    assertEquals(allowed.written[0].data.passed, true);
  } finally {
    fake.cleanup();
  }
});

// ---------------------------------------------------------------------------
// unlock — the one permitted mutation
// ---------------------------------------------------------------------------

Deno.test("unlock refuses without an acknowledgement", async () => {
  await assertRejects(
    () =>
      methods.unlock.execute(
        {},
        makeContext(globalsFor("/bin/true")).context,
      ),
    Error,
    "allowUnlock=true",
  );
});

Deno.test("unlock accepts the acknowledgement as a METHOD INPUT", async () => {
  // The defect this guards: a pre-flight check sees only globalArgs, rejects
  // --input allowUnlock=true, and forces the flag to be armed permanently.
  const fake = await fakeRestic("exit 0");
  try {
    const out = await methods.unlock.execute(
      { allowUnlock: true },
      makeContext(globalsFor(fake.path)).context,
    );
    assertEquals(out.dataHandles.length, 0);
  } finally {
    fake.cleanup();
  }
});

Deno.test("unlock never uses --remove-all, which would delete live locks", async () => {
  const log = await Deno.makeTempFile();
  const fake = await fakeRestic(`echo "$@" >> ${log}; exit 0`);
  try {
    await methods.unlock.execute(
      { allowUnlock: true },
      makeContext(globalsFor(fake.path)).context,
    );
    const argv = await Deno.readTextFile(log);
    assert(!argv.includes("--remove-all"), `unsafe unlock argv: ${argv}`);
  } finally {
    fake.cleanup();
    Deno.removeSync(log);
  }
});

// ---------------------------------------------------------------------------
// Model shape
// ---------------------------------------------------------------------------

Deno.test("the model declares no write-capable method", () => {
  const names = Object.keys(model.methods).sort();
  for (const forbidden of ["backup", "forget", "prune", "init"]) {
    assert(!names.includes(forbidden), `${forbidden} must not be a method`);
  }
  assertEquals(names, ["check", "dump", "restore", "scan", "unlock", "verify"]);
});

Deno.test("no check gates a method that takes an acknowledgement input", () => {
  // Asserting the platform boundary directly: swamp never passes method
  // inputs to checks, so a check can never gate on an acknowledgement.
  for (const [name, check] of Object.entries(checks)) {
    const appliesTo = (check as { appliesTo?: string[] }).appliesTo ?? [];
    for (const method of appliesTo) {
      assert(
        method !== "unlock" && method !== "restore",
        `check "${name}" must not gate "${method}" — checks cannot see ` +
          `method inputs, so it would reject the per-run acknowledgement`,
      );
    }
  }
});

Deno.test("the repository-url check rejects a bare bucket name", async () => {
  const check = checks["repository-url-configured"];
  const bad = await check.execute({
    globalArgs: { ...CREDS, repository: "heron-debian" },
  });
  assertEquals(bad.pass, false);
  const good = await check.execute({
    globalArgs: { ...CREDS, repository: "s3:host/heron-debian" },
  });
  assertEquals(good.pass, true);
});

Deno.test("the credentials check catches an empty secret", async () => {
  const check = checks["credentials-present"];
  const missing = await check.execute({
    globalArgs: { ...CREDS, password: "  " },
  });
  assertEquals(missing.pass, false);
  assertEquals((missing.errors ?? []).length, 1);
  const ok = await check.execute({ globalArgs: CREDS });
  assertEquals(ok.pass, true);
});
