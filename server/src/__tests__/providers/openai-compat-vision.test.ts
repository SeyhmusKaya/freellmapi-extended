import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';

const provider = new OpenAICompatProvider({
  platform: 'groq',
  name: 'Groq',
  baseUrl: 'https://api.groq.com/openai/v1',
});

describe('OpenAICompatProvider vision passthrough', () => {
  let body: any = null;

  beforeEach(() => {
    body = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, init: any) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        id: 'chatcmpl-x', object: 'chat.completion', created: 0, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'cat' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('forwards array content untouched', async () => {
    const content = [
      { type: 'text', text: 'describe' },
      { type: 'image_url', image_url: { url: 'https://example.com/x.jpg' } },
    ] as any;
    await provider.chatCompletion('fake-key', [
      { role: 'user', content },
    ], 'meta-llama/llama-4-scout-17b-16e-instruct');

    expect(Array.isArray(body.messages[0].content)).toBe(true);
    expect(body.messages[0].content).toEqual(content);
  });

  it('forwards tools alongside vision content', async () => {
    await provider.chatCompletion('fake-key', [
      { role: 'user', content: [
        { type: 'text', text: 'look + use tool' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ] as any },
    ], 'meta-llama/llama-4-scout-17b-16e-instruct', {
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
    });

    expect(body.tools).toHaveLength(1);
    expect(body.messages[0].content[1].image_url.url).toContain('data:image/png');
  });
});
