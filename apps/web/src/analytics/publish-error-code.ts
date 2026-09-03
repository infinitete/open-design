/**
 * Classify a failed publish/unpublish error into a stable, queryable analytics
 * code for `artifact_publish_result.error_code`.
 *
 * Public-file publishing (a workspace-share feature) was removed with the user
 * system, so every publish failure now buckets to the single generic code.
 *
 * Mirrors apps/web/src/analytics/deploy-error-code.ts (issue-#5220 pattern).
 */

import type { TrackingPublishErrorCode } from '@open-design/contracts/analytics';

export function publishErrorCode(_err: unknown): TrackingPublishErrorCode {
  return 'publish_failed';
}
