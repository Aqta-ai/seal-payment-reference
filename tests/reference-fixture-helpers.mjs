// Independently authored test fixtures for editing a signed payment record.
// These helpers do not implement a browser view or make an authority decision.
export function editOneCent(record) {
  const copy = structuredClone(record);
  const amountMinor = record.ledger[0].amountMinor + 1;
  const paymentId = record.ledger[0].id;
  const event = copy.events.find(item => item.type === 'payment_committed' && item.details.payment.id === paymentId);
  copy.ledger[0].amountMinor = amountMinor;
  event.details.payment.amountMinor = amountMinor;
  event.proof.payload.details.payment.amountMinor = amountMinor;
  return copy;
}

export const integrityRejected = result => result?.valid === false
  && ['HASH_MISMATCH', 'SIGNATURE_MISMATCH'].includes(result?.failure?.code);
