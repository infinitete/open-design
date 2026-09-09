import type Database from 'better-sqlite3';
import type { OdNextRolloutStopReasonCode } from '@open-design/contracts';

import { latchOdNextRolloutStop } from './rollout.js';

/** Persist one instance latch. */
export function latchOdNextRolloutStopOperationally(input: {
  db: Database.Database;
  mode: 'off' | 'observe';
  reasonCode: OdNextRolloutStopReasonCode;
}): void {
  latchOdNextRolloutStop(input.db, {
    mode: input.mode,
    reasonCode: input.reasonCode,
  });
}
