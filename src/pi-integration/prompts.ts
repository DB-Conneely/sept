import type { DurableHandover, Manifest, OperatorMessage, WorkControl } from "../durable/index.js";

const CONTROL_CONTRACT = `When this agent run reaches a coherent seam, end with exactly one JSON object and no text after it:
{"status":"continue|waiting|complete|blocked","summary":"...","verification":["..."],"next_action":"..."}
Use waiting only when current work is coherent and no useful action remains until new operator or webhook input arrives. Waiting releases Pi and resumes this same run and session on accepted input. Use complete only when the standing task is fully implemented and verified. Use blocked only when progress truly requires operator action because of a genuine impediment. Otherwise continue.`;

export function initialPrompt(manifest: Manifest, continuity?: string): string {
  return `You are SEPT, a durable Pi-backed coding worker. Work directly on the standing task using Pi's native tools and agent loop.

Standing task:
${manifest.task}

Independent role:
${manifest.role || "No additional role was supplied."}

${continuity ? `Durable recovery context:\n${continuity}\n` : ""}
Do useful work now. Respect every AGENTS.md and repository instruction. Do not merely describe a plan.

${CONTROL_CONTRACT}`;
}

export function continuationPrompt(control: WorkControl, messages: OperatorMessage[]): string {
  return `Continue the same standing task and role in this active Pi session.

Previous durable control record:
${JSON.stringify(control, null, 2)}
${operatorBlock(messages)}
Perform the exact next useful work without rediscovering settled facts.

${CONTROL_CONTRACT}`;
}

export const ROTATION_STEER = `SEPT_CONTEXT_ROTATION: The active Pi session reached its configured context threshold. Finish the current atomic tool batch normally. Start no new implementation, investigation, or verification work. Then return the structured handover JSON below as the next assistant response, with no prose outside the JSON. This instruction supersedes any previously planned subsequent tool calls.

Required exact keys:
{"handover_summary":"...","entry_state_and_done":"...","completed":["..."],"in_flight":["..."],"not_started":["..."],"decisions":["..."],"rejected_approaches":["..."],"verification":["..."],"uncertainties":["..."],"references":["..."],"lessons":["..."],"next_action":"..."}`;

export function successorPrompt(manifest: Manifest, value: DurableHandover, messages: OperatorMessage[]): string {
  return `You are the fresh successor SEPT Pi session. Continue immediately; do not rediscover the predecessor's work.

Standing task:
${manifest.task}

Independent role:
${manifest.role || "No additional role was supplied."}

Full durable predecessor handover:
${JSON.stringify(value, null, 2)}
${operatorBlock(messages)}
Execute the exact next action using Pi's native tools.

${CONTROL_CONTRACT}`;
}

export function operatorBlock(messages: OperatorMessage[]): string {
  if (messages.length === 0) return "";
  return `\nOperator messages (IDs and exact text; acknowledge through the next durable control/handover record):\n${JSON.stringify(messages, null, 2)}\n`;
}
