# Work board

The work board groups project work into To-do, Plan, Build queue, and Done.
The existing Build queue panel remains available while a session is open.
Open it from the **Work board** button in the session sidebar header. Project
tabs across the board header switch between project boards. Choose **+** beside
the tabs to add another project tab, or close a tab to hide it from the board.
Tabs drag into a new order, and the selected one is drawn as a rounded rectangle
joined to the board below it. Closing a tab does not remove its project or
cards. The open tabs, their order, and the selected project are
saved per runtime and restored when the app restarts. The board includes saved
To-do cards and the selected project's top-level sessions in its root
directory. Worktree directories retain their own Build queues.

Choose **+** in the To-do column header to start a card. It opens a composer already set to
**To-do**, so the brief saves instead of running a model, and the To-do chip is
highlighted while that mode is active. A board the user has opened keeps a
**Work Board** button beside the chat in every session, which returns to the
board's last project.
The **+** button in Plan opens a fresh composer for the board's project with the
Plan agent selected. In the Build queue column, **New Build session** sits where
the running build would be and opens a fresh composer with the Build agent
selected. Nothing runs until submission. Build submissions enter the existing
queue and appear in the Build queue column.

The Build queue column is the project's queue, not a copy of it. The build the
project is running now sits at the top, under a gap, and the builds waiting sit
below it in the order the queue will dispatch them. That running build is the
only card on the board that carries a moving diagonal band, so work in progress
reads apart from work that is merely waiting. A build the server has parked for
review keeps its error treatment instead, because it is not running.
Hovering a waiting row reaches the same controls the Build queue panel offers:
move up, move down, pause or resume, and cancel. Each one writes to the queue and
the column redraws from the refreshed snapshot.
The column lists every queued build for the project, including one the board has
no card for, so it never shows a shorter queue than the project actually has.
Rows act on the queue's own order, so a move keeps the builds the board cannot
see. A queued build with no board card has no card action: it is queue work.

Cards come in two sizes, and the size says which state the card is in, not which
lane it sits in. A card that is being worked, waiting to be worked, or asking for
the user takes the larger box; everything else stays compact. So the running
build, the waiting rows, a plan turn that is running now, and a card showing
**Needs attention** are one height, and a settled card in To-do, Plan or Done is
the other. Every card of a size reserves one line for the status it may show, so
a card gaining or losing a notice, a loading line or a review warning keeps the
height it had, and a card never moves because a status arrived. A card that needs
the user is tinted, not just worded: the card itself carries the amber treatment,
while a plan turn that is still running keeps its own green treatment, because
work in progress outranks a notice. The running build card keeps its band and its
blue fill, and a working plan card keeps its green band.

Live Build sessions in the board's scope also appear above the waiting rows when
they have no server queue entry. These sessions offer Open session only; queue
pause, reorder, and cancel controls apply only to waiting queue entries. A session
that gains a queue entry uses that entry's row without a duplicate live card.
The column count includes the running lease, waiting entries, and these live
builds. Project-tab badges continue to count server-managed queue work only.

A waiting build can be forced to start now, outside the queue. Its row in the
Build queue pane and on the board carries a **Force** control that confirms
first, because the build starts in parallel with whatever the project is already
running. A forced build is not part of the queue: it takes no lease, waits for no
project order, skips the Git policy, and the queue does not wait for it. It
leaves the queue and appears above the waiting rows marked **Outside queue**
while it runs, then settles like any other finished build.

While the board is open it owns the top of the window: the header shows
**Work board** with a back button, instead of the last opened session's title.
Sessions live inside a board, not the other way around.

The board is a page, so it is part of the URL: opening it writes
`?board=<projectId>`, and switching project tabs while it is open rewrites that
id. The session id stays out of the URL while the board is open, because the
board covers the chat. A reload therefore returns to the board on its last
project instead of reopening a chat nobody was looking at, and a launch that
carries a board link does not restore the last session. Closing the board drops
the parameter, and the URL names the chat again.

Each project tab in that header carries the project's build load, so the open
tabs read as an overview of which projects are building without switching
between them. A blue spinner counts every build in that project's queue — the
running one plus everything waiting — so one running build already reads as
one, and a build can never be hidden inside a total that looks idle. A project
with an empty queue shows no mark at all, never a zero. The spinner follows the
appearance setting for animated activity indicators, like the marks in the
session list. When the queue state cannot be read, that project's tab shows an
amber exclamation instead, so an unreachable queue is never mistaken for an
idle project.

## Save a to-do

Write the initial brief in the chat composer and attach files, then choose
**To-do** in the agent picker and submit to save. The text and files are saved
on the OpenChamber server. Saving a new-session draft does not create an
OpenCode session or call a model. Saving from an existing idle session links
the card to that conversation. Remove queued messages and wait for active work
to finish before parking an existing session. The composer clears only after
the server confirms the save. If the session becomes busy while To-do is
selected, its notes stay in the composer and cannot be queued for execution.

