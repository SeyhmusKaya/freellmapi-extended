import { describe, it, expect } from 'vitest';
import { isRetryableError, isModelLevelFailure, isBadRequestError } from '../../lib/runChatCompletion.js';

describe('isBadRequestError (V57 cascade-on-400)', () => {
  it('matches provider 400 / 422 rejections', () => {
    expect(isBadRequestError(new Error('NVIDIA NIM API error 400: Bad Request'))).toBe(true);
    expect(isBadRequestError(new Error('GitHub Models API error 422: max_tokens too large'))).toBe(true);
    expect(isBadRequestError(new Error('Unprocessable Entity'))).toBe(true);
  });

  it('does not match success-ish or unrelated messages', () => {
    expect(isBadRequestError(new Error('429 Too Many Requests'))).toBe(false);
    expect(isBadRequestError(new Error('aborted'))).toBe(false);
  });

  it('a 400 is NOT treated as retryable (so it would otherwise sink)', () => {
    // This is exactly why isBadRequestError exists: the retry path skips 400,
    // so without the dedicated bad-request cascade branch a 400 ends the request.
    expect(isRetryableError(new Error('NVIDIA NIM API error 400: Bad Request'))).toBe(false);
  });

  it('model-level failures (hang/abort) are distinct from bad requests', () => {
    expect(isModelLevelFailure(new Error('This operation was aborted'))).toBe(true);
    expect(isBadRequestError(new Error('This operation was aborted'))).toBe(false);
  });
});
