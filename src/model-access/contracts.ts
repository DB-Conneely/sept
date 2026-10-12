/**
 * Defines credential-blind model-access contracts projected from Pi. ModelRuntime remains the owner
 * of provider discovery, authentication, and model transport; SEPT exposes only bounded metadata,
 * selection authority, and ephemeral operator interaction callbacks.
 */

/** Credential-blind authentication availability reported for one Pi provider. */
export type AuthenticationState =
  | "authenticated"
  | "authentication_required"
  | "not_required"
  | "error";

/** Pi authentication flow exposed without credential values. */
export type AuthenticationMethod = "api_key" | "subscription" | "oauth";

/** Bounded authentication status projected for operators and admission. */
export interface AuthenticationStatus {
  provider: string;
  state: AuthenticationState;
  method?: AuthenticationMethod;
  methods: AuthenticationMethod[];
  error?: string;
}

/** Credential-blind provider metadata normalized from Pi. */
export interface ProviderDescription {
  id: string;
  name: string;
  authentication: Omit<AuthenticationStatus, "provider">;
  modelCount: number;
  availableModelCount: number;
}

/** Credential-blind model metadata required for selection and rollover. */
export interface ModelDescription {
  provider: string;
  id: string;
  name: string;
  available: boolean;
  api: string;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: {
    reasoning: boolean;
    input: ("text" | "image")[];
  };
}

/** Provider and model catalogue with a bounded partial-availability diagnostic. */
export interface ModelCatalogue {
  providers: ProviderDescription[];
  models: ModelDescription[];
  error?: string;
}

/** Complete provider/model pair accepted as selection authority. */
export interface ModelSelection {
  provider: string;
  model: string;
}

/** Precedence source for the immutable model pair selected at admission. */
export type SelectionSource = "explicit" | "pod_default" | "built_in_default";

/** Model pair annotated with the selection rule that supplied it. */
export interface ResolvedModelSelection extends ModelSelection {
  source: SelectionSource;
}

/** Fully available and authenticated selection safe to persist in a run manifest. */
export interface PreflightedModelSelection {
  selected: ResolvedModelSelection;
  available: true;
  authenticated: true;
  model: ModelDescription;
}

/** UI-neutral prompt delegated directly to an interactive Pi authentication flow. */
export type LoginPrompt =
  | {
      type: "text" | "secret" | "manual_code";
      message: string;
      placeholder?: string;
      signal?: AbortSignal;
    }
  | {
      type: "select";
      message: string;
      options: readonly { id: string; label: string; description?: string }[];
      signal?: AbortSignal;
    };

/** Credential-free progress event emitted by a Pi authentication flow. */
export type LoginEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

/** Operator-owned interaction boundary passed to Pi without retaining secrets. */
export interface LoginInteraction {
  signal?: AbortSignal;
  prompt(value: LoginPrompt): Promise<string>;
  notify(value: LoginEvent): void;
}

/** Bounded summary of validated custom Pi provider/model configuration. */
export interface CustomConfigurationStatus {
  configured: boolean;
  providers: number;
  models: number;
}
