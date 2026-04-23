# Portkey AI Gateway — Providers, Plugins, Auth & Multi-Environment Deployment

## 1. Provider Architecture

### Provider Registry (`src/providers/index.ts:78`)

```typescript
const Providers: { [key: string]: ProviderConfigs } = {
  openai: OpenAIConfig,
  anthropic: AnthropicConfig,
  groq: GroqConfig,
  bedrock: BedrockConfig,
  'vertex-ai': VertexAIConfig,
  // ... 60+ more
};
```

Key = provider string used in `x-portkey-provider` header or config JSON.

### ProviderConfigs Shape (`src/providers/types.ts`)

```typescript
interface ProviderConfigs {
  api: ProviderAPIConfig;              // REQUIRED: URL, headers, endpoint routing
  chatComplete?: ProviderConfig;       // param mapping for chat completions
  complete?: ProviderConfig;
  embed?: ProviderConfig;
  imageGenerate?: ProviderConfig;
  createSpeech?: ProviderConfig;
  // ... other endpoints
  responseTransforms?: {
    chatComplete?: Function;
    'stream-chatComplete'?: Function;
    complete?: Function;
    'stream-complete'?: Function;
    embed?: Function;
  };
  requestHandlers?: Partial<Record<endpointStrings, RequestHandler>>;
  requestTransforms?: Record<string, Function>;
  getConfig?: ({ params, providerOptions }) => ProviderConfigs; // dynamic config
}
```

### ProviderAPIConfig Interface (`src/providers/types.ts:47`)

```typescript
interface ProviderAPIConfig {
  headers: (args: {
    c: Context;
    providerOptions: Options;
    fn: string;
    transformedRequestBody: Record<string, any>;
    transformedRequestUrl: string;
    gatewayRequestBody?: Params;
  }) => Promise<Record<string, any>> | Record<string, any>;

  getBaseURL: (args: {
    providerOptions: Options;
    fn?: endpointStrings;
    c: Context;
    gatewayRequestURL: string;
    params?: Params;
  }) => Promise<string> | string;

  getEndpoint: (args: {
    c: Context;
    providerOptions: Options;
    fn: endpointStrings;
    gatewayRequestBodyJSON: Params;
    gatewayRequestURL: string;
  }) => string;

  transformToFormData?: (args: { gatewayRequestBody: Params }) => boolean;
  getProxyEndpoint?: (args: { providerOptions: Options; reqPath: string; reqQuery: string }) => string;
}
```

### ProviderConfig (Parameter Mapping)

```typescript
interface ParameterConfig {
  param: string;       // provider's actual parameter name (dot notation for nesting)
  default?: any;
  min?: number;
  max?: number;
  required?: boolean;
  transform?: (params: Params, providerOptions: Options) => any;
}

interface ProviderConfig {
  [openAIParamName: string]: ParameterConfig | ParameterConfig[];
}
```

### Provider File Structure

```
src/providers/<name>/
  api.ts          ProviderAPIConfig — base URL, auth headers, endpoint paths
  chatComplete.ts ProviderConfig + response/stream transformers
  complete.ts     ProviderConfig for text completions
  embed.ts        ProviderConfig for embeddings
  index.ts        Assembles and exports ProviderConfigs
  types.ts        Provider-specific TypeScript types
  utils.ts        Shared helpers (error transforms, etc.)
```

### Adding a New Provider

1. `src/providers/<name>/api.ts` — implement `ProviderAPIConfig`
2. Endpoint config files — use `chatCompleteParams(excludeList)` from `open-ai-base` for OpenAI-compatible providers
3. `src/providers/<name>/index.ts` — assemble `ProviderConfigs`
4. Register in `src/providers/index.ts`
5. Add provider string to `src/globals.ts` and `VALID_PROVIDERS` array

---

## 2. OpenAI Compatibility Layer (`src/providers/open-ai-base/index.ts`)

### Base Parameter Factories

```typescript
// Inherits all OpenAI params, excludes specified ones
chatCompleteParams(exclude: string[], defaultValues?, extra?: ProviderConfig): ProviderConfig

completeParams(exclude: string[], defaultValues?, extra?): ProviderConfig
embedParams(exclude: string[], defaultValues?, extra?): ProviderConfig
createSpeechParams(exclude: string[], defaultValues?, extra?): ProviderConfig
```

### Response Transformer Factory

```typescript
responseTransformers(
  provider: string,
  options: {
    chatComplete?: boolean | CustomTransformer;  // true = already OpenAI format
    complete?: boolean | CustomTransformer;
    embed?: boolean | CustomTransformer;
    createSpeech?: boolean | CustomTransformer;
  }
): Record<string, Function>
```

