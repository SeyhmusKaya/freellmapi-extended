import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolCall,
  ChatToolChoice,
  ChatToolDefinition,
  ChatContentPart,
  TokenUsage,
} from '@myllm/shared/types.js';
import { BaseProvider, type CompletionOptions, type ResponseFormat, type EmbedOptions, type EmbedResult } from './base.js';

/**
 * OpenAI `response_format` → Gemini `generationConfig`. Gemini uses
 * `responseMimeType` ("application/json" for structured output) and an
 * optional `responseSchema` for OpenAPI-style schema constraint. We only
 * forward the schema when the caller provided one; bare `json_object` just
 * flips the MIME type.
 */
// Gemini's `responseSchema` is a restricted OpenAPI 3.0 subset. Standard JSON
// Schema keywords it does NOT accept make the whole request 400. We recursively
// drop them so a normal OpenAI json_schema (which often carries
// additionalProperties / $ref / allOf / etc.) routes to Gemini cleanly instead
// of failing and cascading. The constraint is slightly looser (composition
// keywords are removed) but the request succeeds.
const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  'additionalProperties', 'unevaluatedProperties', 'uniqueItems',
  '$schema', '$id', '$ref', '$defs', 'definitions', '$comment',
  'allOf', 'oneOf', 'not', 'if', 'then', 'else',
  'const', 'examples', 'readOnly', 'writeOnly', 'deprecated',
  'prefixItems', 'contains', 'propertyNames', 'patternProperties',
  'multipleOf', 'dependencies', 'dependentRequired', 'dependentSchemas',
]);

export function stripGeminiSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripGeminiSchema);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(k)) continue;
      out[k] = stripGeminiSchema(v);
    }
    return out;
  }
  return node;
}

function applyResponseFormat(generationConfig: Record<string, unknown>, rf?: ResponseFormat): void {
  if (!rf) return;
  if (rf.type === 'json_object') {
    generationConfig.responseMimeType = 'application/json';
  } else if (rf.type === 'json_schema') {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = stripGeminiSchema(rf.json_schema.schema);
  }
}

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
const IMAGE_FETCH_TIMEOUT_MS = 15_000;

interface GeminiPart {
  text?: string;
  thoughtSignature?: string;
  inline_data?: {
    mime_type: string;
    data: string;
  };
  functionCall?: {
    id?: string;
    name?: string;
    args?: unknown;
  };
  functionResponse?: {
    id?: string;
    name?: string;
    response?: unknown;
  };
}

// SSRF guard — refuse to fetch private / link-local hosts. Provider modules
// pull image bytes when consumers pass an http(s) image_url; without this a
// caller can use MyLLM as a proxy to scan internal services.
function isPrivateHost(host: string): boolean {
  if (!host) return true;
  const h = host.toLowerCase();
  if (h === 'localhost') return true;
  if (h.endsWith('.local')) return true;
  // IPv4 literal checks
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;       // link-local / metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
  }
  // IPv6 loopback / link-local / unique-local
  if (h.startsWith('[::1]') || h === '::1') return true;
  if (h.startsWith('[fe80:') || h.startsWith('fe80:')) return true;
  if (h.startsWith('[fc') || h.startsWith('[fd') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

async function fetchImageAsInlineData(url: string): Promise<GeminiPart> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('image_url.url is not a valid URL');
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error('image_url host blocked (private/loopback)');
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`image fetch failed: HTTP ${res.status}`);
  const ct = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_MIME.includes(ct)) throw new Error(`image MIME not allowed: ${ct}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image too large: ${buf.length} > ${MAX_IMAGE_BYTES}`);
  return { inline_data: { mime_type: ct, data: buf.toString('base64') } };
}

async function partsFromContent(content: string | ChatContentPart[] | null | undefined): Promise<GeminiPart[]> {
  if (content == null) return [];
  if (typeof content === 'string') {
    return content.length > 0 ? [{ text: content }] : [];
  }
  const out: GeminiPart[] = [];
  for (const p of content) {
    if (p.type === 'text') {
      if (p.text.length > 0) out.push({ text: p.text });
    } else if (p.type === 'image_url') {
      const url = p.image_url.url;
      if (url.startsWith('data:')) {
        const m = url.match(/^data:(image\/[\w+.-]+);base64,(.+)$/i);
        if (!m) throw new Error('invalid data URL (expected data:image/<type>;base64,...)');
        const mime = m[1].toLowerCase();
        if (!ALLOWED_IMAGE_MIME.includes(mime)) throw new Error(`image MIME not allowed: ${mime}`);
        const approxBytes = Math.floor(m[2].length * 0.75);
        if (approxBytes > MAX_IMAGE_BYTES) throw new Error(`image too large: ${approxBytes} > ${MAX_IMAGE_BYTES}`);
        out.push({ inline_data: { mime_type: mime, data: m[2] } });
      } else if (url.startsWith('https://') || url.startsWith('http://')) {
        out.push(await fetchImageAsInlineData(url));
      } else {
        throw new Error('image_url.url must be data:image/* or http(s)://');
      }
    }
  }
  return out;
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { value: raw };
  }
}

