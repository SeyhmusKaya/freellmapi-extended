import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Platform,
} from '@myllm/shared/types.js';
import { BaseProvider, type CompletionOptions, type EmbedOptions, type EmbedResult } from './base.js';

/**
 * Generic provider for platforms that use an OpenAI-compatible API.
 * Covers: Groq, Cerebras, SambaNova, NVIDIA NIM, Mistral, OpenRouter,
 * GitHub Models, Fireworks AI.
 */
export class OpenAICompatProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  /** Keyless providers (Kilo's anonymous gateway, etc.) set this false so the
   *  router synthesizes a placeholder key row and we send NO Authorization
   *  header (an empty `Bearer ` is rejected by some gateways). */
  readonly requiresApiKey: boolean;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly validateUrl?: string;
  /** Per-provider HTTP timeout override. Cloud APIs finish in ~15s; locally-hosted
   * inference (llama.cpp / vLLM on CPU) can take 30-120s for long prompts. Default 15000. */
  private readonly timeoutMs: number;

  constructor(opts: {
    platform: Platform;
    name: string;
    baseUrl: string;
    extraHeaders?: Record<string, string>;
    validateUrl?: string;
    timeoutMs?: number;
    requiresApiKey?: boolean;
  }) {
    super();
    this.platform = opts.platform;
    this.name = opts.name;
    this.baseUrl = opts.baseUrl;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.validateUrl = opts.validateUrl;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.requiresApiKey = opts.requiresApiKey ?? true;
  }

  /** Authorization header — omitted for keyless providers when apiKey is empty,
   *  so anonymous gateways don't see a malformed `Bearer ` token. */
  private authHeaders(apiKey: string): Record<string, string> {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(apiKey),
        'Content-Type': 'application/json',
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        response_format: options?.response_format,
      }),
    }, options?.timeoutMs ?? this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const data = await res.json() as ChatCompletionResponse;
    normalizeChoices(data);
    data._routed_via = { platform: this.platform, model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(apiKey),
        'Content-Type': 'application/json',
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        response_format: options?.response_format,
        stream: true,
      }),
    }, options?.timeoutMs ?? this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data) as ChatCompletionChunk;
        } catch {
          // Skip malformed chunks
        }
      }
    }
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Note: transport errors (DNS / timeout / TLS) propagate to the caller.
    // health.ts catches them and marks status='error' WITHOUT incrementing
    // the consecutive-failure counter — only confirmed 401/403 disables a key.
    const url = this.validateUrl ?? `${this.baseUrl}/models`;
    // 20s timeout: some providers (Ollama Cloud, OpenRouter under load) take
    // 10-15s for /models even when the key is healthy. 10s previously caused
    // benign abort warnings in the log every few sweeps.
    const res = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        ...this.authHeaders(apiKey),
        ...this.extraHeaders,
      },
    }, 20000);
    return res.status !== 401 && res.status !== 403;
  }

  /**
   * OpenAI-compatible /v1/embeddings. Used by Mistral, Zhipu, GitHub Models,
   * NVIDIA NIM, OpenRouter, and any other provider whose embedding endpoint
   * matches the OpenAI shape:
   *   POST {baseUrl}/embeddings  body {model, input, dimensions?}
   *   reply {object:'list', data:[{embedding:[...],index}], usage:{prompt_tokens}}
   *
   * Cohere is NOT routed through here — it uses its own /v1/embed endpoint
   * with different field names. See cohere.ts.
   */
  async embed(
    apiKey: string,
    modelId: string,
    input: string[],
    options?: EmbedOptions,
  ): Promise<EmbedResult> {
    const url = `${this.baseUrl}/embeddings`;
    const body: Record<string, unknown> = {
      model: modelId,
      input,
    };
    if (options?.dimensions != null) body.dimensions = options.dimensions;
    // NVIDIA NIM embed-qa models REQUIRE `input_type` ('query'|'passage');
    // others ignore the field. Default to 'query' so RAG search flows work
    // out of the box; client can override via EmbedOptions.inputType.
    if (this.platform === 'nvidia') {
      body.input_type = options?.inputType === 'search_document' ? 'passage' : 'query';
      body.truncate = 'NONE';
    }

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        ...this.authHeaders(apiKey),
        'Content-Type': 'application/json',
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
    }, this.timeoutMs);

    if (!res.ok) {
      let msg = res.statusText;
      try {
        const e = await res.json() as any;
        msg = e.error?.message ?? e.message ?? msg;
      } catch {}
      throw new Error(`${this.name} embed API error ${res.status}: ${msg}`);
    }

    const data = await res.json() as {
      data?: Array<{ embedding: number[]; index?: number }>;
      usage?: { prompt_tokens?: number; total_tokens?: number };
      model?: string;
    };

    if (!data.data || data.data.length === 0) {
      throw new Error(`${this.name} embed API: empty response from ${modelId}`);
    }

    // Preserve input-array order even if the upstream re-shuffled (some
    // providers return data sorted by index, others by submission order).
    const sorted = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = sorted.map(d => d.embedding);
    const dimensions = vectors[0]?.length ?? 0;
    const promptTokens = data.usage?.prompt_tokens
      ?? Math.ceil(input.reduce((s, t) => s + t.length, 0) / 4);

    return { vectors, promptTokens, dimensions };
  }
}

/**
 * Some providers (Z.ai glm-4.5-flash, Cloudflare DeepSeek-R1-distill, others)
 * return reasoning models' actual answer in `message.reasoning_content` with
 * `message.content === ""`. Fold reasoning_content into content so OpenAI-
 * compatible clients see a non-empty assistant message.
 *
 * Other providers (Mistral magistral-medium) return `message.content` as an
 * array of text segments instead of a string. Flatten to string.
 */
function normalizeChoices(data: ChatCompletionResponse): void {
  for (const choice of data.choices ?? []) {
    const msg = choice.message as ChatMessage & {
      reasoning_content?: string;
      reasoning?: string;
      content: unknown;
    };
    // Flatten array content (Mistral magistral) → join text segments.
    if (Array.isArray(msg.content)) {
      msg.content = (msg.content as Array<{ text?: string; type?: string }>)
        .map(seg => (typeof seg === 'string' ? seg : (seg.text ?? '')))
        .join('');
    }
    // Fold reasoning into content if content is empty AND there are no
    // tool_calls. With tool_calls present, content=null is the correct OpenAI
    // shape; folding reasoning would confuse clients that branch on content.
    // Field naming varies by provider: Z.ai uses `reasoning_content`, Ollama
    // uses `reasoning`. Prefer `reasoning_content` when both are set.
    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    if (!hasToolCalls && (msg.content === '' || msg.content == null)) {
      const fold = (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0)
        ? msg.reasoning_content
        : (typeof msg.reasoning === 'string' && msg.reasoning.length > 0 ? msg.reasoning : null);
      if (fold !== null) msg.content = fold;
    }
  }
}