`chatComplete: true` = pass-through, just stamp provider name. Used by Groq, Cerebras, Mistral, 30+ others.

### Example: Groq (OpenAI-compatible)

```typescript
const GroqConfig: ProviderConfigs = {
  api: GroqAPIConfig,
  chatComplete: chatCompleteParams(
    ['logprobs', 'logits_bias', 'top_logprobs'],  // unsupported params excluded
    undefined,
    { service_tier: { param: 'service_tier' }, reasoning_effort: { param: 'reasoning_effort' } }
  ),
  responseTransforms: {
    ...responseTransformers(GROQ, { chatComplete: true, createSpeech: true }),
    'stream-chatComplete': GroqChatCompleteStreamChunkTransform,
  },
};
```

### Example: Anthropic (full custom transforms)

```typescript
const AnthropicConfig: ProviderConfigs = {
  chatComplete: AnthropicChatCompleteConfig,  // maps messages → messages+system, converts tool_calls
  messages: AnthropicMessagesConfig,          // native Anthropic messages format
  api: AnthropicAPIConfig,
  responseTransforms: {
    'stream-complete': AnthropicCompleteStreamChunkTransform,
    complete: AnthropicCompleteResponseTransform,
    chatComplete: getAnthropicChatCompleteResponseTransform(ANTHROPIC),
    'stream-chatComplete': getAnthropicStreamChunkTransform(ANTHROPIC),
    messages: AnthropicMessagesResponseTransform,
  },
};
```

Anthropic transform: splits OpenAI `messages` array into `messages` (non-system) + `system`, converts `tool_calls` to Anthropic `tool_use` blocks, handles base64/URL image content.

### Request Transformation Pipeline (`src/services/transformToProviderRequest.ts`)

```
OpenAI request params
    |
    v
transformUsingProviderConfig(providerConfig, params, providerOptions)
    for each param in providerConfig:
        apply transform() if defined
        apply min/max clamping
        apply defaults
        set nested property via dot-path (e.g. "generation_config.temperature")
    |
    v
Provider-native request body
```

---

## 3. Streaming Architecture

### Stream Detection (`src/handlers/services/requestContext.ts:89`)

`params.stream === true` or `FormData.get('stream') === 'true'` (for multipart).

### SSE Streaming (most providers)

```
Provider Response (ReadableStream)
    |
readStream(reader, splitPattern, transformFunction)  [async generator]
    buffer until splitPattern ('\n\n' or provider-specific)
    apply transformFunction to each complete SSE chunk
    yield transformed chunk strings
    |
TransformStream writer.write(encoder.encode(chunk))
    |
Response body to client
```

### AWS Binary Streaming (Bedrock)

`readAWSStream()` — parses binary framing protocol:
1. Read binary `Uint8Array` chunks
2. Parse 4-byte total length + 4-byte headers length from prelude
3. Extract payload, base64-decode `bytes` field
4. Apply `transformFunction` to decoded JSON string

### JSON-to-Stream (cache hits)

`handleJSONToStreamResponse()` — synthesizes SSE stream from cached JSON response using `OpenAIChatCompleteJSONToStreamResponseTransform`.

### Content-Type Routing (`src/handlers/responseHandlers.ts:102`)

| Condition | Handler |
|---|---|
| `stream=true` + status 200 | `handleStreamingMode()` |
| `audio/*` | `handleAudioResponse()` (passthrough) |
| `application/octet-stream` | `handleOctetStreamResponse()` (passthrough) |
| `image/*` | `handleImageResponse()` (passthrough) |
| `text/plain` or `text/html` | `handleTextResponse()` |
| default (JSON) | `handleNonStreamingMode()` |

Google/Cohere return newline-delimited JSON — gateway forces `content-type: text/event-stream` after transforming.

### strictOpenAiCompliance

`x-portkey-strict-open-ai-compliance: false` header or config — when `false`, extra fields (provider-specific data, `hook_results`) pass through. Default: `true`.

---

## 4. Plugin and Guardrail System

### Architecture

```
Config / Headers (before_request_hooks, after_request_hooks)
    |
HooksManager (per-request)
    HookSpan (context: request.json, response.json, text)
    |
executeHooks(spanId, eventTypePresets, options)
    for each HookObject:
        executeEachHook()
            for each Check:
                executeFunction(context, check, eventType, options)
                    plugins[source][fn](context, params, eventType, options)
    |
HookResult { verdict, checks, transformed, feedback, deny, async }
```

### Plugin Registry (`plugins/index.ts`)

