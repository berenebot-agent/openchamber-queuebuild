# Work board (shared UI)

The work board is a full-surface React view over the server's work-board
projection. It renders lanes, cards, the queue column and every control; it does
not classify sessions itself.

## Ownership

- `WorkBoardView.tsx` — the view: tabs, lanes, drag-and-drop, card editing,
  queue rows, the project queue toggle, and the recovery dialogs. Its `mobile`
  prop renders the same board as a one-lane phone view for the mobile shells.
- `workBoardMobileLane.ts` — the last lane the phone showed, remembered per
  client and connected server.
- `workBoardWorkflow.ts` — pure helpers: lane ordering within a drop, feedback
  wording, queue rows/entries, tab badges, and the readers that adapt a server
  snapshot into what the view renders (lane, order, queue state).
- `workBoardSnapshot.fixture.ts` — a test fixture that builds a snapshot the way
  the server projection does.
- `WorkBoardProjectTabs.tsx`, `workBoardProjectState.ts` — project tab strip and
  the project's display name.
- `SavedTodoBrief.tsx`, `SessionSavedTodos.tsx`, `useSavedTodoComposer.ts`,
  `workBoardSavedTodo.ts` — the saved-brief surfaces shared with the chat
  composer and the session transcript.
- `lib/workBoardApi.ts` — the HTTP contract: stored cards, placements, viewed
  acknowledgement, the projection snapshot, and the project queue settings.

## The projection is the source of truth

The board renders `GET /api/work-board/snapshot` through `useWorkBoardSnapshot`
(`hooks/useWorkBoardSnapshot.ts`). The snapshot carries each card's effective
lane, each lane's order, live activity per session, the ask each session waits
for, and the queue's own state
(rows, positions, running lease, forced builds, issue, enablement). The client
therefore never:

- polls a history timer — the server derives live activity and history once;
- classifies a session's lane from messages — the server owns the precedence
  (queue, then placement, then history);
- infers a completion order — the server already ordered each lane.

The hook re-reads on the server's `build-queue-updated` and
`work-board-updated` events, on the tab becoming visible, and when the control
stream reconnects. A failed read keeps the last snapshot and reports the error;
it never replaces the board with an empty one.

## Writes and the boundaries they must not cross

Every write goes to the server: placements (`placeWorkBoardCard`,
`placeWorkBoardCards`), edits, removal, viewed acknowledgement, save-to-to-do,
and the queue's own routes. A drag writes the board and nothing else: it never
starts a turn, and it can neither put a card into nor take one out of the build
queue. The queue column's rows are the only queue-mutation surface.

Cancelling a waiting build keeps its prompt. The cancel route answers with the
removed item, and the board hands its text and file references to that session's
draft through `input-store.adoptPrompt` (appended, never replacing the draft),
then says so with an info toast. Only the text and files travel: a queued build
captures no chips. A build whose session cannot be resolved still cancels.

Placements are stamped by the server's clock, and each one carries the card
version the client read, so a change made on another device between the read and
the write is a 409 the board reports instead of an overwrite.

Moving a card to or from Done also syncs the linked session's Done/In-work
state (`setSessionWorkState`). That write is separate and best-effort: the card
is placed even when the session write fails, and the failure is reported on its
own rather than rolled back, so a partial failure is visible.

## Ambiguous Force

A build forced outside the queue whose prompt was not confirmed is ambiguous: it
may or may not have started. The projection names that state (`needsReview`, the
targeted `itemId`, a recovery `action`); the board shows it with the error
treatment and a recovery control (`Continue queue` → the queue's resolve route).
It is never rendered as an ordinary running build, and never left without a way
to resolve it. A plain forced build stays display-only.

## Project queue toggle

The board owns the project's queue enablement (`Queue on` / `Queue off`), read
from and written to `GET`/`PUT /api/build-queue/settings`. The toggle is
optimistic and reverts on a failed write. Default is enabled. The Git policy
selector is not here: it lives in Settings → Work board.

## Mobile presentation

`WorkBoardView` takes a `mobile` prop for the hosted-mobile and Capacitor
shells, which mount it from the sessions drawer. The board reads the same
snapshot, writes through the same routes and keeps every action. Only the
presentation changes. It shows one lane at a time behind a lane picker whose
counts match the lane it opens, replaces the tab strip with a project selector,
moves the queue rows' actions into a touch-sized menu, and scrolls vertically.
The lane picker remembers the last lane per client and connected server in
`workBoardMobileLane.ts`, and opens on the queue lane when nothing is stored or
storage is blocked.

The `onLeave` prop dismisses the board. The mobile shells draw the board over
the chat, so opening a session or starting a draft calls it; the desktop shells
pass nothing and close the board surface as before.
