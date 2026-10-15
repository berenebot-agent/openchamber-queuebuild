# Work board server module

The work board stores prompt cards in `work-board.json` under the OpenChamber data directory. It is server-owned state, separate from the message queue. Writes run serially within the server process and publish through a same-directory temporary file and atomic rename. A failed write leaves the prior board file in place.

The authenticated API is registered before the generic OpenCode proxy:

- `GET /api/work-board?directory=<path>` returns `{ cards }` scoped to the resolved directory. Optional `sessionId` filters by the linked session, independently of its worktree directory. The session view uses this filter to restore saved briefs without reading unrelated attachment payloads. Omitting both filters returns the full list. Supplying both applies both filters.
- `POST /api/work-board` accepts `{ directory, text, attachments }` and returns `{ card }` with status 201.
- `POST /api/work-board/sessions/:sessionId/todo` accepts `{ directory, sessionDirectory?, text, attachments }` and returns `{ card }`. The board directory and the session's worktree directory may differ. The queue runtime rejects queued, active, or uncertain work and holds queue dispatch while checking idleness and saving.
- `PATCH /api/work-board/:id` accepts `text`, `attachments`, `sessionId`, and/or `stage`, and returns `{ card }`.
- `DELETE /api/work-board/:id` removes the card and returns `{ ok: true }`.
- `POST /api/work-board/complete` accepts `{ directory, targets }`. Each target
  has `id`, `updatedAt`, `text`, and optional `sessionId` and `sessionDirectory`.
  It returns `{ completed: string[], failed: { id, error }[] }` using the target
  ids. Each linked target runs inside the queue runtime's idle-session parking
  guard. Missing queue checks fail closed. Bulk writes are independent atomic
  card writes, so one failed card does not block unrelated cards.

A card has `id`, `directory`, `text`, `attachments`, `createdAt`, `updatedAt`, and `stage`. `sessionId` and `completedAt` are optional. Stages are `todo`, `plan`, and `done`. Existing version 1 files remain readable without conversion. An attachment has `id`, `filename`, `mimeType`, `size`, and a validated base64 `dataUrl`. Text or at least one attachment is required. JSON bodies are limited to 50 MiB. The server checks base64 syntax, MIME consistency, and decoded size.

Only the completion operation writes `done`; generic PATCH cannot bypass the
idle guard. Completion preserves saved text and attachments. Stored target ids,
directories, session links, and `updatedAt` must still match. An inherited
session uses `session:<sessionId>` as its target id and gets a durable card on
first completion. An existing link prevents duplicate inherited cards. The
server sets `completedAt`; later submitted turns override this saved intent.
Returning to To-do clears the completion timestamp.

Promotion to `plan` requires a persisted session link. A card linked to one session cannot be linked to another. Clients persist the session link before sending and change stage only after the send succeeds. The card contents remain available after a failed send. A linked To-do offers an Open session action so the user can inspect an ambiguous send before submitting again. The client never automatically retries a linked card.

Parking uses one serialized store operation and one atomic file replacement to create or update a session-linked card. A failed write preserves the previous board and leaves no unlinked intermediate card. Repeating the latest notes does not append them again; attachment IDs deduplicate repeated uploads. Existing text and files are preserved when returning a card to To-do with no additional content.

The shared session transcript displays linked saved briefs directly from this
store, including cards saved before this display existed. It shows only cards
still in `todo`; a promoted card's text is a real user turn in the transcript, so
showing the card too would duplicate it. Parking never writes
an OpenCode prompt or synthetic message. The visible entry follows the saved
card through edits and removal; it does not change session activity or queue
admission.

Malformed persisted data is a read failure. It never becomes an empty board or gets overwritten by a later save. Store files use mode `0600` because they contain prompt text and attachment bytes. The store validates saved card shapes and duplicate ids as well as incoming content.

Stored stages describe the board's saved intent. The UI derives Queued and Building from the project queue and live OpenCode status, and uses actual assistant/idle history for Plan and automatic Done. Manual Done intent remains until a later real turn. Changing a model or agent selector alone does not change a card's lane. Parking a card sets `updatedAt`; a later real turn overrides that parking marker. Done ordering uses the successful idle record's timestamp or the manual completion timestamp, never the session's last update.
