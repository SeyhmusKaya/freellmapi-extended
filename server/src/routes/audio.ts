import { Router } from 'express';
import type { Request, Response } from 'express';
import { audioTranscriptionSchema, runAudioTranscription } from '../lib/runAudioTranscription.js';
import { audioSpeechSchema, runAudioSpeech } from '../lib/runAudioSpeech.js';
import { multipartAudioUpload, isMultipart, multipartAudioBody } from '../lib/multipartHelper.js';
import { authenticateClient } from '../lib/clientAuth.js';
import {
  ModelNotFoundError,
  AllProvidersFailedError,
  ProviderFatalError,
  RoutingError,
} from '../lib/runChatCompletion.js';

export const audioRouter = Router();

function authenticate(req: Request, res: Response): boolean {
  return authenticateClient(req, res);
}

// POST /v1/audio/transcriptions — OpenAI-compatible speech-to-text.
//
// Faz 1 accepts JSON body with `audio` field (data: URL or http(s) URL).
// Multipart/form-data (OpenAI's preferred shape) is Faz 2.
//
// Body:
//   {
//     audio: "data:audio/wav;base64,..." | "https://...",
//     model?: "@cf/openai/whisper-large-v3-turbo",
//     language?: "tr"|"en"|...,
//     response_format?: "json"|"text"|"verbose_json",
//     temperature?: 0..1,
//     prompt?: "domain-specific glossary"
//   }
//
// Response (json default):
//   { text, language?, duration?, segments?, _routed_via }
audioRouter.post('/transcriptions', multipartAudioUpload, async (req: Request, res: Response) => {
  if (!authenticate(req, res)) return;

  const body = isMultipart(req) ? multipartAudioBody(req) : req.body;
  const parsed = audioTranscriptionSchema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => `${e.path.join('.')} ${e.message}`).join('; ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  try {
    const result = await runAudioTranscription(parsed.data);
    res.setHeader('X-Routed-Via', `${result.routedPlatform}/${result.routedModel}`);
    if (result.attempts > 0) res.setHeader('X-Fallback-Attempts', String(result.attempts));

    if (parsed.data.response_format === 'text') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(result.text);
      return;
    }

    const payload: Record<string, unknown> = { text: result.text };
    if (parsed.data.response_format === 'verbose_json') {
      payload.language = result.language;
      payload.duration = result.duration;
      payload.segments = result.segments;
    }
    payload._routed_via = { platform: result.routedPlatform, model: result.routedModel };
    res.json(payload);
  } catch (err: any) {
    if (err instanceof ModelNotFoundError) {
      res.status(400).json({ error: { message: err.message, type: 'invalid_request_error', code: 'model_not_found' } });
      return;
    }
    if (err instanceof AllProvidersFailedError) {
      res.status(429).json({ error: { message: err.message, type: 'rate_limit_error' } });
      return;
    }
    if (err instanceof ProviderFatalError) {
      res.status(502).json({ error: { message: err.message, type: 'provider_error' } });
      return;
    }
    if (err instanceof RoutingError) {
      res.status(err.status).json({ error: { message: err.message, type: 'routing_error' } });
      return;
    }
    console.error('[Audio] Unexpected error:', err);
    res.status(500).json({ error: { message: 'Internal error', type: 'internal_error' } });
  }
});

// POST /v1/audio/speech — OpenAI-compatible text-to-speech.
// Returns BINARY audio bytes (Content-Type: audio/mpeg for MP3) so OpenAI
// SDK consumers can write directly to disk: `r.content` -> file.mp3.
audioRouter.post('/speech', async (req: Request, res: Response) => {
  if (!authenticate(req, res)) return;
  const parsed = audioSpeechSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => `${e.path.join('.')} ${e.message}`).join('; ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }
  try {
    const result = await runAudioSpeech(parsed.data);
    res.setHeader('X-Routed-Via', `${result.routedPlatform}/${result.routedModel}`);
    if (result.attempts > 0) res.setHeader('X-Fallback-Attempts', String(result.attempts));
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Length', String(result.audio.length));
    res.send(result.audio);
  } catch (err: any) {
    if (err instanceof ModelNotFoundError) {
      res.status(400).json({ error: { message: err.message, type: 'invalid_request_error', code: 'model_not_found' } });
      return;
    }
    if (err instanceof AllProvidersFailedError) {
      res.status(429).json({ error: { message: err.message, type: 'rate_limit_error' } });
      return;
    }
    if (err instanceof ProviderFatalError) {
      res.status(502).json({ error: { message: err.message, type: 'provider_error' } });
      return;
    }
    if (err instanceof RoutingError) {
      res.status(err.status).json({ error: { message: err.message, type: 'routing_error' } });
      return;
    }
    console.error('[Speech] Unexpected error:', err);
    res.status(500).json({ error: { message: 'Internal error', type: 'internal_error' } });
  }
});
