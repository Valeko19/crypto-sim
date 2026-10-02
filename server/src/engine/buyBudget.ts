// Shared by BUY quote and settlement. The budget already includes the fee.
export function calculateBuyCharge(budget: number, feePct: number, executedNet: number) {
  const requestedFee = budget * feePct;
  const requestedNet = budget - requestedFee;
  const fee = requestedFee * (executedNet / requestedNet);
  // Without a cap, preserve the original budget exactly: (budget - fee) + fee
  // can exceed it by one ULP. With a cap, charge only the executed fraction,
  // bounded by the budget even at the cap's floating-point boundary.
  const totalCharged = executedNet === requestedNet
    ? budget
    : Math.min(budget, executedNet + fee);
  return { fee, totalCharged };
}
