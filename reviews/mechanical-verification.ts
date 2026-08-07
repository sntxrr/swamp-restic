/**
 * Mechanical verification for @sntxrr/restic-repository, per the
 * adversarial-review contract: schema-write conformance, truncation honesty,
 * instance-name consistency, schema field coverage — plus the two invariants
 * this model exists to guarantee.
 *
 * Executed, not read:
 *
 *   deno test --allow-all reviews/mechanical-verification.ts
 *
 * Judgment-based review has missed this class of defect in every extension in
 * this suite. The two checks that matter most here are #5 and #6, because they
 * are the ones whose failure is silent AND destructive:
 *
 *   #5 — a secret reaching argv, a resource snapshot, or a log line. `ps` is
 *        world-readable, and a resource is written to the datastore forever.
 *   #6 — a missing `--no-lock`, or a write subcommand slipping through. Either
 *        one makes the owning host's nightly backup fail. This suite must
 *        never be able to break the backup it validates.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import {
  model,
  RESTIC_EXIT,
  runRestic,
  safeFragment,
} from "../extensions/models/restic-repository/restic_repository.ts";

const CREDS = {
  repository: "s3:s3.example.invalid/heron-debian",
  password: "MECHANICAL-repo-password-do-not-log",
  accessKeyId: "MECHANICALKEYID000000000",
  secretAccessKey: "MECHANICAL-secret-access-key-do-not-log",
};

/** Every secret this harness plants, so #5 can search for all of them. */
const SECRETS = [CREDS.password, CREDS.secretAccessKey];

interface Written {
  spec: string;
  instance: string;
  data: Record<string, unknown>;
}

/** A fake restic binary. The real subprocess boundary executes. */
async function fakeRestic(
  script: string,
): Promise<{ path: string; cleanup: () => void }> {
  const dir = await Deno.makeTempDir({ prefix: "restic-mech-" });
  const path = `${dir}/restic`;
  await Deno.writeTextFile(path, `#!/bin/sh\n${script}\n`);
  await Deno.chmod(path, 0o755);
  return { path, cleanup: () => Deno.removeSync(dir, { recursive: true }) };
}

/**
 * A context whose writeResource VALIDATES against the real resource schema and
 * records every log line. A recording-only stub makes every schema bug
 * invisible.
 */
function makeContext(globalArgs: Record<string, unknown>) {
  const written: Written[] = [];
  const logged: string[] = [];
  const resources = model.resources as Record<string, { schema: z.ZodType }>;
  const context = {
    globalArgs,
    logger: {
      info: (m: string) => logged.push(m),
      warn: (m: string) => logged.push(m),
      debug: (m: string) => logged.push(m),
      error: (m: string) => logged.push(m),
    },
    writeResource: (
      spec: string,
      instance: string,
      data: Record<string, unknown>,
    ) => {
      const resource = resources[spec];
      assert(resource, `writeResource targeted unknown spec "${spec}"`);
      const parsed = resource.schema.safeParse(data);
      assert(
        parsed.success,
        `spec "${spec}" instance "${instance}" failed its own schema: ` +
          JSON.stringify(parsed.error?.issues ?? [], null, 2),
      );
      written.push({ spec, instance, data });
      return Promise.resolve({ name: instance });
    },
    readResource: () => Promise.resolve(null),
  };
  return { context, written, logged };
}

const SNAPSHOTS = JSON.stringify([
  {
    id: "a".repeat(64),
    short_id: "aaaaaaaa",
    time: new Date().toISOString(),
    paths: ["/etc", "/root"],
    hostname: "host.example.net",
    username: "root",
  },
  {
    id: "b".repeat(64),
    short_id: "bbbbbbbb",
    time: new Date().toISOString(),
    paths: ["/etc", "/root"],
    hostname: "host.example.net",
    username: "root",
  },
]);

const STATS = JSON.stringify({
  total_size: 1024,
  total_uncompressed_size: 2048,
  compression_ratio: 2.0,
});

