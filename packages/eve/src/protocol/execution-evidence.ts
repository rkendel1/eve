import type { JsonObject } from "#shared/json.js";
import type { HarnessEmitFn } from "#harness/types.js";

/**
 * Identifiers the Compute runtime assigned to the execution a turn ran in.
 *
 * Every field is optional: different Compute execution paths expose different
 * authoritative identifiers, and a partial set is carried as-is. Nothing here is
 * ever derived, so no field may be filled from a session id, a turn id, a work
 * id, a path, a command, shell output or an error message.
 */
export interface ComputeExecutionEvidence {
  readonly environmentId?: string;
  readonly executionId?: string;
  readonly jobId?: string;
  readonly receiptId?: string;
}

/**
 * Execution evidence a host supplies for the turns it runs.
 *
 * Chip does not create or derive Compute identity. When a host supplies Compute
 * execution evidence, Chip carries the normalized evidence through its terminal
 * events (`turn.completed`, `turn.failed`, `turn.cancelled`) as `details.compute`.
 * The host is responsible for obtaining authoritative values from the runtime that
 * owns them. Absence is expected and meaningful: a turn with no supplied evidence
 * emits no `details.compute`.
 *
 * The container is generic so the carrier is not coupled to one runtime; `compute`
 * is the first namespace.
 */
export interface ExecutionEvidence {
  readonly compute?: ComputeExecutionEvidence;
}

const COMPUTE_FIELDS = ["environmentId", "executionId", "jobId", "receiptId"] as const;

/** Terminal events that carry execution evidence. `turn.started` is deliberately not one. */
const TERMINAL_TURN_EVENTS: ReadonlySet<string> = new Set([
  "turn.cancelled",
  "turn.completed",
  "turn.failed",
]);

/**
 * Normalizes host-supplied evidence. Keeps only the known fields that are
 * non-empty strings, copied exactly, and returns `undefined` when nothing is left,
 * so an empty `compute` object is never emitted.
 */
export function normalizeExecutionEvidence(input: unknown): ExecutionEvidence | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const compute = (input as { readonly compute?: unknown }).compute;
  if (typeof compute !== "object" || compute === null) return undefined;

  const kept: Record<string, string> = {};
  for (const field of COMPUTE_FIELDS) {
    const value = (compute as Record<string, unknown>)[field];
    if (typeof value === "string" && value.trim() !== "") kept[field] = value;
  }
  return Object.keys(kept).length === 0 ? undefined : { compute: kept as ComputeExecutionEvidence };
}

/**
 * The `details` fragment for normalized evidence, or `undefined` when there is none.
 */
export function executionEvidenceDetails(input: unknown): JsonObject | undefined {
  const evidence = normalizeExecutionEvidence(input);
  return evidence?.compute === undefined ? undefined : { compute: { ...evidence.compute } };
}

/**
 * Wraps an emit function so terminal turn events carry the host's execution
 * evidence as `details.compute`. Every other event, and every event when no
 * evidence is supplied, passes through untouched. Existing `details` are kept;
 * only the `compute` key is set, from the host, never inferred.
 */
export function withExecutionEvidence(emit: HarnessEmitFn, evidence: unknown): HarnessEmitFn;
export function withExecutionEvidence(
  emit: HarnessEmitFn | undefined,
  evidence: unknown,
): HarnessEmitFn | undefined;
export function withExecutionEvidence(
  emit: HarnessEmitFn | undefined,
  evidence: unknown,
): HarnessEmitFn | undefined {
  const fragment = executionEvidenceDetails(evidence);
  if (emit === undefined || fragment === undefined) return emit;
  return (event, messages) => {
    if (!TERMINAL_TURN_EVENTS.has(event.type)) return emit(event, messages);
    // The three terminal turn events all carry `data`; session events such as `session.completed` do not.
    const data = (event as { readonly data: { readonly details?: JsonObject } }).data;
    return emit({ ...event, data: { ...data, details: { ...data.details, ...fragment } } } as typeof event, messages);
  };
}
