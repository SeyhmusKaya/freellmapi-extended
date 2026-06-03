// ---- Platform & Model Types ----

// Active platforms — must match server/src/providers/index.ts and
// server/src/routes/keys.ts PLATFORMS allowlist.
// Hugging Face, Moonshot, and MiniMax direct integrations were dropped
// in migrateModelsV4 (see server/src/db/index.ts).
export type Platform =
  | 'google'
  | 'groq'
  | 'cerebras'
  | 'sambanova'
  | 'nvidia'
  | 'mistral'
  | 'openrouter'
  | 'github'
  | 'cohere'
  | 'cloudflare'
  | 'zhipu'
  | 'ollama'
  | 'pollinations'
  | 'deepseek'
  | 'ai21'
  | 'reka'
  | 'kilo';

export interface Model {
  id: number;
  platform: Platform;
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  rpmLimit: number | null;
  rpdLimit: number | null;
  tpmLimit: number | null;
  tpdLimit: number | null;
  monthlyTokenBudget: string;
  contextWindow: number | null;
  enabled: boolean;
}

export type KeyStatus = 'healthy' | 'rate_limited' | 'invalid' | 'error' | 'unknown';

export interface ApiKey {
  id: number;
  platform: Platform;
  label: string;
  maskedKey: string;
  status: KeyStatus;
  enabled: boolean;
  createdAt: string;
  lastCheckedAt: string | null;
  // NVIDIA dev keys expire 6 months from issue. Null for non-expiring providers.
  expiresAt?: string | null;
  daysUntilExpiry?: number | null;
}

export interface ApiKeyCreate {
  platform: Platform;
  key: string;
  label?: string;
}

// ---- Fallback Config ----

export interface FallbackEntry {
  modelId: number;
  platform: Platform;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  priority: number;
  enabled: boolean;
}

// ---- OpenAI-Compatible Types ----

export interface ChatToolCallFunction {
  name: string;
  arguments: string;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: ChatToolCallFunction;
  thought_signature?: string;
}

export interface ChatToolFunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ChatToolDefinition {
  type: 'function';
  function: ChatToolFunctionDefinition;
}

export type ChatToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | {
    type: 'function';
    function: {
      name: string;
    };
  };

// ---- Image Generation Types (OpenAI-compatible) ----

export interface ImageGenerationRequest {
  prompt: string;
  model?: string;
  n?: number;
  size?: '512x512' | '1024x1024' | '1024x768' | '768x1024';
  response_format?: 'b64_json' | 'url';
  negative_prompt?: string;
  seed?: number;
  quality?: 'standard' | 'hd';
}

export interface ImageGenerationData {
  b64_json?: string;
  url?: string;
  revised_prompt?: string | null;
}

export interface ImageGenerationResponse {
  created: number;
  data: ImageGenerationData[];
  _routed_via?: { platform: string; model: string };
}

export interface ImageEditRequest {
  prompt: string;
  image: string;     // data:image/* base64 or http(s) URL
  mask?: string;     // optional, inpainting mask
  model?: string;
  n?: number;
  size?: '512x512' | '1024x1024' | '1024x768' | '768x1024';
  response_format?: 'b64_json' | 'url';
  strength?: number; // 0..1 — how much to deviate from source
  seed?: number;
}

export interface ImageVariationRequest {
  image: string;
  prompt?: string;
  model?: string;
  n?: number;
  size?: '512x512' | '1024x1024' | '1024x768' | '768x1024';
  response_format?: 'b64_json' | 'url';
  strength?: number;
  seed?: number;
}

// ---- Audio (STT) Types ----

export interface AudioTranscriptionRequest {
  // Audio reference: data:audio/<wav|mp3|flac|ogg|webm|m4a|mp4>;base64,... or http(s) URL
  audio: string;
  model?: string;
  language?: string;
  response_format?: 'json' | 'text' | 'verbose_json';
  temperature?: number;
  prompt?: string;
}

export interface AudioTranscriptionResponse {
  text: string;
  language?: string;
  duration?: number;
  segments?: Array<{ start: number; end: number; text: string }>;
  _routed_via?: { platform: string; model: string };
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export type ChatMessageContent = string | ChatContentPart[];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  // Only user messages may carry an array of content parts (multimodal).
  // Other roles stay string|null.
  content: ChatMessageContent | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: TokenUsage;
  _routed_via?: {
    platform: Platform;
    model: string;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      tool_calls?: ChatToolCall[];
    };
    finish_reason: string | null;
  }[];
}

// ---- Analytics Types ----

export interface AnalyticsSummary {
  totalRequests: number;
  successRate: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgLatencyMs: number;
  estimatedCostSavings: number;
}

export interface PlatformStats {
  platform: Platform;
  requests: number;
  successRate: number;
  avgLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface TimelinePoint {
  timestamp: string;
  requests: number;
  successCount: number;
  failureCount: number;
}

export interface RequestLog {
  id: number;
  platform: Platform;
  modelId: string;
  status: 'success' | 'error';
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error: string | null;
  createdAt: string;
}

// ---- Embedding Types (OpenAI-compatible) ----

export interface EmbeddingRequest {
  model: string;
  // Single string or batch (array). Most providers accept up to 96 inputs per call.
  input: string | string[];
  // Optional output dimension cap (Matryoshka — Gemini/Cohere v4 honor this).
  dimensions?: number;
  // OpenAI-compat field, often ignored upstream. Kept for client parity.
  encoding_format?: 'float' | 'base64';
  // Cohere needs this; ignored by other providers.
  input_type?: 'search_document' | 'search_query' | 'classification' | 'clustering';
  user?: string;
}

export interface EmbeddingObject {
  object: 'embedding';
  index: number;
  embedding: number[];
}

export interface EmbeddingUsage {
  prompt_tokens: number;
  total_tokens: number;
}

export interface EmbeddingResponse {
  object: 'list';
  data: EmbeddingObject[];
  model: string;
  usage: EmbeddingUsage;
}

// ---- Rate Limit Types ----

export interface RateLimitStatus {
  platform: Platform;
  modelId: string;
  rpm: { used: number; limit: number | null };
  rpd: { used: number; limit: number | null };
  tpm: { used: number; limit: number | null };
  available: boolean;
  nextResetAt: string | null;
}