function normalizeGeminiArgs(args: unknown): string {
  if (typeof args === 'string') return args;
  return JSON.stringify(args ?? {});
}

function toGeminiFinishReason(finishReason?: string): string {
  const r = (finishReason ?? '').toUpperCase();
  if (!r) return 'stop';
  if (r === 'MAX_TOKENS') return 'length';
  if (r === 'SAFETY' || r === 'RECITATION' || r === 'BLOCKLIST' || r === 'PROHIBITED_CONTENT' || r === 'SPII') {
    return 'content_filter';
  }
  return 'stop';
}

function toGeminiTools(tools?: ChatToolDefinition[]): Array<{ functionDeclarations: Array<Record<string, unknown>> }> | undefined {
  if (!tools || tools.length === 0) return undefined;

  return [{
    functionDeclarations: tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    })),
  }];
}

function toGeminiToolConfig(toolChoice?: ChatToolChoice): { functionCallingConfig: Record<string, unknown> } | undefined {
  if (!toolChoice) return undefined;

  if (typeof toolChoice === 'string') {
    const mode =
      toolChoice === 'none'
        ? 'NONE'
        : toolChoice === 'required'
          ? 'ANY'
          : 'AUTO';
    return { functionCallingConfig: { mode } };
  }

  return {
    functionCallingConfig: {
      mode: 'ANY',
      allowedFunctionNames: [toolChoice.function.name],
    },
  };
}

// Translate OpenAI messages to Gemini format. Now async because user messages
// may carry image_url parts that have to be fetched + base64'd into inline_data.
async function toGeminiContents(messages: ChatMessage[]) {
  const systemMessages = messages
    .filter(m => m.role === 'system' && typeof m.content === 'string' && m.content.length > 0)
    .map(m => m.content as string);

  const toolNameByCallId = new Map<string, string>();
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) {
      toolNameByCallId.set(tc.id, tc.function.name);
    }
  }

  const contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> = [];

  for (const m of messages) {
    if (m.role === 'system') continue;

    if (m.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (typeof m.content === 'string' && m.content.length > 0) {
        parts.push({ text: m.content });
      }
      for (const call of m.tool_calls ?? []) {
        parts.push({
          thoughtSignature: call.thought_signature,
          functionCall: {
            id: call.id,
            name: call.function.name,
            args: safeParseObject(call.function.arguments),
          },
        });
      }
      if (parts.length === 0) continue;
      contents.push({ role: 'model', parts });
      continue;
    }

    if (m.role === 'tool') {
      const toolCallId = m.tool_call_id;
      if (!toolCallId) continue;
      const toolName = m.name ?? toolNameByCallId.get(toolCallId) ?? 'tool';
      const response = safeParseObject(typeof m.content === 'string' ? m.content : '');
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: { id: toolCallId, name: toolName, response },
        }],
      });
      continue;
    }

    // user role — content may be string or ChatContentPart[]
    const parts = await partsFromContent(m.content);
    if (parts.length === 0) parts.push({ text: '' });
    contents.push({ role: 'user', parts });
  }

  return {
    contents,
    systemInstruction: systemMessages.length > 0
      ? { parts: [{ text: systemMessages.join('\n\n') }] }
      : undefined,
  };
}

function extractToolCalls(parts: GeminiPart[] | undefined): ChatToolCall[] {
  const calls: ChatToolCall[] = [];
  if (!parts) return calls;

  let fallbackIndex = 0;
  for (const part of parts) {
    if (!part.functionCall?.name) continue;

    const id = part.functionCall.id ?? `call_${Date.now()}_${fallbackIndex++}`;
    calls.push({
      id,
      type: 'function',
      function: {
        name: part.functionCall.name,
        arguments: normalizeGeminiArgs(part.functionCall.args),
      },
      thought_signature: part.thoughtSignature,
    });
  }

  return calls;
}

function extractText(parts: GeminiPart[] | undefined): string | null {
  if (!parts) return null;
  const text = parts
    .map(p => p.text ?? '')
    .join('');
  return text.length > 0 ? text : null;
}

export class GoogleProvider extends BaseProvider {
  readonly platform = 'google' as const;
  readonly name = 'Google AI Studio';

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const { contents, systemInstruction } = await toGeminiContents(messages);

    const generationConfig: Record<string, unknown> = {
      temperature: options?.temperature,
      maxOutputTokens: options?.max_tokens,
      topP: options?.top_p,
    };
    applyResponseFormat(generationConfig, options?.response_format);

