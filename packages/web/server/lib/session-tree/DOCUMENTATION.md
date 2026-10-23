# Session tree context

## Ownership

This module records a checkout baseline when a session's whole turn ends and
describes it at Build dispatch. The baseline belongs to the session and its
directory, across Plan and Build agent changes. Git supplies HEAD, branch,
status and committed path changes; content fingerprints distinguish dirty
files whose contents change without their status changing. No file contents
or patches enter the prompt.

The message queue owns dispatch timing and the serialization sentence.
`session-knowledge` continues to own standing instructions; it does not send
this build summary during submission. Existing submission-time instruction
updates and attached context are unchanged.

## Invariants

- A completion baseline requires known-idle session, descendant and background
  shell activity. A parent waiting for a subagent is not complete. A newer busy
  event or runtime reset cancels an in-flight capture.
- Baselines are per session and directory, with the canonical repository root
  checked before comparison. The queue's selected repository applies inside
  the project; outside worktrees use their own repository.
- The queue waits for a pending completion capture before Git preparation.
  It reads the startup summary after preparation, immediately before admitting
  the build preamble and user prompt. Enqueueing does not read or inject it.
- HEAD and status are checked again after fingerprinting. A failed or moving
  checkout read omits the summary, never claims a clean tree. An unavailable
  baseline omits the delta without a missing-baseline notice.
- Each path list shows at most 30 entries and counts omitted paths. Paths and
  branch names are JSON-quoted to escape newlines and other unusual characters.
  Dirty paths retain Git's two-column staged/unstaged status; committed renames
  are reported as deletion plus addition. Changes carry no ownership claim.
- Dirty baselines require complete fingerprints. At most 1,000 dirty paths and
  32 MiB of file content are read per snapshot. Larger trees and dirty submodules
  keep their status summary but have no delta baseline. Symlink targets are
  never opened; only the link value is fingerprinted.
- Baselines are bounded to 500 session/directory pairs, in memory only. A server
  restart or OpenCode runtime reset loses them. The next completed turn restores
  a baseline. Git reads never stage, commit, reset or otherwise alter user work.

## Decisions

### Why session baselines rather than a directory timestamp

Another session completing in the same checkout must not advance this session's
baseline. Comparing Git snapshots also catches committed changes, deletions and
dirty-content edits that timestamps or two status maps alone miss.

### Why one dispatch-time synthetic rather than a standing tree instruction

A queued build may wait through several other commits. Its tree facts must be
read after queue preparation and travel once with the build, rather than appear
at submission and become stale. The existing build preamble carries both the
facts and, only after an actual queue hold, the shortened serialization sentence.

## Runtimes

- Web uses the server queue's summary.
- Electron uses the same in-process server queue.
- Hosted mobile receives the same server-owned dispatch context.
- Capacitor mobile receives it from its connected server.
- VS Code's UI-owned queue is unchanged and does not produce this server summary.
