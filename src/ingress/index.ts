/**
 * Public ingress boundary. Callers compose the authenticated service or reuse request validation;
 * HTTP parsing and webhook receipt internals stay owned by this mechanism.
 */

/** Authenticated worker HTTP composition and its explicit construction dependencies. */
export { SeptService, type ServiceOptions } from "./service.js";

/** Strict task-admission validation shared with installed composition tests. */
export { validateRequest } from "./validation.js";
