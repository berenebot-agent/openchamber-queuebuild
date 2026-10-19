# Work board

The work board groups project work into To-do, Plan, Build queue, Build complete,
and Done, and is the one surface a project's Build queue is managed from.
Open it from the **Work board** button in the session sidebar header. Project
tabs across the board header switch between project boards. Choose **+** beside
the tabs to add another project tab, or close a tab to hide it from the board.
Tabs drag into a new order, and the selected one is drawn as a rounded rectangle
whose base curves out into the board below it. Closing a tab does not remove its
project or cards. The open tabs, their order, and the selected project are
saved per runtime and restored when the app restarts. The board includes saved
To-do cards and the selected project's top-level sessions in its root
directory. Worktree directories retain their own Build queues.

Choose **+** in the To-do column header to start a card. It opens a composer already set to
**To-do**, so the brief saves instead of running a model, and the To-do chip is
highlighted while that mode is active. Clicking an existing To-do card opens it
in a composer with its brief as the draft (see *Edit a to-do*). A board the user
has opened keeps a
**Work Board** button beside the chat in every session, which returns to the
board's last project.
The **+** button in Plan opens a fresh composer for the board's project with the
Plan agent selected. In the Build queue column, **New Build session** sits where
the running build would be and opens a fresh composer with the Build agent
selected. Nothing runs until submission. Build submissions enter the existing
queue and appear in the Build queue column.

The Build queue column is the project's queue, not a copy of it. The build the
project is running now sits at the top, under a gap, and the builds waiting sit
below it in the order the queue will dispatch them. A build that leaves a
background command running keeps the queue on its session after its turn ends,
because OpenCode resumes that session when the command exits; the next queued
build waits until then. That running build is the
only card on the board that carries a moving diagonal band, so work in progress
reads apart from work that is merely waiting. A build the server has parked for
review keeps its error treatment instead, because it is not running.
Hovering a waiting row reaches the queue's own controls:
move up, move down, pause or resume, and cancel. Each one writes to the queue and
the column redraws from the refreshed snapshot. Cancel also hands the build's
prompt back: its text and file references go into the draft of the session that
held it, appended after whatever that draft already holds, and the board says so.
Nothing the user typed is lost, even when that session is not the one on screen.
The column lists every queued build for the project, including one the board has
no card for, so it never shows a shorter queue than the project actually has.
Rows act on the queue's own order, so a move keeps the builds the board cannot
see. A queued build with no board card has no card action: it is queue work.

The pause button in the Build queue column header pauses that directory's whole
queue, including new Build entries submitted afterwards. Prompts and attachments
stay queued in order. The running build continues. The button also works with an
empty queue, and its state is shared across clients and survives server restart.
Pausing every row individually does not pause the queue. Resuming the queue
preserves individual row pauses; resuming a row cannot bypass a paused queue.
Worktree queues keep their own pause state. Force still starts a build outside
the queue after confirmation.

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
they have no server queue entry. A live Build the queue has adopted as the
project's active build holds the lane — a queued build waits for it — and shows
as the running build rather than as a separate live row. The remaining live
sessions offer Open session only; queue pause, reorder, and cancel controls apply
only to waiting queue entries. A session that gains a queue entry uses that
entry's row without a duplicate live card. The column count includes the running
lease, waiting entries, and these live builds. Project-tab badges continue to
count server-managed queue work only.

A waiting build can be forced to start now, outside the queue. Its row on the
board carries a **Force** control that confirms
first, because the build starts in parallel with whatever the project is already
running. A forced build is not part of the queue: it takes no lease, waits for no
project order, skips the Git policy, and the queue does not wait for it. It
leaves the queue and appears above the waiting rows marked **Outside queue**
while it runs, then settles like any other finished build. If its prompt cannot
be confirmed, the row says so and offers to resolve the uncertainty rather than
reading as running; that state survives a server restart.

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

A tab also carries what needs the user's answer in that project, even while it
is not the open one: a question mark when a session waits on a question, and a
shield when one waits on a permission. The marks are independent, so a tab can
show a question, a permission and its build load at once, and a project with
nothing waiting shows none. Both reuse the session list's own wording.

## Save a to-do

Write the initial brief in the chat composer and attach files, then choose
**To-do** in the agent picker and submit to save. The text and files are saved
on the OpenChamber server. Saving a new-session draft does not create an
OpenCode session or call a model. Saving from an existing idle session links
the card to that conversation. Remove queued messages and wait for active work
to finish before parking an existing session. The composer clears only after
the server confirms the save. If the session becomes busy while To-do is
selected, its notes stay in the composer and cannot be queued for execution.

