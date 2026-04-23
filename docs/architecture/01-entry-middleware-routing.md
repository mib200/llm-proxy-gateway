# Portkey AI Gateway — Entry Points, Middleware, and Request Routing

## 1. Entry Point: `src/index.ts`

Hono app created at `src/index.ts:46`. Runtime detected via `getRuntimeKey()` (workerd, node, bun, etc.).

On Node.js + `REDIS_CONNECTION_STRING`: Redis cache backend initialized (`src/index.ts:49–51`).

### Global Middleware Registration Order

```
app.use('*', compression)         line 57  — skipped on lagon/workerd/node
app.use('*', websocket_error)     line 66  — Node.js only, handles /realtime WS errors
app.use('*', prettyJSON())        line 95
app.use('*', logHandler())        line 99  — Node.js only, SSE log broadcast
app.use('*', hooks)               line 106 — attaches HooksManager to context
app.use('*', memoryCache())       line 109 — only when conf.cache === true
```

### All Registered Routes

```
GET  /                              greeting
GET  /v1/models                     modelsHandler   ← BEFORE hooks/cache (bypasses them)
POST /v1/messages                   requestValidator, messagesHandler
POST /v1/messages/count_tokens      requestValidator, messagesCountTokensHandler
POST /v1/chat/completions           requestValidator, chatCompletionsHandler
POST /v1/completions                requestValidator, completionsHandler
POST /v1/embeddings                 requestValidator, embeddingsHandler
POST /v1/images/generations         requestValidator, imageGenerationsHandler
POST /v1/images/edits               requestValidator, imageEditsHandler
POST /v1/audio/speech               requestValidator, createSpeechHandler
POST /v1/audio/transcriptions       requestValidator, createTranscriptionHandler
POST /v1/audio/translations         requestValidator, createTranslationHandler
GET  /v1/files                      requestValidator, filesHandler('listFiles', 'GET')
GET  /v1/files/:id                  requestValidator, filesHandler('retrieveFile', 'GET')
GET  /v1/files/:id/content          requestValidator, filesHandler('retrieveFileContent', 'GET')
POST /v1/files                      requestValidator, filesHandler('uploadFile', 'POST')
DEL  /v1/files/:id                  requestValidator, filesHandler('deleteFile', 'DELETE')
POST /v1/batches                    requestValidator, batchesHandler('createBatch', 'POST')
GET  /v1/batches/:id                requestValidator, batchesHandler('retrieveBatch', 'GET')
GET  /v1/batches/*/output           requestValidator, batchesHandler('getBatchOutput', 'GET')
POST /v1/batches/:id/cancel         requestValidator, batchesHandler('cancelBatch', 'POST')
GET  /v1/batches                    requestValidator, batchesHandler('listBatches', 'GET')
POST /v1/responses                  requestValidator, modelResponsesHandler('createModelResponse')
GET  /v1/responses/:id              requestValidator, modelResponsesHandler('getModelResponse')
DEL  /v1/responses/:id              requestValidator, modelResponsesHandler('deleteModelResponse')
GET  /v1/responses/:id/input_items  requestValidator, modelResponsesHandler('listResponseInputItems')
ALL  /v1/fine_tuning/jobs/:jobId?   requestValidator, finetuneHandler
POST /v1/prompts/*                  requestValidator, chatCompletionsHandler or completionsHandler
GET  /v1/realtime                   realTimeHandler (workerd only, WebSocket)
POST /v1/proxy/*                    proxyHandler (deprecated)
POST /v1/*                          requestValidator, proxyHandler (catch-all)
GET  /v1/:path{(?!realtime).*}      requestValidator, proxyHandler
DEL  /v1/*                          requestValidator, proxyHandler
```

---

## 2. Middleware Pipeline

### 2.1 `requestValidator` (`src/middlewares/requestValidator/index.ts:85`)

Applied per-route (not global). Validates:

1. **Content-Type** — `application/json`, `multipart/form-data`, or `audio/*`
2. **Required headers** — `x-portkey-config` OR `x-portkey-provider` must be present
3. **Provider validity** — if `x-portkey-provider` given, must be in `VALID_PROVIDERS` (60+ providers)
4. **Custom host SSRF protection** — blocks: private IPs (RFC1918), reserved IPs, IPv6 private, hex/octal/decimal IP representations, homograph attacks, blocked TLDs (`.local`, `.internal`, `.onion`, etc.)
5. **Config schema** — `x-portkey-config` parsed + validated via Zod (`src/middlewares/requestValidator/schema/config.ts`)
6. **Forward headers loop prevention** — `x-portkey-forward-headers` must not contain itself

