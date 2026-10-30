# Real-project coding smoke test

This harness runs the acceptance loop of [ADR-0001](../../../docs/adr/0001-real-project-coding-is-the-acceptance-criterion.md)
against a disposable fixture project, in an isolated profile, with the user's
own ChatGPT account:

1. the model reads `sum.js`;
2. it proposes the edit that makes the test pass;
3. OpenCode executes that edit under its own permission policy;
4. it proposes running the test, and the test runs;
5. the model observes the output and reports the outcome.

The runner proves its own receipts. It re-arms the fixture from a proven RED
state and records the RED exit code before the run, lists the tool calls the
native turn actually executed, and re-runs the test afterwards. A run only
reports `SMOKE=PASS` when the RED exit was non-zero, the three tool calls were
executed, the test is green afterwards, the CLI exited 0 and the model
answered.

## What it is not

- It is **not** an activation proof. `promotionAllowed` and `activationAuthorized`
  stay `false`, and the personal activation verdict stays NO-GO (ADR-0003).
- It never touches a personal installation, profile, browser profile, cookie,
  secret or token. The CLI, the provider profile and the fixture are named by
  the caller and are disposable by contract.
- It does not commit evidence. The repository policy excludes `docs/evidence/`
  from the release inputs (ADR-0004); the run's own artefacts stay in the
  disposable profile.

## Requirements

- Windows with PowerShell 5.1 and Node.js on `PATH`.
- A disposable OpenCode CLI (2.1.4 or later) and an isolated OpenCode profile
  whose `opencode.jsonc` selects the provider with `"nativeTools": "coding"`.
  The runner refuses any other mode rather than proving the wrong thing.
- The profile's provider plugin must point at a build of this package.

## Run it

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File run-coding-smoke.ps1 `
  -Cli <path-to-disposable-opencode-cli.exe> `
  -Profile <path-to-isolated-profile>
```

The fixture is materialised into `<Profile>\fixture-coding` (override with
`-Fixture`), and the run's artefacts are written next to the profile as
`run-<timestamp>.out.json` and `run-<timestamp>.err.log`.

## The protocol under test

The model answers with one envelope per turn, and the gateway converts it into
an OpenCode `tool_calls` entry. The gateway never executes anything:

```
<opencode-tool>{"name":"TOOL_NAME","arguments":{...}}</opencode-tool>
```

The protocol, its bounds and the reasons the turn had to change three times
are recorded in ADR-0002, ADR-0006, ADR-0008, ADR-0009 and ADR-0010.
