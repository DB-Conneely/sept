/** Credential-blind Pi model-access facade used by composition and admission. */
export { ModelAccessService } from "./service.js";

/** Installed Pi runtime construction with SEPT custom-configuration safety checks. */
export { createPodModelRuntime, type ModelAccessCreateOptions } from "./runtime-factory.js";

/** Custom Pi provider/model safety and rollover metadata validation. */
export { validateCustomConfiguration } from "./custom-configuration.js";

/** Model identity, metadata, and fallback-selection policy. */
export { assertModelMetadata, builtInDefault, safeModelIdentifier } from "./model-metadata.js";

/** Atomic credential-free Pod selection persistence. */
export { readPodDefault, writePodDefault } from "./pod-selection.js";

/** Stable credential-blind model-access contracts. */
export type {
  AuthenticationMethod,
  AuthenticationState,
  AuthenticationStatus,
  CustomConfigurationStatus,
  LoginEvent,
  LoginInteraction,
  LoginPrompt,
  ModelCatalogue,
  ModelDescription,
  ModelSelection,
  PreflightedModelSelection,
  ProviderDescription,
  ResolvedModelSelection,
  SelectionSource,
} from "./contracts.js";
