# Contributing

Thanks for helping make MCP migrations safer.

## Development

Requirements:

- Node.js 22 or newer for development
- npm 11

```bash
npm install
npm test
npm run verify
```

`npm run verify` runs formatting, strict linting, type checking, coverage, builds, package metadata validators, ESM/CommonJS/CLI integration checks, and a tarball dry run.

## Protocol changes

Every protocol rule must include:

1. a link to the normative MCP specification, accepted SEP, conformance case, or official Tier 1 SDK behavior;
2. a valid positive fixture;
3. at least one invalid or conflicting fixture;
4. stable diagnostic wording and a finding code when user-visible;
5. tests proving unknown future revisions are not guessed.

Do not add lossy translation and label it compatible. When the two eras cannot preserve semantics, return a diagnostic.

## Pull requests

- Keep changes focused.
- Add or update tests.
- Add a changelog entry for user-visible changes.
- Run `npm run verify` before opening the pull request.
- Never include credentials, production transcripts, private endpoints, or personal data in fixtures.

By contributing, you agree that your contribution is licensed under the MIT License.
