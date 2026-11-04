export const MODEL_BUDGET_EXHAUSTED = Object.freeze({
  status: 'error',
  reasonCode: 'MODEL_BUDGET_EXHAUSTED',
  error: 'Today’s model request limit is used up. Try again tomorrow.',
});

// Reservation must finish synchronously before dispatch. An async callback
// cannot reserve safely here, so only an explicit true permits the request.
export function reserveModelRequest(beforeModelRequest) {
  if (beforeModelRequest === undefined) return true;
  try {
    const reserved = beforeModelRequest();
    if (reserved && typeof reserved.then === 'function') {
      Promise.resolve(reserved).catch(() => {});
      return false;
    }
    return reserved === true;
  }
  catch { return false; }
}