```typescript
export const plugins = {
  default: {
    regexMatch, sentenceCount, wordCount, characterCount,
    jsonSchema, jsonKeys, contains, validUrls, webhook,
    log, containsCode, alluppercase, alllowercase, endsWith,
    modelWhitelist, modelRules, jwt, requiredMetadataKeys,
    addPrefix, regexReplace, allowedRequestTypes, notNull,
  },
  portkey: { moderateContent, language, pii, gibberish },
  qualifire: { contentModeration, grounding, policy, toolUseQuality, hallucinations, pii, promptInjections },
  azure: { pii, contentSafety, shieldPrompt, protectedMaterial },
  // ... aporia, patronus, pangea, promptsecurity, bedrock, acuvity, lasso, exa, etc.
};
```

Plugin invocation: `check.id` (e.g., `"default.regexMatch"`) split on `.` → `plugins["default"]["regexMatch"](context, params, eventType, options)`.

### PluginHandler Interface (`plugins/types.ts`)

```typescript
type PluginHandler = (
  context: PluginContext,
  parameters: PluginParameters,
  eventType: HookEventType,
  options?: {
    env: Record<string, any>;
    getFromCacheByKey?: (key: string) => Promise<any>;
    putInCacheWithValue?: (key: string, value: any) => Promise<any>;
  }
) => Promise<{
  error: any;
  verdict?: boolean;        // true = pass, false = fail
  data?: any | null;
  transformedData?: {       // for mutators
    request: { json: any };
    response: { json: any };
  };
  transformed?: boolean;
}>
```

### Hook Types

```typescript
enum HookType {
  GUARDRAIL = 'guardrail',  // evaluates content, returns verdict, can block (446)
  MUTATOR   = 'mutator',    // transforms request or response body
}
```

### Config Shorthand vs Full Hook Objects

**Shorthand (user-facing):**
```json
{
  "inputGuardrails": [
    { "default.regexMatch": { "rule": ".*credit card.*", "not": true }, "deny": true }
  ]
}
```

**Full (internal, after `convertHooksShorthand()`):**
```json
{
  "beforeRequestHooks": [{
    "type": "guardrail",
    "id": "input_guardrail_abc",
    "deny": true,
    "checks": [{ "id": "default.regexMatch", "parameters": { "rule": ".*credit card.*", "not": true } }]
  }]
}
```

`inputGuardrails` → `beforeRequestHooks`, `outputGuardrails` → `afterRequestHooks`.

### Hook Execution Logic (`src/middlewares/hooks/index.ts:246`)

- `sequential: false` (default): all checks `Promise.all()`
- `sequential: true`: checks run serially; each sees mutations from previous
- MUTATOR: always serial
- `verdict = checks.every(result => result.verdict || (result.error && !result.fail_on_error))`
- `hook.deny && !verdict` → HTTP 446

---

## 5. Auth and API Key Management

### x-portkey-* Header Reference

| Header | Purpose |
|---|---|
| `x-portkey-api-key` | Portkey platform API key (managed deployments) |
| `x-portkey-provider` | Target provider (e.g., `openai`, `anthropic`) |
| `x-portkey-virtual-key` | Virtual key alias → resolved server-side to real credentials |
| `x-portkey-config` | Full routing config JSON |
| `x-portkey-retry-count` | Number of retry attempts |
| `x-portkey-trace-id` | Request correlation ID |
| `x-portkey-cache` | Cache mode (`simple`, `semantic`) |
| `x-portkey-metadata` | Arbitrary JSON metadata for logging/routing |
| `x-portkey-forward-headers` | Headers to forward as-is to provider |
| `x-portkey-custom-host` | Override provider base URL |
| `x-portkey-request-timeout` | Per-request timeout (ms) |
| `x-portkey-strict-open-ai-compliance` | `true`/`false` |
| `Authorization` | `Bearer <key>` — provider API key (direct passthrough) |

**Provider-specific headers:**

| Header | Provider |
|---|---|
| `x-portkey-azure-resource-name` | Azure OpenAI |
| `x-portkey-azure-deployment-id` | Azure OpenAI |
| `x-portkey-azure-api-version` | Azure OpenAI / Azure AI Inference |
| `x-portkey-azure-ad-token` | Azure (Entra auth) |
| `x-portkey-aws-access-key-id` | Bedrock / SageMaker |
| `x-portkey-aws-secret-access-key` | Bedrock / SageMaker |
| `x-portkey-aws-region` | Bedrock / SageMaker |
| `x-portkey-aws-role-arn` | Bedrock (IAM role) |
| `x-portkey-vertex-project-id` | Google Vertex AI |
| `x-portkey-vertex-region` | Google Vertex AI |
| `x-portkey-anthropic-beta` | Anthropic / Bedrock Claude |
| `x-portkey-workers-ai-account-id` | Cloudflare Workers AI |
| `x-portkey-openai-organization` | OpenAI |
| `x-portkey-openai-project` | OpenAI |