Saving a new-session draft returns to that project's board with a
**Saved to To-do** dialog showing the full saved text and attachment downloads.
Saving in an existing session keeps that session open. Its saved brief appears
at the end of the transcript in a **Saved to To-do** entry, including after
reopening the session or refreshing the page. Existing linked cards also appear
there, but only while they are still To-do. The entry is a pending message: once
a card is promoted, its text is a real user turn in the transcript, so the footer
stops echoing it to avoid showing it twice. Returning a card to To-do brings the
entry back. The entry reads the server card, so edits and removal of that card
also change what is shown in the session. It is not an OpenCode user turn and
does not send context or start a model.

Session entries are scoped by session ID, including when the session lives in a
worktree and its card belongs to the root project's board. A failed read keeps
the last loaded text visible and offers **Try again**. Session and runtime
changes discard reads that finish for the previous session or server.

### Edit, plan or remove a saved brief in the session

Web and Electron desktop, including a chat pinned in the side panel, show three
actions on that **Saved to To-do** entry. The dedicated mobile and VS Code
composers keep the read-only entry.

**Edit brief** loads the saved text and files into the composer with the existing
draft and attachments already there, and selects **To-do**. Submit with
**Update to-do** to save the combined text and files back onto the same card. No
message is sent and no second card is created. **Cancel** restores the draft,
attachments and agent you had before, and leaves the card unchanged. A stale
save is refused: reload the board or session and try again.

**Plan** loads the same combined draft and selects the Plan agent. Your existing
draft stays in front of the saved text, and Cancel restores everything as it
was. Nothing is sent until you submit. Once the message is accepted the card
moves to Plan and its session entry here disappears. If you switch to another
agent before submitting, the to-do still travels with that message: the card
follows the agent you chose, so a Build submit through the project build queue
moves the card to Build queue once the queue accepts it. If the send fails, the
card stays to-do and your draft comes back. If the message was accepted but the
board write failed, the entry says so and offers **Try again**, which updates the
board without sending anything again. Cancelling a queued build does not bring
the to-do back.

**Remove to-do** asks for confirmation, then deletes the saved brief everywhere.
The session, its chat history and its board lane are untouched, and its board
card stays as a session card. The text cannot be restored; saving a new to-do
from that session creates a fresh brief.

To-do cards live on the board. They do not add empty sessions to the sidebar.

## Start planning

**Start Plan** creates a Plan session and submits the card's text and files as
its first prompt. The card retains its saved contents and links to the session.
Opening a linked card takes you to its chat.
The board starts the Plan turn on the model the Plan agent would use in a fresh
chat, resolved through the usual defaults. The board has no model picker; to run
a particular model, open the card's session and change it in the chat composer.
Auto routing is unavailable for promotion because it may select a different
agent.
Edit an unstarted card on the board to change its text, add files, or remove files.

If session creation or submission fails, the saved brief remains available.
A card that already links to a session must be inspected before attempting
another submission. A lost response can mean the original prompt was accepted.

## Continue work

By default, automatically inherited session cards include only sessions updated
in the last 30 days. Running sessions, sessions with running background commands
or subagents, and queued sessions remain included regardless of age. Saved board
cards always remain visible. The filter runs before per-session history reads.

Use **Include older sessions** in the board header to show the older inherited
sessions too. The choice is saved locally per runtime and project directory and
defaults to off. It does not archive or delete sessions, or change the sidebar's
global session list.

Switching projects retains card previews, column placements, completion ordering
and compact history summaries in memory, scoped to the runtime and directory.
Attachment bytes, full briefs and unused history metadata do not enter the cache.
Returning restores the last columns while current status loads. Histories whose
session update times are unchanged are reused after a fresh idle check. Running
sessions, previously running histories, changed versions and missing versions
require a new history read.

The cache keeps up to 8 boards and 4 MiB of projected payload. Boards whose
previews exceed that limit take the first-load path again. Reloading the app
clears this memory cache. Editing and promotion wait for the server to restore
full briefs and attachment bytes.

Restored history provides display continuity only. Running flags are checked
again, and card mutations wait for fresh board and activity checks. A pending
check shows Loading; a failed check shows Status unavailable and preserves the
last known history. Idle checks and queue guards still run on the server before
linked cards can be completed or parked.
Previously running cards retain their last column while checking. Their preview
shows no running animation or Active label until live state confirms execution.

Build submissions use the existing project Build queue. Waiting and active work
is shown using the queue's server state. Open the session and choose the Build
agent to submit implementation work through the normal composer. A linked card
follows the agent of its last assistant turn: a Build turn that is not running
puts the card in Done, whether that turn succeeded, failed, or was stopped,
because no work is running and the session is history. Done does not certify
tests or a release. A card whose last turn was Plan stays in Plan, however it
ended. Linked cards show the same live activity icons as the session list,
including background subagents and commands. The appearance setting for
animated activity indicators applies to cards too. Finished unread turns show
the session list's unread icon.

