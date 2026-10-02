# Working on Canvy

Read README.md and plugins/canvy/skills/canvy/SKILL.md before changing the integration.

- Keep product text and public documentation in English. Preserve user-authored design content and names.
- Keep the Codex canvas a self-contained native MCP App. Browser mode is a development harness.
- Preserve document IDs, `.freecanvas` checkpoints, `.fig` backups and legacy protocol identifiers unless implementing a tested migration.
- Do not commit `.runtime`, `.local`, credentials, personal screenshots, exports or research artifacts. Generated manifests contain machine-specific paths.
- Preserve explicit document routing, save acknowledgements, one-writer-per-document checks, conflict recovery and the rule against replaying uncertain writes.
- Run `npm run build` and the isolated `npm test` suites for editor/protocol changes. Installed discovery is checked separately with `npm run test:installed`.
- Distinguish actual native host validation from the opaque protocol harness in reports.
- Source plugin metadata is in `plugins/canvy`; `npm run configure` generates the runnable marketplace under `.local`.
