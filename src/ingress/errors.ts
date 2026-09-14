import { SeptError } from "../durable/index.js";

export class RequestError extends SeptError {
  constructor(readonly status: number, message: string) { super(message); }
}
