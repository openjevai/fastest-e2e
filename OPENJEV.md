# OpenJEV Support

This fork adds optional [OpenJEV](https://openjev.sh) support alongside the
existing TypeSafe integration. OpenJEV is a free community gateway to the same
Jev model. TypeSafe remains the default; anyone with a `TYPESAFE_API_KEY` sees
zero behaviour change.

## What was added

- **`worker/jev_runner.py`** — provider selection and a lightweight `post_json`
  patch that redirects Jev requests to the OpenJEV endpoint (`https://api.openjev.sh/v1/systemone`,
  model `openjev`) when OpenJEV is selected. When TypeSafe is selected (default),
  the original `https://api.typesafe.ai/v1/systemone` endpoint and `jev-latest`
  model are used unchanged.
- **`src/workflows.ts`** — the `jevCall` credential check now accepts
  `OPENJEV_API_KEY` / `JEV_PROVIDER=openjev` in addition to `TYPESAFE_API_KEY`.
- **`src/runtime.ts`** — `doctor` reports `openjevKeyPresent`; `install` strips
  `OPENJEV_API_KEY` from the install environment (alongside `TYPESAFE_API_KEY`).
- **`.env.example`** — documents the optional `OPENJEV_API_KEY` and
  `JEV_PROVIDER` variables (commented out; TypeSafe stays default).
- **`docs/setup.md`** — OpenJEV configuration note.
- **`README.md`** — OpenJEV support note after the project intro.
- **`test/core.test.mjs`** — verifies `OPENJEV_API_KEY` is preserved by the
  worker environment (same as `TYPESAFE_API_KEY`).

## Provider selection rule

1. `JEV_PROVIDER=openjev` → OpenJEV (explicit choice wins).
2. `TYPESAFE_API_KEY` set → TypeSafe (unchanged default).
3. Only `OPENJEV_API_KEY` set → OpenJEV.

When OpenJEV is selected, the worker aliases `OPENJEV_API_KEY` into
`TYPESAFE_API_KEY` (so the pinned `jev_ultrafast` dependency finds it), sets
`TYPESAFE_MODEL=openjev`, and patches the request URL to the OpenJEV gateway.

## How to configure

Set `OPENJEV_API_KEY` in your invoking environment (or `JEV_PROVIDER=openjev`
to force OpenJEV even when a TypeSafe key is also present):

```sh
export OPENJEV_API_KEY=your-key
fastest-e2e doctor   # openjevKeyPresent: true
```

Get a free key at https://openjev.sh/dashboard.

## How it was verified

- A live POST to `https://api.openjev.sh/v1/systemone` with model `openjev`,
  state `ping`, and one `noul` question returned HTTP 200.
- `grep -r "api.typesafe.ai" .` confirms no hardcoded TypeSafe endpoint in this
  repo's source (the endpoint lives in the external `jev_ultrafast` dependency,
  which is redirected at runtime when OpenJEV is selected).

## Upstream

Original project: https://github.com/BleedingDev/fastest-e2e by @BleedingDev.
