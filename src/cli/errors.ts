/**
 * Typed failures owned by CLI composition. Command handlers may present these messages, while
 * credential and runtime mechanisms remain responsible for their own classified failures.
 */

/** A safe operator-facing failure caused by invalid CLI input or interaction. */
export class CliError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}
