# Setup

Requires Node 24.18 or newer, uv, and installed Google Chrome or Chromium. Python 3.12 is provisioned by uv. No npm package is published yet.

```sh
git clone https://github.com/BleedingDev/fastest-e2e.git
cd fastest-e2e
npm ci
npm run build
npm link
fastest-e2e init
fastest-e2e install
```

`init` detects Chrome and creates configuration under `~/.fastest-e2e`. Override this root with `FASTEST_E2E_HOME`. To choose the executable or profile on first setup:

```sh
fastest-e2e init --chrome /absolute/path/to/chrome --profile /absolute/path/to/dedicated-user-data
```

Existing configuration is preserved. Edit its `config.json` deliberately to change it. Use a separate root for each independent session. Keep configuration, profiles, and credentials outside source repositories.

Supply `TYPESAFE_API_KEY` and `TEXT_MODEL_API_KEY` through the invoking process environment. `.env.example` lists the optional model settings. The CLI does not load arbitrary project `.env` files. With a local gitignored environment file, Node can load it explicitly:

```sh
node --env-file=.env dist/cli.js doctor
```

**OpenJEV (optional):** TypeSafe stays the default. To use the free community gateway instead, set `OPENJEV_API_KEY` (or `JEV_PROVIDER=openjev`). When only `OPENJEV_API_KEY` is present and `TYPESAFE_API_KEY` is absent, OpenJEV is used automatically. The worker redirects Jev requests to the OpenJEV endpoint with model `openjev`; no TypeSafe behaviour changes when a TypeSafe key is set.

Jev is pinned to a Git revision; its dependency pins Browser Harness 0.1.13. `install` uses the committed uv lock and installs outside the package, in the selected home. It must complete before browser tasks. A locked install never upgrades dependencies during a task.

## Log in, then run headless

```sh
fastest-e2e start --headed
# Log into only the intended accounts in this Chrome window.
fastest-e2e stop
fastest-e2e start
fastest-e2e doctor
```

The headed and headless processes reuse persistent browser storage, not an in-memory tab session. Authentication can expire or require interactive reauthentication. Two Chrome processes cannot use the same user-data directory simultaneously. `start` reuses a live configured browser; it does not change that process's headed/headless mode.

You can also launch this dedicated profile yourself with `--remote-debugging-port=0`. The runtime reads that profile's `DevToolsActivePort` and verifies its browser ID. It never scans personal profiles or default debugging ports.

Do not enable Chrome sync into the automation profile. A profile limits the accounts exposed to browser automation; it does not sandbox coding agents or trusted fallback scripts. CDP controls the entire configured browser. Keep it on loopback. Page text and field context are sent to TypeSafe and the configured text-model provider. Recordings are disabled by default; explicit script output may still contain sensitive data.

## Skills

Use the target agent's configured skill directory. There is no assumed universal path. Symlink each skill directory from this checkout, so setup and reference files remain available:

```sh
ln -s /absolute/path/to/fastest-e2e/skills/browser-use /your/agent/skills/browser-use
ln -s /absolute/path/to/fastest-e2e/skills/browser-test /your/agent/skills/browser-test
ln -s /absolute/path/to/fastest-e2e/skills/setup-fastest-e2e /your/agent/skills/setup-fastest-e2e
```

On Windows use directory symlinks or an agent-supported skill search path. Check that the client follows relative references through symlinked skills; otherwise register the checkout's `skills` directory directly. These are portable skill documents, not a claim that every client's installer has been tested. Codex, Claude Code, OpenCode, Pi, and OMP can all invoke the CLI when their shell permissions allow it.

## MCP

The generic stdio launch configuration is:

```json
{
  "mcpServers": {
    "fastest-e2e": {
      "command": "fastest-e2e",
      "args": ["mcp"],
      "env": { "FASTEST_E2E_HOME": "/absolute/path/to/automation-state" }
    }
  }
}
```

Adapt the enclosing configuration to your client and inject model keys through its supported environment mechanism. CLI and MCP must use the same home. Tools are `browser_run`, `browser_test`, `browser_inspect`, `browser_close`, `browser_doctor`, `browser_resume`, `browser_verify`, `browser_reconcile`, and `browser_screenshot`. Run-based calls take the returned `runId`; resume also requires `expectedRevision`. `mcp --allow-scripts` additionally exposes trusted local Python execution through `browser_harness`.

## Recovery

A crashed process can leave a lease. The runtime reclaims it only after its owner and registered workers are dead. Do not delete a live lease or launch a competing session. A stopped or mismatched Chrome produces an error instead of selecting another profile. Restart the configured browser, not a personal browser.

## Vision

Vision is optional and disabled in existing installations. In the selected home's `config.json`, set `visionEnabled` to `true` without changing its Chrome/profile settings. Provide `MIDSCENE_MODEL_API_KEY`, `MIDSCENE_MODEL_BASE_URL`, `MIDSCENE_MODEL_NAME`, and `MIDSCENE_MODEL_FAMILY` through the invoking environment. Choose a model/family supported by the pinned Midscene version; there is no assumed working provider default.

This authorizes sending screenshots to that configured provider. `doctor` reports readiness but makes no validation/model calls. Try an explicitly authorized small `--engine vision` task before relying on it. MCP and CLI must inherit the same provider settings. Upstream documentation: [model configuration](https://midscenejs.com/model-provider.html).

`jev` is the default; `auto` opts into bounded fallback. Explicit deterministic steps need no model credentials. The Python worker remains required for Jev and Browser Harness lifecycle/fallback commands. The outer agent need not support images for Midscene execution; viewing returned screenshots still depends on its client.

## Update and local data

After pulling an update, run `npm ci && npm run build`, then `fastest-e2e install` for the locked worker. Re-registering symlinked skills is unnecessary. No install command upgrades dependencies during a task.

Run intent, literal inputs, and evidence are stored locally. Use `valueFromEnv` for sensitive fields instead of literal values/goals, and do not put them in the recovery allowlist. `retentionHours` defaults to 24; `fastest-e2e prune` removes expired data. A disconnected or restarted browser does not restore unsaved forms; use [recovery rules](design.md#recovery).
