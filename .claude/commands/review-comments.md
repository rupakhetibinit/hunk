---
description: Work through open Hunk review comments, then resolve or dispute each one.
---

Work through the reviewer's open comments on this repository using Hunk's local, daemon-free comment store.

1. Run `hunk comment list --json`. These are the reviewer's open comments; each has an `id`, `file`, `line`/`side`, `anchorText`, and `text`.
2. For every open comment, read the anchored code and make the smallest change that addresses it. Do not guess what the comment means — inspect the file first.
3. When you changed code for a comment, run `hunk comment resolve <id> --note "<what you did>" --json`.
4. If the comment is wrong or the code should stay as-is, run `hunk comment dispute <id> --text "<why>" --json`. Leave the code unchanged.
5. If the comment needs a conversation rather than a terminal state, use `hunk comment reply <id> --text "<reply>" --json`. Use `hunk comment reopen <id> --json` only when asked to revisit a resolved item.
6. After the loop, run the repository's tests or build if one is present. Report what you resolved, what you disputed, and the verification result.

Never run interactive TUI commands (`hunk diff`, `hunk show`, etc.) and never edit the comment JSON file directly. Use only `hunk comment *` so writes stay atomic and the reviewer's live TUI updates.
