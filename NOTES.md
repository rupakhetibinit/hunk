# Two-way review comments — investigation and design notes

Phase 1 findings for extending Hunk into a two-way review loop with Claude Code. Written before any
source changes. All paths are relative to the repository root.

## 1. What the repo is

- TypeScript + Bun monorepo (`package.json`, `bun.lock`). Published CLI/package is `hunkdiff` in
  `packages/hunk/`; private workspaces provide VCS backends and the session broker.
- TUI: React 19 + `@opentui/react` + `@opentui/core`, driven by Pierre diffs. Entry:
  `packages/hunk/src/main.tsx` → `app/startup.ts` → `app/cli.ts` (Commander-based hand dispatch).
- No hosted service is required for the feature: the existing daemon is a loopback TCP service
  (`127.0.0.1:47657`) used only by `hunk session *`. The new comment commands will not use it.
- Existing persistent local state is `$XDG_STATE_HOME/hunk/state.json` (Windows falls back to
  `~/.local/state`). Helpers: `core/run/paths.ts` (`resolveUserStateDir`),
  `core/process/appStateFile.ts` (atomic, merge-friendly, mode 0600),
  `core/process/appStateLocation.ts` (`prepareAppStatePath`).
- Git detection: `core/process/projectRoot.ts` (`findProjectRootCandidate`) and
  `packages/hunk-git/src/commands.ts` (`resolveGitMetadata`, spawns git). A filesystem-only `.git`
  walk exists in `packages/hunk-git/src/index.ts` (`detectGitRepo`).

## 2. Review notes today

### Model (`packages/hunk/src/core/review/`)

`ReviewNote` (`types.ts:45-68`) already has:

- `id: string` — caller-supplied (core never allocates ids/timestamps; `intents.ts:367-373`,
  `reducer.ts:6`). TUI user notes use `user:<timestamp>-<n>` or `user:<uuid>`; daemon agent notes
  use `mcp:<requestId>[:<index>]`.
- `parentId?: string`, `source: "ai"|"agent"|"user"`, `originalSource?`.
- `fileKey: string`, `anchor: ReviewRangeAnchor` (`oldRange`, `newRange`, `preferred: {side,line}`,
  `intersectingHunkIndices`, `ownerHunkIndex`).
- `summary: string`, `rationale?`, `markup?` (experimental STML), `title?`, `author?`,
  `createdAt?`, `updatedAt?`, `editable`, `tags?`, `confidence?`.

There is **no status/lifecycle field**. The only related concept is the wrapper
`ReviewStoredNote.resolution: "active"|"stale"|"orphaned"` (`state.ts:22-28`). It is a reload
reconciliation verdict: `active → stale` when the file's `contentIdentity` changes
(`reducer.ts:124-190`, `state.ts:49-54`). `orphaned` is never produced by any reload path and is the
only verdict that hides a note (`isRenderableStoredReviewNote`, `state.ts:36-38`). Notes are never
moved or deleted because the diff changed.

Reply threads are already modeled: `parentId` plus `notes/start-reply`, `notes/add-user` with
`parentId`, and threading selectors (`selectThreadedStoredReviewNotes`,
`selectVisibleThreadedStoredReviewNotes`, `core/review/selectors.ts:246-385`).

### Anchoring and reload survival

- `fileKey` is deliberately **not** content-derived (`identity.ts:100-115`) so a reload that changes
  a file does not orphan its notes. `reviewFileContentIdentity` hashes patch + rendered lines
  (`identity.ts:73-89`).
- `resolveReviewNoteAnchor` (`anchors.ts:56-92`) computes intersecting hunks and picks one owner;
  the anchor is never rewritten on reload, only the `resolution` label is updated.
- Conclusion: the model already has the notion "note context went stale". We will reuse the spirit
  of it but keep our lifecycle status in a separate store (see design decision D1).

### State/UI plumbing

- Notes live in memory in `ReviewState.liveNotes` / `.userNotes`; `ReviewStore` is a synchronous
  observable (`getSnapshot`/`subscribe`/`dispatch`, `store.ts:15-52`).
- `useTerminalReview.ts:114-151` subscribes to the store, shared-state revision, and agent marks.
  Any dispatch re-renders the TUI immediately. There is no polling in this path.
- Projection: `useTerminalReview.ts:421-450` threads notes via `selectVisibleThreadedStoredReviewNotes`
  and converts them with `storedNoteToLiveComment` / `storedNoteToUserNote`
  (`ui/lib/reviewNoteMapping.ts`) into terminal-only `StoredReviewNoteRenderMetadata` attached to
  `AgentAnnotation`. `DiffPane.tsx:621-695` applies `reviewNoteVisibleByPolicy` and builds
  `VisibleAgentNote`s; `DiffSectionBody.tsx:377-404` and `FileView.tsx:191-215` render
  `<AgentInlineNote>`.
