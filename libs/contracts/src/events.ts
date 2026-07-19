/**
 * Fire-and-forget event names (emitted via `ClientProxy.emit`, not `send`).
 *
 * Kept separate from RPC patterns in `patterns.ts` on purpose: an event has no
 * caller waiting on a reply, so adding a new subscriber is a safe change while
 * changing an RPC signature is a breaking one. Mixing them in one file makes
 * that distinction easy to lose.
 *
 * Naming convention: `<resource>.<past-tense-verb>`
 */

export const EVENTS = {
  SERVICE_STARTED: 'service.started',
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];
