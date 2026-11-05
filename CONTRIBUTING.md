# Contributing

## Development checks

- Use Node.js 18 or newer.
- Run `npm test` for the dependency-free module tests.
- Run `node --check` on changed JavaScript/CommonJS files.
- Parse changed PowerShell scripts with the PowerShell language parser.
- Review release payload lists in `install.ps1`, `apply-store-patch.ps1`,
  `sb_update.cjs`, and `.github/workflows/release.yml` when adding payload files.

## Scope and validation

Keep changes focused and preserve existing Slack install/restore behavior. Do
not commit user data, credentials, Slack application packages, or generated
`work/app.new.asar`. Changes to the Windows patching flow should be tested on a
disposable Slack installation before release; the Node.js tests do not replace
that end-to-end check.

## Releases

Release tags use the `v*` format. The release workflow overlays source onto a
known-good release package because the repository does not have the source
build required to generate `work/app.new.asar`. A release cannot be bootstrapped
until that seed package is available. Verify the resulting package and checksum
assets before publishing.
