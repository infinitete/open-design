import { describe, expect, it } from 'vitest';
import {
  retryFinalResultForRunStatus,
  scanRunEventsForRetrySideEffects,
} from '../../src/runtimes/run-lifecycle-analytics.js';

describe('run retry helpers', () => {
  it('detects retry-blocking side effects from run events', () => {
    expect(scanRunEventsForRetrySideEffects([
      { event: 'stderr', data: { chunk: 'HTTP 503' } },
    ])).toEqual({
      userVisibleOutputSeen: false,
      toolCallSeen: false,
      artifactWriteSeen: false,
      liveArtifactSeen: false,
    });

    expect(scanRunEventsForRetrySideEffects([
      { event: 'agent', data: { type: 'text_delta', delta: 'hello' } },
      { event: 'agent', data: { type: 'tool_use', id: 't1', name: 'Read', input: {} } },
      { event: 'agent', data: { type: 'live_artifact' } },
    ])).toMatchObject({
      userVisibleOutputSeen: true,
      toolCallSeen: true,
      liveArtifactSeen: true,
    });
  });

  it('derives retry final result from terminal status and attempt count', () => {
    expect(retryFinalResultForRunStatus('succeeded', 0)).toBe('not_attempted');
    expect(retryFinalResultForRunStatus('failed', 0)).toBe('suppressed');
    expect(retryFinalResultForRunStatus('succeeded', 1)).toBe('success');
    expect(retryFinalResultForRunStatus('failed', 1)).toBe('failed');
    expect(retryFinalResultForRunStatus('canceled', 1)).toBe('suppressed');
  });

});
