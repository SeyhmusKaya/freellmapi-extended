import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleProvider } from '../../providers/google.js';

const provider = new GoogleProvider();

describe('GoogleProvider response_format', () => {
  let body: any = null;

  beforeEach(() => {
    body = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, init: any) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('json_object → responseMimeType=application/json', async () => {
    await provider.chatCompletion('fake', [{ role: 'user', content: 'hi' }], 'gemini-2.5-flash', {
      response_format: { type: 'json_object' },
    });
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toBeUndefined();
  });

  it('json_schema → responseMimeType + responseSchema set', async () => {
    const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
    await provider.chatCompletion('fake', [{ role: 'user', content: 'hi' }], 'gemini-2.5-flash', {
      response_format: { type: 'json_schema', json_schema: { name: 'City', schema } },
    });
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toEqual(schema);
  });

  it('text → no mime or schema injected', async () => {
    await provider.chatCompletion('fake', [{ role: 'user', content: 'hi' }], 'gemini-2.5-flash', {
      response_format: { type: 'text' },
    });
    expect(body.generationConfig.responseMimeType).toBeUndefined();
    expect(body.generationConfig.responseSchema).toBeUndefined();
  });

  it('no response_format → no mime or schema', async () => {
    await provider.chatCompletion('fake', [{ role: 'user', content: 'hi' }], 'gemini-2.5-flash');
    expect(body.generationConfig.responseMimeType).toBeUndefined();
    expect(body.generationConfig.responseSchema).toBeUndefined();
  });
});
