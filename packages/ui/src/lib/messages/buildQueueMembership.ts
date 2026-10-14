/**
 * Who belongs in the project build queue.
 *
 * Membership is a property of the session's own mode, not of the composer's
 * agent. The composer's agent is global fallback state: a Plan session left on
 * the default Build agent would otherwise have its prompt flagged as a queued
 * build and appear in the project queue under a chat the pane cannot even name.
 */
export function isBuildQueueSessionAgent(sessionAgent: string | null | undefined): boolean {
    return sessionAgent?.toLowerCase() === 'build';
}

export function shouldQueueAsBuild({ buildQueued, serverOwnedQueue, sessionAgent, directoryEnabled }: {
    buildQueued: boolean;
    serverOwnedQueue: boolean;
    sessionAgent: string | null | undefined;
    directoryEnabled: boolean;
}): boolean {
    if (buildQueued) return true;
    return serverOwnedQueue && isBuildQueueSessionAgent(sessionAgent) && directoryEnabled;
}