    const body: Record<string, unknown> = {
      contents,
      generationConfig,
      tools: toGeminiTools(options?.tools),
      toolConfig: toGeminiToolConfig(options?.tool_choice),
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    const url = `${API_BASE}/models/${modelId}:generateContent?key=${apiKey}`;
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Google API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const data = await res.json() as GeminiResponse;
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts;
    const toolCalls = extractToolCalls(parts);
    const text = extractText(parts);

    const usage: TokenUsage = {
      prompt_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: data.usageMetadata?.totalTokenCount ?? 0,
    };

    return {
      id: this.makeId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : toGeminiFinishReason(candidate?.finishReason),
      }],
      usage,
      _routed_via: { platform: 'google', model: modelId },
    };
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const { contents, systemInstruction } = await toGeminiContents(messages);

    const generationConfig: Record<string, unknown> = {
      temperature: options?.temperature,
      maxOutputTokens: options?.max_tokens,
      topP: options?.top_p,
    };
    applyResponseFormat(generationConfig, options?.response_format);

    const body: Record<string, unknown> = {
      contents,
      generationConfig,
      tools: toGeminiTools(options?.tools),
      toolConfig: toGeminiToolConfig(options?.tool_choice),
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    const url = `${API_BASE}/models/${modelId}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Google API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    const id = this.makeId();
    let buffer = '';
    let emittedFinish = false;
    let sawToolCalls = false;

    const seenToolCallKeys = new Set<string>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const raw = trimmed.slice(6);
        if (raw === '[DONE]') {
          if (!emittedFinish) {
            emittedFinish = true;
            yield {
              id,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: sawToolCalls ? 'tool_calls' : 'stop',
              }],
            };
          }
          return;
        }

        const chunk = JSON.parse(raw) as GeminiResponse;
        const candidate = chunk.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];

        const text = extractText(parts);
        const toolCalls = extractToolCalls(parts).filter(call => {
          const key = `${call.id}:${call.function.name}:${call.function.arguments}`;
          if (seenToolCallKeys.has(key)) return false;
          seenToolCallKeys.add(key);
          return true;
        });

        if ((text && text.length > 0) || toolCalls.length > 0) {
          sawToolCalls = sawToolCalls || toolCalls.length > 0;
          yield {
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{
              index: 0,
              delta: {
                ...(text ? { content: text } : {}),
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: null,
            }],
          };
        }

        if (candidate?.finishReason && !emittedFinish) {
          emittedFinish = true;
          yield {
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: sawToolCalls ? 'tool_calls' : toGeminiFinishReason(candidate.finishReason),
            }],
          };
          return;
        }
      }
    }

    if (!emittedFinish) {
      yield {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: sawToolCalls ? 'tool_calls' : 'stop',
        }],
      };
    }
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Transport errors propagate — health.ts marks status='error' without
    // counting toward auto-disable. Only confirmed 401/403 disables a key.
    const res = await this.fetchWithTimeout(
      `${API_BASE}/models?key=${apiKey}`,
      { method: 'GET' },
      10000,
    );
    return res.status !== 401 && res.status !== 403;
  }

  /**
   * Text embeddings via Gemini :batchEmbedContents (array form).
   *
   * Endpoint: POST {base}/models/{model}:batchEmbedContents?key={apiKey}
   *   body  : {requests: [{model: 'models/{m}', content: {parts:[{text}]}}, ...]}
   *   reply : {embeddings: [{values: [float,...]}, ...]}
   *
   * Supported model_id (V30 catalog): `gemini-embedding-001` (768-d default,
   * Matryoshka — can request 256/512/768 via options.dimensions).
   *
   * Per-call max ~100 inputs; we chunk over MAX_BATCH if caller goes higher.
   */
  async embed(
    apiKey: string,
    modelId: string,
    input: string[],
    options?: EmbedOptions,
  ): Promise<EmbedResult> {
    const MAX_BATCH = 100;
    const url = `${API_BASE}/models/${modelId}:batchEmbedContents?key=${apiKey}`;
    const allVectors: number[][] = [];

    for (let i = 0; i < input.length; i += MAX_BATCH) {
      const slice = input.slice(i, i + MAX_BATCH);
      const requests = slice.map(t => {
        const req: Record<string, unknown> = {
          model: `models/${modelId}`,
          content: { parts: [{ text: t }] },
        };
        if (options?.dimensions != null) req.outputDimensionality = options.dimensions;
        return req;
      });
      const res = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
      }, 30000);
      if (!res.ok) {
        let msg = res.statusText;
        try { const e = await res.json() as any; msg = e.error?.message ?? msg; } catch {}
        throw new Error(`Google embed API error ${res.status}: ${msg}`);
      }
      const data = await res.json() as { embeddings?: Array<{ values: number[] }> };
      if (!data.embeddings) throw new Error(`Google embed API: empty response from ${modelId}`);
      for (const e of data.embeddings) allVectors.push(e.values);
    }

    if (!allVectors.length) throw new Error(`Google embed API: empty response from ${modelId}`);
    return {
      vectors: allVectors,
      promptTokens: Math.ceil(input.reduce((s, t) => s + t.length, 0) / 4),
      dimensions: allVectors[0]?.length ?? 0,
    };
  }
}
