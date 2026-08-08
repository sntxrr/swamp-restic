import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Canonical restic runner — CONVENTIONS.md §5. Copied byte-identical.
// ---------------------------------------------------------------------------

/** Exit codes restic uses from 0.17.1 onward. */
export const RESTIC_EXIT = {
  OK: 0,
  GENERIC: 1,
  PARTIAL: 3,
  NO_REPOSITORY: 10,
  ALREADY_LOCKED: 11,
  WRONG_PASSWORD: 12,
  CANCELLED: 130,
} as const;

/** Credentials for one repository. Never logged, never serialised. */
export interface ResticCredentials {
  repository: string;
  password: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface ResticRunOptions {
  binary?: string;
  cacheDir?: string;
  timeoutMs?: number;
  /** Capture stdout as raw bytes instead of text (required for `dump`). */
  binaryStdout?: boolean;
}

export interface ResticResult {
  code: number;
  stdout: string;
  stdoutBytes: Uint8Array;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/** Commands that must never be invoked: this suite is read-only. */
const FORBIDDEN = new Set([
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
]);

/**
 * Run restic with credentials supplied only through the environment.
 *
 * Two invariants are enforced here rather than trusted to callers, because
 * both fail invisibly and expensively:
 *
 *  - `--no-lock` is injected if absent. `check` takes an EXCLUSIVE lock, and a
 *    validator holding one makes the owning host's nightly backup fail.
 *  - Secrets never reach `args`. Process arguments are world-readable via `ps`.
 */
export async function runRestic(
  creds: ResticCredentials,
  args: string[],
  options: ResticRunOptions = {},
): Promise<ResticResult> {
  const subcommand = args.find((a) => !a.startsWith("-"));
  if (subcommand && FORBIDDEN.has(subcommand)) {
    throw new Error(
      `restic "${subcommand}" is a write operation and this suite is ` +
        `read-only; the ansible restic role owns the write path`,
    );
  }

  const secrets = [creds.password, creds.secretAccessKey].filter((s) =>
    s.length > 0
  );
  for (const arg of args) {
    for (const secret of secrets) {
      if (arg.includes(secret)) {
        throw new Error(
          "refusing to run: a credential appeared in restic arguments, " +
            "which are world-readable via ps",
        );
      }
    }
  }

  const argv = args.includes("--no-lock") ? args : [...args, "--no-lock"];

  // clearEnv gives an explicit, auditable environment. PATH is needed to
  // resolve the binary; HOME is not passed, so RESTIC_CACHE_DIR must be set
  // explicitly or restic has nowhere to cache.
  const env: Record<string, string> = {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin:/usr/local/bin",
    RESTIC_REPOSITORY: creds.repository,
    RESTIC_PASSWORD: creds.password,
    AWS_ACCESS_KEY_ID: creds.accessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
  };
  if (options.cacheDir) env.RESTIC_CACHE_DIR = options.cacheDir;

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const command = new Deno.Command(options.binary ?? "restic", {
      args: argv,
      env,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    });
    const output = await command.output();
    const decoder = new TextDecoder();
    return {
      code: output.code,
      stdout: options.binaryStdout ? "" : decoder.decode(output.stdout),
      stdoutBytes: output.stdout,
      stderr: redactSecrets(decoder.decode(output.stderr), secrets),
      durationMs: Date.now() - started,
      timedOut: false,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        code: RESTIC_EXIT.CANCELLED,
        stdout: "",
        stdoutBytes: new Uint8Array(),
        stderr: `restic timed out after ${timeoutMs}ms`,
        durationMs: Date.now() - started,
        timedOut: true,
      };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * restic echoes its configuration into error messages. Strip credentials
 * before any stderr reaches a resource snapshot or a log line.
 */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.replaceAll(secret, "[redacted]");
  }
  return out;
}

/**
 * Parse restic's JSON-lines output permissively.
 *
 * restic documents that new message types and fields may appear at any time,
 * so an unknown `message_type` is never an error. Non-JSON lines are skipped:
 * restic 0.19.0 leaked a progress bar into JSON mode, and older versions leak
 * plain-text errors into `restore --json`.
 */
export function parseJsonLines(stdout: string): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        messages.push(parsed as Record<string, unknown>);
      }
    } catch {
      // A partial or non-JSON line is expected noise, not a failure.
    }
  }
  return messages;
}

/** The last message of a given type, which is the one that summarises a run. */
export function lastMessageOfType(
  messages: Record<string, unknown>[],
  type: string,
): Record<string, unknown> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].message_type === type) return messages[i];
  }
  return null;
}

/**
 * Was this outcome inconclusive rather than a genuine failure?
 *
 * A lock conflict or a cancellation says nothing about repository health.
 * Recording either as a failed rung reports a healthy repository as broken.
 */
