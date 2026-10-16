# Models and Pi authentication

SEPT uses the installed Pi **1.1.0 ModelRuntime**. A suitable supported/configured model can run a SEPT task; “any model” does not mean any arbitrary protocol or incomplete model metadata. Pi owns provider discovery, availability, authentication, requests and loaded local-model integrations. SEPT normalizes bounded credential-blind metadata and controls immutable task selection.

## Select a model

All commands below use the same explicit private agent directory as the worker:

```sh
sept auth status --provider openai-codex --agent-dir "$PI_CODING_AGENT_DIR"
sept auth login --provider openai-codex --method subscription --agent-dir "$PI_CODING_AGENT_DIR"
sept auth login --provider anthropic --method api-key --agent-dir "$PI_CODING_AGENT_DIR"
sept models list --provider openai-codex --agent-dir "$PI_CODING_AGENT_DIR"
sept models select --provider openai-codex --model gpt-6-sol --agent-dir "$PI_CODING_AGENT_DIR"
sept models current --agent-dir "$PI_CODING_AGENT_DIR"
sept models validate --agent-dir "$PI_CODING_AGENT_DIR"
sept doctor --agent-dir "$PI_CODING_AGENT_DIR"
```

Login reads hidden TTY input or stdin, including secrets/manual codes; never put credentials in arguments, tasks, profiles or evidence. `sept auth logout --provider anthropic --agent-dir "$PI_CODING_AGENT_DIR"` delegates to Pi. Pi's `auth.json` retains one credential per provider and owns refresh. Keep agent storage private and outside hands; do not commit it or embed it in an image. CLI defaults use `${PI_CODING_AGENT_DIR:-~/.pi/agent}`; library callers explicitly provide `agentDir`.

Each direct or HTTP/webhook task resolves:

1. Its explicit complete `provider`/`model` pair.
2. The Pod's freshly reread `sept-model.json` default.
3. Built-in `openai-codex/gpt-6-sol`, only after Pi validates existence, availability, authentication and metadata.

The fallback is not a credential/availability promise. The default record is atomic mode0600 and contains only format version/provider/model. Changing it affects later admissions; every accepted run's final pair persists immutably. `thinking` is per task: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`, default `xhigh`; suitability remains Pi/model-owned.

```sh
sept run --task "Review the evidence and state unknowns" --role "Evidence reviewer" \
  --provider openai-codex --model gpt-6-sol --thinking xhigh \
  --state-dir "$SEPT_STATE_DIR" --agent-dir "$PI_CODING_AGENT_DIR" \
  --workspace "$SEPT_WORKSPACE_ROOT" --hands "$SEPT_HANDS_CONFIGURATION"
```

For the public client, put `provider`, `model`, `thinking` in `task`. Model preflight precedes durable acceptance; missing credentials or unusable metadata refuse safely. Authenticated HTTP exposes provider/model catalogue, GET selection and PUT selection for future runs; see [all routes](worker-api.md). It deliberately offers no secret-bearing login over plain TCP. Catalogue responses never expose auth values/paths, raw provider objects or headers.

## Custom and local endpoints

Use Pi's `models.json` under the same private agent directory. SEPT accepts at most 1 MiB of configuration and requires each custom model's explicit integer `contextWindow` **4096..10,000,000** and `maxTokens` **1..contextWindow**, with 1..1000 entries per configured model list. The current compatible APIs are `openai-completions`, `openai-responses`, `anthropic-messages` and `google-generative-ai`. Pi remains responsible for endpoint compatibility and model behavior.

A deliberately keyless local HTTP example, for an already running compatible server:

```json
{
  "providers": {
    "local-evidence": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "models": [{
        "id": "evidence-model",
        "name": "Evidence model",
        "reasoning": false,
        "input": ["text"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 32768,
        "maxTokens": 4096
      }]
    }
  }
}
```

Use real server-supported IDs/limits; this is configuration shape, not a supplied model/server. Run `sept models validate`, list that provider, then select or explicitly admit its pair. Ollama, LM Studio, vLLM and Pi's loaded llama.cpp integration can be used when the installed Pi provider/API and metadata support them. SEPT performs no serving, downloading or automatic unconfigured-server discovery; model catalogue network refresh is off by default.

URLs are at most 2048 characters and may not contain userinfo, query or fragment. HTTPS is allowed. Deliberate HTTP is limited to `localhost`, `host.docker.internal`, `::1`, loopback127/8 and private IPv4 `10/8`, `172.16/12`, `192.168/16`. A generic hostname/private DNS name, CGNAT or IPv6 ULA is not automatically admitted for model HTTP. These URL rules differ from [hands network CIDR rights](pi-contract.md#explicit-hands-network). Base URL paths such as `/v1` are supported here; the task client's worker URL is origin-only.

The exact non-secret plaintext API-key sentinel is **`local`**, only for a keyless deliberate local/private HTTP provider. Other API-key values and sensitive headers require Pi credential storage, environment interpolation such as `${MODEL_API_KEY}`, or an intentional `!credential-command`. Header names are bounded; authorization/API-key/token/secret/password headers always require indirection. Credential strings are1..4096 characters without controls and recognizable plaintext secret material refuses. Treat credential commands as trusted operator code. Non-sensitive literal headers remain allowed. Never log resolved values.

Reachability is from the **brain process**, where Pi runs: `127.0.0.1` inside a brain container means that container, not the host/hands namespace. Configure a reachable admitted endpoint and credentials there. Granting hands network does not configure model reachability or expose credentials to tools.

## Usage, context and recovery

Pi must provide usable context/output metadata and finalized provider-reported assistant usage. SEPT disables auto-compaction and rotates after a durable handover according to that model's context window and observed same-conversation growth. Cumulative spend never triggers rotation; there is no local tokenizer, character-count or compaction fallback. Missing/zero/regressing finalized usage is not treated as zero; persistent unusable samples stop dispatch safely. [Pi session and rollover](pi-contract.md#session-and-rollover) specifies the exact ownership/order.

A successful compatible/local or live request does not establish outage tolerance or expiring OAuth/subscription refresh resilience; those remain separately qualified in [support limits](pi-contract.md#portability-qualification).