/** Dispatch on subcommand so one fake serves scan's two calls. */
const SCAN_SCRIPT = `
case "$1" in
  snapshots) echo '${SNAPSHOTS}' ;;
  stats)     echo '${STATS}' ;;
  cat)       echo '{"version":2}' ;;
  version)   echo 'restic 0.19.1 compiled with go1.24' ;;
  *)         echo '{}' ;;
esac
exit 0
`;

async function runScan(
  extraGlobals: Record<string, unknown> = {},
  extraArgs: Record<string, unknown> = {},
) {
  const fake = await fakeRestic(SCAN_SCRIPT);
  try {
    const h = makeContext({
      ...CREDS,
      resticBinary: fake.path,
      cacheDir: "/tmp/restic-mech-cache",
      ...extraGlobals,
    });
    // deno-lint-ignore no-explicit-any
    const scan = (model.methods as any).scan;
    const parsedArgs = scan.arguments.parse(extraArgs);
    await scan.execute(parsedArgs, h.context);
    return h;
  } finally {
    fake.cleanup();
  }
}

// ---------------------------------------------------------------------------
// #1 Schema-Write Conformance
// ---------------------------------------------------------------------------

Deno.test("MECH#1 every writeResource validates against its declared spec", async () => {
  const { written } = await runScan({}, { mode: "detailed" });
  assert(written.length > 0, "scan wrote nothing");
  // makeContext throws on any schema mismatch, so reaching here is the pass.
  for (const w of written) {
    assert(
      w.spec in (model.resources as Record<string, unknown>),
      `unknown spec ${w.spec}`,
    );
  }
});

Deno.test("MECH#1 no schema field is hardcoded to a placeholder on the healthy path", async () => {
  const { written } = await runScan();
  const repo = written.find((w) => w.spec === "repository");
  assert(repo, "no repository resource written");
  // These are the fields a placeholder would silently flatten. On the healthy
  // path each must carry real data, not the empty value.
  assertEquals(repo.data.reachable, true);
  assertEquals(repo.data.snapshotCount, 2);
  assert(
    Array.isArray(repo.data.hostnames) && repo.data.hostnames.length === 1,
    "hostnames was not populated from the snapshot list",
  );
  assert(
    Array.isArray(repo.data.latestPaths) && repo.data.latestPaths.length === 2,
    "latestPaths was not populated from the latest snapshot",
  );
  assertEquals(repo.data.repositoryFormatVersion, 2);
  assertEquals(repo.data.totalSizeBytes, 1024);
});

// ---------------------------------------------------------------------------
// #2 Truncation Honesty
// ---------------------------------------------------------------------------

Deno.test("MECH#2 a capped detailed scan is distinguishable from a complete one", async () => {
  const { written } = await runScan({}, { mode: "detailed", maxSnapshots: 1 });
  const repo = written.find((w) => w.spec === "repository");
  const snaps = written.filter((w) => w.spec === "snapshot");
  assert(repo, "no repository resource written");
  assertEquals(snaps.length, 1, "the cap did not apply");

  // The repository resource carries the TRUE total, written before the cap is
  // applied, so a consumer can always detect a partial emission by comparing.
  // If this ever stops holding, a report counting snapshot resources reads a
  // floor as a total — the b2-files `maxPages` defect, in a new place.
  assertEquals(
    repo.data.snapshotCount,
    2,
    "snapshotCount must be the true total, not the emitted count",
  );
  assert(
    (repo.data.snapshotCount as number) > snaps.length,
    "truncation is undetectable: snapshotCount equals the emitted count",
  );
});

// ---------------------------------------------------------------------------
// #3 Instance Name Consistency
// ---------------------------------------------------------------------------

