# 00 — Start, do one small piece, and remember where you stopped

[Book](../MADHURITA_BUILD_BOOK.md) · [Plan](../build/PLAN.json) · [Checkpoint](../build/CHECKPOINT.json)

## The school-notebook idea

Imagine building a bicycle. Today you fit the front wheel. You do not reread a whole engineering library. Your notebook says which wheel, which bolts, how to test it, and what comes next. Madhurita's build needs the same notebook outside the model's memory.

There are TWO kinds of work here. **Build tasks** B00–B11 construct software. **Runtime jobs** are the owner's future research/reminder/document work. Their checkpoints, IDs and databases are separate.

## Your first five actions

1. Read this page. Read the checkpoint's `taskId`, `sliceId`, `nextAction`, `blocker` and `workspace` fields.
2. Inspect the actual repository status and revision. Never delete uncommitted owner edits. A checkpoint from another tree is not permission to overwrite files.
3. Read PLAN. If the checkpoint is uninitialized, choose B00/s1. Otherwise choose the unfinished slice whose dependencies have verified evidence. Recheck previous evidence fingerprints after code changes.
4. Read that task card and only the named contract sections/source functions. Do not load every chapter or every test log.
5. Write the concrete next action before editing: for example, “Add a failing test that rejects success=true, verified=false in TaskExecutor.”

## One packet, not one entire project

A packet includes exactly: task/slice ID; owner-visible outcome; dependency contract; source revision; allowed files; relevant complete function/type excerpts; one acceptance test; expected failure; next verification command; stopping conditions.

Target a packet under 1,500 tokens where practical. This is a target, not a universal fit guarantee. Measure with the selected model's actual tokenizer. Reserve at least 35% of its usable context for generated code, tool output and verification. If the needed complete function plus types does not fit, split the task or use a more capable model. Never silently truncate contracts, input, or test expectations.

A slice normally changes no more than three implementation files plus its tests and checkpoint. A cross-module migration is divided into store, executor, transport and UI slices. Do not scatter half-connected interfaces across ten files.

## The work loop

1. **Read:** verify the exact current source and dependencies. Follow existing TypeScript imports and error handling.
2. **Specify:** turn the card's acceptance example into a deterministic failing test. Observe it fail for the intended reason, not a syntax/import mistake.
3. **Implement:** change the smallest connected piece. No mock in production to pretend a provider exists.
4. **Verify:** run the targeted test; then typecheck and affected integrations. At milestone boundaries run lint, full suite and build.
5. **Record:** store command, exit code, timestamp, tree fingerprint, test case IDs, result summary and evidence location. Include remaining failures.
6. **Advance:** only a verified slice may advance. Otherwise repair, checkpoint or report a precise blocker.

A prose promise that “tests should pass” is not evidence. An existing test that passes before a bug reproduction does not demonstrate the fix. Never weaken a test to match the bug.

## What goes in the checkpoint?

`CHECKPOINT.json` is a cursor, NOT a source of truth about success. Its initial values are honest unknowns. Preserve these categories:

- workspace revision and fingerprint including dirty implementation files;
- active task/slice and current phase: read, test, implement, verify;
- changed files and completed slices;
- last actual command and observed outcome;
- evidence paths/hashes;
- exact next action;
- blocker and bounded repair attempt count.

Before B01 is built, a human or capable agent updates this file manually using atomic replace: write a temporary adjacent file, parse it, then rename. Temporary files are not committed. Do not put credentials, raw private conversations or hidden reasoning in the checkpoint. Record decisions and test facts, not private thought transcripts.

After B01, the supervisor performs checkpoint writes and validates evidence. Never let a builder's “done” message alone update the verified list.

## Restart after forgetting or process death

Read checkpoint → inspect working tree → validate referenced evidence → rerun the last incomplete check → resume the listed next action. If evidence is missing or the tree changed, demote the affected slice to `needs_revalidation`. Completed unrelated work need not be rebuilt, but its dependency fingerprints must still match.

Recover a stale build-worker lease only after expiry. One builder owns a slice at a time. Independent workers need separate worktrees and nonoverlapping ownership; simply launching several agents in the same files is not parallel engineering.

## When may an agent return?

- **Verified milestone:** state the working behavior and link to its evidence.
- **Checkpoint:** session/context budget is ending; state exactly what was verified and the next action. This is useful progress, not a fake completion.
- **Blocked:** required hardware, credential, permission, provider availability or specification is missing; name it, include the failing check, and ask only the decision needed.
- **Stopped:** the user requested stop, or continuing risks data or budget.

After three unsuccessful repair attempts on one slice, preserve evidence and escalate; do not loop forever. Platform timeout cannot be defeated by a paragraph in a book. An external controller must relaunch workers; B01 defines its local protocol. No script should repeatedly spawn agents without a session/time/cost limit.

## Evidence rules

Evidence must identify the tested application tree, test file hashes, command and exit status. Exclude checkpoint/log outputs themselves from the source fingerprint to avoid a self-changing hash. When tests or requirements change, rerun their gates and record why. The same LLM that wrote code may help review it, but is not an independent proof oracle.

Do not create additional status docs spontaneously. Use this notebook. Record new decisions in the affected card with rationale and owner approval when behavior changes. The initial PLAN and checkpoint are data files; they cannot execute, verify or restart anything until B01 is implemented.
