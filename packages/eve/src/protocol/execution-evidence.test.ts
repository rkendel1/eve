import { describe, expect, it } from "vitest";

import { emitCancelledTurn } from "#harness/cancelled-turn-emission.js";
import { emitFailedStep, emitTurnEpilogue } from "#harness/emission.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import type { HarnessEmitFn } from "#harness/types.js";
import {
  executionEvidenceDetails,
  normalizeExecutionEvidence,
  withExecutionEvidence,
} from "#protocol/execution-evidence.js";
import {
  createTurnCancelledEvent,
  createTurnCompletedEvent,
  createTurnFailedEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";

const FULL = {
  compute: { environmentId: "env_123", executionId: "exec_789", jobId: "job_456", receiptId: "receipt_abc" },
};
const state: HarnessEmissionState = { sessionStarted: true, sequence: 17, stepIndex: 0, turnId: "turn_17" };

function recorder() {
  const events: UnstampedMessageStreamEvent[] = [];
  const emit: HarnessEmitFn = async (event) => void events.push(event);
  return { emit, events };
}
const terminal = (events: UnstampedMessageStreamEvent[], type: string) =>
  events.find((e) => e.type === type) as { data: Record<string, unknown> } | undefined;

describe("normalizeExecutionEvidence", () => {
  it("preserves authoritative identifiers exactly", () => {
    expect(normalizeExecutionEvidence(FULL)).toEqual(FULL);
  });

  it("keeps partial evidence without inventing the rest", () => {
    expect(normalizeExecutionEvidence({ compute: { jobId: "job_456" } })).toEqual({ compute: { jobId: "job_456" } });
    expect(Object.keys(normalizeExecutionEvidence({ compute: { jobId: "job_456" } })?.compute ?? {})).toEqual(["jobId"]);
  });

  it("omits empty evidence rather than emitting an empty object", () => {
    for (const input of [undefined, null, {}, { compute: {} }, { compute: { jobId: "" } }, { compute: { jobId: "  " } }, { compute: { jobId: 7 } }, { compute: "x" }, "x"])
      expect(normalizeExecutionEvidence(input)).toBeUndefined();
    expect(executionEvidenceDetails({ compute: {} })).toBeUndefined();
  });

  it("drops anything that isn't a known Compute identifier", () => {
    expect(normalizeExecutionEvidence({ compute: { jobId: "job_1", sessionId: "s", turnId: "t", workId: "w" }, other: 1 })).toEqual({ compute: { jobId: "job_1" } });
  });
});

describe("terminal events carry host-supplied evidence", () => {
  it("turn.completed", async () => {
    const { emit, events } = recorder();
    await emitTurnEpilogue(withExecutionEvidence(emit, FULL), state, "conversation");
    expect(terminal(events, "turn.completed")?.data).toEqual({ details: FULL, sequence: 17, turnId: "turn_17" });
  });

  it("turn.failed keeps its code and message, and adds the evidence", async () => {
    const { emit, events } = recorder();
    await emitFailedStep(withExecutionEvidence(emit, FULL), state, { code: "execution_failed", message: "sh: cargo: command not found", sessionId: "session_1" });
    const failed = terminal(events, "turn.failed")?.data;
    expect(failed).toMatchObject({ code: "execution_failed", message: "sh: cargo: command not found", details: FULL, turnId: "turn_17" });
  });

  it("turn.cancelled", async () => {
    const { emit, events } = recorder();
    await emitCancelledTurn(emit, state, FULL);
    expect(terminal(events, "turn.cancelled")?.data).toEqual({ details: FULL, sequence: 17, turnId: "turn_17" });
  });

  it("carries the same identity across every terminal event it applies to", async () => {
    const { emit, events } = recorder();
    const wrapped = withExecutionEvidence(emit, FULL);
    await wrapped(createTurnCompletedEvent({ sequence: 1, turnId: "t" }));
    await wrapped(createTurnFailedEvent({ code: "c", message: "m", sequence: 2, turnId: "t" }));
    await wrapped(createTurnCancelledEvent({ sequence: 3, turnId: "t" }));
    const details = events.map((e) => (e as { data: { details?: unknown } }).data.details);
    expect(details).toEqual([FULL, FULL, FULL]);
  });

  it("merges into existing details and never edits them otherwise", async () => {
    const { emit, events } = recorder();
    await withExecutionEvidence(emit, FULL)(createTurnFailedEvent({ code: "c", details: { retryable: false }, message: "m", sequence: 1, turnId: "t" }));
    expect(terminal(events, "turn.failed")?.data.details).toEqual({ retryable: false, ...FULL });
  });

  it("leaves turn.started and other events untouched", async () => {
    const { emit, events } = recorder();
    const started = { data: { sequence: 1, turnId: "t" }, type: "turn.started" } as UnstampedMessageStreamEvent;
    await withExecutionEvidence(emit, FULL)(started);
    expect(events[0]).toBe(started);
  });
});

describe("no evidence means no Compute evidence", () => {
  it("emits no details.compute without a host input", async () => {
    const { emit, events } = recorder();
    await emitTurnEpilogue(withExecutionEvidence(emit, undefined), state, "conversation");
    expect(terminal(events, "turn.completed")?.data).toEqual({ sequence: 17, turnId: "turn_17" });
    expect("details" in (terminal(events, "turn.completed")?.data ?? {})).toBe(false);
  });

  it("returns the very same emit function when there is nothing to add", () => {
    const { emit } = recorder();
    expect(withExecutionEvidence(emit, undefined)).toBe(emit);
    expect(withExecutionEvidence(emit, { compute: {} })).toBe(emit);
    expect(withExecutionEvidence(undefined, FULL)).toBeUndefined();
  });

  it("does not read failure text as Compute identity", async () => {
    const { emit, events } = recorder();
    await emitFailedStep(withExecutionEvidence(emit, undefined), state, { code: "execution_failed", message: "sh: cargo: command not found", sessionId: "session_1" });
    const failed = terminal(events, "turn.failed")?.data as { message: string; details?: { compute?: unknown } };
    expect(failed.message).toBe("sh: cargo: command not found");
    expect(failed.details?.compute).toBeUndefined();
  });

  it("does not alias Chip identity into Compute identity", async () => {
    const { emit, events } = recorder();
    // Evidence names only a job; the turn and session ids must not leak into any Compute field.
    await emitTurnEpilogue(withExecutionEvidence(emit, { compute: { jobId: "job_3" } }), { ...state, turnId: "turn_2" }, "conversation");
    const details = terminal(events, "turn.completed")?.data.details as { compute: Record<string, string> };
    expect(details.compute).toEqual({ jobId: "job_3" });
    expect(Object.values(details.compute)).not.toContain("turn_2");
    expect(Object.values(details.compute)).not.toContain("session_1");
  });
});

describe("compatibility", () => {
  it("serializes events without details.compute exactly as before", () => {
    const event = createTurnCompletedEvent({ sequence: 1, turnId: "t" });
    expect(JSON.stringify(event)).toBe('{"data":{"sequence":1,"turnId":"t"},"type":"turn.completed"}');
    expect(JSON.stringify(createTurnCancelledEvent({ sequence: 1, turnId: "t" }))).toBe('{"data":{"sequence":1,"turnId":"t"},"type":"turn.cancelled"}');
  });

  it("round-trips through JSON, and a consumer that ignores details still reads the event", () => {
    const { data } = JSON.parse(JSON.stringify(createTurnFailedEvent({ code: "c", details: executionEvidenceDetails(FULL), message: "m", sequence: 1, turnId: "t" })));
    expect(data.details).toEqual(FULL);
    const { code, message, sequence, turnId } = data; // what an older consumer reads
    expect({ code, message, sequence, turnId }).toEqual({ code: "c", message: "m", sequence: 1, turnId: "t" });
  });

  it("doesn't change the existing failure event when no evidence is supplied", () => {
    expect(createTurnFailedEvent({ code: "c", message: "m", sequence: 1, turnId: "t" })).toEqual({
      data: { code: "c", details: undefined, message: "m", sequence: 1, turnId: "t" },
      type: "turn.failed",
    });
  });
});