export function isInconclusive(result: ResticResult): boolean {
  if (result.timedOut) return true;
  if (
    result.code === RESTIC_EXIT.ALREADY_LOCKED ||
    result.code === RESTIC_EXIT.CANCELLED
  ) {
    return true;
  }
  // Fleet hosts below 0.17.0 collapse every failure to exit 1, so fall back to
  // matching restic's stable lock-conflict prose.
  return result.code === RESTIC_EXIT.GENERIC &&
    /repository is already locked|already locked exclusively/i.test(
      result.stderr,
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Classify a failed run into a stable reason code.
 *
 * Exit codes 10/11/12 only exist from restic 0.17.x, so the prose fallbacks
 * matter for any repository examined with an older binary.
 */
export function classifyFailure(result: ResticResult): string {
  if (result.timedOut) return "timed-out";
  switch (result.code) {
    case RESTIC_EXIT.NO_REPOSITORY:
      return "repository-not-found";
    case RESTIC_EXIT.ALREADY_LOCKED:
      return "already-locked";
    case RESTIC_EXIT.WRONG_PASSWORD:
      return "wrong-password";
    case RESTIC_EXIT.CANCELLED:
      return "cancelled";
  }
  const stderr = result.stderr;
  if (/wrong password|no key could be found/i.test(stderr)) {
    return "wrong-password";
  }
  if (/repository is already locked|already locked exclusively/i.test(stderr)) {
    return "already-locked";
  }
  if (/unable to open config file|repository does not exist/i.test(stderr)) {
    return "repository-not-found";
  }
  if (/unsupported repository version/i.test(stderr)) {
    return "repository-version-unsupported";
  }
  return "error";
}

/** FNV-1a, rendered as 8 hex chars. Not a cryptographic hash. */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Make a string safe for use as a swamp instance name.
 *
 * When the value has to be truncated, a hash of the FULL input is appended.
 * Truncating alone maps two distinct inputs that share a prefix onto one
 * instance name, and instance names share a flat namespace on disk, so the
 * second write silently clobbers the first — one repository's validation
 * status would then masquerade as another's, which is precisely the false
 * reassurance this suite exists to eliminate. B2 bucket names run to 50
 * characters, so the 48-character cut is reachable with no exotic input at
 * all. Same defect, same fix as `@sntxrr/b2/transfer`'s `unfinishedInstanceName`.
 *
 * Values short enough not to be truncated are returned unchanged, so the
 * ordinary case keeps its readable name.
 */
export function safeFragment(value: string, max = 48): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length <= max) return cleaned;
  const suffix = `-${shortHash(value)}`;
  return cleaned.slice(0, max - suffix.length).replace(/-+$/, "") + suffix;
}

/**
 * Pull the removed-lock count out of `restic unlock`'s free text.
 *
 * `unlock` has no `--json` in any released restic, so this is text parsing and
 * is treated as best-effort: a failure to match returns null, never 0.
 *
 * Live-verified against restic 0.19.1: with nothing to remove, `unlock` exits 0
 * and prints NOTHING on either stream. The `successfully removed N locks` form
 * is restic's message for N > 0 and is matched here, but it is NOT live-
 * verified — manufacturing a genuinely stale lock needs a lock restic agrees is
 * dead, and killing a backup mid-write leaves a partial file that `list locks`
 * does not even report. So a successful unlock that prints nothing is recorded
 * as "no count reported", which on 0.19.1 means zero — but the caller is never
 * told a number restic did not give.
 */
export function parseLocksRemoved(stdout: string): number | null {
  const match = /successfully removed (\d+) locks?/i.exec(stdout);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Derive a short, stable name for a repository from its URL.
 *
 * `s3:s3.us-west-002.backblazeb2.com/heron-debian` -> `heron-debian`.
 */
export function repositoryName(repository: string): string {
  const trimmed = repository.replace(/\/+$/, "");
  const tail = trimmed.split("/").pop() ?? trimmed;
  const name = safeFragment(tail);
  return name.length > 0 ? name : "repository";
}

/**
 * The set difference `expected \ actual`, used for backup-scope drift.
 *
 * A repository's `paths` genuinely change over its life; only the LATEST
 * snapshot's paths describe what a restore today would yield.
 */
export function missingPaths(
  expected: string[],
  actual: string[],
): string[] {
  const have = new Set(actual);
  return expected.filter((p) => !have.has(p));
}

/** Hours between an ISO timestamp and now, or null if unparseable. */
export function ageHours(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, (now - then) / 3_600_000);
}

// ---------------------------------------------------------------------------
// Platform types
// ---------------------------------------------------------------------------

type Logger = {
  info: (message: string, props?: Record<string, unknown>) => void;
  warn: (message: string, props?: Record<string, unknown>) => void;
};

