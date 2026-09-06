import { expect, it, vi } from 'vitest';

import { completeActiveRunProjectTerminal } from '../../src/runtimes/run-project-terminal.js';

it('reconciles portable message state before recording the terminal receipt', () => {
  const order: string[] = [];
  completeActiveRunProjectTerminal({
    reconcileMessage: () => { order.push('message'); },
    recordReceipt: () => { order.push('receipt'); },
  });
  expect(order).toEqual(['message', 'receipt']);
});

it('withholds the receipt when message reconciliation fails', () => {
  const recordReceipt = vi.fn();
  expect(() => completeActiveRunProjectTerminal({
    reconcileMessage: () => { throw new Error('message write failed'); },
    recordReceipt,
  })).toThrow('message write failed');
  expect(recordReceipt).not.toHaveBeenCalled();
});
