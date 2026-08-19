# CONVENTIONS — restic Restore-Validation Suite

**Lead-owned. Builders read this, copy from it, and propose changes via the
lead — never edit it directly.** Single source of truth for the shared technical
contract in [`PRD.md`](./PRD.md). If the PRD and this file disagree, this file
wins for _implementation_ detail; the PRD wins for _scope_.

Derived from `../backblaze/CONVENTIONS.md`, whose structure and hard rules
carry over unchanged. The one architectural difference is fundamental and
shapes everything below: **B2 is an HTTP API and restic is a binary.** There is
no canonical HTTP client here. There is a canonical **subprocess runner** (§5),
and every trap it guards against is a subprocess trap.

---

## 1. How a builder uses this doc

1. Pick one model row from [`PRD.md`](./PRD.md) §8.
2. Create your extension's **own directory**:
   `extensions/models/restic-<domain>/`.
3. Copy the **canonical restic runner (§5) byte-identical** — do not "improve"
   it per-model. It is kept `deno fmt`-clean so copying it verbatim and passing
   `swamp extension fmt --check` are compatible. If `fmt` wants to reformat it,
   that is a lead bug — report it, do not silently reformat your copy.
4. Fill in schemas and methods, obeying §3 (locking) and §4 (CLI facts).
5. Copy the test template to `restic_<domain>_test.ts` in the same dir; mock
   the subprocess boundary, never the parser.
6. Copy the manifest / README / LICENSE templates into the same dir.
7. Run the verification + publish sequence (§9), including the Adversarial
   Review Gate.

**Layout — one isolated directory per extension (mandatory):**

```
extensions/models/restic-<domain>/
  restic_<domain>.ts        # export const model
  restic_<domain>_test.ts   # unit tests (excluded from loading)
  manifest.yaml             # paths.base: manifest
  README.md                 # per-extension docs (additionalFiles)
  LICENSE.md                # MIT (additionalFiles)
```

**File ownership:** a builder touches **only files inside its own
`extensions/models/restic-<domain>/` directory.** `CONVENTIONS.md`, `PRD.md`
and the root `README.md` are lead-owned.

---

## 2. Hard rules (non-negotiable)

- `import { z } from "npm:zod@4";` — **never** bare `"zod"`. The swamp-club
  scorer runs in a hermetic sandbox with no imports map.
- Static imports only; **no** dynamic `import()` (rejected at push).
- Deno-native only: `Deno.Command` + `fetch`. **No npm deps** beyond zod.
- **Never put a secret in `args`.** Process arguments are world-readable via
  `ps` on every host. The repository password and the B2 application key travel
  in the subprocess environment (§6) and nowhere else. There is no exception to
  this, including for debugging.
- **Never write a secret into a resource snapshot or a log line.** The
  repository password and `applicationKey` are `.meta({ sensitive: true })` and
  wired from a vault.
- **Never shell out through a shell.** Pass `Deno.Command` an argv array. No
  `sh -c`, no string interpolation into a command line.
- **This suite is read-only** (PRD §2). No method may invoke `backup`,
  `forget`, `prune`, `init`, `key`, `tag`, `migrate`, `repair` or `copy`.
  `unlock` is the sole permitted mutation and is gated per §7.

---

## 3. THE SAFETY RULE — locking

**Every restic invocation in this suite passes `--no-lock`. Without exception.**

This is not a performance choice, and getting it wrong does more damage than
failing:

| Command | Lock taken by default |
| ------- | --------------------- |
| `check` | **exclusive** |
| `backup` | shared |
| `forget`, `prune` | **exclusive** |
| `snapshots`, `stats`, `ls`, `find`, `dump`, `restore`, `cat` | shared |
| `unlock` | none |

restic permits at most one exclusive lock, and while one is held **no other
lock of any kind may exist**. `check` has taken an exclusive lock in every
restic version ever released. So a validator that runs `check` without
`--no-lock` at 00:00 does not merely fail — it **makes the owning host's
nightly `backup` fail**, silently converting a validation tool into the cause
of a missing backup.

