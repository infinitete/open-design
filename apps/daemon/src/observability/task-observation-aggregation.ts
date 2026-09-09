/**
 * Stable observation-id derivation for strategy task runs. The OD Next
 * complex-production eligibility gate and the Codex child-evidence collector
 * use these ids to parent child observations under the strategy task run.
 */

export function strategyTaskRootObservationId(taskExecutionId: string): string {
  return `strategy-task:${taskExecutionId}`;
}

export function strategyTaskRunObservationId(
  taskExecutionId: string,
  runId: string,
): string {
  return `task-run:${taskExecutionId}:${runId}`;
}
