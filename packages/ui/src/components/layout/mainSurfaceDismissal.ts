/**
 * When a full-page surface gives way to the chat behind it.
 *
 * The board, the archive and the other main pages cover the chat. The user
 * leaves one of them by picking a session or by asking for a new session in
 * the chat, and the layout closes the surface so the chat shows.
 *
 * The chat also opens a draft by itself when nothing is selected, which is not
 * the user asking to leave. That happens when the session behind the surface
 * goes away: the board's own Archive or Delete clears the chat's selection,
 * and the chat fills the empty space with a draft of its own. The surface
 * stays, because the user is still working on it.
 */

/** The part of the session state this rule reads. */
type SurfaceDismissalState = {
  currentSessionId: string | null
  newSessionDraft: { open: boolean; automatic?: boolean } | undefined
}

/**
 * True when the change from `previous` to `next` is the user moving to the
 * chat, so the full-page surface over it closes.
 *
 * A selected session is the user picking one. A draft the user opened is the
 * user asking for a new session. The chat's own fallback draft is neither: it
 * only fills a chat that has nothing selected, so the surface stays.
 */
export const surfaceShouldDismiss = (
  next: SurfaceDismissalState,
  previous: SurfaceDismissalState,
): boolean => {
  const sessionSelected = Boolean(next.currentSessionId)
    && next.currentSessionId !== previous.currentSessionId
  // Draft identity change covers re-opening a draft while one is already
  // open (the boolean alone never transitions then).
  const draftOpened = Boolean(next.newSessionDraft?.open)
    && next.newSessionDraft !== previous.newSessionDraft
  const draftIsNavigation = draftOpened && next.newSessionDraft?.automatic !== true
  return sessionSelected || draftIsNavigation
}
