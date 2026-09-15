export type AuthenticationState = "authenticated" | "authentication_required" | "not_required" | "error";
export type AuthenticationMethod = "api_key" | "subscription" | "oauth";

export interface AuthenticationStatus {
  provider: string;
  state: AuthenticationState;
  method?: AuthenticationMethod;
  methods: AuthenticationMethod[];
  error?: string;
}

export interface ProviderDescription {
  id: string;
  name: string;
  authentication: Omit<AuthenticationStatus, "provider">;
  modelCount: number;
  availableModelCount: number;
}

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
    input: Array<"text" | "image">;
  };
}

export interface ModelCatalogue {
  providers: ProviderDescription[];
  models: ModelDescription[];
  error?: string;
}

export interface ModelSelection {
  provider: string;
  model: string;
}

export type SelectionSource = "explicit" | "pod_default" | "built_in_default";

export interface ResolvedModelSelection extends ModelSelection {
  source: SelectionSource;
}

export interface PreflightedModelSelection {
  selected: ResolvedModelSelection;
  available: true;
  authenticated: true;
  model: ModelDescription;
}

export type LoginPrompt =
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string; signal?: AbortSignal }
  | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[]; signal?: AbortSignal };

export type LoginEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };

export interface LoginInteraction {
  signal?: AbortSignal;
  prompt(value: LoginPrompt): Promise<string>;
  notify(value: LoginEvent): void;
}

export interface CustomConfigurationStatus {
  configured: boolean;
  providers: number;
  models: number;
}