- Note card: `ui/components/panes/AgentInlineNote.tsx`. The saved-card title/top border (~L802-869)
  is the natural place for a status badge; appending to the title costs no extra row, so the
  shared height measurement (`measureAgentInlineNoteHeight`, same file L139-168) and
  `agentNoteGeometry` stay valid.
- `a` toggles agent notes via `core/run/commandCatalog.ts:461-470`
  (`hunk.view.toggleAgentNotes`, `notes/toggle-visibility`), lowered in `commandCatalog.ts:716-717`,
  handled in `ui/App.tsx:1135-1140`. Reply already has a keybinding `R`
  (`hunk.review.replyToActiveNote`). Free single-key candidates: `X`, `S` (not in the catalog).

### Session/daemon seam (why we do not extend it)

- `hunk session *` commands are declarative specs in `session/agent/surface.ts`
  (`SESSION_AGENT_COMMANDS`, `satisfies Record<SessionDaemonAction, AgentCommandSpec>`), parsed in
  `app/cli.ts`, run by `session/agent/commands.ts` over `HttpHunkSessionCliClient` to the loopback
  daemon, forwarded over WebSocket to the live TUI by `session/broker/brokerServer.ts` →
  `app/session/bridge.ts` → `ReviewSessionHost`.
- Adding new daemon actions would require: new `SessionDaemonAction` (`session/protocol.ts:65-79`),
  strict Zod request/response schemas (`session/protocolSchemas.ts`), client methods, broker cases,
  bridge command union, **and a `HUNK_SESSION_DAEMON_VERSION` bump plus regenerated wire fixture**
  (`AGENTS.md`). That is invasive and would make the feature depend on a running session, which
  contradicts "agent can use it without the TUI".

## 3. Existing agent skill

`packages/hunk/skills/hunk-review/SKILL.md` (239 lines) tells Claude not to launch interactive
commands and to inspect/control live sessions via `hunk session *`. It documents `comment add`,
`apply`, `list`, `rm`, `clear`, highlights, navigation, reload, browser `open`, STML, and errors.
It has **no comment lifecycle**: no statuses, no resolve/dispute/reopen, and no instruction to fix
code in response to comments.

The file is generated: edit `packages/hunk/src/hunk-review/skillDocument.ts` (narrative) and
regenerate with `bun run generate:skill`; `skillDocument.test.ts` guards drift. Do not hand-edit.
There is no `.claude/` directory or existing slash command/hook convention in this repo.

## 4. What is missing

1. A durable, repo-scoped comment record with id, file/line anchor, text, author role, status, and
   a reply thread.
2. Agent-facing CLI commands that work with no TUI and emit `--json`.
3. Status rendering, resolved-hiding toggle, disputed flagging, user resolve/reopen keybinding,
   and live refresh in the TUI.
4. Skill/slash-command guidance for the two-way loop, plus an optional Stop hook.
5. README workflow, changeset, and tests for the store and CLI.

## 5. Proposed design (smallest change that fits)

### D1 — Keep lifecycle in a separate local store; do not add `status` to `ReviewNote`

**Decision.** A new module `packages/hunk/src/core/reviewComments/` owns a JSON document keyed by
repo root. Existing notes keep their ids; the lifecycle record references `noteId` when the comment
originated in a TUI note. The terminal applies status as terminal-only render metadata.

**Why.** Adding `status` to `ReviewNote` would force changes through the shared semantic seam
(`core/review` types, intents, reducers, selectors), `extension-api/types.ts`, live-comment
ingestion, `sharedState`/browser projections, the session wire fixture and version, plus the
conformance corpus. All of that risks breaking existing behavior for a feature that only the local
review loop needs. A sidecar keyed by note id leaves the shared model untouched.

**Tradeoff.** Status is not part of the daemon snapshot, so a browser review page does not show it.
The requested workflow is terminal-native and local; this is acceptable and documented as a known
limitation. Replies created by the agent are stored in the comment record's thread; replies the
user creates in the TUI are recorded as reply entries carrying their note id so the whole thread
shares one status.

### D2 — Storage location and discovery

**Decision.** One JSON file per repo at `$XDG_STATE_HOME/hunk/comments/<digest>.json`, where
`<digest>` is `reviewContentDigest([canonicalRepoRoot])` (reuse `core/review/identity.ts`). On
Windows, `USERPROFILE` fallback is used by `resolveUserStateDir`. `HUNK_COMMENTS_PATH` overrides the
file path for tests and advanced setups.

**Why.** The brief allows `.git` or an XDG data dir. XDG state avoids polluting `.git`, works for
worktrees (which have a `.git` file), and matches Hunk's existing state convention. It is outside
the working tree, so it can never be committed.

**Repo root resolution.** A filesystem-only upward `.git` walk from `process.cwd()` (mirroring
`packages/hunk-git/src/index.ts:detectGitRepo`), falling back to cwd. No git spawn, no network.

**File format and safety.** `{"version":1,"comments":[...]}`. Atomic write via temp file + rename,
mode 0600, corrupt file quarantined to `.corrupt-<uuid>` rather than silently reset.