`--no-lock` is honoured on `check` (verified live on 0.19.1: a
`check --no-lock` completed and left `list locks` empty). Since 0.17.0 it also
puts the repository into dry-run mode, wrapping the backend so writes become
no-ops — a second layer of protection that is worth having.

**Assert this mechanically.** A test must fail if any code path builds an argv
that omits `--no-lock`, and the runner in §5 enforces it as well. Belt and
braces, because the failure is invisible in testing and expensive in
production: it shows up as somebody else's backup not running.

**Consequences to design around, not to ignore:**

- `check --no-lock` concurrent with another process's `forget --prune` can
  report **false-positive** errors (`id ... not found in repository`) because
  the repository is being rewritten underneath the read. So a `check` failure
  is only trustworthy outside the maintenance window. Record the run's wall
  time; a report must be able to say "this ran during maintenance" rather than
  "this repository is corrupt".
- `--retry-lock` defaults to **0** — a lock collision is an instant failure,
  not a wait. Do not rely on retries; rely on `--no-lock` and scheduling.
- Never call `unlock --remove-all`. It deletes live locks belonging to running
  backups. Plain `unlock` removes only stale ones (>30 min old), which is the
  only safe form. A lock created on another host can only ever age out by that
  30-minute rule — the validator cannot probe a remote PID.

---

## 4. restic CLI facts

**Version-gated features.** The fleet installs restic from distro apt with no
pinning (Debian 12 → 0.14.0, Ubuntu 24.04 → 0.16.4). The validator runs the
**upstream binary** and must record which version it used, because these
landed late:

| Feature | Needs | Notes |
| ------- | ----- | ----- |
| `check --json` | **0.18.0** | Not 0.17.0. On 0.16.x `--json` only suppresses the progress bar and output stays plain text — a grep for `.JSON` in restic's source gives a false positive here |
| `restore --json` | 0.16.0 | 0.17.1 also made *errors* JSON; before that plain-text errors leak into the stream and break parsers |
| Exit codes 10 / 11 / 12 | 0.17.0 / 0.17.1 | Below this **every** failure collapses to exit 1 |
| Exit code 130 (cancelled) | 0.19.0 | |
| `--retry-lock` | 0.16.0 | |
| `restore --dry-run` | 0.17.0 | |
| `restore --verify` | 0.9.2 | Universally available |
| `dump --target` | 0.17.0 | |
| Repository format v2 | 0.14.0 | Default since 0.14.0. restic ≤0.13 **cannot open a v2 repo at all** |

**Response shapes verified live against a real repository on 0.19.1,
2026-08-07. Trust these over the prose in restic's docs:**

1. **`snapshots --json` is leaner than documented on older repositories.** A
   real repository returned exactly
   `["hostname","id","parent","paths","short_id","time","tree","username"]`.
   The documented `summary` block (with `total_bytes_processed`, file counts)
   is written by the restic that **created** the snapshot and only exists from
   0.17.0 onward — so on a fleet running 0.14.0/0.16.4 it is **absent**, and
   per-snapshot byte totals are simply not available. Get sizes from `stats`,
   never from `snapshots`. `tags` is likewise omitted when empty rather than
   emitted as `[]`. **Type every one of these as optional.**

2. **`paths` drifts over a repository's life, and that is a finding.** On the
   baseline repository the set went `["/etc"]` →
   `["/etc","/var/lib/docker"]` → `["/etc","/root","/var/lib/docker"]` across
   ten months. A restore from any snapshot before the last change silently
   yields an incomplete host. Compare the latest snapshot's `paths` against
   declared expected paths; do not assume a repository is homogeneous.

3. **`hostname` drifts too.** The same repository carries snapshots under two
   different hostnames because the machine was renamed and renamed back. Any
   logic that filters by `--host`, or that assumes one repository means one
   hostname, silently splits the history. Collect the distinct set.

