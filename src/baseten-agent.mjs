import { runAgent } from "./meta-agent.mjs";

export { tools } from "./meta-agent.mjs";

/**
 * Same local tool and resume contract as runAgent, with the fixed Baseten
 * endpoint/model and BASETEN_API_KEY as the default key. Provider, URL and model
 * cannot be overridden here. Reasoning text is omitted from returned records.
 */
export function runBasetenAgent(options = {}) {
  return runAgent({ ...options, provider: "baseten" });
}
