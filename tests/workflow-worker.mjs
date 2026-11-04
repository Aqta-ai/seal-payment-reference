import { parentPort, workerData } from "node:worker_threads";
import { WorkflowStore } from "../src/workflow.mjs";

const store = new WorkflowStore({ filename: workerData.filename, now: () => workerData.now });
const gate = new Int32Array(workerData.gate);
parentPort.postMessage({ ready: true });
Atomics.wait(gate, 0, 0);

let result;
if (workerData.mode === "review-and-execute") {
  const requested = store.requestApproval(workerData.workflowId, workerData.tuple);
  if (requested.status === "awaiting_human") {
    const { reviewId, digest, expectedRevision } = requested.pendingReview;
    const approved = store.approve(workerData.workflowId, { reviewId, digest, expectedRevision });
    result = approved.status === "approved"
      ? store.executePayment(workerData.workflowId, { approvalId: approved.currentApproval.id, ...workerData.tuple })
      : approved;
  } else {
    result = requested;
  }
} else {
  result = store.executePayment(workerData.workflowId, workerData.intent);
}
store.close();
parentPort.postMessage({ result });
parentPort.close();
