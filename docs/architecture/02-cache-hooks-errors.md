# Portkey AI Gateway — Architecture: Cache, Hooks, Errors, Transformation, Retry, Load Balancing

## 1. System Overview

```
HTTP Request
    |
    v
[compression]           src/index.ts:57
[requestValidator]      src/middlewares/requestValidator/index.ts:85
[hooks middleware]      src/middlewares/hooks/index.ts:551   <- creates HooksManager
[memoryCache]           src/middlewares/cache/index.ts:83    <- injects getFromCache fn
    |
    v
[route handler]         e.g. src/handlers/chatCompletionsHandler.ts:16
    constructConfigFromRequestHeaders()
    tryTargetsRecursively()
    |
    v
[tryPost()]             src/handlers/handlerUtils.ts:288
    HooksService -> HookSpan
    CacheService.getCachedResponse()
    recursiveAfterRequestHookHandler()
    |
    v
[retryRequest()]        src/handlers/retryHandler.ts:65
[responseHandler()]     src/handlers/responseHandlers.ts:38
[afterRequestHookHandler()]
    |
    v
HTTP Response
```

---

## 2. Cache System

### Two-Layer Architecture

**Layer 1 — Shared CacheService (infrastructure):** `src/shared/services/cache/index.ts`
General-purpose KV cache with pluggable backends. Used for tokens, sessions, configs, OAuth, MCP. NOT for LLM response caching.

**Layer 2 — Handler CacheService (LLM response cache):** `src/handlers/services/cacheService.ts`
Used within `tryPost()`. Delegates to `getFromCache` injected by memoryCache middleware.

### Layer 1: Shared CacheService Backends

| Backend | File | Notes |
|---|---|---|
| MemoryCacheBackend | backends/memory.ts | In-process Map |
| FileCacheBackend | backends/file.ts | Map + JSON file, debounced saves (1s) |
| RedisCacheBackend | backends/redis.ts | ioredis, SETEX for TTL |
| CloudflareKVCacheBackend | backends/cloudflareKV.ts | KV binding wrapper |

**CacheBackend interface** (`src/shared/services/cache/types.ts:28`):
```typescript
interface CacheBackend {
  get<T>(key: string, namespace?: string): Promise<CacheEntry<T> | null>
  set<T>(key: string, value: T, options?: CacheOptions): Promise<void>
  delete(key: string, namespace?: string): Promise<boolean>
  clear(namespace?: string): Promise<void>
  has(key: string, namespace?: string): Promise<boolean>
  keys(namespace?: string): Promise<string[]>
  cleanup(): Promise<void>
  close(): Promise<void>
}
```

**Named cache instances by runtime:**

| Instance | Local | Redis | CF Workers | TTL |
|---|---|---|---|---|
| defaultCache | memory | redis | KV:default | 5 min |
| tokenCache | memory | memory | KV:token | 5–10 min |
| sessionCache | file | redis | KV:session | 30 min |
| configCache | memory | redis | KV:config | 30 days |
| oauthStore | file | redis | KV:oauth | none |
| mcpServersCache | file | redis | KV:mcp | none |

Key format: `{dbName}:{namespace}:{key}`

### Layer 2: LLM Response Cache

**Cache key generation** (`src/middlewares/cache/index.ts:14`):
```
key = SHA-256( JSON.stringify(requestBody) + "-" + url )
```

**Cache modes** (`Options.cache`):
- `simple` — exact match
- `semantic` — placeholder, not implemented in OSS
- `DISABLED` — no caching

**TTL:** `Options.cache.maxAge` ms. Default: 24h.

**Force refresh:** `x-portkey-cache-force-refresh` header → status `REFRESH`.

**Non-cacheable endpoints:** `uploadFile`, `listFiles`, `retrieveFile`, `deleteFile`, `retrieveFileContent`, `createBatch`, `retrieveBatch`, `cancelBatch`, `listBatches`, `getBatchOutput`, `listFinetunes`, `createFinetune`, `retrieveFinetune`, `cancelFinetune`, `imageEdit`.

