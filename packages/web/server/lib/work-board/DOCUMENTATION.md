# Work board server module

The work board stores prompt cards in `work-board.json` under the OpenChamber data directory. It is server-owned state, separate from the message queue. Writes run serially within the server process and publish through a same-directory temporary file and atomic rename. A failed write leaves the prior board file in place.

The authenticated API is registered before the generic OpenCode proxy:

- `GET /api/work-board?directory=<path>` returns `{ cards }` scoped to the resolved directory. Omitting `directory` returns the full list.
- `POST /api/work-board` accepts `{ directory, text, attachments }` and returns `{ card }` with status 201.
- `POST /api/work-board/sessions/:sessionId/todo` accepts `{ directory, sessionDirectory?, text, attachments }` and returns `{ card }`. The board directory and the session's worktree directory may differ. The queue runtime rejects queued, active, or uncertain work and holds queue dispatch while checking idleness and saving.
- `PATCH /api/work-board/:id` accepts `text`, `attachments`, `sessionId`, and/or `stage`, and returns `{ card }`.
- `DELETE /api/work-board/:id` removes the card and returns `{ ok: true }`.

A card has `id`, `directory`, `text`, `attachments`, `createdAt`, `updatedAt`, and `stage`. `sessionId` is optional. Stages are `todo` and `plan`. An attachment has `id`, `filename`, `mimeType`, `size`, and a validated base64 `dataUrl`. Text or at least one attachment is required. JSON bodies are limited to 50 MiB. The server checks base64 syntax, MIME consistency, and decoded size.

Promotion to `plan` requires a persisted session link. A card linked to one session cannot be linked to another. Clients persist the session link before sending and change stage only after the send succeeds. The card contents remain available after a failed send. A linked To-do offers an Open session action so the user can inspect an ambiguous send before submitting again. The client never automatically retries a linked card.

Parking uses one serialized store operation and one atomic file replacement to create or update a session-linked card. A failed write preserves the previous board and leaves no unlinked intermediate card. Repeating the latest notes does not append them again; attachment IDs deduplicate repeated uploads. Existing text and files are preserved when returning a card to To-do with no additional content.

Malformed persisted data is a read failure. It never becomes an empty board or gets overwritten by a later save. Store files use mode `0600` because they contain prompt text and attachment bytes. The store validates saved card shapes and duplicate ids as well as incoming content.

Stored stages describe the board's saved intent. The UI derives Queued and Building from the project queue and live OpenCode status, and uses actual assistant/idle history for Plan and Done. Changing a model or agent selector alone does not change a card's lane. Parking a card sets `updatedAt`; a later real turn overrides that parking marker.