### D3 — Anchoring survives edits by content, then degrades to `outdated`

**Decision.** Each comment records `file` (repo-relative), `side`, `line`, `hunkIndex`, and
`anchorText` (the source line captured when the user leaves the note). On `hunk comment list` and on
TUI reload, re-anchor: read the working-tree file, search for `anchorText`; if found (unique or
first match), update `line`; if not found, set status `outdated` for `open`/`disputed` comments.
`resolved` comments are never changed. Comments on the `old` side have no working-tree text, so
their line is kept and they are marked `outdated` only if the file is missing.

**Why.** Re-anchoring by content is simple, deterministic, and local. This mirrors Hunk's own
policy of labelling notes stale without hiding them. An `outdated` comment stays visible but is
flagged, so the agent/user can reopen or re-anchor deliberately.

### D4 — CLI commands are top-level and daemon-free

`hunk comment list [--all] [--status <status>] --json`, `resolve <id> --note "..."`,
`reply <id> --text "..."`, `dispute <id> --text "..."`, `reopen <id>`; all support `--json` and
reuse `stringifyJson` (`session/agent/cliClient.ts:328-330`). Text output is a compact human form.

Implementation touchpoints (mirroring `hunk status`/`hunk daemon`):

- add `"comment"` to `BUILT_IN_CLI_COMMAND_NAMES` (`core/run/cliCommandNames.ts`);
- add `CommentCommandInput` to `ParsedCliInput` (`core/run/commandInputs.ts`);
- add `parseCommentCommand` + `case "comment"` + help lines in `app/cli.ts`;
- add `kind: "comment-command"` to `StartupPlan` (`app/startup.ts`) and dispatch in `main.tsx`;
- runner in `app/comment/runCommentCommand.ts` operating only on the local store.

No protocol, broker, wire-version, or daemon changes. Existing `hunk session *` behavior is
untouched.

### D5 — TUI changes are presentation-only, driven by a local file poll

- A hook polls the comment file (~750 ms) and exposes a status-by-note-id map (root status applied
  to all reply note ids), plus a `showResolved` view flag. Polling is deliberate: it is portable
  (including Windows) and avoids adding an agent command to the daemon protocol. The store dispatch
  that follows a poll re-renders through the existing `useReviewStoreSnapshot` path.
- Status is attached as `commentStatus` on `StoredReviewNoteRenderMetadata` in
  `ui/lib/reviewNoteMapping.ts`; `AgentInlineNote` appends a compact badge to the saved-card title
  (`✓ resolved`, `⚑ disputed`, `~ outdated`). No extra row, so geometry is unchanged.
- `DiffPane` filters annotations whose `commentStatus === "resolved"` when `showResolved` is false.
  This mirrors `reviewNoteVisibleByPolicy` at the terminal surface and keeps the shared seam pure.
- New keybindings: `X` toggles resolve/reopen on the active tracked note (with note "Resolved by
  reviewer" when resolving from the TUI); `S` toggles showing resolved comments. `R` (reply) is
  reused. Command catalog entry + `appCommands` dispatch + `App.tsx` handler write through the
  local store.
- When the user leaves a note (`c` → draft save), the TUI writes a new open comment to the store
  with the note id, path, anchor, and anchor text read from the working tree.

### D6 — Skill, slash command, and Stop hook

- Add a "Two-way comment lifecycle" section to `skillDocument.ts`: list open comments with
  `hunk comment list --json`, fix each one, call `resolve --note` or `dispute --text`, then run the
  repo's tests/build. Explicitly forbid interactive TUI commands. Regenerate `SKILL.md`.
- Add `.claude/commands/review-comments.md` implementing that loop as a short slash command.
- Document a Stop hook (not auto-installed) with an example script
  `examples/claude/check-open-comments.ts` that prints hook JSON when open comments remain.

## 6. Feasibility and limitations

- All requested pieces are feasible. The only deliberate non-goal is browser/session-wire status
  propagation (D1), which the terminal-only workflow does not need.
- Re-anchoring is best-effort: duplicate `anchorText` matches use the first occurrence, and
  deleted-line (`old` side) anchors cannot be re-located from the working tree.
- Live refresh is polling-based (~750 ms), not push; immediate enough for a human-in-the-loop
  review and avoids protocol changes.
- The TUI must be running from the same repo root as the agent for store discovery to agree; the
  `--repo`/cwd convention in this repo already assumes that.

## 7. Verification plan

- Baseline: `bun run test` before changes (result recorded in the final summary).
- After each committed step: `bun run typecheck`, focused `bun test` for changed modules,
  `bun run test`, `bun run deps:check`, `bun run format:check`, `bun run lint`.
- Rendered/keybinding changes: PTY/TTY suites are Unix-only and cannot run on Windows here; report
  that limitation honestly. Unit tests cover status projection, filtering, and store/CLI behavior.
- End-to-end: throwaway git repo, open TUI, leave a note, use `hunk comment list --json`, resolve,
  confirm the TUI hides it; dispute/reopen and confirm the badge and flag.
