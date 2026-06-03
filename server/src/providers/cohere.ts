import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@myllm/shared/types.js';
import { BaseProvider, type CompletionOptions, type EmbedOptions, type EmbedResult, type RerankOptions, type RerankResult } from './base.js';

const API_BASE = 'https://api.cohere.ai/compatibility/v1';

export class CohereProvider extends BaseProvider {
  readonly platform = 'cohere' as const;
  readonly name = 'Cohere';

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      temperature: options?.temperature,
      max_tokens: options?.max_tokens,
      top_p: options?.top_p,
      tools: options?.tools,
      tool_choice: options?.tool_choice,
      response_format: options?.response_format,
    };

    const res = await this.fetchWithTimeout(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Cohere API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const data = await res.json() as ChatCompletionResponse;
    data._routed_via = { platform: 'cohere', model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      temperature: options?.temperature,
      max_tokens: options?.max_tokens,
      top_p: options?.top_p,
      tools: options?.tools,
      tool_choice: options?.tool_choice,
      response_format: options?.response_format,
      stream: true,
    };

    const res = await this.fetchWithTimeout(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Cohere API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
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
    // Transport errors propagate — health.ts marks status='error' without
    // counting toward auto-disable. Only confirmed 401/403 disables a key.
    const res = await this.fetchWithTimeout(`${API_BASE}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, 10000);
    return res.status !== 401 && res.status !== 403;
  }

  /**
   * Cohere embeddings via the native /v2/embed endpoint.
   *
   * Cohere does NOT use the OpenAI shape:
   *   POST https://api.cohere.com/v2/embed
   *   body  : {model, texts: [...], input_type, embedding_types: ["float"]}
   *   reply : {embeddings: {float: [[...],...]}, meta:{billed_units:{input_tokens}}}
   *
   * input_type is REQUIRED on embed-v3+ models. Defaults to 'search_document'
   * which is right for indexing flows; clients can override via options.
   *
   * Catalog model_ids (V30):
   *   - embed-english-v3.0   (1024d)
   *   - embed-multilingual-v3.0 (1024d) — default for non-English
   *   - embed-v4.0 (128k ctx, 1024d default) — latest multilingual
   */
  async embed(
    apiKey: string,
    modelId: string,
    input: string[],
    options?: EmbedOptions,
  ): Promise<EmbedResult> {
    const url = 'https://api.cohere.com/v2/embed';
    const body: Record<string, unknown> = {
      model: modelId,
      texts: input,
      input_type: options?.inputType ?? 'search_document',
      embedding_types: ['float'],
    };

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, 30000);

    if (!res.ok) {
      let msg = res.statusText;
      try { const e = await res.json() as any; msg = e.message ?? msg; } catch {}
      throw new Error(`Cohere embed API error ${res.status}: ${msg}`);
    }

    const data = await res.json() as {
      embeddings?: { float?: number[][] };
      meta?: { billed_units?: { input_tokens?: number } };
    };
    const vectors = data.embeddings?.float ?? [];
    if (!vectors.length) throw new Error(`Cohere embed API: empty response from ${modelId}`);
    const promptTokens = data.meta?.billed_units?.input_tokens
      ?? Math.ceil(input.reduce((s, t) => s + t.length, 0) / 4);
    return { vectors, promptTokens, dimensions: vectors[0]?.length ?? 0 };
  }

  /**
   * Cohere rerank-v3.5 / rerank-v4.0 via the native /v2/rerank endpoint.
   *
   *   POST https://api.cohere.com/v2/rerank
   *   body  : {model, query, documents: [str,...], top_n?, max_chunks_per_doc?}
   *   reply : {results: [{index, relevance_score}], meta:{billed_units:{search_units}}}
   *
   * Cohere returns `results` sorted by score DESC. `index` references the
   * caller's documents[] array position. Free trial: 1000 calls/month.
   * Catalog model_ids (V34): rerank-v3.5, rerank-v4.0-fast, rerank-v4.0-pro.
   */
  async rerank(
    apiKey: string,
    modelId: string,
    query: string,
    documents: string[],
    options?: RerankOptions,
  ): Promise<RerankResult> {
    const body: Record<string, unknown> = { model: modelId, query, documents };
    if (options?.topN != null) body.top_n = options.topN;
    if (options?.maxChunksPerDoc != null) body.max_chunks_per_doc = options.maxChunksPerDoc;

    const res = await this.fetchWithTimeout('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 30000);

    if (!res.ok) {
      let msg = res.statusText;
      try { const e = await res.json() as any; msg = e.message ?? msg; } catch {}
      throw new Error(`Cohere rerank API error ${res.status}: ${msg}`);
    }

    const data = await res.json() as {
      results?: Array<{ index: number; relevance_score: number }>;
      meta?: { billed_units?: { search_units?: number } };
    };
    if (!data.results) throw new Error(`Cohere rerank API: empty results from ${modelId}`);
    return {
      results: data.results.map(r => ({ index: r.index, relevanceScore: r.relevance_score })),
      searchUnits: data.meta?.billed_units?.search_units ?? 1,
    };
  }
}
