/** Projects only completed native message text; tool, image and reasoning blocks stay private. */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

/** Extract native text for the existing bounded SEPT control/public-message validators. */
export function sessionMessageText(message: unknown): string {
  if (!isRecord(message)) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter(isTextPart)
    .map((part) => part.text)
    .join("");
}