4. **`check --json` emits one summary object on stdout**, errors as separate
   objects on **stderr**:
   ```json
   { "message_type": "summary", "num_errors": 0, "broken_packs": null,
     "suggest_repair_index": false, "suggest_prune": false }
   ```
   Note `broken_packs` is `null`, **not `[]`**, on a clean repository. Typing
   it as an array fails validation on every healthy repository — the exact
   shape of bug that live verification catches and mocks do not.

5. **`stats --json` is the only source of size.** Real response:
   ```json
   { "total_size": 100203257, "total_uncompressed_size": 255114219,
     "compression_ratio": 2.5459673331776034, "compression_progress": 100,
     "compression_space_saving": 60.72, "total_blob_count": 1284,
     "snapshots_count": 1 }
   ```
   The four compression fields are meaningful only on format v2.
   `total_file_count` is documented but **was absent** in `raw-data` mode —
   type it optional. Modes differ in meaning: `raw-data` gives stored bytes,
   `restore-size` gives the logical bytes a restore would write. Report storage
   cost with `raw-data`.

   **Do not size a restore guard with `stats --mode restore-size`.** It works
   only for a whole snapshot; the moment the target is a subtree it rejects the
   selector and returns a zero that reads as a safe size. See §11 — that guard
   shipped inoperative, and this line is how it got written.

6. **`restore --json` emits JSON-lines**: repeated `status` objects then one
   `summary`. Parse the **last** `summary` line; do not assume a single line of
   output.

7. **`files_restored` counts directories and symlinks, not just regular
   files.** A verified restore reported 1,719 files where the restored tree
   held 925 regular files. Asserting equality against a filesystem count is
   wrong. It is a restic-internal item count, and should be named as such.

8. **`dump` has no JSON output and must never be passed `--json`.** It writes
   raw file bytes to stdout; a JSON flag would corrupt the stream. Capture
   stdout as bytes, not as a string, and compare by hash — a canary file may be
   binary, and decoding it as UTF-8 before hashing corrupts the comparison.

9. **`--read-data-subset` accepts three forms** — `n/t` (deterministic
   partition, `t` ≤ 256), `x%` / `x.y%` (random), and a byte size with
   `k/K/m/M/g/G/t/T` (random). All three verified live in the `10%` and `1/7`
   forms. **Prefer `n/t`**: rotating `1/7` … `7/7` covers the entire repository
   across a week, where a random 10% every night re-reads the same tenth by
   chance and never converges on full coverage.

10. **Plain `check` verifies structure only.** It never downloads a pack, so it
    cannot detect bitrot. Only `--read-data[-subset]` does. Never describe a
    passing `check` as proof the data is intact — it is proof the *metadata* is
    coherent, which is a different fact.

11. **`restic stats` REJECTS the `<snapshot>:<subfolder>` selector, and then
    exits 0 with a zero.** Live-verified 2026-08-07:

    ```
    $ restic stats latest:/etc --mode restore-size --json
    Ignoring "latest:/etc": <snapshot>:<subfolder> syntax not allowed
    {"total_size":0,"snapshots_count":0}
    ```

    The warning goes to stderr, the exit status is **0**, and the JSON is
    structurally valid. So a size guard built on `stats` reads `0`, compares
    `0 > ceiling`, and passes — **for any size whatsoever**. The guard is not
    merely inaccurate, it is inoperative, and it looks like it is working.

    This shipped and was caught only by running a real restore and noticing
    `estimatedBytes: 0` next to `bytesRestored: 254231900`. Every unit test
    passed, because the mock returned a plausible number: the mock was
    *better-behaved than reality*, the same class of error as wave 2's mocks
    being richer than reality and wave 3's being shorter.

    **Size a subtree with `restore --dry-run --json`** (restic 0.17.0+). It
    walks the same code path as the real restore, honours the selector, writes
    nothing, and its `summary.total_bytes` matched the subsequent real restore
    to the byte. `restic ls` is not a substitute — it is **not recursive by
    default** and silently returns only the top level (87 files / 250 KB where
    the true subtree was 1,719 files / 254 MB).

    **And the guard must fail CLOSED.** `snapshots_count: 0` and a missing
    `summary` both mean "did not measure", which is not the same as "measured
    zero". Require a `summary` message carrying a numeric `total_bytes`; if it
    is absent, refuse the restore rather than proceeding blind. An unmeasurable
    size must never read as a safe size — that is precisely how the broken
    guard let everything through.