Deno.test("MECH#3 instance names never collide across specs in one execution", async () => {
  const { written } = await runScan({}, { mode: "detailed" });
  const seen = new Map<string, string>();
  for (const w of written) {
    const prior = seen.get(w.instance);
    assert(
      prior === undefined || prior === w.spec,
      `instance "${w.instance}" is written by both "${prior}" and "${w.spec}" ` +
        `— two specs sharing an instance name silently clobber on disk`,
    );
    seen.set(w.instance, w.spec);
  }
  assertEquals(new Set(written.map((w) => w.instance)).size, written.length);
});

Deno.test("MECH#3 each rung owns a distinct validation instance name", () => {
  // deno-lint-ignore no-explicit-any
  const rungs = (model.resources as any).validation.schema.shape.rung.options;
  const names = new Set(rungs.map((r: string) => `validation-${r}`));
  assertEquals(
    names.size,
    rungs.length,
    "two rungs would write the same validation instance",
  );
});

// ---------------------------------------------------------------------------
// #4 Schema Field Coverage
// ---------------------------------------------------------------------------

Deno.test("MECH#4 every repository schema field is written by scan", async () => {
  const { written } = await runScan();
  const repo = written.find((w) => w.spec === "repository");
  assert(repo);
  // deno-lint-ignore no-explicit-any
  const fields = Object.keys((model.resources as any).repository.schema.shape);
  const missing = fields.filter((f) => !(f in repo.data));
  assertEquals(missing, [], `repository fields never written: ${missing}`);
  const extra = Object.keys(repo.data).filter((f) => !fields.includes(f));
  assertEquals(extra, [], `written fields absent from schema: ${extra}`);
});

Deno.test("MECH#4 the unreachable path writes every field too", async () => {
  const fake = await fakeRestic(
    `echo "Fatal: unable to open repo" >&2; exit 10`,
  );
  try {
    const h = makeContext({ ...CREDS, resticBinary: fake.path });
    // deno-lint-ignore no-explicit-any
    const scan = (model.methods as any).scan;
    await scan.execute(scan.arguments.parse({}), h.context);
    const repo = h.written.find((w) => w.spec === "repository");
    assert(repo, "an unreachable repository must still write a resource");
    assertEquals(repo.data.reachable, false);
    // deno-lint-ignore no-explicit-any
    const fields = Object.keys(
      (model.resources as any).repository.schema.shape,
    );
    const missing = fields.filter((f) => !(f in repo.data));
    assertEquals(missing, [], `unreachable path omits: ${missing}`);
  } finally {
    fake.cleanup();
  }
});

Deno.test("MECH#4 every validation schema field is written by a rung", async () => {
  // writeValidation spreads a full null template, so any rung covers the shape.
  const fake = await fakeRestic(
    `echo '{"message_type":"summary","num_errors":0}'`,
  );
  try {
    const h = makeContext({ ...CREDS, resticBinary: fake.path });
    // deno-lint-ignore no-explicit-any
    const check = (model.methods as any).check;
    await check.execute(check.arguments.parse({}), h.context);
    const v = h.written.find((w) => w.spec === "validation");
    assert(v, "check wrote no validation resource");
    // deno-lint-ignore no-explicit-any
    const fields = Object.keys(
      (model.resources as any).validation.schema.shape,
    );
    const missing = fields.filter((f) => !(f in v.data));
    assertEquals(
      missing,
      [],
      `validation fields never written (absent != null): ${missing}`,
    );
  } finally {
    fake.cleanup();
  }
});

Deno.test("MECH#4 every maintenance schema field is written by unlock", async () => {
  const fake = await fakeRestic(`echo "successfully removed 2 locks"; exit 0`);
  try {
    const h = makeContext({ ...CREDS, resticBinary: fake.path });
    // deno-lint-ignore no-explicit-any
    const unlock = (model.methods as any).unlock;
    await unlock.execute(
      unlock.arguments.parse({ allowUnlock: true }),
      h.context,
    );
    const rec = h.written.find((w) => w.spec === "maintenance");
    assert(rec, "unlock wrote no maintenance resource");
    // deno-lint-ignore no-explicit-any
    const fields = Object.keys(
      (model.resources as any).maintenance.schema.shape,
    );
    const missing = fields.filter((f) => !(f in rec.data));
    assertEquals(missing, [], `maintenance fields never written: ${missing}`);
    const extra = Object.keys(rec.data).filter((f) => !fields.includes(f));
    assertEquals(extra, [], `written fields absent from schema: ${extra}`);
  } finally {
    fake.cleanup();
  }
});

