/**
 * Defines credential-free native-session payloads shared by runtime tests. These immutable values
 * model Pi output only; production codecs remain responsible for validation and durable authority.
 */

/** Canonical rollover payload used by controller lifecycle tests. */
export const handover = {
  handover_summary: "first session exhausted",
  entry_state_and_done: "finish the fixture",
  completed: ["atomic batch"],
  in_flight: [],
  not_started: ["finish"],
  decisions: [],
  rejected_approaches: [],
  verification: ["batch passed"],
  uncertainties: [],
  references: ["fixture"],
  lessons: [],
  next_action: "finish",
};

/** Canonical terminal control payload for scripted sessions. */
export const complete = {
  status: "complete",
  summary: "done",
  verification: ["ok"],
  next_action: "",
};

/** Canonical waiting control payload for scripted sessions. */
export const waiting = {
  status: "waiting",
  summary: "dormant until input arrives",
  verification: ["current work checkpointed"],
  next_action: "Resume when a new message arrives.",
};