A build the queue still holds for review is the one exception. It stays in the
Build queue column until the user resolves the lease, because the server will
not release that lease on its own and the card must not leave the lane behind
it. The card offers no Move to Done, Back to To-do, or remove action while that
lease is unresolved.

Lanes follow a card's saved stage and live state, so the board reads each linked
session's history to place it. It reads every linked card's history at once, and
reuses a card's history while its session has not been updated and no turn is
running, rather than re-reading settled cards on every poll. A card whose session
history has not yet arrived keeps the lane its saved stage implies.

The project queue outranks that history. A session the server has queued for a
build sits in the Build queue column even while its last assistant turn was
Plan, which is the usual shape of a Plan session the user follows up with a
Build prompt. The board asks the server's queue first, so the card is placed
when the build was submitted rather than when its first Build turn starts
streaming. A queue read that fails is not "nothing queued": the card falls back
to its history until the queue can be read again.

The board re-reads the queue when the server announces a change, so a submitted
build reaches the column immediately. Its timed refresh remains as the fallback
for a missed event.

Failed or stopped unread turns show an attention notice. Opening the session
from the board or session list clears that notice and the unread icon. Another
unread failed or stopped turn can show the notice again. Build-queue recovery
warnings remain until resolved, even after opening the session.
An unavailable status stays visible as an error and is never treated as proof
of completion.
Cards retain these notices below their titles, in the one line every card
reserves for status. A card carrying a notice takes the larger card size and the
amber treatment on the card itself, so it reads as a problem card rather than an
ordinary card with unusual text. Linked-card removal
and return actions wait for known session and queue state.

Returning an idle card to To-do preserves the linked conversation and saved
brief. It does not revert files or delete session history.
Submitting another Plan or Build prompt returns the card to the corresponding
lane. Changing the composer agent without submitting does not move it.

## Complete cards

Done is sorted by the last Build turn's finish time, newest first.
Session creation dates and unrelated session updates do not affect this order.

An idle To-do or Plan card offers **Move to Done** in its card menu. This also
works for inherited sessions that have never been saved as board cards. Manual
completion is saved on the server and uses its completion time for Done ordering.
Submitting a later Plan or Build prompt reopens the card. Completion preserves
the conversation and never starts, stops, or cancels work. A card whose build the
queue is still holding for review offers no completion action at all.

A finished card shows the session list's green checkbox until the user opens the
card, which acknowledges that completion on the server and clears the mark for
every client sharing the board. A card that is completed again, or manually moved
to Done again, marks itself again without any reset step. A card returning to
To-do drops the acknowledgement along with the completion.

The three-dot menu beside Plan's **+** offers **Move all cards to Done**.
The confirmation lists the cards and their count for the selected project.
Busy cards and cards with unavailable status are excluded, with their count
shown. The server rechecks idleness and saved-card revisions before each move.
If some moves fail, successful moves remain saved and the board reports the
failed cards. Refresh before retrying cards that changed during confirmation.

## Supported interfaces

Web and Electron desktop display the existing four-column Work Board.
Hosted mobile and Capacitor Android/iOS now expose the same board from the
sessions drawer, using the shared WorkBoardView state, card actions and
server APIs. The phone/tablet version shows one lane at a time, a project
selector, lane counts, a queue enable switch and touch-friendly queue actions.
New To-do drafts can be saved from the shared mobile composer. Selecting a
session from the board dismisses the mobile surface, returning to chat.
VS Code still does not expose the board or use the server-owned queue.

The project's Build queue enablement is persisted on the OpenChamber server
inside the existing message-queue state file, instead of being independently
chosen by each browser profile. The first successful preference refresh
migrates legacy local enabled flags into any previously unconfigured server
projects, without overriding explicit server settings. The server also tags
Build-agent messages submitted to the shared message-queue API as managed
builds when the project is enabled, even if the client carries stale flags.
Web, Electron and mobile composers refresh this server setting before an
ordinary Build submit and refuse to bypass it when the server cannot confirm
the current setting.

**Scope limitation:** An external client that sends directly to the OpenCode
prompt API does not pass through the OpenChamber message queue. Explicit
steering into an active session and Force Build also remain outside ordinary
serial dispatch. These are not silently intercepted by this change.
Stored cards belong to the OpenChamber server and are available to other
browser profiles connected to that server.
The board refreshes stored cards on focus, after writes, and every 30 seconds
while visible. Activity icons subscribe to the session list's live status index.
Lane classification also checks turn status every 5 seconds. History reads are
bounded and cached until the session changes.