### API Key Flow Through Provider

```
constructConfigFromRequestHeaders()
    Authorization: Bearer <key> → Options.apiKey
    |
RequestContext holds providerOption (Options)
    |
ProviderContext.getHeaders() → api.headers({ providerOptions })
    |
Provider api.ts constructs auth header:
    OpenAI:   Authorization: Bearer ${apiKey}
    Anthropic: X-API-Key: ${apiKey}
    Bedrock:  AWS SigV4 signature (accessKeyId + secretAccessKey + region)
    |
Headers merged into fetchOptions → sent to upstream provider
```

### Response Headers Added

| Header | Value |
|---|---|
| `x-portkey-retry-attempt-count` | Number of retries made |
| `x-portkey-last-used-option-index` | Index of target that served the response |
| `x-portkey-cache-status` | `HIT` / `MISS` / `DISABLED` / `REFRESH` |
| `x-portkey-trace-id` | Echo of request trace ID |
| `x-portkey-provider` | Provider name |

---

## 6. Multi-Environment Deployment

### Shared Core

`src/index.ts` exports `default app` with standard `app.fetch` handler — works anywhere that accepts a `fetch`-compatible handler.

### Runtime Detection

```typescript
import { getRuntimeKey } from 'hono/adapter';
const runtime = getRuntimeKey();
// 'node' | 'workerd' | 'lagon' | 'edge-light' | 'fastly' | 'bun' | 'deno'
```

Runtime-conditional behavior:
- **Node.js**: Redis init, log handler middleware, WebSocket adapter
- **workerd**: WebSocket realtime route registered
- **Compression**: skipped for `lagon`, `workerd`, `node`; applied for others

### Node.js Entry (`src/start-server.ts`)

```typescript
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
app.get('/v1/realtime', requestValidator, upgradeWebSocket(realTimeHandlerNode));

const server = serve({ fetch: app.fetch, port });
injectWebSocket(server);
```

### Cloudflare Workers

`wrangler.toml` points to `src/index.ts`. Exported `default app` implements `ExportedHandler`. No additional wrapper needed.

### Environment Variables

Accessed via `hono/adapter`'s `env(c)` — compatible across runtimes. Node.js-specific features (Redis, filesystem, `process.argv`) gated behind `runtime === 'node'` checks.

### Architecture Diagram

```
                    ┌─────────────────────────────┐
                    │        src/index.ts          │
                    │  (Hono app, runtime-agnostic)│
                    └────────────┬────────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                       │
          v                      v                       v
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐
│ src/start-       │  │ Cloudflare Workers│  │ Other JS runtimes    │
│ server.ts        │  │ (workerd)         │  │ (Deno, Bun, etc.)    │
│ (Node.js)        │  │                   │  │                      │
│ @hono/node-server│  │ export default app│  │ export default app   │
│ + WS adapter     │  │ (wrangler deploy) │  │ (platform wraps)     │
└──────────────────┘  └──────────────────┘  └──────────────────────┘
```

---

## 7. Key Files

| File | Purpose |
|---|---|
| `src/providers/index.ts` | Provider registry (60+ providers) |
| `src/providers/types.ts` | ProviderAPIConfig, ProviderConfig, endpointStrings |
| `src/providers/open-ai-base/index.ts` | OpenAI compat layer factories |
| `src/providers/openai/index.ts` | OpenAI config (canonical reference) |
| `src/providers/anthropic/chatComplete.ts` | Complex message/tool transform example |
| `src/providers/bedrock/index.ts` | Dynamic dispatch via getConfig() |
| `src/handlers/streamHandler.ts` | readStream, readAWSStream, JSON→stream |
| `src/handlers/responseHandlers.ts` | Content-type routing, response transform selection |
| `src/services/transformToProviderRequest.ts` | transformUsingProviderConfig |
| `plugins/index.ts` | Static plugin registry |
| `plugins/types.ts` | PluginHandler, PluginContext, PluginParameters |
| `src/middlewares/hooks/index.ts` | HooksManager, hook execution |
| `src/middlewares/hooks/types.ts` | HookObject, HookType, Check |
| `src/globals.ts` | HEADER_KEYS, VALID_PROVIDERS |
| `src/start-server.ts` | Node.js server entry point |
