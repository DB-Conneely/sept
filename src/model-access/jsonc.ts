import { SeptError } from "../durable/index.js";

type CommentState = "content" | "string" | "line-comment" | "block-comment";

interface CommentScan {
  state: CommentState;
  escaped: boolean;
  output: string;
}

function scanStringCharacter(scan: CommentScan, character: string): void {
  scan.output += character;
  if (scan.escaped) {
    scan.escaped = false;
  } else if (character === "\\") {
    scan.escaped = true;
  } else if (character === '"') {
    scan.state = "content";
  }
}

function scanCommentCharacter(scan: CommentScan, character: string, next: string): boolean {
  if (scan.state === "line-comment") {
    scan.output += character === "\n" || character === "\r" ? character : " ";
    if (character === "\n" || character === "\r") {
      scan.state = "content";
    }
    return false;
  }
  scan.output += character === "\n" || character === "\r" ? character : " ";
  if (character === "*" && next === "/") {
    scan.output += " ";
    scan.state = "content";
    return true;
  }
  return false;
}

function scanContentCharacter(scan: CommentScan, character: string, next: string): boolean {
  if (character === '"') {
    scan.state = "string";
    scan.output += character;
    return false;
  }
  if (character === "/" && (next === "/" || next === "*")) {
    scan.state = next === "/" ? "line-comment" : "block-comment";
    scan.output += "  ";
    return true;
  }
  scan.output += character;
  return false;
}

function stripJsonComments(input: string): string {
  const scan: CommentScan = { state: "content", escaped: false, output: "" };
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === undefined) {
      break;
    }
    if (scan.state === "string") {
      scanStringCharacter(scan, character);
      continue;
    }
    const next = input[index + 1] ?? "";
    const consumedNext =
      scan.state === "content"
        ? scanContentCharacter(scan, character, next)
        : scanCommentCharacter(scan, character, next);
    if (consumedNext) {
      index += 1;
    }
  }
  if (scan.state === "string") {
    throw new SeptError("models.json contains an unterminated string");
  }
  if (scan.state === "block-comment") {
    throw new SeptError("models.json contains an unterminated comment");
  }
  return scan.output;
}

function removeTrailingCommas(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === undefined) {
      break;
    }
    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === "," && followedByClosingDelimiter(input, index + 1)) {
      continue;
    }
    output += character;
  }
  return output;
}

function followedByClosingDelimiter(input: string, start: number): boolean {
  let cursor = start;
  while (/\s/.test(input[cursor] ?? "")) {
    cursor += 1;
  }
  return input[cursor] === "}" || input[cursor] === "]";
}

/** Parse bounded Pi JSONC configuration as hostile unknown input. */
function parseJsonc(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(removeTrailingCommas(stripJsonComments(text)));
    return parsed;
  } catch (error: unknown) {
    if (error instanceof SeptError) {
      throw error;
    }
    throw new SeptError("models.json must contain valid JSON or JSONC", { cause: error });
  }
}

export { parseJsonc };
