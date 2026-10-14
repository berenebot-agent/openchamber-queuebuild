import { describe, expect, test } from 'bun:test';
import { isBuildQueueSessionAgent, shouldQueueAsBuild } from './buildQueueMembership';

describe('isBuildQueueSessionAgent', () => {
    test('accepts the Build agent regardless of casing or padding', () => {
        expect(isBuildQueueSessionAgent('build')).toBe(true);
        expect(isBuildQueueSessionAgent('Build')).toBe(true);
    });

    test('rejects other modes and unknown sessions', () => {
        expect(isBuildQueueSessionAgent('plan')).toBe(false);
        expect(isBuildQueueSessionAgent('architect')).toBe(false);
        expect(isBuildQueueSessionAgent(null)).toBe(false);
        expect(isBuildQueueSessionAgent(undefined)).toBe(false);
        expect(isBuildQueueSessionAgent('')).toBe(false);
    });
});

describe('shouldQueueAsBuild', () => {
    const base = { buildQueued: false, serverOwnedQueue: true, sessionAgent: 'build', directoryEnabled: true };

    test('queues a Build session on an enabled project', () => {
        expect(shouldQueueAsBuild(base)).toBe(true);
    });

    // The regression: a Plan session whose composer still sat on the default
    // Build agent must not have its prompt flagged as a queued build.
    test('leaves a Plan session out even when the composer agent was Build', () => {
        expect(shouldQueueAsBuild({ ...base, sessionAgent: 'plan' })).toBe(false);
    });

    test('requires the project to have opted in', () => {
        expect(shouldQueueAsBuild({ ...base, directoryEnabled: false })).toBe(false);
    });

    test('requires a server-owned queue', () => {
        expect(shouldQueueAsBuild({ ...base, serverOwnedQueue: false })).toBe(false);
    });

    test('honours an explicit build request without the mode or opt-in', () => {
        expect(shouldQueueAsBuild({
            ...base, buildQueued: true, sessionAgent: 'plan', directoryEnabled: false, serverOwnedQueue: false,
        })).toBe(true);
    });
});