Returns 400 on failure.

### 2.2 `hooks` (`src/middlewares/hooks/index.ts:551`)

Global middleware. Creates `HooksManager`, attaches to context via `c.set('hooksManager', ...)`. Calls `next()` immediately — actual hook execution happens in `tryPost()`.

### 2.3 `memoryCache()` (`src/middlewares/cache/index.ts:83`)

Only mounted when `conf.cache === true`.

**Before `next()`:** attaches `getFromCache` to context.

**After `next()`:** if non-streaming + `mode=simple`, calls `putInCache()`.
- Key: `SHA-256(JSON.stringify(requestBody) + "-" + url)`
- TTL: `cacheMaxAge` or 24h default
- Store: module-level `inMemoryCache` object

### 2.4 `logHandler()` (`src/middlewares/log/index.ts:87`)

Node.js only. Attaches `addLogClient`/`removeLogClient` to context. After response: broadcasts to SSE log clients. Payload: `{time, method, endpoint, status, duration, requestOptions}`.

---

## 3. Request Routing — Full Call Chain

```
HTTP Request
    |
[Hono Router]
    |
[requestValidator]
    |
[Handler]  (e.g. chatCompletionsHandler)
    constructConfigFromRequestHeaders()  <- builds Options|Targets from headers
    tryTargetsRecursively()
    |
    +-- FALLBACK:     iterate targets until success
    +-- LOADBALANCE:  weighted random selection
    +-- CONDITIONAL:  MongoDB-style query against metadata/params
    +-- SINGLE:       targets[0]
    +-- (leaf):       tryPost()
    |
[tryPost()]
    RequestContext
    HooksService.createSpan()            <- HookSpan with before/after hooks
    ProviderContext.getFullURL()         <- base URL + endpoint
    beforeRequestHookHandler()          <- guardrails/mutators; may deny (446)
    requestContext.transformToProviderRequestAndSave()  <- OpenAI -> provider format
    constructRequest()                  <- fetch headers + body
    CacheService.getCachedResponse()    <- per-request cache check
    PreRequestValidatorService()        <- virtual key budget check
    recursiveAfterRequestHookHandler()
        retryRequest()                  <- fetch + timeout + async-retry
        responseHandler()               <- streaming/non-streaming/audio/image
        afterRequestHookHandler()       <- after-request guardrails
    ResponseService.create()            <- append response headers
    LogObjectBuilder.log()
    |
HTTP Response
```

### 3.1 `constructConfigFromRequestHeaders()` (`src/handlers/handlerUtils.ts:836`)

**Path A — `x-portkey-config` present:**
- Parse JSON config
- Merge provider-specific sub-configs (azureConfig, awsConfig, etc.) if no `provider`/`targets`
- `convertKeysToCamelCase()` — snake_case → camelCase, preserving `override_params`, `conditions`

**Path B — `x-portkey-provider` only:**
- Construct `Options` directly from individual headers
- Provider-specific headers (`x-portkey-aws-region`, `x-portkey-vertex-project-id`, etc.) merged in

### 3.2 `tryTargetsRecursively()` (`src/handlers/handlerUtils.ts:476`)

1. Merges inherited config (retry, cache, overrideParams, forwardHeaders, customHost, requestTimeout, hooks) — child takes precedence
2. Converts shorthand guardrails → HookObject arrays
3. Filters circuit-open targets (`isOpen === true`) when config has `id`
4. Dispatches by strategy

