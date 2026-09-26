import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { BrowserError, type Check } from "./contracts.js";
import * as host from "./host.js";
import { subprocess } from "./process.js";
import { Cdp, checkpoint, sameDocument, liveStateExpression } from "./cdp.js";
import { legacyExpression, readElement, readPage } from "./dom.js";
import { Journal, atomic, createRun, remaining, summary, type Data, type State, type Checkpoint } from "./journal.js";
import { validateTask, type Task, type Step, type Resume, type Report, type InspectRun, type ShotInput } from "./task.js";
import { applyRecipe, quarantineRecipe } from "./recipes.js";
import type { PageJob } from "./page-worker.js";

const failure = (error: unknown): BrowserError => error instanceof BrowserError ? error : new BrowserError({ code: "runtime", reason: "Operation could not finish. Inspect the run before retrying." });
const io = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: failure });
const sync = <A>(f: () => A) => Effect.try({ try: f, catch: failure });
export const withLease = <A, E, R>(f: () => Effect.Effect<A, E, R>) => Effect.acquireUseRelease(io(host.acquireLock), f, release => Effect.promise(release));
function envelope(text: string): Data {
  const r = JSON.parse(text) as { ok: boolean; result?: Data; error?: { code: string; reason: string } };
  if (!r.ok) throw new BrowserError(r.error ?? { code: "worker", reason: "Worker did not finish." });
  return r.result ?? {};
}
async function workerEnv(session: host.Session, journal: Journal): Promise<NodeJS.ProcessEnv> {
  const env = host.workerEnvironment(session);
  const config = await host.configuration();
  for (const key of ["MIDSCENE_MODEL_API_KEY", "MIDSCENE_MODEL_BASE_URL", "MIDSCENE_MODEL_NAME", "MIDSCENE_MODEL_FAMILY"]) if (process.env[key]) env[key] = process.env[key];
  env.FASTEST_E2E_VISION_ENABLED = config.visionEnabled ? "1" : "0";
  env.MIDSCENE_MODEL_RETRY_COUNT = "0";
  env.MIDSCENE_MODEL_TIMEOUT = "30000";
  env.MIDSCENE_RUN_DIR = path.join(journal.dir, "temporary-vision");
  env.MIDSCENE_REPORT_QUIET = "1";
  return env;
}
function pageCall(session: host.Session, journal: Journal, job: Omit<PageJob, "root" | "runId" | "session" | "targetId">, observer?: Journal) {
  return Effect.gen(function* () {
    const state = journal.state();
    const env = yield* io(() => workerEnv(session, journal));
    const request: PageJob = { root: host.home(), runId: journal.runId, session, targetId: observer?.state().targetId ?? state.targetId, ...(observer ? { observationRunId: observer.runId } : {}), ...job };
    return yield* subprocess(process.execPath, [path.join(host.packageRoot, "dist/page-worker.js")], env, JSON.stringify(request), job.timeoutMs).pipe(Effect.flatMap(text => sync(() => envelope(text))));
  }).pipe(Effect.ensuring(sync(() => fs.rmSync(path.join(journal.dir, "temporary-vision"), { recursive: true, force: true })).pipe(Effect.ignore)));
}
function jevCall(session: host.Session, journal: Journal, goal: string, timeoutMs: number) {
  return Effect.gen(function* () {
    const jevProvider = process.env.JEV_PROVIDER;
    const hasTypesafeKey = Boolean(process.env.TYPESAFE_API_KEY);
    const hasOpenjevKey = Boolean(process.env.OPENJEV_API_KEY);
    const jevConfigured = jevProvider === "openjev" ? hasOpenjevKey : (hasTypesafeKey || (!hasTypesafeKey && hasOpenjevKey));
    if (!jevConfigured) return yield* Effect.fail(new BrowserError({ code: "credentials", reason: "Set TYPESAFE_API_KEY (or OPENJEV_API_KEY / JEV_PROVIDER=openjev) in the invoking environment, or use explicit deterministic steps." }));
    const env = yield* io(() => workerEnv(session, journal));
    return yield* subprocess(host.pythonExecutable(), [path.join(host.packageRoot, "worker/jev_runner.py")], env,
      JSON.stringify({ root: host.home(), runId: journal.runId, targetId: journal.state().targetId, goal }), timeoutMs)
      .pipe(Effect.flatMap(text => sync(() => envelope(text))));
  });
}
export function canFallback(before: number, state: State, code: string): boolean {
  return ["engine_blocked", "unsupported"].includes(code) && !state.pendingAction && state.actionsUsed === before;
}
function requireBudget(j: Journal, deadline: number): number {
  const ms = deadline - Date.now();
  if (ms < 100) throw new BrowserError({ code: "budget_exhausted", reason: "Run active-time budget exhausted." });
  return ms;
}
async function createTarget(cdp: Cdp, session: host.Session, j: Journal, navigate: boolean, deadline: number): Promise<string> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true });
  atomic(path.join(host.home(), "targets", session.namespace, `${targetId}.json`), { targetId, browserId: session.browserId });
  j.append("target", { targetId, browserId: session.browserId });
  const sid = await cdp.attach(targetId);
  // Only our newly created target: keep background rAF/actionability alive without foregrounding Chrome.
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sid);
  if (navigate) {
    const id = randomUUID(); j.append("action.start", { id, kind: "navigate", safeToRepeat: j.meta().task.recovery?.restartSafe === true, engine: "cdp" });
    const result = await cdp.send<{ errorText?: string }>("Page.navigate", { url: j.meta().task.url }, sid);
    if (result.errorText) throw new BrowserError({ code: "navigation", reason: "Initial navigation failed; inspect before recovery." });
    const end = Math.min(deadline, Date.now() + 8_000);
    while (Date.now() < end) {
      const ready = await cdp.evaluate<boolean>(sid, 'location.href!=="about:blank" && ["interactive","complete"].includes(document.readyState)').catch(() => false);
      if (ready) { j.append("checkpoint", { ...await checkpoint(cdp, sid) }); j.append("action.end", { id }); return sid; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new BrowserError({ code: "navigation", reason: "Page did not become readable; do not repeat navigation blindly." });
  }
  return sid;
}
async function ownedSession(cdp: Cdp, session: host.Session, j: Journal): Promise<string> {
  const s = j.state();
  if (!s.tabRetained || s.browserId !== session.browserId) throw new BrowserError({ code: "session_changed", reason: "The run's original browser/tab is unavailable. Choose explicit reconstruction or restart when safe." });
  await cdp.send("Target.getTargetInfo", { targetId: s.targetId });
  return cdp.attach(s.targetId);
}
function checkCall(cdp: Cdp, sid: string, session: host.Session, j: Journal, checks: readonly Check[], deadline: number, observer?: Journal) {
  return Effect.gen(function* () {
    if (checks.some(c => c.frames?.length || c.shadow && c.shadow !== "none" || c.kind === "visual")) {
      const r = yield* pageCall(session, j, { operation: "checks", checks, timeoutMs: requireBudget(j, deadline) }, observer); return r.results as Data[];
    }
    const end = Math.min(deadline, Date.now() + (j.meta().task.checkTimeoutMs ?? 5_000));
    while (true) {
      const results = yield* io(() => cdp.evaluate<Data[]>(sid, legacyExpression(checks)));
      if (!Array.isArray(results) || results.length !== checks.length) return yield* Effect.fail(new BrowserError({ code: "verification", reason: "Missing assertion results." }));
      if (results.some(r => r.error)) return yield* Effect.fail(new BrowserError({ code: "verification", reason: String(results.find(r => r.error)!.error) }));
      if (results.every(r => r.passed === true) || Date.now() >= end) return results;
      yield* Effect.sleep("100 millis");
    }
  });
}
function collectExtraction(cdp: Cdp, sid: string, session: host.Session, j: Journal, deadline: number) {
  return Effect.gen(function* () {
    const extract = j.meta().task.extract ?? [];
    if (!extract.length) return;
    if (extract.some(x => x.frames?.length || x.shadow && x.shadow !== "none" || x.kind === "visual" || x.schema)) {
      const result = yield* pageCall(session, j, { operation: "extract", extract, timeoutMs: requireBudget(j, deadline) });
      const ref = j.evidence("extraction", { fields: result.fields, checkpoint: yield* io(() => checkpoint(cdp, sid)) });
      j.append("extraction", { fields: result.fields, evidenceRef: ref });
      if (result.complete === false) return yield* Effect.fail(new BrowserError({ code: "extraction_incomplete", reason: "Some requested fields could not be read. See partial extraction errors." }));
      return;
    }
    const fields: Data = {};
    for (const x of extract) {
      const expression = x.kind === "url" ? "location.href" : x.kind === "title" ? "document.title" : `(() => { const n=document.querySelectorAll(${JSON.stringify(x.selector ?? "body")}); if(n.length!==1)return {error:'ambiguous'}; return (${readElement.toString()})(n[0],${JSON.stringify(x)}); })()`;
      const field = yield* io(() => cdp.evaluate<unknown>(sid, expression)).pipe(Effect.map(value => {
        if (value && typeof value === "object" && ("error" in value || "available" in value && value.available === false)) return { error: "extraction", reason: "The locator did not identify a readable visible value." };
        const answer = value && typeof value === "object" && "actual" in value ? value.actual : value;
        return JSON.stringify(answer)?.length > 40_000 ? { error: "extraction_limit", reason: "Narrow this extraction; the value exceeds its output budget." } : { value: answer, method: "dom" };
      }), Effect.orElseSucceed(() => ({ error: "observation", reason: "The page could not be read." })));
      fields[x.name] = field;
    }
    const ref = j.evidence("extraction", { fields, checkpoint: yield* io(() => checkpoint(cdp, sid)) }); j.append("extraction", { fields, evidenceRef: ref });
    if (Object.values(fields).some(v => v && typeof v === "object" && "error" in v)) return yield* Effect.fail(new BrowserError({ code: "extraction_incomplete", reason: "Some requested fields could not be read. See partial extraction errors." }));
  });
}
async function validateRecoveryInputs(j: Journal): Promise<void> {
  for (const s of j.meta().task.recovery?.reconstruct ?? []) {
    if (s.valueFromRecovery && !j.recoveryFields()[s.valueFromRecovery]) throw new BrowserError({ code: "input_lost", reason: `Recovery input ${s.valueFromRecovery} was not retained. Re-entry is required.` });
    if (s.valueFromEnv && process.env[s.valueFromEnv] === undefined) throw new BrowserError({ code: "input_required", reason: `Set ${s.valueFromEnv} locally before reconstruction.` });
  }
}
export function recoveryChoices(s: State, live: Checkpoint | null): string[] {
  if (s.status === "failed" || s.status === "passed" || s.status === "done" || s.resumeForbidden) return ["inspect", "verify"];
  if (s.pendingAction && !s.pendingSafe || s.unresolvedEffect && (!live || !sameDocument(s.checkpoint, live))) return ["inspect", "reconcile"];
  if (!s.pendingAction && live && sameDocument(s.checkpoint, live) && s.checkpoint?.fingerprint === live.fingerprint) return ["resume"];
  const options: string[] = [];
  if (!s.unresolvedEffect) {
    if (s.meta.task.recovery?.reconstruct?.length) options.push("reconstruct");
    if (s.meta.task.recovery?.restartSafe && !s.hasUnsafeActions) options.push("restart");
  }
  return options.length ? options : ["blocked"];
}

function attempt(j: Journal, session: host.Session, mode: "new" | "resume" | "reconstruct" | "restart", engineOverride?: string, remainingGoal?: string) {
  const before = j.state();
  if (before.attempts.length >= (before.meta.task.recovery?.maxAttempts ?? 3)) return Effect.fail(new BrowserError({ code: "attempt_limit", reason: "Recovery attempt limit reached. Inspect the run before authorizing new work." }));
  const allocation = remaining(before).activeMs;
  if (allocation < 100 || remaining(before).actions < 1) return Effect.fail(new BrowserError({ code: "budget_exhausted", reason: "The saved run has no remaining budget. Start a separately authorized new task." }));
  const started = Date.now(); const deadline = started + allocation;
  let cdp: Cdp | undefined;
  j.append("attempt.start", { mode, engine: engineOverride ?? before.meta.task.engine ?? "jev", allocatedMs: allocation, ownerPid: process.pid, ...(remainingGoal ? { remainingGoal } : {}) });
  const finish = (status: string, reasonCode: string, reason: string) => {
    j.append("attempt.end", { status, reasonCode, reason, durationMs: Math.min(allocation, Date.now() - started) });
    return summary(j.state());
  };
  return Effect.gen(function* () {
    cdp = yield* io(() => Cdp.open(session));
    let sid: string;
    if (mode !== "new" && before.pendingAction && before.pendingSafe && !before.unresolvedEffect) j.append("safe_repeat", { originalAction: before.pendingAction, mode });
    if ((mode === "reconstruct" || mode === "restart") && before.tabRetained && before.browserId === session.browserId) {
      // Explicit recovery abandons this document. A crashed page can block
      // Playwright attachment to its replacement. Never retire user tabs.
      yield* io(async () => {
        const registry = path.join(host.home(), "targets", session.namespace, `${before.targetId}.json`);
        const owner = JSON.parse(await fs.promises.readFile(registry, "utf8"));
        if (owner.targetId !== before.targetId || owner.browserId !== session.browserId) throw new BrowserError({ code: "target", reason: "Cannot retire a tab without its matching ownership record." });
        const targets = await cdp!.send<{ targetInfos: { targetId: string }[] }>("Target.getTargets");
        if (targets.targetInfos.some(t => t.targetId === before.targetId)) {
          const result = await cdp!.send<{ success: boolean }>("Target.closeTarget", { targetId: before.targetId });
          if (!result.success) throw new BrowserError({ code: "target", reason: "The abandoned task tab could not be retired." });
        }
        j.append("closed", { targetId: before.targetId, reason: "explicit_recovery", mode });
        fs.rmSync(registry, { force: true });
      });
    }
    if (mode === "new" || mode === "reconstruct" || mode === "restart") sid = yield* io(() => createTarget(cdp!, session, j, mode !== "reconstruct", deadline));
    else sid = yield* io(() => ownedSession(cdp!, session, j));
    if (mode === "reconstruct") {
      const reconstruct = j.meta().task.recovery?.reconstruct ?? [];
      yield* pageCall(session, j, { operation: "steps", steps: reconstruct, saveProgress: false, timeoutMs: requireBudget(j, deadline) });
      j.append("reconstructed", { availableInputs: Object.keys(j.recoveryFields()) });
    }
    if (mode === "restart") j.append("steps.reset");
    const task = j.meta().task;
    if (task.preconditions?.length) {
      const results = yield* checkCall(cdp!, sid, session, j, task.preconditions, deadline);
      if (!results.every(r => r.passed)) return yield* Effect.fail(new BrowserError({ code: "precondition_failed", reason: "Account, deployment, or UI preconditions do not hold. No task actions were performed." }));
    }
    const steps: readonly Step[] = task.steps?.length ? task.steps : [{ kind: "goal", goal: task.goal }];
    let index = j.state().nextStep;
    while (index < steps.length) {
      const s = steps[index]!;
      if (s.kind !== "goal") {
        let end = index; while (end < steps.length && steps[end]!.kind !== "goal") end++;
        yield* pageCall(session, j, { operation: "steps", steps: steps.slice(index, end), startIndex: index, timeoutMs: requireBudget(j, deadline) });
        index = end; continue;
      }
      const selected = engineOverride ?? s.engine ?? task.engine ?? "jev";
      const goal = `Continue from the current page. Do not repeat completed steps. Required outcome: ${remainingGoal && index === before.nextStep ? remainingGoal : s.goal ?? task.goal}`;
      const previousActions = j.state().actionsUsed;
      if (selected === "vision") yield* pageCall(session, j, { operation: "vision", goal, timeoutMs: requireBudget(j, deadline) });
      else {
        const result = yield* jevCall(session, j, goal, requireBudget(j, deadline)).pipe(Effect.catchTag("BrowserError", e =>
          e.code === "unsupported" ? Effect.succeed({ execution: "blocked", reasonCode: "unsupported" } as Data) : Effect.fail(e)));
        if (result.execution !== "done") {
          if (selected === "auto" && canFallback(previousActions, j.state(), String(result.reasonCode))) {
            j.append("handoff", { from: "jev", to: "midscene", reasonCode: result.reasonCode });
            yield* pageCall(session, j, { operation: "vision", goal, timeoutMs: requireBudget(j, deadline) });
          } else return yield* Effect.fail(new BrowserError({ code: String(result.reasonCode), reason: "Executor stopped. Inspect the run; automatic replay of prior actions is disabled." }));
        }
      }
      j.append("step.done", { index }); index++;
      j.append("checkpoint", { ...yield* io(() => checkpoint(cdp!, sid)) });
      if (s.checks?.length) {
        const results = yield* checkCall(cdp!, sid, session, j, s.checks, deadline);
        j.append("checks", { results });
        if (!results.every(r => r.passed)) return yield* Effect.fail(new BrowserError({ code: "assertion_failed", reason: "A goal checkpoint assertion failed." }));
        j.append("verified_checkpoint");
      }
    }
    let passed = true;
    if (task.checks?.length) {
      const results = yield* checkCall(cdp!, sid, session, j, task.checks, deadline);
      const ref = j.evidence("checks", { results, checkpoint: yield* io(() => checkpoint(cdp!, sid)) });
      j.append("checks", { results, evidenceRef: ref }); passed = results.every(r => r.passed === true);
      if (passed) j.append("verified_checkpoint");
    }
    if (passed) yield* collectExtraction(cdp!, sid, session, j, deadline);
    j.append("checkpoint", { ...yield* io(() => checkpoint(cdp!, sid)) });
    const status = passed ? before.meta.testing ? "passed" : "done" : "failed";
    if (passed && task.keepTab !== true && (before.meta.testing || task.keepTab === false)) {
      yield* io(() => cdp!.send("Target.closeTarget", { targetId: j.state().targetId })); j.append("closed", { targetId: j.state().targetId });
      fs.rmSync(path.join(host.home(), "targets", session.namespace, `${j.state().targetId}.json`), { force: true });
    }
    return finish(status, passed ? "complete" : "assertion_failed", passed ? before.meta.testing ? "All declared checks passed." : "Task completed. Inspect the supplied evidence; completion alone is not verification." : "An explicit assertion did not match. No repair was attempted.");
  }).pipe(
    Effect.catchTag("BrowserError", e => Effect.succeed(finish(e.code === "assertion_failed" ? "failed" : "blocked", e.code, e.reason))),
    Effect.ensuring(Effect.promise(async () => {
      if (j.state().running) finish("blocked", "cancelled", "Execution was interrupted. Inspect partial state before any recovery.");
      await cdp?.close();
    })),
  );
}
export function runTask(input: Task, testing = false) {
  return withLease(() => Effect.gen(function* () {
    const task = yield* sync(() => applyRecipe(host.home(), input));
    yield* sync(() => validateTask(task, testing));
    const config = yield* io(host.configuration);
    const profile = yield* io(() => fs.promises.realpath(config.profileDir));
    const { journal, duplicate } = yield* sync(() => createRun(host.home(), task, testing, profile));
    // Only preflight failures are retryable through the idempotency key. Once
    // execution started (or an unknown event exists), recovery must be explicit.
    if (duplicate && !journal.events().every(e => e.type === "created" || e.type === "preflight.failed")) {
      return { ...summary(journal.state()), duplicate: true };
    }
    return yield* io(host.connect).pipe(Effect.flatMap(session => attempt(journal, session, "new")), Effect.tap(result => sync(() => {
      if (task.recipe && ["precondition_failed", "ambiguous_target", "assertion_failed"].includes(journal.state().reasonCode)) quarantineRecipe(host.home(), task.recipe, journal.state().reasonCode);
    })), Effect.catchTag("BrowserError", e => sync(() => {
      journal.append("preflight.failed", { code: e.code, reason: e.reason }); return summary(journal.state());
    })));
  }));
}
export function resumeRun(input: Resume) {
  return withLease(() => Effect.gen(function* () {
    const j = new Journal(host.home(), input.runId);
    let state = yield* sync(() => j.state());
    if (input.expectedRevision !== state.revision) return yield* Effect.fail(new BrowserError({ code: "revision_conflict", reason: "Run changed since inspection. Read its latest revision before continuing." }));
    if (state.status === "failed" || state.status === "passed" || state.status === "done") return yield* Effect.fail(new BrowserError({ code: "test_finished", reason: "This test already has a verdict. Use verify without replay; preserve the original attempt." }));
    const session = yield* io(host.connect);
    if (session.profileDir !== state.meta.profileDir) return yield* Effect.fail(new BrowserError({ code: "profile", reason: "The configured profile differs from this run." }));
    const cdp = yield* io(() => Cdp.open(session));
    let live: Checkpoint | null = null;
    try {
      if (state.browserId === session.browserId && state.tabRetained) {
        live = yield* io(async () => checkpoint(cdp, await ownedSession(cdp, session, j))).pipe(Effect.orElseSucceed(() => null));
      }
    } finally { yield* io(() => cdp.close()); }
    const mode = input.mode ?? "resume";
    if (live && state.scopeFingerprint && mode === "resume") {
      const scopes = yield* pageCall(session, j, { operation: "continuity", timeoutMs: 10_000 });
      if (scopes.fingerprint !== state.scopeFingerprint) return yield* Effect.fail(new BrowserError({ code: "state_changed", reason: "A frame's live state changed since the saved checkpoint. Choose explicit safe reconstruction, not blind continuation." }));
    }
    if (state.running) {
      const last = state.attempts.at(-1)!;
      j.append("attempt.end", { status: "blocked", reasonCode: "interrupted", reason: "Previous caller stopped without a final receipt.", durationMs: Math.min(last.allocatedMs, Date.now() - last.startedAt) }); state = j.state();
    }
    if (!recoveryChoices(state, live).includes(mode)) return yield* Effect.fail(new BrowserError({ code: state.pendingAction ? "mutation_uncertain" : live ? "state_changed" : "state_lost", reason: "Requested recovery is not safe from current evidence. Inspect, reconcile saved checks, or supply missing inputs; no replay occurred." }));
    if (mode === "reconstruct") yield* io(() => validateRecoveryInputs(j));
    const currentStep = state.meta.task.steps?.[state.nextStep];
    const autonomous = !state.meta.task.steps || currentStep?.kind === "goal";
    if (input.remainingGoal !== undefined && (!input.remainingGoal.trim() || input.remainingGoal.length > 20_000)) return yield* Effect.fail(new BrowserError({ code: "input", reason: "remainingGoal must contain 1..20,000 characters." }));
    if (autonomous && state.actionsUsed > 1 && !input.remainingGoal) return yield* Effect.fail(new BrowserError({ code: "remaining_goal_required", reason: "Partial autonomous work has no deterministic cursor. Inspect its receipts and explicitly supply the remaining goal; the original workflow will not be replayed." }));
    return yield* attempt(j, session, mode, input.engine, input.remainingGoal);
  }));
}
export function inspectRun(input: typeof InspectRun.Type) {
  const j = new Journal(host.home(), input.runId);
  const view = input.view ?? "summary";
  if (view === "task") return sync(() => ({ runId: j.runId, task: j.meta().task, revision: j.state().revision }));
  if (view === "summary") return sync(() => ({ ...summary(j.state()), recoveryInputs: Object.keys(j.recoveryFields()) }));
  if (view === "history" || view === "checks") return sync(() => {
    j.meta(); const events = j.events().filter(e => view === "history" || e.type === "checks" || e.type === "recheck");
    const cursor = Math.max(0, input.cursor ?? 0); const limit = Math.max(1, Math.min(100, input.limit ?? 20));
    const remainingEvents = events.filter(e => e.seq > cursor), batch = remainingEvents.slice(0, limit);
    return { runId: input.runId, events: batch, nextCursor: remainingEvents.length > limit ? batch.at(-1)!.seq : null, revision: j.state().revision };
  });
  return withLease(() => Effect.gen(function* () {
    const session = yield* io(host.connect); const cdp = yield* io(() => Cdp.open(session));
    try {
      const sid = yield* io(() => ownedSession(cdp, session, j));
      const limit = Math.max(1, Math.min(100, input.limit ?? 20));
      const observed = input.frames?.length || input.shadow && input.shadow !== "none"
        ? yield* pageCall(session, j, { operation: "inspect", scope: input, limit, timeoutMs: 10_000 })
        : yield* io(() => cdp.evaluate<Data>(sid, `(() => {const n=document.querySelectorAll(${JSON.stringify(input.selector ?? "body")}); if(n.length!==1)return {unavailable:true,reason:'Observation requires one matching region'}; return (${readPage.toString()})(n[0],${JSON.stringify({ limit })})})()`));
      const live = yield* io(() => checkpoint(cdp, sid));
      return { ...summary(j.state()), page: { ...observed, documentId: live.documentId }, recoveryChoices: recoveryChoices(j.state(), live), liveMatchesCheckpoint: j.state().checkpoint?.fingerprint === live.fingerprint };
    } finally { yield* io(() => cdp.close()); }
  })).pipe(Effect.catchTag("BrowserError", error => sync(() => ({ ...summary(j.state()), page: null, observationError: { code: error.code, reason: error.reason }, recoveryChoices: recoveryChoices(j.state(), null) }))));
}
export function verifyRun(runId: string, reconcile = false, fromRun?: string) {
  return withLease(() => Effect.gen(function* () {
    const j = new Journal(host.home(), runId); const state = j.state();
    const observer = fromRun && reconcile ? new Journal(host.home(), fromRun) : j;
    if (observer.meta().profileDir !== state.meta.profileDir) return yield* Effect.fail(new BrowserError({ code: "profile", reason: "Reconciliation observation must use the same dedicated profile." }));
    let charged = false;
    const started = Date.now(), allowance = Math.min(30_000, remaining(state).activeMs);
    if (allowance < 100) return yield* Effect.fail(new BrowserError({ code: "budget_exhausted", reason: "No verification budget remains; original evidence is still readable." }));
    const checks = reconcile ? state.meta.task.recovery?.reconcile : state.meta.task.checks;
    if (!checks?.length) return yield* Effect.fail(new BrowserError({ code: "verification", reason: reconcile ? "No predeclared reconciliation checks. Uncertain effects cannot be cleared automatically." : "This run has no saved assertions." }));
    const session = yield* io(host.connect); const cdp = yield* io(() => Cdp.open(session));
    try {
      const sid = yield* io(() => ownedSession(cdp, session, observer));
      const pendingChecks = reconcile && state.meta.task.recovery?.reconcileOutcome === "completed" && state.pendingStep !== null
        ? state.meta.task.steps?.[state.pendingStep]?.checks ?? [] : [];
      const results = yield* checkCall(cdp, sid, session, j, [...checks, ...pendingChecks], started + allowance, observer === j ? undefined : observer);
      const ref = j.evidence(reconcile ? "reconciliation" : "recheck", { results, observedRunId: observer.runId, checkpoint: yield* io(() => checkpoint(cdp, sid)) });
      j.append("recheck", { results, evidenceRef: ref });
      if (reconcile && results.every(r => r.passed)) {
        const completed = state.meta.task.recovery?.reconcileOutcome === "completed";
        // A completed deterministic dispatch advances once. Never replay a successful Save.
        const knownStep = state.pendingAction !== null && state.pendingStep !== null && state.meta.task.steps?.[state.pendingStep]?.kind !== "goal";
        j.append("reconciled", { evidenceRef: ref, outcome: state.meta.task.recovery?.reconcileOutcome,
          continuationForbidden: completed && state.pendingAction !== null && !knownStep,
          ...(completed && knownStep ? { nextStep: state.pendingStep! + 1 } : {}) });
        if (observer === j) {
          j.append("checkpoint", { ...yield* io(() => checkpoint(cdp, sid)) });
          if (state.scopeFingerprint) {
            const liveScopes = yield* pageCall(session, j, { operation: "continuity", timeoutMs: Math.max(100, started + allowance - Date.now()) });
            j.append("scope.checkpoint", { fingerprint: liveScopes.fingerprint });
          }
        }
      }
      j.append("observation.time", { durationMs: Math.min(allowance, Date.now() - started) }); charged = true;
      return { runId, results, evidenceRef: ref, originalStatus: state.status, revision: j.state().revision, recheckPassed: results.every(r => r.passed) };
    } finally { if (!charged) j.append("observation.time", { durationMs: Math.min(allowance, Date.now() - started) }); yield* io(() => cdp.close()); }
  }));
}
export function screenshotRun(input: typeof ShotInput.Type) {
  return withLease(() => Effect.gen(function* () {
    const j = new Journal(host.home(), input.runId); const session = yield* io(host.connect); const cdp = yield* io(() => Cdp.open(session));
    try {
      const sid = yield* io(() => ownedSession(cdp, session, j));
      const before = yield* io(() => checkpoint(cdp, sid));
      const dimensions = yield* io(() => cdp.evaluate<{ width: number; height: number; x: number; y: number; dpr: number }>(sid, input.fullPage ? '({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,x:0,y:0,dpr:devicePixelRatio})' : '({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY,dpr:devicePixelRatio})'));
      if (dimensions.width > 10_000 || dimensions.height > 10_000) return yield* Effect.fail(new BrowserError({ code: "image_limit", reason: "Page is too large. Request a viewport screenshot." }));
      const { dpr, ...css } = dimensions;
      const scale = Math.min(1, 1800 / (Math.max(dimensions.width, dimensions.height) * Math.max(1, dpr)));
      const shot = yield* io(() => cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: input.fullPage ?? false, clip: { ...css, scale } }, sid));
      const bytes = Buffer.from(shot.data, "base64");
      if (bytes.length > 6_000_000) return yield* Effect.fail(new BrowserError({ code: "image_limit", reason: "Screenshot exceeds the image budget." }));
      const after = yield* io(() => checkpoint(cdp, sid));
      const metadata = { runId: j.runId, targetId: j.state().targetId, browserId: session.browserId, documentId: before.documentId,
        capturedAt: Date.now(), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), css, devicePixelRatio: dpr, scale: { x: bytes.readUInt32BE(16) / dimensions.width, y: bytes.readUInt32BE(20) / dimensions.height }, mimeType: "image/png", stable: before.fingerprint === after.fingerprint };
      const evidenceRef = j.evidence("screenshot", metadata); const file = path.join(j.dir, "evidence", `${evidenceRef}.png`);
      yield* sync(() => fs.writeFileSync(file, bytes, { mode: 0o600 }));
      return { ...metadata, evidenceRef, path: file, revision: j.state().revision };
    } finally { yield* io(() => cdp.close()); }
  }));
}
export function closeRun(runId: string) {
  return withLease(() => Effect.gen(function* () {
    const j = new Journal(host.home(), runId); const session = yield* io(host.connect); const cdp = yield* io(() => Cdp.open(session));
    try {
      if (session.profileDir !== j.meta().profileDir) return yield* Effect.fail(new BrowserError({ code: "profile", reason: "Configured profile differs from this run." }));
      let closed = 0;
      for (const target of j.state().targets.filter(t => !t.closed && t.browserId === session.browserId)) {
        yield* io(() => cdp.send("Target.closeTarget", { targetId: target.targetId })); j.append("closed", { targetId: target.targetId }); closed++;
        fs.rmSync(path.join(host.home(), "targets", session.namespace, `${target.targetId}.json`), { force: true });
      }
      return { ok: true, closed };
    }
    finally { yield* io(() => cdp.close()); }
  }));
}
