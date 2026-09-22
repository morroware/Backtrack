# AGENTS.md

## Scope

These rules apply only to the Backtrack repository in this directory. They
supplement the installation-wide AGENTS.md without changing it.

## Versioning

Update Backtrack's version proactively whenever a user-visible behavior change,
bug fix, installable package, or release is prepared. The user must not need to
request the version change separately.

- Use semantic versioning: patch for compatible fixes and refinements, minor
  for compatible feature additions, and major for incompatible changes.
- An explicit version supplied by the user always takes precedence.
- Keep `manifest.json`, `package.json`, runtime version constants, current
  documentation, tests, package names, tags, and release titles synchronized.
- Preserve older version numbers when they intentionally describe historical
  behavior or earlier test evidence.
- A proactive version update does not by itself authorize a commit, push, tag,
  package upload, or GitHub release. Those actions still require explicit user
  authorization.