Deno.test("MECH#4 an unreported lock count stays null, never collapses to zero", async () => {
  // Live-verified on restic 0.19.1: with nothing to remove, unlock exits 0 and
  // prints nothing at all. A helper of the shape `x ?? 0` here would assert a
  // number restic never gave — the same three-states-into-two defect as
  // legalHoldOnCount and enable_api_keys.
  const fake = await fakeRestic("exit 0");
  try {
    const h = makeContext({ ...CREDS, resticBinary: fake.path });
    // deno-lint-ignore no-explicit-any
    const unlock = (model.methods as any).unlock;
    await unlock.execute(
      unlock.arguments.parse({ allowUnlock: true }),
      h.context,
    );
    const rec = h.written.find((w) => w.spec === "maintenance");
    assert(rec);
    assertEquals(
      rec.data.locksRemoved,
      null,
      "an absent count became a number",
    );
    assertEquals(rec.data.countReported, false);
  } finally {
    fake.cleanup();
  }
});

// ---------------------------------------------------------------------------
// #5 Secret hygiene — argv, resources, logs
// ---------------------------------------------------------------------------

Deno.test("MECH#5 no secret reaches any written resource", async () => {
  const { written } = await runScan({}, { mode: "detailed" });
  const blob = JSON.stringify(written);
  for (const secret of SECRETS) {
    assert(
      !blob.includes(secret),
      `a credential was persisted into a resource snapshot`,
    );
  }
});

Deno.test("MECH#5 no secret reaches any log line", async () => {
  const { logged } = await runScan({}, { mode: "detailed" });
  const blob = logged.join("\n");
  for (const secret of SECRETS) {
    assert(!blob.includes(secret), `a credential was logged`);
  }
});

Deno.test("MECH#5 a credential echoed into stderr is redacted before it is persisted", async () => {
  // restic echoes its configuration into error messages. This is the path by
  // which a repository password reaches a resource snapshot that lives in the
  // datastore forever, and it is not hypothetical — the runner redacts at the
  // subprocess boundary precisely because of it.
  const fake = await fakeRestic(
    `echo "Fatal: config error: password=${CREDS.password} key=${CREDS.secretAccessKey}" >&2; exit 1`,
  );
  try {
    const h = makeContext({ ...CREDS, resticBinary: fake.path });
    // deno-lint-ignore no-explicit-any
    const scan = (model.methods as any).scan;
    await scan.execute(scan.arguments.parse({}), h.context);
    const blob = JSON.stringify(h.written) + "\n" + h.logged.join("\n");
    for (const secret of SECRETS) {
      assert(
        !blob.includes(secret),
        "a credential echoed by restic reached a resource or a log line",
      );
    }
    assert(blob.includes("[redacted]"), "redaction did not run at all");
  } finally {
    fake.cleanup();
  }
});

Deno.test("MECH#5 a secret in argv is refused before the process spawns", async () => {
  let threw = false;
  try {
    await runRestic(CREDS, ["snapshots", `--password=${CREDS.password}`]);
  } catch (e) {
    threw = true;
    assert(
      String(e).includes("world-readable"),
      "wrong error; expected the ps/argv refusal",
    );
  }
  assert(threw, "a credential in argv was NOT refused — ps is world-readable");
});