**CONDITIONAL strategy** uses `ConditionalRouter` (`src/services/conditionalRouter.ts`). Operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$regex`, `$and`, `$or`. Evaluates against `{metadata, params, url}`.

---

## 4. Config System

### 4.1 Per-Request Config (x-portkey-config)

Full Zod-validated schema (`src/middlewares/requestValidator/schema/config.ts`):

```json
{
  "strategy": {
    "mode": "single|loadbalance|fallback|conditional",
    "on_status_codes": [429, 500],
    "conditions": [{ "query": {}, "then": "target-id" }],
    "default": "target-id"
  },
  "provider": "openai",
  "api_key": "sk-...",
  "targets": [],
  "retry": {
    "attempts": 3,
    "on_status_codes": [429, 500, 502, 503, 504],
    "use_retry_after_header": true
  },
  "cache": { "mode": "simple|semantic", "max_age": 86400000 },
  "weight": 1,
  "request_timeout": 30000,
  "custom_host": "https://...",
  "forward_headers": ["x-request-id"],
  "override_params": { "model": "gpt-4o" },
  "before_request_hooks": [],
  "after_request_hooks": [],
  "input_guardrails": [],
  "output_guardrails": [],
  "strict_open_ai_compliance": true
}
```

Schema is **recursive** via `z.lazy(() => configSchema)` for `targets` — enables arbitrarily deep routing trees.

### 4.2 Config → Runtime Behavior

| Field | Effect |
|---|---|
| `strategy.mode = fallback` | Iterate targets; next on failure or status in `on_status_codes` |
| `strategy.mode = loadbalance` | Weighted random selection |
| `strategy.mode = conditional` | Route by MongoDB-style query |
| `retry.attempts` | Max retries via `async-retry` |
| `retry.on_status_codes` | Trigger retry on these codes (default: 429,500,502,503,504) |
| `retry.use_retry_after_header` | Honor `Retry-After` / `retry-after-ms` header |
| `cache.mode = simple` | SHA-256 keyed response cache |
| `cache.max_age` | TTL ms (default 24h) |
| `override_params` | Deep-merged into request params |
| `request_timeout` | AbortController timeout per request |
| `forward_headers` | Pass-through to provider |
| `strict_open_ai_compliance = false` | Include `hook_results` in response |

### 4.3 `conf.json` — Server-Level Config

Controls server behavior, not per-request:

```json
{
  "plugins_enabled": ["default", "portkey", "qualifire", ...],
  "credentials": { "portkey": { "apiKey": "..." } },
  "cache": true
}
```

No Zod schema. Read raw at `src/index.ts:42`. Only fields consumed at runtime: `plugins_enabled`, `credentials`, `cache`, `integrations`.

---

## 5. Handler Architecture

All handlers follow identical pattern:

```typescript
export async function xyzHandler(c: Context): Promise<Response> {
  const request = await c.req.json();
  const requestHeaders = Object.fromEntries(c.req.raw.headers);
  const config = constructConfigFromRequestHeaders(requestHeaders);
  return tryTargetsRecursively(c, config, request, requestHeaders, 'endpointString', 'POST', 'config');
}
```

### Handler → Endpoint String Mapping

| File | Endpoint string | Route |
|---|---|---|
| `chatCompletionsHandler.ts` | `chatComplete` | POST /v1/chat/completions |
| `completionsHandler.ts` | `complete` | POST /v1/completions |
| `embeddingsHandler.ts` | `embed` | POST /v1/embeddings |
| `messagesHandler.ts` | `messages` | POST /v1/messages |
| `messagesCountTokensHandler.ts` | `messagesCountTokens` | POST /v1/messages/count_tokens |
| `imageGenerationsHandler.ts` | `imageGenerate` | POST /v1/images/generations |
| `imageEditsHandler.ts` | `imageEdit` | POST /v1/images/edits |
| `createSpeechHandler.ts` | `createSpeech` | POST /v1/audio/speech |
| `createTranscriptionHandler.ts` | `createTranscription` | POST /v1/audio/transcriptions |
| `createTranslationHandler.ts` | `createTranslation` | POST /v1/audio/translations |
| `filesHandler.ts` | `uploadFile`, `listFiles`, etc. | /v1/files/* |
| `batchesHandler.ts` | `createBatch`, `retrieveBatch`, etc. | /v1/batches/* |
| `modelResponsesHandler.ts` | `createModelResponse`, etc. | /v1/responses/* |
| `finetuneHandler.ts` | `createFinetune`, etc. | /v1/fine_tuning/jobs/* |
| `realtimeHandler.ts` | `realtime` (WebSocket) | GET /v1/realtime |
| `proxyHandler.ts` | `proxy` | /v1/* (catch-all) |

### Special Handlers

**`proxyHandler`** — catch-all, content-type-aware body parsing. `proxy` endpoint string skips param transformation.

**`realtimeHandler`** — WebSocket only (workerd). Creates `WebSocketPair`, proxies bidirectional messages. Uses `RealtimeLlmEventParser`.

**`modelsHandler`** — proxies to control plane if `ALBUS_BASEPATH` env set, else falls through to proxy handler.

---

## 6. Provider System

### Registry (`src/providers/index.ts:78`)

Plain object: `{ providerKey: ProviderConfigs }`. 60+ providers registered.

### `ProviderConfigs` Interface (`src/providers/types.ts:149`)

```typescript
interface ProviderConfigs {
  api: ProviderAPIConfig;                        // REQUIRED
  chatComplete?: ProviderConfig;                 // param mapping per endpoint
  complete?: ProviderConfig;
  embed?: ProviderConfig;
  // ... other endpoint configs
  responseTransforms?: {
    chatComplete?: Function;
    'stream-chatComplete'?: Function;
    // ... per endpoint
  };
  requestHandlers?: Record<string, RequestHandler>;  // custom fetch handler
  requestTransforms?: Record<string, Function>;      // request body transform
  getConfig?: ({ params, providerOptions }) => ProviderConfigs;  // dynamic config
}
```

### `ProviderAPIConfig` Interface (`src/providers/types.ts:47`)

```typescript
interface ProviderAPIConfig {
  getBaseURL: (args: { providerOptions, fn, c, gatewayRequestURL, params }) => string | Promise<string>;
  headers: (args: { c, providerOptions, fn, transformedRequestBody, ... }) => Record<string, any> | Promise<...>;
  getEndpoint: (args: { c, providerOptions, fn, gatewayRequestBodyJSON, ... }) => string;
  transformToFormData?: (args: { gatewayRequestBody }) => boolean;
  getProxyEndpoint?: (args: { providerOptions, reqPath, reqQuery }) => string;
}
```

### `ProviderConfig` (param mapping)

```typescript
interface ParameterConfig {
  param: string;          // provider param name (dot notation for nesting)
  default?: any;
  min?: number;
  max?: number;
  required?: boolean;
  transform?: (params, providerOptions) => any;
}
```

### Special Provider Patterns

**`getConfig()` — dynamic dispatch:** Bedrock and Vertex AI use this to select config based on model. Bedrock splits on `model.split('.')[0]` (model family prefix: `anthropic`, `cohere`, `ai21`, `amazon`, etc.).

**`requestHandlers` — bypass normal fetch:** Used for endpoints that can't use standard JSON fetch (e.g., `BedrockGetBatchOutputRequestHandler`, `OpenAIGetBatchOutputRequestHandler`).

**OpenAI compatibility layer** (`src/providers/open-ai-base/index.ts`):
- `chatCompleteParams(exclude[], defaultValues?, extra?)` — inherits all OpenAI params, excludes specified ones
- `responseTransformers(provider, options)` — for OpenAI-compatible providers, `chatComplete: true` means no transform needed
- Used by Groq, Cerebras, Mistral, 30+ others

---

## 7. Response Status Codes

| Condition | HTTP |
|---|---|
| Hook deny | 446 |
| Hooks failed (non-deny) | 246 |
| Request timeout | 408 |
| Invalid provider / RouterError | 400 |
| Provider unreachable | 503 |
| GatewayError | error.status |
| Unhandled exception | 500 |

---

## 8. Key Files

| File | Purpose |
|---|---|
| `src/index.ts` | Hono app, all routes, global middleware |
| `src/globals.ts` | HEADER_KEYS, RESPONSE_HEADER_KEYS, VALID_PROVIDERS |
| `src/types/requestBody.ts` | Options, Targets, RetrySettings, CacheSettings, StrategyModes |
| `src/middlewares/requestValidator/index.ts` | Input validation, SSRF protection |
| `src/middlewares/requestValidator/schema/config.ts` | Zod schema for x-portkey-config |
| `src/middlewares/hooks/index.ts` | HookSpan, HooksManager, hooks middleware |
| `src/middlewares/cache/index.ts` | Global memoryCache middleware |
| `src/handlers/handlerUtils.ts` | constructConfigFromRequestHeaders, tryTargetsRecursively, tryPost |
| `src/handlers/responseHandlers.ts` | responseHandler, afterRequestHookHandler |
| `src/handlers/retryHandler.ts` | retryRequest, timeout, Retry-After |
| `src/handlers/services/requestContext.ts` | Per-request state container |
| `src/handlers/services/providerContext.ts` | Provider config accessor |
| `src/handlers/services/hooksService.ts` | HooksService, HookSpan creation |
| `src/handlers/services/cacheService.ts` | Per-request LLM response cache |
| `src/handlers/services/responseService.ts` | Response assembly + header injection |
| `src/handlers/services/preRequestValidatorService.ts` | Virtual key budget check |
| `src/services/transformToProviderRequest.ts` | OpenAI params → provider-specific |
| `src/services/conditionalRouter.ts` | ConditionalRouter, MongoDB-style query eval |
| `src/providers/index.ts` | Provider registry (60+ providers) |
| `src/providers/types.ts` | ProviderAPIConfig, ProviderConfig, endpointStrings |
| `src/providers/open-ai-base/index.ts` | OpenAI compat layer (chatCompleteParams, responseTransformers) |