12. **`program_version` is absent from real snapshots.** All 43 snapshots in
    the live baseline repository carry exactly
    `["hostname","id","parent","paths","short_id","time","tree","username"]` —
    no `program_version`, no `tags`, no `summary`. So a "which restic wrote
    this" field cannot be derived from snapshot metadata on this fleet, and any
    finding depending on it will silently never fire. Record the empty set
    honestly rather than inferring a version.

11. **`restic` writes a local cache** and will happily fill the validator's
    disk across 18 repositories. Always set `RESTIC_CACHE_DIR` explicitly and
    account for it; never inherit the default.

**Exit codes** (reliable only because the validator pins an upstream binary):

| Code | Meaning | Treat as |
| ---- | ------- | -------- |
| 0 | success | pass |
| 1 | generic error | fail |
| 3 | partial (`backup`/`forget`) | not reachable in this suite |
| 10 | repository does not exist | `repo-unreachable` |
| 11 | already locked | retryable, **never** a corruption finding |
| 12 | wrong password | `repo-unreachable`, credential fault |
| 130 | cancelled | inconclusive, not a failure |

Classify 11 and 130 as **inconclusive**, never as a failed rung. A lock
conflict recorded as "check failed" is how a healthy repository gets reported
as broken.

**Transaction cost.** Every rung is B2 egress. Rung 1–2 are metadata-only and
cheap. Rung 3 downloads exactly its subset of the repository; rung 5 downloads
the restored subtree uncompressed. Timings measured live on a 100 MB
repository: structure check 40s, 10% read-data 77s, 254 MB restore 32s — all
I/O-bound, ~2% CPU. Scale those against a 42.7 GiB repository before scheduling
anything fleet-wide.

---

## 5. Canonical restic runner (copy byte-identical)

```ts
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
```

---

## 6. Secrets

Three separate places, all of which have leaked in comparable projects:

1. **Into the model** — `${{ vault.get(...) }}` in `globalArguments`, resolved
   at run time. Never a literal; `swamp vault create --config` persists what it
   is given verbatim, and `sensitive` governs logging, not what lands on disk.
2. **Into the subprocess** — the `env` option on `Deno.Command`, with
   `clearEnv: true` so the environment is explicit and auditable. **Never
   argv.** `RESTIC_PASSWORD_COMMAND` is marginally stronger (it keeps the
   secret out of `/proc/<pid>/environ` too) but requires a helper process that
   must itself obtain the secret; on a single-user validation host the env
   route is the right trade, and it is why `clearEnv` is not optional.
3. **Out of the snapshot** — mark secret-bearing fields
   `.meta({ sensitive: true })`, and prefer simply never writing them. Pass all
   captured stderr through `redactSecrets` before it reaches a resource: restic
   echoes configuration into error messages.

A test must assert that no credential appears in any written resource, and that
`runRestic` throws when a credential is passed in `args`.

---

## 7. Gating the one mutation

`unlock` is the only write this suite may perform. Per the hard-won rule from
the B2 suite:

**A pre-flight check must never gate a method on an acknowledgement passed as a
method input.** Checks receive `globalArgs` only — swamp does not pass method
inputs to them — so a check guarding `unlock` on `allowUnlock` rejects
`--input allowUnlock=true` before `execute` runs, and its error message then
instructs the operator to do the very thing it made impossible. Worse, the only
way through becomes setting the flag **permanently** on the model definition:
a check written to prevent an accidental mutation ends up forcing that mutation
to be armed for good. It fires on the safe configuration and passes on the
dangerous one.

