import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';

const provider = new OpenAICompatProvider({
  platform: 'groq',
  name: 'Groq',
  baseUrl: 'https://api.groq.com/openai/v1',
});

describe('OpenAICompatProvider response_format passthrough', () => {
  let body: any = null;

  beforeEach(() => {
    body = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, init: any) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('forwards json_object response_format to upstream body', async () => {
    await provider.chatCompletion('fake', [{ role: 'user', content: 'x' }], 'llama-3.3-70b-versatile', {
      response_format: { type: 'json_object' },
    });
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('forwards json_schema response_format with schema body', async () => {
    const rf = {
      type: 'json_schema' as const,
      json_schema: { name: 'City', schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
    };
    await provider.chatCompletion('fake', [{ role: 'user', content: 'x' }], 'llama-3.3-70b-versatile', {
      response_format: rf,
    });
    expect(body.response_format).toEqual(rf);
  });

  it('omits response_format from body when undefined', async () => {
    await provider.chatCompletion('fake', [{ role: 'user', content: 'x' }], 'llama-3.3-70b-versatile');
    expect(body.response_format).toBeUndefined();
  });
});