**Stream requests are never cached** (`src/middlewares/cache/index.ts:70`).

**Cache flow in `tryPost()`:**
```
CacheService.getCachedResponse()
    +-- not cacheable?  -> DISABLED
    +-- no getFromCache fn or mode? -> DISABLED
    +-- getFromCache(env, headers, body, endpoint, key, mode, maxAge)
         HIT  -> Response(200), merge beforeRequestHooksResult
         MISS -> { cacheResponse: undefined, cacheStatus: "MISS" }
```

**putInCache** runs after `next()` in memoryCache middleware. Only for `mode=simple`, non-streaming.

---

## 3. Hook System

### Architecture

```
hooks middleware
    HooksManager created, stored on ctx

HooksService (per request in tryPost())
    HookSpan via hooksManager.createSpan()
        holds: context (request/response json+text)
               beforeRequestHooks[], afterRequestHooks[]

HooksManager.executeHooks(spanId, eventTypePresets, options)
    parallel Promise.all or sequential for-loop per hook
    shouldDeny = any hook: deny:true AND verdict:false
```

### Hook Types

| Type | Behavior |
|---|---|
| `GUARDRAIL` | evaluates checks, verdict pass/fail, can deny (HTTP 446) |
| `MUTATOR` | transforms request or response JSON |

### HookObject Schema (`src/middlewares/hooks/types.ts:17`)

```typescript
interface HookObject {
  type: 'guardrail' | 'mutator'
  id: string
  checks?: Check[]           // [{ id: "default.regexMatch", parameters: {...} }]
  async?: boolean            // fire-and-forget
  sequential?: boolean       // checks run serially vs parallel
  deny?: boolean             // block with 446 on verdict=false
  eventType: 'beforeRequestHook' | 'afterRequestHook'
}
```

### Execution Flow

**Before request** (`beforeRequestHookHandler`, `src/handlers/handlerUtils.ts:1300`):
```
executeHooks(spanId, ['syncBeforeRequestHook'])
    shouldDeny -> Response(446, { error: 'hooks_failed', hook_results })
    isTransformed -> use span.getContext().request.json as new body
    else -> continue to cache + LLM call
```

**After request** (`afterRequestHookHandler`, `src/handlers/responseHandlers.ts:223`):
```
setSpanContextResponse(spanId, responseJSON, status)
executeHooks(spanId, ['syncAfterRequestHook'])
    shouldDeny          -> Response(446)
    failedHooks + 200   -> Response(246, data + hook_results)
    isTransformed       -> use span.getContext().response.json
    else                -> Response(original_status, data + hook_results)
```

**Skip conditions:**
- Request type not in `chatComplete | complete | embed | messages`
- Embed + afterRequestHook or MUTATOR
- afterRequestHook when status != 200
- beforeRequestHook when parentHookSpanId != null (nested spans)
- MUTATOR with async=true

**Plugin dispatch:**
```typescript
const [source, fn] = check.id.split('.')
plugins[source][fn](context, check.parameters, eventType, options)
```

### Status Codes

| Scenario | HTTP |
|---|---|
| Hook deny (before or after) | 446 |
| Hooks failed (non-deny) | 246 |
| Normal success | 200 |

---

## 4. Error Handling

### Error Classes

**GatewayError** (`src/errors/GatewayError.ts`):
```typescript
class GatewayError extends Error {
  status: number  // default 500
}
```
Sets `x-portkey-gateway-exception: true` — stops fallback loop.

**RouterError** (`src/errors/RouterError.ts`): thrown by ConditionalRouter → HTTP 400.

### generateErrorResponse / generateInvalidProviderResponseError

**File:** `src/providers/utils.ts`

```typescript
// Normalize provider error to OpenAI format
generateErrorResponse({ message, type, param, code }, provider): ErrorResponse
// Returns: { error: { message: "${provider} error: ${message}", type, param, code }, provider }

generateInvalidProviderResponseError(response, provider): ErrorResponse
// Returns: { error: { message: "Invalid response received from ${provider}: ..." }, provider }
```

