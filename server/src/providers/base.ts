import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolDefinition,
  ChatToolChoice,
  Platform,
} from '@myllm/shared/types.js';

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name?: string; schema: Record<string, unknown>; strict?: boolean } };

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
  response_format?: ResponseFormat;
  /** Per-request HTTP timeout override (ms). Frontier models legitimately
   *  take longer than the 15s provider default; runChatCompletion raises it
   *  for large models so a slow-but-valid completion is not aborted. */
  timeoutMs?: number;
}

export interface ImageGenerationOptions {
  n?: number;
  size?: string;
  negative_prompt?: string;
  seed?: number;
  quality?: 'standard' | 'hd';
}

export interface ImageEditOptions {
  prompt: string;
  image: string;          // data:image/<type>;base64,... or http(s) URL
  mask?: string;          // optional inpainting mask, same format as image
  n?: number;
  size?: string;
  strength?: number;
  seed?: number;
}

export interface ImageGenerationResult {
  b64Images: string[]; // base64 PNG bytes (no data: prefix)
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}

export interface AudioTranscribeOptions {
  language?: string;
  prompt?: string;
  temperature?: number;
  responseFormat?: 'json' | 'text' | 'verbose_json';
}

export interface AudioTranscribeResult {
  text: string;
  language?: string;
  duration?: number;
  segments?: Array<{ start: number; end: number; text: string }>;
}

export interface TtsOptions {
  // OpenAI-compat: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer'
  // Cloudflare MeloTTS treats this as a LANGUAGE selector (en/es/fr/zh/ja/ko)
  // since melotts ships fixed voices per language.
  voice?: string;
  // 'mp3' (default) | 'opus' | 'aac' | 'flac' | 'wav'. MeloTTS returns MP3
  // only; other formats throw a "not supported" 400.
  responseFormat?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav';
  // Speed multiplier 0.25 - 4.0. MeloTTS ignores; future providers may honor.
  speed?: number;
}

export interface TtsResult {
  // Raw binary audio bytes (MP3 from MeloTTS).
  audio: Buffer;
  mimeType: 'audio/mpeg' | 'audio/ogg' | 'audio/aac' | 'audio/flac' | 'audio/wav';
}

export interface RerankOptions {
  // 1..N - return only the top N most-relevant docs. Default returns all,
  // sorted by relevance_score descending.
  topN?: number;
  // Optional max chunks per doc (Cohere splits long docs). Pass-through.
  maxChunksPerDoc?: number;
}

export interface RerankObject {
  index: number;            // position in the original documents[] array
  relevanceScore: number;   // 0..1 (higher = more relevant)
}

export interface RerankResult {
  results: RerankObject[];  // sorted by relevanceScore DESC by Cohere
  searchUnits: number;      // Cohere billing unit; usually 1/request
}

export interface EmbedOptions {
  // Matryoshka dimension cap. Honored by Gemini embedding-001 and Cohere v4.
  // Other providers ignore (return full vector).
  dimensions?: number;
  // Cohere needs this for retrieval-tuned models; ignored elsewhere.
  inputType?: 'search_document' | 'search_query' | 'classification' | 'clustering';
}

export interface EmbedResult {
  // One vector per input string. Order MUST match input array order.
  vectors: number[][];
  // Approximate input token count for usage reporting. Provider returns it
  // when available; otherwise we estimate (~4 char / token).
  promptTokens: number;
  // Reported vector dimensionality (vectors[0].length). Surfaced for clients
  // building schemas / pgvector tables.
  dimensions: number;
}

export abstract class BaseProvider {
  abstract readonly platform: Platform;
  abstract readonly name: string;
  // Default: provider needs a stored api_keys row. Pollinations and other
  // keyless services override this to false so the router can route to them
  // without a configured key.
  readonly requiresApiKey: boolean = true;

  abstract chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse>;

  abstract streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk>;

  abstract validateKey(apiKey: string): Promise<boolean>;

  // Optional image generation. Default throws — providers override to add
  // support. Routing's modality filter ensures this is only called on
  // providers the catalog actually maps to image_gen models.
  async generateImage(
    _apiKey: string,
    _modelId: string,
    _prompt: string,
    _options?: ImageGenerationOptions,
  ): Promise<ImageGenerationResult> {
    throw new Error(`${this.name} does not support image generation`);
  }

  // Optional image-to-image / inpainting. Providers override to add support.
  // Default throw — router's modality + supports_img2img / supports_inpainting
  // gates already prevent this being called on unsupported providers, so this
  // path only fires on a misconfigured catalog row.
  async editImage(
    _apiKey: string,
    _modelId: string,
    _options: ImageEditOptions,
  ): Promise<ImageGenerationResult> {
    throw new Error(`${this.name} does not support image editing`);
  }

  // Optional speech-to-text (audio transcription). Providers override.
  async transcribeAudio(
    _apiKey: string,
    _modelId: string,
    _audio: Buffer,
    _options?: AudioTranscribeOptions,
  ): Promise<AudioTranscribeResult> {
    throw new Error(`${this.name} does not support audio transcription`);
  }

  // Optional document re-ranking. Cohere-style query + documents -> sorted
  // results with relevance scores. Used in RAG pipelines after embedding
  // retrieval to refine the top-K. Default throw - providers override.
  async rerank(
    _apiKey: string,
    _modelId: string,
    _query: string,
    _documents: string[],
    _options?: RerankOptions,
  ): Promise<RerankResult> {
    throw new Error(`${this.name} does not support rerank`);
  }

  // Optional text-to-speech. Default throw — providers override. Today
  // only Cloudflare implements this (MeloTTS). OpenAI-shape /v1/audio/speech
  // semantics: input = text, voice = vendor-specific id (lang for melotts).
  async synthesizeSpeech(
    _apiKey: string,
    _modelId: string,
    _input: string,
    _options?: TtsOptions,
  ): Promise<TtsResult> {
    throw new Error(`${this.name} does not support text-to-speech`);
  }

  // Optional text embeddings. Providers override to add support. The default
  // throw fires only if the catalog routes an embedding request to a provider
  // missing the implementation (router's modality='embedding' filter normally
  // prevents this). Inputs always come in as a single string OR a batch array;
  // providers should pass through the array form to upstream batch endpoints
  // when supported (CF BGE, Cohere, Mistral, Zhipu all accept batch natively).
  async embed(
    _apiKey: string,
    _modelId: string,
    _input: string[],
    _options?: EmbedOptions,
  ): Promise<EmbedResult> {
    throw new Error(`${this.name} does not support embeddings`);
  }

  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = 15000,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  protected makeId(): string {
    return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
