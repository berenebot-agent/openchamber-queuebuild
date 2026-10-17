# Work board server module

The work board stores prompt cards in `work-board.json` under the OpenChamber data directory. It is server-owned state, separate from the message queue. Writes run serially within the server process and publish through a same-directory temporary file and atomic rename. A failed write leaves the prior board file in place.

The store keeps the parsed card list of the last successful read in memory (`createWorkBoardStore`). Only this store process writes the file, so that list stays valid until a write replaces it, and a successful write makes the new list the one every later read sees. Without it every request re-parses the whole file, attachments included, and a card list can approach 50 MiB. A first read that finds malformed data is still a read failure: it caches nothing, so the failure never turns into a remembered empty board, and a later write cannot replace the file with a guess.

The authenticated API is registered before the generic OpenCode proxy:

- `GET /api/work-board?directory=<path>` returns `{ cards }` scoped to the resolved directory. Optional `sessionId` filters by the linked session, independently of its worktree directory. The session view uses this filter to restore saved briefs without reading unrelated attachment payloads. Omitting both filters returns the full list. Supplying both applies both filters.
- `POST /api/work-board` accepts `{ directory, text, attachments }` and returns `{ card }` with status 201.
- `POST /api/work-board/sessions/:sessionId/todo` accepts `{ directory, sessionDirectory?, text, attachments }` and returns `{ card }`. The board directory and the session's worktree directory may differ. The queue runtime rejects queued, active, or uncertain work and holds queue dispatch while checking idleness and saving.
- `PATCH /api/work-board/:id` accepts `text`, `attachments`, `sessionId`, and/or `stage`, plus optional `expectedUpdatedAt`, and returns `{ card }`. When the expected version is stale, it returns 409 without changing the card. A client can offer the current card and retry an explicit overwrite against its new `updatedAt`.
- `PATCH /api/work-board/:id` also accepts `removeBrief: true`, alone, on a card that already links a session. It clears the text and attachments and stamps the card `briefRemoved`, so the board keeps its card and the session keeps its lane without the brief. The session view hides that entry, and parking the session again replaces the card with a fresh brief. Removal leaves `updatedAt`, `completedAt` and `viewedAt` alone, because the board's lane and completion rules read them. A content write against a removed brief is a 409.
- `PATCH /api/work-board/:id/viewed` acknowledges the card's current completion and returns `{ card }`. It is the only writer of `viewedAt`, requires no body, and leaves `updatedAt` alone so the completion's stale check still compares against the last real change. An unknown card is a 404; a card with nothing to acknowledge is returned unchanged. The acknowledgement lives on the server, so every client sharing the board clears the mark together.
- `POST /api/work-board/:id/placement` accepts `{ lane, at, before?, directory?, sessionId?, text? }` and returns `{ card }`. `lane` is `todo`, `plan`, `build`, or `done`. `before` names the card the moved one now sits in front of, `null` puts it at the end of the lane, and omitting it leaves that lane's stored order alone. `directory`, `sessionId`, and `text` are the identity of an inherited card the board has no record for yet: its first placement creates the card, exactly as its first completion did, and any later placement of the same session's derived id is a 404 rather than a duplicate. A drag writes the board and nothing else: it never starts a turn, and it cannot put a card into or take one out of the build queue.
- `DELETE /api/work-board/:id` removes the card and returns `{ ok: true }`.
- `POST /api/work-board/placement` accepts `{ directory, lane, at, targets }`
  and returns `{ placed, failed }`, the bulk form of one placement. Each target
  carries `id`, `updatedAt`, `text`, and optional `sessionId`; a target whose
  stored `updatedAt` no longer matches, or whose id belongs to another project, is
  failed with a 409 rather than overwritten. Cards are placed independently, so
  one conflict does not block the rest.

A card has `id`, `directory`, `text`, `attachments`, `createdAt`, `updatedAt`, and `stage`. `sessionId`, `completedAt`, `viewedAt`, `placementAt`, and `placementOrder` are optional. Stages are `todo`, `plan`, and `done`. Existing version 1 files remain readable without conversion. An attachment has `id`, `filename`, `mimeType`, `size`, and a validated base64 `dataUrl`. Text or at least one attachment is required. JSON bodies are limited to 50 MiB. The server checks base64 syntax, MIME consistency, and decoded size.

Only a placement can write `done`; generic PATCH cannot bypass the idle guard. Placement preserves saved text and attachments. Stored card ids,
directories, session links, and `updatedAt` must still match, and an inherited
session uses `session:<sessionId>` as its target id: the store creates its durable
card on first placement, and an existing link prevents a duplicate. A bulk target
whose `updatedAt` no longer matches, or whose id belongs to another project, is
reported as a failure rather than overwritten, and the remaining cards in the
batch are still placed. The server sets `completedAt` when a card first reaches
Done; later submitted turns override this saved intent.
Returning to To-do clears the completion timestamp and any acknowledgement of it.

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

Stored stages describe the board's saved intent. The UI derives the Build queue lane from the project queue and live OpenCode status, and uses actual assistant/idle history for Plan and Build complete. Changing a model or agent selector alone does not change a card's lane. Parking a card sets `updatedAt`; a later real turn overrides that parking marker. Done ordering uses the card's manual completion timestamp, never the session's last update; a lane the user has arranged falls back to that order, and anything the arrangement does not name follows at the end.

A card's lane is the queue first, then the user's own placement, then the session's own history. `placementAt` is the moment of the drag and `placementOrder` is the card's position within its lane; a real turn in the session or a queue lease that starts later outranks both, so the card returns to the lane its work belongs in and only a later drag moves it again. Build complete holds every Build turn that has settled: an idle Build session is finished history, and only a manual move puts its card in Done. The board's Build complete lane is a view of that state; it is not a stored stage.

The Build queue column renders server queue entries and live Build sessions in
the board's scope that have no queue entry. Queue entries take presentation
precedence for their session; a live-only build has no queue mutation controls.
The column count follows rendered rows, including entries without board cards.