These are **god nodes** — called by every provider's error transform, hence 54 and 91 edges in the graph.

### Error Propagation

```
Provider API error (4xx/5xx)
    |
    v
retryRequest()
    status in statusCodesToRetry? -> throw (triggers retry)
    status 200-204               -> success
    other status                 -> bail() (no retry)
    network error                -> Response(503/500)
    |
    v
responseHandler()
    responseTransformerFunction(response, status)
        status != 200 && 'error' in response
            -> ProviderErrorResponseTransform(response, provider)
               -> generateErrorResponse(...)
               -> { error: { message: "openai error: ..." }, provider }
    |
    v
afterRequestHookHandler()
    wrap with hook_results if any
    |
    v
ResponseService.updateHeaders()
    x-portkey-cache-status, x-portkey-retry-attempt-count, etc.
    |
    v
Client receives normalized OpenAI-format error JSON
```

**tryTargetsRecursively** on unhandled throw:
```typescript
response = new Response(JSON.stringify({ status: 'failure', message }), {
  status: error instanceof GatewayError ? error.status : 500,
  headers: { 'x-portkey-gateway-exception': 'true' }
})
```

### HTTP Status Reference

| Condition | Status |
|---|---|
| Hook deny | 446 |
| Hooks failed | 246 |
| Request timeout | 408 |
| Invalid provider / RouterError | 400 |
| Provider unreachable | 503 |
| GatewayError | error.status |
| Unhandled exception | 500 |

---

## 5. Request/Response Transformation Pipeline

### Request

**Entry:** `RequestContext.transformToProviderRequestAndSave()` (`src/handlers/services/requestContext.ts:211`)

```
transformToProviderRequestJSON()
    |
    ProviderConfigs[provider][fn]  (or via getConfig() for dynamic)
    |
    transformUsingProviderConfig(providerConfig, params, providerOptions)
        for each configParam:
            getValue():
                paramConfig.transform? -> apply fn
                'portkey-default'?     -> use paramConfig.default
                < min?                 -> clamp
                > max?                 -> clamp
            setNestedProperty(result, paramConfig.param, value)
    |
    transformedRequest (provider-native field names)
```

Special cases bypass JSON transform: `uploadFile`, FormData, ArrayBuffer, `proxy` endpoint.

### Response

**Transformer selection** (`src/handlers/responseHandlers.ts:38`):

| Condition | Transformer |
|---|---|
| streaming + success + !cacheHit | `providerTransformers['stream-{fn}']` |
| non-streaming + !cacheHit | `providerTransformers[fn]` |
| streaming + cacheHit | `OpenAIChatCompleteJSONToStreamResponseTransform` |
| non-streaming + cacheHit | none (already normalized) |

**Non-streaming:** `response.json()` → transformer → `new Response(JSON.stringify(result))`

**Streaming (SSE):**
```
TransformStream { readable, writable }
readStream(reader, splitPattern='\n\n', transformFn)
    buffer until splitPattern found
    apply transformFn per SSE chunk
    writer.write(encoder.encode(normalizedChunk))
```

**AWS Bedrock binary stream:** `readAWSStream()` — parses 4-byte prelude (total length + headers length), extracts payload, base64-decodes `bytes` field, applies transform.

**Google/Cohere JSON streams:** newline-delimited JSON, gateway forces `content-type: text/event-stream`.

**strictOpenAiCompliance** (`x-portkey-strict-open-ai-compliance: false`): when false, provider-specific fields and hook_results pass through.

---

## 6. Retry and Fallback

### Retry Config (`src/types/requestBody.ts:8`)

```typescript
interface RetrySettings {
  attempts: number
  onStatusCodes: number[]        // default: [429, 500, 502, 503, 504]
  useRetryAfterHeader?: boolean  // honor Retry-After on 429
}
```

### retryRequest Algorithm (`src/handlers/retryHandler.ts:65`)

