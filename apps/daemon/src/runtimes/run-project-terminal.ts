export function completeActiveRunProjectTerminal(input: {
  reconcileMessage(): void;
  recordReceipt(): void;
}): void {
  input.reconcileMessage();
  input.recordReceipt();
}
