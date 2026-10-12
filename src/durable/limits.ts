/**
 * Centralizes hard durable and public-projection resource bounds. Storage and transport owners use
 * these constants to reject or compact before buffering becomes unbounded; changing a limit changes
 * recovery capacity and therefore requires corresponding boundary tests.
 */

/** Maximum operator messages awaiting a durable consumption proof. */
export const MAX_PENDING_MESSAGES = 64;

/** Maximum aggregate UTF-8 bytes retained in the pending operator queue. */
export const MAX_PENDING_MESSAGE_BYTES = 512 * 1024;

/** Maximum client-facing events retained for one run. */
export const MAX_CONVERSATION_EVENTS = 1024;

/** Maximum aggregate UTF-8 bytes retained in one conversation. */
export const MAX_CONVERSATION_BYTES = 4 * 1024 * 1024;

/** Maximum concurrent conversation streams owned by one worker. */
export const MAX_CONVERSATION_STREAMS = 32;

/** Maximum UTF-8 bytes accepted for one durable JSONL record. */
export const MAX_JSONL_RECORD_BYTES = 2 * 1024 * 1024;

/** Maximum serialized bytes accepted for one assistant lifecycle control. */
export const MAX_CONTROL_BYTES = 512 * 1024;

/** Maximum characters accepted in one assistant lifecycle field. */
export const MAX_CONTROL_STRING_CHARS = 65_536;

/** Maximum entries accepted in one assistant lifecycle array. */
export const MAX_CONTROL_ARRAY_ITEMS = 64;

/** Maximum characters retained in one public conversation message. */
export const MAX_CONVERSATION_TEXT_CHARS = 32_768;
