import type Database from 'better-sqlite3';
import type { Express, RequestHandler } from 'express';
import type {
  OdNextRolloutControlResponse,
  ResetOdNextRolloutControlRequest,
} from '@open-design/contracts';

import {
  readOdNextRolloutControlStatus,
  resetOdNextRolloutStop,
  type OdNextRolloutAppConfig,
} from '../strategies/od-next/rollout.js';

export function registerStrategyRolloutRoutes(app: Express, deps: {
  db: Database.Database;
  requireLocalDaemonRequest: RequestHandler;
  /**
   * The installation's saved OD Next preference. Injected rather than read
   * here so this route never resolves a daemon data path of its own, and so
   * status reflects a preference the user changed since the daemon started.
   */
  readOdNextPreference: () => Promise<OdNextRolloutAppConfig>;
}): void {
  app.get(
    '/api/strategies/od-next/rollout',
    deps.requireLocalDaemonRequest,
    async (_req, res) => {
      const body: OdNextRolloutControlResponse = {
        status: readOdNextRolloutControlStatus(
          deps.db,
          process.env,
          await deps.readOdNextPreference(),
        ),
      };
      res.json(body);
    },
  );

  app.post(
    '/api/strategies/od-next/rollout/reset',
    deps.requireLocalDaemonRequest,
    async (req, res) => {
      const body = req.body as Partial<ResetOdNextRolloutControlRequest> | null;
      if (
        !body
        || typeof body.expectedRevision !== 'number'
        || !Number.isInteger(body.expectedRevision)
        || body.expectedRevision < 0
      ) {
        res.status(400).json({
          error: {
            code: 'BAD_REQUEST',
            message: 'expectedRevision must be a non-negative integer',
          },
        });
        return;
      }

      const preference = await deps.readOdNextPreference();
      const result = resetOdNextRolloutStop(deps.db, {
        expectedRevision: body.expectedRevision,
        reasonCode: 'operator_reset',
      });
      const status = readOdNextRolloutControlStatus(deps.db, process.env, preference);
      if (!result.ok) {
        res.status(409).json({
          error: {
            code: 'ROLLOUT_REVISION_CONFLICT',
            message: 'OD Next rollout control changed; refresh status before resetting.',
            data: { expectedRevision: body.expectedRevision, currentRevision: result.currentRevision },
          },
          status,
        });
        return;
      }

      const response: OdNextRolloutControlResponse = { status };
      res.json(response);
    },
  );
}
