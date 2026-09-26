import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateRun, validateTest, exitCode } from "../dist/contracts.js";
import { acquireLock, assertEndpoint, parseActivePort, workerEnvironment } from "../dist/host.js";

const run = { url: "https://example.com", goal: "Read the page" };
test("browser URLs exclude local files, JavaScript and embedded credentials", () => {
  validateRun(run);
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://user:password@example.com"]) {
    assert.throws(() => validateRun({ ...run, url }));
  }
});
test("budgets are bounded and integral", () => {
  for (const maxSteps of [0, -1, 1.5, 101]) assert.throws(() => validateRun({ ...run, maxSteps }));
  for (const timeoutMs of [0, 999, 600001, NaN]) assert.throws(() => validateRun({ ...run, timeoutMs }));
});
test("tests require real assertions and reject vacuous expectations", () => {
  assert.throws(() => validateTest({ ...run, name: "empty", checks: [] }));
  for (const check of [{ kind: "text", value: "" }, { kind: "url", value: " " },
    { kind: "value", value: "test" }, { kind: "checked", selector: "input", value: "yes" },
    { kind: "count", selector: "button", value: "-1" }]) {
    assert.throws(() => validateTest({ ...run, name: "bad", checks: [check] }));
  }
  validateTest({ ...run, name: "good", checks: [{ kind: "text", value: "Welcome" }] });
});
test("DevToolsActivePort is parsed strictly", () => {
  assert.deepEqual(parseActivePort("9333\n/devtools/browser/a-b-c\n"), { port: 9333, browserPath: "/devtools/browser/a-b-c" });
  for (const text of ["0\n/devtools/browser/x", "65536\n/devtools/browser/x", "9333\n/other", "9333\n/devtools/browser/x?token=secret"]) {
    assert.throws(() => parseActivePort(text));
  }
});
test("the same port with another browser ID fails closed", () => {
  assertEndpoint("ws://127.0.0.1:9333/devtools/browser/expected", 9333, "/devtools/browser/expected");
  for (const endpoint of ["ws://127.0.0.1:9333/devtools/browser/personal", "ws://evil.example:9333/devtools/browser/expected",
    "ws://127.0.0.1:9334/devtools/browser/expected", "ws://user:secret@127.0.0.1:9333/devtools/browser/expected"]) {
    assert.throws(() => assertEndpoint(endpoint, 9333, "/devtools/browser/expected"));
  }
});
test("the worker cannot inherit another daemon, endpoint or cloud credentials", () => {
  const session = { browserId: "expected", wsUrl: "ws://127.0.0.1:9333/devtools/browser/expected", namespace: "abc", profileDir: "/dedicated" };
  const env = workerEnvironment(session, { BU_CDP_URL: "http://personal:9222", BU_CDP_WS: "ws://personal",
    BU_NAME: "default", BH_RUNTIME_DIR: "/shared", BH_HOME: "/personal", BROWSER_USE_API_KEY: "private", TYPESAFE_API_KEY: "preserve", OPENJEV_API_KEY: "preserve-oj" });
  assert.equal(env.BU_CDP_URL, undefined);
  assert.equal(env.BH_RUNTIME_DIR, undefined);
  assert.equal(env.BROWSER_USE_API_KEY, undefined);
  assert.equal(env.BU_CDP_WS, session.wsUrl);
  assert.equal(env.BU_NAME, "fe2e-abc");
  assert.equal(env.TYPESAFE_API_KEY, "preserve");
  assert.equal(env.OPENJEV_API_KEY, "preserve-oj");
  assert.equal(env.BH_RECORD, "0");
});
test("session locks serialize callers and only the owner can release", async () => {
  const previous = process.env.FASTEST_E2E_HOME;
  const root = await mkdtemp(path.join(tmpdir(), "fe2e-lock-"));
  process.env.FASTEST_E2E_HOME = root;
  try {
    const release = await acquireLock();
    await assert.rejects(acquireLock(), /locked/);
    assert.equal(JSON.parse(await readFile(path.join(root, "session.lock"), "utf8")).pid, process.pid);
    await release();
    const releaseAgain = await acquireLock();
    await writeFile(path.join(root, "session.lock"), JSON.stringify({ token: "other-owner" }));
    await releaseAgain();
    assert.equal(JSON.parse(await readFile(path.join(root, "session.lock"), "utf8")).token, "other-owner");
  } finally {
    if (previous === undefined) delete process.env.FASTEST_E2E_HOME; else process.env.FASTEST_E2E_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});
test("test status maps to deliberate exit codes", () => {
  assert.equal(exitCode("passed"), 0); assert.equal(exitCode("done"), 0);
  assert.equal(exitCode("failed"), 1); assert.equal(exitCode("blocked"), 2);
});
