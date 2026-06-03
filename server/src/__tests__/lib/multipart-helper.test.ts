import { describe, it, expect } from 'vitest';
import { fileToDataUrl, isMultipart, multipartImageBody, multipartAudioBody } from '../../lib/multipartHelper.js';

function fakeFile(buf: Buffer, mime: string): Express.Multer.File {
  return {
    fieldname: 'image',
    originalname: 'x.png',
    encoding: '7bit',
    mimetype: mime,
    size: buf.length,
    destination: '', filename: '', path: '',
    buffer: buf,
    stream: undefined as any,
  };
}

describe('multipartHelper', () => {
  it('fileToDataUrl wraps buffer with mime', () => {
    const buf = Buffer.from('abc');
    const url = fileToDataUrl(fakeFile(buf, 'image/png'));
    expect(url).toBe('data:image/png;base64,' + buf.toString('base64'));
  });

  it('isMultipart sniffs Content-Type', () => {
    expect(isMultipart({ headers: { 'content-type': 'multipart/form-data; boundary=---x' } } as any)).toBe(true);
    expect(isMultipart({ headers: { 'content-type': 'application/json' } } as any)).toBe(false);
    expect(isMultipart({ headers: {} } as any)).toBe(false);
  });

  it('multipartImageBody maps image + mask + text fields', () => {
    const req: any = {
      files: {
        image: [fakeFile(Buffer.from('img'), 'image/png')],
        mask:  [fakeFile(Buffer.from('msk'), 'image/png')],
      },
      body: {
        prompt: 'add a hat',
        model: '@cf/runwayml/stable-diffusion-v1-5-inpainting',
        n: '2',
        size: '1024x1024',
        strength: '0.6',
        seed: '42',
      },
    };
    const out = multipartImageBody(req);
    expect(out.image).toContain('data:image/png;base64,');
    expect(out.mask).toContain('data:image/png;base64,');
    expect(out.prompt).toBe('add a hat');
    expect(out.model).toBe('@cf/runwayml/stable-diffusion-v1-5-inpainting');
    expect(out.n).toBe(2);
    expect(out.strength).toBe(0.6);
    expect(out.seed).toBe(42);
  });

  it('multipartImageBody handles missing files/fields gracefully', () => {
    const out = multipartImageBody({ files: {}, body: {} } as any);
    expect(out.image).toBeUndefined();
    expect(out.mask).toBeUndefined();
    expect(out.prompt).toBeUndefined();
  });

  it('multipartAudioBody maps file + language + response_format', () => {
    const req: any = {
      file: fakeFile(Buffer.from('audio'), 'audio/wav'),
      body: { language: 'tr', response_format: 'verbose_json', temperature: '0.2' },
    };
    const out = multipartAudioBody(req);
    expect(out.audio).toContain('data:audio/wav;base64,');
    expect(out.language).toBe('tr');
    expect(out.response_format).toBe('verbose_json');
    expect(out.temperature).toBe(0.2);
  });
});
