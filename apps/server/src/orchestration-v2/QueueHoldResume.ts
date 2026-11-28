import { CommandId, type RunId, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * A provider-failure hold leaves the queue waiting for a person. A held queue after a
 * transient provider error waits for nobody: these retries re-attempt the start the way
 * `retryContinuationStart` retries a cut continuation, then leave the hold for the user.
 */
export const QUEUE_HOLD_RETRY_DELAYS_MS = [30_000, 120_000, 300_000];

// The ladder restarts after each completed run, so a thread keeps its retries for later failures.
export const queueHoldRetryEffectId = (
  threadId: ThreadId,
  lastCompletedRunId: RunId | undefined,
  attempt: number,
) => `effect:queue-hold-retry:${threadId}:${lastCompletedRunId ?? "none"}:${attempt}`;

/**
 * The retry effect for a queue this command just held on a provider failure. The caller
 * counts the attempts already spent on this hold (the effect ids are deterministic) and
 * passes the next one; past the ladder the hold waits for a person, as designed.
 */
export const queueHoldRetryEffect = (input: {
  readonly threadId: ThreadId;
  readonly failedRunId: RunId | undefined;
  readonly lastCompletedRunId: RunId | undefined;
  readonly attempt: number;
  readonly now: DateTime.Utc;
}) => ({
  id: queueHoldRetryEffectId(input.threadId, input.lastCompletedRunId, input.attempt),
  commandId: CommandId.make(
    `command:system:${queueHoldRetryEffectId(input.threadId, input.lastCompletedRunId, input.attempt)}`,
  ),
  threadId: input.threadId,
  request: {
    type: "queue-hold.retry" as const,
    attempt: input.attempt,
    ...(input.failedRunId === undefined ? {} : { failedRunId: input.failedRunId }),
  },
  availableAt: DateTime.add(input.now, {
    milliseconds: QUEUE_HOLD_RETRY_DELAYS_MS[input.attempt - 1] as number,
  }),
});