A save returns to that project's board, where the card is now in the To-do lane,
and confirms with a **Saved to To-do** toast. The board itself opens no dialog
over the card.

## Edit a to-do

A To-do card is edited in a composer, never on the board. Clicking the card
opens its session — or, for a card that has none, an unsaved draft rooted in the
board's project — with the saved text and files in the composer as the draft and
**To-do** selected. They are appended after whatever the composer already held,
so nothing the user typed is lost. The composer shows an **Editing saved to-do**
row with **Cancel**, which restores the draft, its files and the earlier mode.

Submit with **Update to-do** to save the combined text and files back onto the
same card; the save returns to the board, and the brief is the draft again the
next time the card is opened. A stale save is refused with a message: reload the
board or session and try again. There is no conflict dialog and no transcript
entry — the brief lives only in the composer and on the card.

**Remove to-do** in the card's actions menu deletes only the saved brief. The
session, its chat history and its board lane are untouched, and its card stays
as a session card. The text cannot be restored; saving a new to-do from that
session creates a fresh brief.

Pick the Plan or Build agent in the composer and send to promote the card
instead. The draft and the brief travel with that message, and the card moves to
the lane that agent implies only after the send is accepted; a card that had no
session is linked to the session the send creates. If the send fails, the card
stays to-do and the draft comes back. If the message was accepted but the board
write failed, the composer's status row says so and offers **Try again**, which
updates the board without sending anything again. Cancelling a queued build does
not bring the to-do back.

To-do cards live on the board. They do not add empty sessions to the sidebar
until a real prompt is sent from one.

## Start planning

**Start Plan** creates a Plan session and submits the card's text and files as
its first prompt. The card retains its saved contents and links to the session.
A card that has no session yet carries the control on the card itself, next to
its completion button, and also in the card's actions menu. Opening a linked
card takes you to its chat.
The board starts the Plan turn on the model the Plan agent would use in a fresh
chat, resolved through the usual defaults. The board has no model picker; to run
a particular model, open the card's session and change it in the chat composer.
Auto routing is unavailable for promotion because it may select a different
agent.
Opening a card loads its brief into the chat composer as the draft (see *Edit a
to-do*); to promote it, pick the Plan or Build agent there and send.

If session creation or submission fails, the saved brief remains available.
A card that already links to a session must be inspected before attempting
another submission. A lost response can mean the original prompt was accepted.

## Continue work

By default, automatically inherited session cards include only sessions updated
in the last 30 days. Running sessions, sessions with running background commands
or subagents, and queued sessions remain included regardless of age. Saved board
cards always remain visible. The filter runs before per-session history reads.

Delegated work is never a card. A session OpenCode reports as a subagent's child,
or one running on a subagent-only agent, is left off the board, and a saved card
that links such a session is left off with it — a subagent run never becomes a
card of its own. An agent whose mode is unknown hides nothing.

Use **Include older sessions** on the Settings Work board page to show the older
inherited sessions too. The choice is saved locally per runtime and project
directory and defaults to on. It does not archive or delete sessions, or change
the sidebar's global session list.

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
of completion. A card whose session the server no longer has is the exception:
OpenCode has deleted it, so no later read can succeed, and the card is removed
from the board when the board next reads it rather than left unable to settle.
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
A card the user drops by hand sits where they dropped it, and only that card is
pinned: the rest of the column keeps the newest-first order, so a build that
finishes later still lands at the top. Moving a card into a column — with the
check mark, a column's **Move all cards to Done**, or a drop on the column
itself — names no place and leaves the column's own order alone.

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

The board is available in web, Electron desktop chat, hosted mobile and the
Capacitor Android/iOS shells. VS Code does not provide a board entry point and
does not request board-backed session entries.

The mobile shells open the same board from the sessions drawer, and from the
button next to the session list button in the chat header, so a session is one
tap away from the board it came from. A phone or
tablet shows one lane at a time behind a lane picker with a count per lane, a
project selector in place of the tab strip, and the queue rows' actions in a
touch-sized menu. Opening a session or starting a draft closes the board and
shows the chat. The lane picker reopens on the lane that client last used with
that server.

Stored cards belong to the OpenChamber server and are available to other browser
profiles connected to that server. The board re-reads the projection on the
server's `work-board-updated` and `build-queue-updated` events, after its own
writes, and when the tab becomes visible. A 15-second interval runs only as a
safety net for a dropped stream. Activity icons subscribe to the session list's
live status index. Lanes, order and queue state come from the projection, so the
client classifies nothing.