Deno.test("MECH#5 credentials travel by environment, never by argument", async () => {
  const fake = await fakeRestic(`echo "$@" > "$0.argv"; echo '[]'`);
  try {
    await runRestic({ ...CREDS }, ["snapshots", "--json"], {
      binary: fake.path,
    });
    const argv = await Deno.readTextFile(`${fake.path}.argv`);
    for (const secret of SECRETS) {
      assert(!argv.includes(secret), `credential found in argv: ${argv}`);
    }
  } finally {
    fake.cleanup();
  }
});

// ---------------------------------------------------------------------------
// #6 The two safety invariants
// ---------------------------------------------------------------------------

Deno.test("MECH#6 --no-lock is injected on every invocation", async () => {
  const fake = await fakeRestic(`echo "$@" > "$0.argv"; echo '[]'`);
  try {
    for (
      const cmd of [["snapshots", "--json"], ["check"], ["stats"], ["dump"]]
    ) {
      await runRestic(CREDS, cmd, { binary: fake.path });
      const argv = await Deno.readTextFile(`${fake.path}.argv`);
      assert(
        argv.includes("--no-lock"),
        `--no-lock missing for "${cmd[0]}": a validator that locks a ` +
          `repository makes the owning host's nightly backup fail`,
      );
    }
  } finally {
    fake.cleanup();
  }
});

Deno.test("MECH#6 every restic write subcommand is refused at the runner", async () => {
  const writes = [
    "backup",
    "forget",
    "prune",
    "init",
    "key",
    "tag",
    "migrate",
    "repair",
    "copy",
    "rewrite",
  ];
  for (const cmd of writes) {
    let threw = false;
    try {
      await runRestic(CREDS, [cmd]);
    } catch (e) {
      threw = true;
      assert(
        String(e).includes("read-only"),
        `"${cmd}" threw the wrong error: ${e}`,
      );
    }
    assert(threw, `restic "${cmd}" was NOT refused — this suite is read-only`);
  }
});

Deno.test("MECH#6 the model declares no method that can mutate a repository", () => {
  // deno-lint-ignore no-explicit-any
  const methods = Object.keys(model.methods as any);
  assertEquals(
    methods.filter((m) =>
      ["backup", "forget", "prune", "init", "create", "delete", "destroy"]
        .includes(m)
    ),
    [],
    "a write-capable method is declared",
  );
});

// ---------------------------------------------------------------------------
// Housekeeping the review contract also asks for
// ---------------------------------------------------------------------------

Deno.test("specs declare lifetime and garbageCollection", () => {
  for (const [name, spec] of Object.entries(model.resources)) {
    const s = spec as { lifetime?: string; garbageCollection?: number };
    assert(s.lifetime, `spec "${name}" has no lifetime`);
    assert(
      typeof s.garbageCollection === "number",
      `spec "${name}" has no garbageCollection`,
    );
  }
});

Deno.test("no resource schema uses passthrough (breaks CEL validation)", () => {
  for (const [name, spec] of Object.entries(model.resources)) {
    const s = spec as { schema: z.ZodType };
    const def = (s.schema as unknown as { def?: { catchall?: unknown } }).def;
    const catchall = def?.catchall as { type?: string } | undefined;
    assert(
      catchall === undefined || catchall?.type === "never",
      `spec "${name}" allows passthrough keys`,
    );
  }
});

Deno.test("safeFragment cannot collide two distinct ids", () => {
  // The b2-transfer defect: a fragment truncated below the point where two real
  // ids diverge silently maps both onto one instance name.
  const a = safeFragment("4_z" + "0".repeat(80) + "_t0001");
  const b = safeFragment("4_z" + "0".repeat(80) + "_t0002");
  assert(a !== b, "two distinct long ids collapsed to the same fragment");
});

Deno.test("exit codes are the documented restic set", () => {
  assertEquals(RESTIC_EXIT.NO_REPOSITORY, 10);
  assertEquals(RESTIC_EXIT.ALREADY_LOCKED, 11);
  assertEquals(RESTIC_EXIT.WRONG_PASSWORD, 12);
});