Uses `async-retry` library:
```
for each attempt:
    fetchWithTimeout(url, options, timeout)
        timeout -> AbortController -> Response(408)

    status in statusCodesToRetry?
        YES:
            429 + useRetryAfterHeader?
                parse retry-after-ms | x-ms-retry-after-ms | retry-after header
                > MAX_RETRY_LIMIT_MS (60s)? -> bail (no retry)
                setTimeout(retryAfter) -> throw (retry with provider delay)
            else -> throw (triggers async-retry backoff)
    
    200-204 -> success
    other   -> bail() (propagate, no retry)

catch:
    ConnectTimeoutError -> Response(503)
    TypeError           -> Response(500)
```

### recursiveAfterRequestHookHandler (`src/handlers/handlerUtils.ts:1182`)

```
retryRequest() -> { response, retryCount, createdAt, skip }
responseHandler() -> { mappedResponse, responseJson }
afterRequestHookHandler() -> arhResponse

remainingRetries = retry.attempts - retryCount - retryAttemptsMade
if remainingRetries > 0 && !skip && retriableStatus:
    recurse (after-hooks can trigger retries)

return { mappedResponse, retryCount, createdAt }
```

After-request hooks can influence retry — if a hook transforms a 200 into a retriable status, the system retries.

### Fallback (`tryTargetsRecursively` strategy=fallback)

```
for each target:
    response = tryTargetsRecursively(c, target)
    
    break if:
        onStatusCodes provided && status NOT in onStatusCodes (success)
        onStatusCodes not provided && response.ok
        x-portkey-gateway-exception: true header (stop fallback)
    
    else: continue to next target
```

**Config inheritance:** parent retry/cache/overrideParams/forwardHeaders/hooks cascade to children; child values take precedence.

---

## 7. Load Balancing

**Strategy:** Weighted random, stateless (`src/handlers/handlerUtils.ts:693`).

```
totalWeight = sum(target.weight ?? 1)
r = Math.random() * totalWeight

for each target:
    if r < target.weight: select, break
    r -= target.weight
```

Weights `[1, 2, 1]` → probabilities `25% / 50% / 25%`.

Circuit-open targets are filtered out before weight calculation.

**Edge case:** all weight=0 → no target selected → undefined response (bug).

---

## 8. Key Files

| File | Role |
|---|---|
| `src/middlewares/cache/index.ts` | memoryCache middleware, SHA-256 key, getFromCache/putInCache |
| `src/middlewares/hooks/index.ts` | HookSpan, HooksManager, hooks middleware |
| `src/middlewares/hooks/types.ts` | HookObject, Check, HookSpanContext, HookResult |
| `src/handlers/handlerUtils.ts` | tryTargetsRecursively, tryPost, recursiveAfterRequestHookHandler, beforeRequestHookHandler |
| `src/handlers/retryHandler.ts` | retryRequest, timeout, Retry-After logic |
| `src/handlers/responseHandlers.ts` | responseHandler, afterRequestHookHandler |
| `src/handlers/streamHandler.ts` | readStream, readAWSStream, handleStreamingMode, JSON→stream |
| `src/handlers/services/cacheService.ts` | LLM response cache, endpoint cacheability |
| `src/shared/services/cache/index.ts` | Unified CacheService, backend factories |
| `src/shared/services/cache/types.ts` | CacheBackend interface, CacheEntry, CacheOptions |
| `src/services/transformToProviderRequest.ts` | transformUsingProviderConfig, getValue, setNestedProperty |
| `src/providers/utils.ts` | generateErrorResponse, generateInvalidProviderResponseError |
| `src/errors/GatewayError.ts` | GatewayError (stops fallback) |
| `src/errors/RouterError.ts` | RouterError (400 on conditional routing failure) |
| `src/types/requestBody.ts` | Options, RetrySettings, CacheSettings, Params, Targets |
| `src/globals.ts` | HEADER_KEYS, RETRY_STATUS_CODES, MAX_RETRY_LIMIT_MS |