type ExecuteContext<G> = {
  globalArgs: G;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

type Handles = { dataHandles: Array<{ name: string }> };

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Every field restic may omit is optional.
 *
 * `summary` is written by the restic that CREATED the snapshot and only exists
 * from 0.17.0, so on a fleet running 0.14.0/0.16.4 it is absent entirely.
 * `tags` is omitted rather than emitted as `[]` when unset. Typing either as
 * required fails validation on every real repository.
 */
const SnapshotSchema = z.object({
  id: z.string(),
  short_id: z.string(),
  time: z.string(),
  tree: z.string().optional(),
  parent: z.string().optional(),
  paths: z.array(z.string()).default([]),
  hostname: z.string().optional(),
  username: z.string().optional(),
  uid: z.number().optional(),
  gid: z.number().optional(),
  excludes: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  program_version: z.string().optional(),
  summary: z.unknown().optional(),
});

const RepositorySchema = z.object({
  repositoryName: z.string(),
  reachable: z.boolean(),
  failureReason: z.string().nullable(),
  /** Redacted stderr from the failing call, for diagnosis. */
  failureDetail: z.string().nullable(),

  dormant: z.boolean(),
  snapshotCount: z.number(),
  latestSnapshotId: z.string().nullable(),
  latestSnapshotTime: z.string().nullable(),
  latestSnapshotAgeHours: z.number().nullable(),
  stale: z.boolean(),
  maxStaleDays: z.number(),

  /** Distinct hostnames across all snapshots. More than one means a rename. */
  hostnames: z.array(z.string()),
  hostnameDrift: z.boolean(),

  /** Paths in the LATEST snapshot — what a restore today would yield. */
  latestPaths: z.array(z.string()),
  expectedPaths: z.array(z.string()),
  missingPaths: z.array(z.string()),
  scopeDrift: z.boolean(),

  repositoryFormatVersion: z.number().nullable(),
  resticVersion: z.string().nullable(),
  /** Distinct restic versions that have written to this repository. */
  writerVersions: z.array(z.string()),

  totalSizeBytes: z.number().nullable(),
  totalUncompressedBytes: z.number().nullable(),
  compressionRatio: z.number().nullable(),

  scannedAt: z.string(),
  durationMs: z.number(),
});

/**
 * One rung of the validation ladder.
 *
 * `inconclusive` is deliberately distinct from `passed: false`. A lock
 * conflict or a timeout says nothing about repository health, and recording
 * either as a failure reports a healthy repository as broken.
 */
const ValidationSchema = z.object({
  repositoryName: z.string(),
  rung: z.enum(["check", "read-data", "dump", "restore"]),
  passed: z.boolean(),
  inconclusive: z.boolean(),
  failureReason: z.string().nullable(),
  detail: z.string().nullable(),
  exitCode: z.number(),
  ranAt: z.string(),
  durationMs: z.number(),

  /** check / read-data */
  numErrors: z.number().nullable(),
  brokenPacks: z.array(z.string()).nullable(),
  suggestRepairIndex: z.boolean().nullable(),
  suggestPrune: z.boolean().nullable(),
  readDataSubset: z.string().nullable(),

  /** dump */
  canaryPath: z.string().nullable(),
  canaryBytes: z.number().nullable(),
  canarySha256: z.string().nullable(),

  /** restore */
  restorePath: z.string().nullable(),
  restoreTarget: z.string().nullable(),
  /**
   * restic's own item count. It includes directories and symlinks and does
   * NOT equal a count of regular files on disk.
   */
  itemsRestored: z.number().nullable(),
  bytesRestored: z.number().nullable(),
  verified: z.boolean().nullable(),
  estimatedBytes: z.number().nullable(),
  maxRestoreBytes: z.number().nullable(),
});

/**
 * A record of the one mutation this suite is permitted.
 *
 * Deliberately NOT a rung on the validation ladder. `unlock` proves nothing
 * about restorability, and folding it into `ValidationSchema` would make a
 * readiness report iterating rungs invent an "unlock-never-proven" finding —
 * nonsense, and the kind of alarm that trains an operator to ignore the real
 * ones.
 *
 * `locksRemoved` is nullable and paired with `countReported` because restic's
 * `unlock` has no `--json` and prints a count only when it removed something.
 * Collapsing "restic did not say" into `0` is the same false reassurance as
 * `legalHoldOnCount: 0` meaning "B2 never said" — see CONVENTIONS §4.3.
 */
const MaintenanceSchema = z.object({
  repositoryName: z.string(),
  action: z.literal("unlock"),
  succeeded: z.boolean(),
  /** null means restic reported no count — NOT that zero locks were removed. */
  locksRemoved: z.number().nullable(),
  /** False whenever the count is null, so the third state cannot be lost. */
  countReported: z.boolean(),
  failureReason: z.string().nullable(),
  detail: z.string().nullable(),
  exitCode: z.number(),
  ranAt: z.string(),
  durationMs: z.number(),
});

const GlobalArgsSchema = z.object({
  repository: z.string().describe(
    "restic repository URL, e.g. s3:s3.us-west-002.backblazeb2.com/<bucket>",
  ),
  password: z.string().meta({ sensitive: true }).describe(
    "Repository password — supply via vault.get(), never inline.",
  ),
  accessKeyId: z.string().describe(
    "B2 application key ID. Needs only listBuckets, readBuckets, listFiles " +
      "and readFiles; a validation key must not carry writeFiles or " +
      "deleteFiles.",
  ),
  secretAccessKey: z.string().meta({ sensitive: true }).describe(
    "B2 application key — supply via vault.get(), never inline.",
  ),
  resticBinary: z.string().optional().describe(
    "Path to the restic binary. Defaults to `restic` on PATH. Use an " +
      "upstream build: check --json needs 0.18.0 and exit-code " +
      "classification needs 0.17.1.",
  ),
  cacheDir: z.string().optional().describe(
    "RESTIC_CACHE_DIR. Set it explicitly — clearEnv means there is nothing " +
      "useful to inherit, and caches across many repositories add up.",
  ),
  expectedPaths: z.array(z.string()).optional().describe(
    "Paths this repository is expected to contain. Compared against the " +
      "LATEST snapshot to detect backup-scope drift.",
  ),
  dormant: z.boolean().optional().describe(
    "Declare this repository deliberately inactive (host powered off or " +
      "decommissioned). Excluded from staleness, always still counted.",
  ),
  maxStaleDays: z.number().optional().describe(
    "Age in days beyond which the latest snapshot is stale. Default 2.",
  ),
  maxRestoreBytes: z.number().optional().describe(
    "Byte ceiling for a restore drill, checked BEFORE any data moves. " +
      "Default 1 GiB.",
  ),
  timeoutMinutes: z.number().optional().describe(
    "Per-invocation timeout. Default 30.",
  ),
  allowUnlock: z.boolean().optional().describe(
    "Permit `unlock` to remove stale locks. Can also be passed per run.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ScanArgsSchema = z.object({
  mode: z.enum(["aggregate", "detailed"]).optional().describe(
    "aggregate (default) writes one repository resource; detailed also " +
      "emits one resource per snapshot.",
  ),
  maxSnapshots: z.number().optional().describe(
    "Cap on snapshot resources emitted in detailed mode. Default 200.",
  ),
});

const CheckArgsSchema = z.object({});

const VerifyArgsSchema = z.object({
  subset: z.string().optional().describe(
    "Subset to read: 'n/t' (deterministic partition, t<=256), 'x%', or a " +
      "byte size such as '500M'. Default '1/7'.",
  ),
});

const DumpArgsSchema = z.object({
  path: z.string().describe(
    "Absolute path of the canary file inside the snapshot.",
  ),
  snapshot: z.string().optional().describe("Snapshot ID. Default 'latest'."),
  expectedSha256: z.string().optional().describe(
    "If given, the dump fails unless the content hash matches.",
  ),
});

const RestoreArgsSchema = z.object({
  path: z.string().describe(
    "Subtree inside the snapshot to restore, e.g. /etc.",
  ),
  target: z.string().describe(
    "Local directory to restore into. Contents are overwritten.",
  ),
  snapshot: z.string().optional().describe("Snapshot ID. Default 'latest'."),
  maxRestoreBytes: z.number().optional().describe(
    "Override the byte ceiling for this run only.",
  ),
});

const UnlockArgsSchema = z.object({
  allowUnlock: z.boolean().optional().describe(
    "Per-run acknowledgement. Required unless set as a global argument.",
  ),
});

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function credentialsOf(g: GlobalArgs): ResticCredentials {
  return {
    repository: g.repository,
    password: g.password,
    accessKeyId: g.accessKeyId,
    secretAccessKey: g.secretAccessKey,
  };
}

function runOptionsOf(g: GlobalArgs): ResticRunOptions {
  return {
    binary: g.resticBinary,
    cacheDir: g.cacheDir,
    timeoutMs: (g.timeoutMinutes ?? 30) * 60_000,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type ValidationRecord =
  & Partial<z.infer<typeof ValidationSchema>>
  & {
    repositoryName: string;
    rung: "check" | "read-data" | "dump" | "restore";
    passed: boolean;
    inconclusive: boolean;
    exitCode: number;
    ranAt: string;
    durationMs: number;
  };

/** Every nullable field is written explicitly; absent is not the same as null. */
async function writeValidation(
  context: ExecuteContext<GlobalArgs>,
  record: ValidationRecord,
): Promise<{ name: string }> {
  return await context.writeResource(
    "validation",
    `validation-${record.rung}`,
    {
      failureReason: null,
      detail: null,
      numErrors: null,
      brokenPacks: null,
      suggestRepairIndex: null,
      suggestPrune: null,
      readDataSubset: null,
      canaryPath: null,
      canaryBytes: null,
      canarySha256: null,
      restorePath: null,
      restoreTarget: null,
      itemsRestored: null,
      bytesRestored: null,
      verified: null,
      estimatedBytes: null,
      maxRestoreBytes: null,
      ...record,
    },
  );
}

/** Rungs 2 and 3 differ only by the presence of --read-data-subset. */
async function runCheck(
  context: ExecuteContext<GlobalArgs>,
  subset: string | null,
): Promise<Handles> {
  const g = context.globalArgs;
  const name = repositoryName(g.repository);
  const rung = subset === null ? "check" : "read-data";
  const ranAt = new Date().toISOString();

  const args = ["check", "--json"];
  if (subset !== null) args.push(`--read-data-subset=${subset}`);

  const run = await runRestic(credentialsOf(g), args, runOptionsOf(g));
  const summary = lastMessageOfType(parseJsonLines(run.stdout), "summary");

  // `broken_packs` is null on a clean repository, NOT []. Typing it as an
  // array fails validation on every healthy repository.
  const brokenPacks = Array.isArray(summary?.broken_packs)
    ? (summary.broken_packs as string[])
    : null;
  const numErrors = typeof summary?.num_errors === "number"
    ? summary.num_errors
    : null;

  const inconclusive = isInconclusive(run);
  const passed = run.code === RESTIC_EXIT.OK && (numErrors ?? 0) === 0;

  const handle = await writeValidation(context, {
    repositoryName: name,
    rung,
    passed,
    inconclusive: !passed && inconclusive,
    failureReason: passed
      ? null
      : inconclusive
      ? classifyFailure(run)
      : (numErrors ?? 0) > 0
      ? "errors-found"
      : classifyFailure(run),
    detail: passed ? null : run.stderr.slice(0, 2000) || null,
    exitCode: run.code,
    ranAt,
    durationMs: run.durationMs,
    numErrors,
    brokenPacks,
    suggestRepairIndex: typeof summary?.suggest_repair_index === "boolean"
      ? summary.suggest_repair_index
      : null,
    suggestPrune: typeof summary?.suggest_prune === "boolean"
      ? summary.suggest_prune
      : null,
    readDataSubset: subset,
  });

  context.logger.info(
    `${name}: ${rung} ${
      passed ? "passed" : inconclusive ? "inconclusive" : "FAILED"
    }${subset ? ` (subset ${subset})` : ""} in ${
      (run.durationMs / 1000).toFixed(1)
    }s`,
  );

  if (!passed && !inconclusive) {
    throw new Error(
      `restic check failed (${numErrors ?? "?"} errors): ${run.stderr}`,
    );
  }

  return { dataHandles: [handle] };
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export const model = {
  type: "@sntxrr/restic/repository",
  version: "2026.08.07.2",
  globalArguments: GlobalArgsSchema,

  resources: {
    "repository": {
      description:
        "Freshness and identity of one restic repository — snapshot age, " +
        "backed-up paths, hostnames, format version and size",
      schema: RepositorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    "snapshot": {
      description: "One restic snapshot, emitted only in detailed scan mode, " +
        "instance-named snapshot-<short_id>",
      schema: SnapshotSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
    "validation": {
      description:
        "The outcome of one validation-ladder rung — whether it passed, and " +
        "whether a failure was genuine or merely inconclusive",
      schema: ValidationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    "maintenance": {
      description:
        "A record of the one mutation this suite performs — a stale-lock " +
        "removal, dated and queryable. Kept out of the validation stream " +
        "because unlock proves nothing about restorability",
      schema: MaintenanceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },

  checks: {
    "repository-url-configured": {
      description:
        "The repository must be a restic backend URL, not a bare bucket name.",
      labels: ["policy"],
      // deno-lint-ignore require-await
      execute: async (
        context: { globalArgs: GlobalArgs },
      ): Promise<{ pass: boolean; errors?: string[] }> => {
        const repo = context.globalArgs.repository ?? "";
        if (!/^[a-z0-9+.-]+:/i.test(repo)) {
          return {
            pass: false,
            errors: [
              `repository "${repo}" has no backend scheme. Use a restic URL ` +
              `such as s3:s3.us-west-002.backblazeb2.com/<bucket>.`,
            ],
          };
        }
        return { pass: true };
      },
    },
    "credentials-present": {
      description:
        "Both halves of the B2 key and the repository password must be set — " +
        "an empty value fails at restic with a confusing error.",
      labels: ["policy"],
      // deno-lint-ignore require-await
      execute: async (
        context: { globalArgs: GlobalArgs },
      ): Promise<{ pass: boolean; errors?: string[] }> => {
        const g = context.globalArgs;
        const errors: string[] = [];
        if (!g.password?.trim()) {
          errors.push(
            "globalArgs.password is empty — wire it from a vault, e.g. " +
              "${{ vault.get(onepassword, restic-<repo>/restic-password) }}.",
          );
        }
        if (!g.accessKeyId?.trim()) {
          errors.push("globalArgs.accessKeyId is empty.");
        }
        if (!g.secretAccessKey?.trim()) {
          errors.push(
            "globalArgs.secretAccessKey is empty — wire it from a vault.",
          );
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
    // THERE IS DELIBERATELY NO "unlock-acknowledged" PRE-FLIGHT CHECK.
    //
    // Checks receive only globalArgs — swamp never passes method inputs to
    // them — so a check gating `unlock` on an acknowledgement would reject
    // `--input allowUnlock=true` before `execute` ran, and its own error would
    // tell the operator to do the thing it had just made impossible. The only
    // route through would be arming the flag PERMANENTLY on the model, so a
    // check written to prevent an accidental mutation would end up forcing
    // that mutation to be armed for good. The gate lives in `execute`.
  },

  methods: {
    // -----------------------------------------------------------------------
    // Rung 1 — freshness
    // -----------------------------------------------------------------------
    "scan": {
      description:
        "Rung 1. Inventory the repository: snapshot count and age, hostnames, " +
        "backed-up paths, format version and size. Read-only and cheap. " +
        "Records an unreachable repository rather than throwing, so a fleet " +
        "report can still see it. Detects two things nothing else reports: " +
        "backup-scope drift (the set of backed-up paths changing over time, " +
        "so an older snapshot restores an incomplete host) and hostname " +
        "drift. A dormant repository is excluded from staleness but always " +
        "still counted.",
      arguments: ScanArgsSchema,
      execute: async (
        args: z.infer<typeof ScanArgsSchema>,
        context: ExecuteContext<GlobalArgs>,
      ): Promise<Handles> => {
        const started = Date.now();
        const g = context.globalArgs;
        const creds = credentialsOf(g);
        const opts = runOptionsOf(g);
        const name = repositoryName(g.repository);
        const dormant = g.dormant ?? false;
        const maxStaleDays = g.maxStaleDays ?? 2;
        const expectedPaths = g.expectedPaths ?? [];

        const snapshotsRun = await runRestic(
          creds,
          ["snapshots", "--json"],
          opts,
        );

        if (snapshotsRun.code !== RESTIC_EXIT.OK) {
          // Deliberately not a throw. A repository that cannot be reached is
          // the single most important thing a fleet report needs to see, and a
          // thrown error writes no resource at all — the "clean sweep reported
          // as no sweep" failure mode.
          const reason = classifyFailure(snapshotsRun);
          context.logger.warn(`${name}: unreachable (${reason})`);
          const handle = await context.writeResource("repository", name, {
            repositoryName: name,
            reachable: false,
            failureReason: reason,
            failureDetail: snapshotsRun.stderr.slice(0, 2000) || null,
            dormant,
            snapshotCount: 0,
            latestSnapshotId: null,
            latestSnapshotTime: null,
            latestSnapshotAgeHours: null,
            stale: false,
            maxStaleDays,
            hostnames: [],
            hostnameDrift: false,
            latestPaths: [],
            expectedPaths,
            missingPaths: expectedPaths,
            scopeDrift: expectedPaths.length > 0,
            repositoryFormatVersion: null,
            resticVersion: null,
            writerVersions: [],
            totalSizeBytes: null,
            totalUncompressedBytes: null,
            compressionRatio: null,
            scannedAt: new Date().toISOString(),
            durationMs: Date.now() - started,
          });
          return { dataHandles: [handle] };
        }

        const parsedList = z.array(SnapshotSchema).safeParse(
          JSON.parse(snapshotsRun.stdout || "[]"),
        );
        if (!parsedList.success) {
          throw new Error(
            `restic snapshots returned an unexpected shape: ` +
              parsedList.error.message,
          );
        }

        // restic returns snapshots oldest-first; do not assume it.
        const sorted = [...parsedList.data].sort((a, b) =>
          Date.parse(a.time) - Date.parse(b.time)
        );
        const latest = sorted.length > 0 ? sorted[sorted.length - 1] : null;

        const hostnames = Array.from(
          new Set(
            sorted.map((s) => s.hostname).filter((h): h is string =>
              typeof h === "string" && h.length > 0
            ),
          ),
        ).sort();
        const writerVersions = Array.from(
          new Set(
            sorted.map((s) => s.program_version).filter((v): v is string =>
              typeof v === "string" && v.length > 0
            ),
          ),
        ).sort();

        const latestPaths = latest?.paths ?? [];
        const missing = missingPaths(expectedPaths, latestPaths);
        const age = ageHours(latest?.time ?? null, Date.now());

        // A dormant repository is never stale — but it is always counted.
        const stale = !dormant && age !== null && age > maxStaleDays * 24;

        // Size and format are best-effort: a repository with no snapshots has
        // no `latest` to stat, and neither call should sink the scan.
        let formatVersion: number | null = null;
        let resticVersion: string | null = null;
        let totalSize: number | null = null;
        let totalUncompressed: number | null = null;
        let compressionRatio: number | null = null;

        const configRun = await runRestic(creds, ["cat", "config"], opts);
        if (configRun.code === RESTIC_EXIT.OK) {
          try {
            const cfg = JSON.parse(configRun.stdout);
            if (typeof cfg?.version === "number") formatVersion = cfg.version;
          } catch { /* leave null */ }
        }

        const versionRun = await runRestic(creds, ["version", "--json"], opts);
        if (versionRun.code === RESTIC_EXIT.OK) {
          try {
            const v = JSON.parse(versionRun.stdout);
            if (typeof v?.version === "string") resticVersion = v.version;
          } catch { /* leave null */ }
        }

        if (latest) {
          const statsRun = await runRestic(
            creds,
            ["stats", "latest", "--mode", "raw-data", "--json"],
            opts,
          );
          if (statsRun.code === RESTIC_EXIT.OK) {
            try {
              const s = JSON.parse(statsRun.stdout);
              totalSize = typeof s?.total_size === "number"
                ? s.total_size
                : null;
              totalUncompressed = typeof s?.total_uncompressed_size === "number"
                ? s.total_uncompressed_size
                : null;
              compressionRatio = typeof s?.compression_ratio === "number"
                ? s.compression_ratio
                : null;
            } catch { /* leave null */ }
          }
        }

        const handles: Array<{ name: string }> = [];
        handles.push(
          await context.writeResource("repository", name, {
            repositoryName: name,
            reachable: true,
            failureReason: null,
            failureDetail: null,
            dormant,
            snapshotCount: sorted.length,
            latestSnapshotId: latest?.short_id ?? null,
            latestSnapshotTime: latest?.time ?? null,
            latestSnapshotAgeHours: age,
            stale,
            maxStaleDays,
            hostnames,
            hostnameDrift: hostnames.length > 1,
            latestPaths,
            expectedPaths,
            missingPaths: missing,
            scopeDrift: missing.length > 0,
            repositoryFormatVersion: formatVersion,
            resticVersion,
            writerVersions,
            totalSizeBytes: totalSize,
            totalUncompressedBytes: totalUncompressed,
            compressionRatio,
            scannedAt: new Date().toISOString(),
            durationMs: Date.now() - started,
          }),
        );

        if (args.mode === "detailed") {
          const cap = args.maxSnapshots ?? 200;
          for (const snap of sorted.slice(-cap)) {
            handles.push(
              await context.writeResource(
                "snapshot",
                `snapshot-${safeFragment(snap.short_id)}`,
                snap,
              ),
            );
          }
        }

        context.logger.info(
          `${name}: ${sorted.length} snapshots, latest ${
            age === null ? "unknown" : `${age.toFixed(1)}h`
          } old${stale ? " (STALE)" : ""}${dormant ? " (dormant)" : ""}${
            missing.length > 0 ? ` (missing ${missing.join(", ")})` : ""
          }`,
        );

        return { dataHandles: handles };
      },
    },

    // -----------------------------------------------------------------------
    // Rung 2 — structure
    // -----------------------------------------------------------------------
    "check": {
      description:
        "Rung 2. Structural check of index, trees and pack metadata. This " +
        "does NOT read pack contents and so cannot detect bitrot — use " +
        "`verify` for that. A lock conflict is recorded as inconclusive, " +
        "never as a failure.",
      arguments: CheckArgsSchema,
      execute: (
        _args: z.infer<typeof CheckArgsSchema>,
        context: ExecuteContext<GlobalArgs>,
      ): Promise<Handles> => runCheck(context, null),
    },

    // -----------------------------------------------------------------------
    // Rung 3 — data
    // -----------------------------------------------------------------------
    "verify": {
      description:
        "Rung 3. Download and hash-verify a subset of pack files — the " +
        "bitrot check a plain `check` cannot perform, and which nothing in " +
        "this fleet has ever run. Prefer the deterministic n/t form and " +
        "rotate 1/7..7/7 so a week covers the whole repository; a random 10% " +
        "every night re-reads the same tenth by chance.",
      arguments: VerifyArgsSchema,
      execute: (
        args: z.infer<typeof VerifyArgsSchema>,
        context: ExecuteContext<GlobalArgs>,
      ): Promise<Handles> => runCheck(context, args.subset ?? "1/7"),
    },

    // -----------------------------------------------------------------------
    // Rung 4 — canary
    // -----------------------------------------------------------------------
    "dump": {
      description:
        "Rung 4. Stream one known file out of a snapshot and hash it, " +
        "proving decryption and the data path end to end without writing " +
        "anything to disk. Hashes raw bytes, so a binary canary is safe.",
      arguments: DumpArgsSchema,
      execute: async (
        args: z.infer<typeof DumpArgsSchema>,
        context: ExecuteContext<GlobalArgs>,
      ): Promise<Handles> => {
        const g = context.globalArgs;
        const name = repositoryName(g.repository);
        const snapshot = args.snapshot ?? "latest";
        const ranAt = new Date().toISOString();

        // `dump` writes raw bytes and must never be passed --json.
        const run = await runRestic(
          credentialsOf(g),
          ["dump", snapshot, args.path],
          { ...runOptionsOf(g), binaryStdout: true },
        );

        const ok = run.code === RESTIC_EXIT.OK;
        // Hash the BYTES. Decoding a possibly-binary canary as UTF-8 before
        // hashing corrupts the comparison.
        const hash = ok && run.stdoutBytes.length > 0
          ? await sha256Hex(run.stdoutBytes)
          : null;
        const mismatch = ok && args.expectedSha256 !== undefined &&
          hash !== args.expectedSha256;
        const passed = ok && !mismatch;

        const handle = await writeValidation(context, {
          repositoryName: name,
          rung: "dump",
          passed,
          inconclusive: !ok && isInconclusive(run),
          failureReason: passed
            ? null
            : mismatch
            ? "canary-hash-mismatch"
            : classifyFailure(run),
          detail: passed ? null : run.stderr.slice(0, 2000) || null,
          exitCode: run.code,
          ranAt,
          durationMs: run.durationMs,
          canaryPath: args.path,
          canaryBytes: run.stdoutBytes.length,
          canarySha256: hash,
        });

        if (!passed) {
          throw new Error(
            mismatch
              ? `canary ${args.path} hash mismatch: got ${hash}`
              : `restic dump failed (${classifyFailure(run)}): ${run.stderr}`,
          );
        }

        context.logger.info(
          `${name}: canary ${args.path} ${run.stdoutBytes.length} bytes, ` +
            `sha256 ${hash?.slice(0, 12)}`,
        );
        return { dataHandles: [handle] };
      },
    },

    // -----------------------------------------------------------------------
    // Rung 5 — restore
    // -----------------------------------------------------------------------
    "restore": {
      description:
        "Rung 5. Restore a scoped subtree to a local target and verify it — " +
        "the only rung that actually proves the backup is restorable. The " +
        "size ceiling is measured with a dry-run restore and " +
        "enforced BEFORE any data moves, so a refused drill costs nothing. " +
        "Raise it per run rather than permanently.",
      arguments: RestoreArgsSchema,
      execute: async (
        args: z.infer<typeof RestoreArgsSchema>,
        context: ExecuteContext<GlobalArgs>,
      ): Promise<Handles> => {
        const g = context.globalArgs;
        const creds = credentialsOf(g);
        const opts = runOptionsOf(g);
        const name = repositoryName(g.repository);
        const snapshot = args.snapshot ?? "latest";
        const selector = `${snapshot}:${args.path}`;
        const ranAt = new Date().toISOString();
        // The ceiling is a method input OR a global argument, resolved here in
        // execute. It is deliberately NOT a pre-flight check: checks never
        // receive method inputs, so a check would reject the per-run override
        // and force the ceiling to be raised permanently.
        const ceiling = args.maxRestoreBytes ?? g.maxRestoreBytes ??
          1024 * 1024 * 1024;

        // Measure with a DRY-RUN RESTORE, not `stats`.
        //
        // `restic stats` rejects the <snapshot>:<subfolder> selector: it warns
        // on stderr, then exits 0 with {"total_size":0,"snapshots_count":0}.
        // A zero read as a measurement made the ceiling compare 0 > ceiling
        // and pass for ANY size — the guard was inoperative for every subtree
        // restore. Found only by running it live; the mock returned a real
        // number and the test passed.
        //
        // A dry run walks the same code path as the restore itself, honours
        // the selector, and writes nothing. It needs restic 0.17.0+.
        const dryRun = await runRestic(
          creds,
          [
            "restore",
            selector,
            "--target",
            args.target,
            "--dry-run",
            "--json",
          ],
          opts,
        );
        const drySummary = lastMessageOfType(
          parseJsonLines(dryRun.stdout),
          "summary",
        );
        const estimated = typeof drySummary?.total_bytes === "number"
          ? drySummary.total_bytes
          : null;

        // FAIL CLOSED. An unmeasurable size must never read as a safe size —
        // that is exactly how the previous guard let everything through.
        if (estimated === null || estimated > ceiling) {
          const unmeasurable = estimated === null;
          await writeValidation(context, {
            repositoryName: name,
            rung: "restore",
            passed: false,
            inconclusive: true,
            failureReason: unmeasurable
              ? "size-unmeasurable"
              : "exceeds-size-ceiling",
            detail: unmeasurable
              ? `dry run produced no summary; refusing to restore blind: ` +
                `${dryRun.stderr.slice(0, 500)}`
              : `${estimated} bytes exceeds ceiling ${ceiling}`,
            exitCode: dryRun.code,
            ranAt,
            durationMs: dryRun.durationMs,
            restorePath: args.path,
            restoreTarget: args.target,
            estimatedBytes: estimated,
            maxRestoreBytes: ceiling,
          });
          throw new Error(
            unmeasurable
              ? `could not measure the size of ${selector} — a dry run ` +
                `produced no summary, so the ceiling cannot be enforced and ` +
                `the restore is refused: ${dryRun.stderr.slice(0, 300)}`
              : `restore of ${selector} would write ${estimated} bytes, over ` +
                `the ${ceiling}-byte ceiling. Raise it for this run with ` +
                `--input maxRestoreBytes=<n>, not permanently on the model.`,
          );
        }

        const run = await runRestic(
          creds,
          ["restore", selector, "--target", args.target, "--verify", "--json"],
          opts,
        );

        const summary = lastMessageOfType(
          parseJsonLines(run.stdout),
          "summary",
        );
        const ok = run.code === RESTIC_EXIT.OK;
        const items = typeof summary?.files_restored === "number"
          ? summary.files_restored
          : null;
        const bytes = typeof summary?.bytes_restored === "number"
          ? summary.bytes_restored
          : null;

        const handle = await writeValidation(context, {
          repositoryName: name,
          rung: "restore",
          passed: ok,
          inconclusive: !ok && isInconclusive(run),
          failureReason: ok ? null : classifyFailure(run),
          detail: ok ? null : run.stderr.slice(0, 2000) || null,
          exitCode: run.code,
          ranAt,
          durationMs: run.durationMs,
          restorePath: args.path,
          restoreTarget: args.target,
          itemsRestored: items,
          bytesRestored: bytes,
          verified: ok,
          estimatedBytes: estimated,
          maxRestoreBytes: ceiling,
        });

        if (!ok) {
          throw new Error(
            `restic restore failed (${classifyFailure(run)}): ${run.stderr}`,
          );
        }

        context.logger.info(
          `${name}: restored ${args.path} — ${items ?? "?"} items, ` +
            `${bytes ?? "?"} bytes, verified in ` +
            `${(run.durationMs / 1000).toFixed(1)}s`,
        );
        return { dataHandles: [handle] };
      },
    },

    // -----------------------------------------------------------------------
    // The one permitted mutation
    // -----------------------------------------------------------------------
    "unlock": {
      description:
        "Remove STALE locks (older than 30 minutes) — the only write this " +
        "suite performs, and gated behind an acknowledgement. " +
        "`unlock --remove-all` is deliberately unavailable because it " +
        "deletes locks held by running backups.",
      arguments: UnlockArgsSchema,
      execute: async (
        args: z.infer<typeof UnlockArgsSchema>,
        context: ExecuteContext<GlobalArgs>,
      ): Promise<Handles> => {
        const g = context.globalArgs;
        // Gated HERE, not in a pre-flight check: checks receive only
        // globalArgs, so a check would reject --input allowUnlock=true and
        // force the flag to be armed permanently on the model definition.
        const allowed = args.allowUnlock ?? g.allowUnlock ?? false;
        if (!allowed) {
          throw new Error(
            "unlock removes lock files from the repository. Re-run with " +
              "--input allowUnlock=true to acknowledge.",
          );
        }

        const name = repositoryName(g.repository);
        const ranAt = new Date().toISOString();
        const run = await runRestic(
          credentialsOf(g),
          ["unlock"],
          runOptionsOf(g),
        );
        const ok = run.code === RESTIC_EXIT.OK;
        const removed = parseLocksRemoved(run.stdout);

        // Written on BOTH paths, and before the throw. This is the only change
        // the suite can make to a repository, so a failed attempt is exactly as
        // worth recording as a successful one — and a rung that throws without
        // writing is the "clean sweep reported as no sweep" failure.
        const handle = await context.writeResource("maintenance", "unlock", {
          repositoryName: name,
          action: "unlock" as const,
          succeeded: ok,
          locksRemoved: removed,
          countReported: removed !== null,
          failureReason: ok ? null : classifyFailure(run),
          detail: ok ? null : run.stderr.slice(0, 2000) || null,
          exitCode: run.code,
          ranAt,
          durationMs: run.durationMs,
        });

        if (!ok) {
          throw new Error(
            `restic unlock failed (${classifyFailure(run)}): ${run.stderr}`,
          );
        }

        context.logger.info(
          `${name}: unlock succeeded — ${
            removed === null
              ? "restic reported no lock count"
              : `${removed} stale lock(s) removed`
          }`,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