Put the gate in `execute`, which sees both the input and the global argument.
Assert with a test that no check declares `appliesTo: ["unlock"]`.

A check is still correct for genuine model configuration that has no
method-input equivalent — the repository URL, the expected paths — and should
be used there.

---

## 8. Testing

- **Mock the subprocess boundary, never the parser.** Use
  `withMockedCommand` from `@swamp-club/swamp-testing` so the real argv
  construction, `--no-lock` injection, env assembly, parsing and classification
  all execute. A test that stubs the parse step tests nothing.
- **The test harness must validate schemas.** A recording-only `writeResource`
  stub makes every schema bug invisible. This is mandatory, not advisory — it
  was proven in the B2 suite by a revert that stayed green.
- **Build fixtures from live output, not from restic's docs.** The docs
  disagree with a live 0.19.1 binary on `broken_packs` nullability, on
  `summary` presence in `snapshots --json`, and on `total_file_count`. Fixtures
  built from docs test the docs.
- **Fixture realism cuts both ways.** In the B2 suite one wave's mocks were
  *richer* than reality (fields that live responses omit) and another's were
  *shorter* than reality (a truncation bug a 25-char fixture never reached).
  Copy real shapes, including their absences and their real lengths.
- **Check the test-run exit status, not the reported count.** A suite that
  aborts at type-check reports zero failures and looks identical to a pass.
  This has already hidden 22 never-executed tests in this project.
- **Mutation-test every guard.** Delete the `--no-lock` injection, the
  forbidden-command set, the argv secret scan, and the dormancy exclusion in
  turn; each deletion must fail the suite. A green suite proves nothing until a
  mutation is shown to break it.

---

## 9. Verification and publish sequence

1. `deno check` and `deno test -A` — **confirm the exit status.**
   The `-A` is not optional and not laziness: the model's tests write a
   temporary restore target, so plain `deno test` reports
   `NotCapable: Requires write access` on 30 of the 90 tests. That reads
   exactly like a broken suite on a clean checkout, which is how this line
   came to be wrong in the first place.
2. `swamp extension fmt --check`
3. `swamp extension quality` ≥ 14/15
4. Live read-only smoke against a real repository.
5. Adversarial Review Gate, written to `reviews/` —
   `export SWAMP_EXTENSION_REVIEW_DIR="$PWD/reviews"`, because the default temp
   path is one cleanup away from vanishing.
6. **Re-run `push --dry-run` immediately before publishing.** The gate binds to
   a content hash; a "gate clean" carried forward from before the last fix is
   stale and will be rejected. The regenerated report must also *say different
   things* if the facts changed — a re-stamped report claiming the model has
   never run live, after it has, is a false report.
7. **Pre-publish secret audit.** Extract every real repository, bucket and host
   name from live output; grep the tracked tree **and** the exact shipped-file
   list. `example-` prefixing is not sanitisation when the remainder is the
   real name. Note that a force-push does not purge GitHub — old commits stay
   fetchable by SHA — so an identifier that reaches a public repo is not
   retractable by rewriting history.

   **"Pre-publish" is the wrong deadline: audit before you PUSH.** This repo is
   public, so a branch and its PR body are world-readable the instant they are
   pushed — long before `extension publish` runs. Violated on 2026-08-17, when a
   fix branch carried a real host name and a real 1Password vault name into the
   diff, the commit message and the PR description. Redaction after the fact
   left the original commit fetchable by SHA and the pre-edit PR body visible in
   GitHub's edit history, which is exactly what the paragraph above warns about.
   Sanitise while writing: this suite's placeholder hosts are `heron` and
   `mallard`, and there is never a reason for a real one to appear.

The single most reliable finding across this project: **live verification beat
mocks every time.** Every wave of the B2 suite shipped defects that a green
test suite could not see, and every one was found by running the thing against
reality. Budget for it.
