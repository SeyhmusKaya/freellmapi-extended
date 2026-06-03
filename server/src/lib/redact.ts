/**
 * Redact secrets from provider error messages before they are persisted to the
 * `requests` analytics table.
 *
 * Upstream provider errors occasionally echo back a fragment of the request —
 * an Authorization header, a `?key=...` query param, an account id, or an email
 * — and those rows are later shown in the dashboard / exportable analytics. A
 * single redaction chokepoint (called from logRequest) keeps any credential or
 * PII out of stored error text without changing routing behaviour.
 *
 * Conservative: only strips things that look like secrets/PII, leaving the
 * human-readable error ("429 Too Many Requests", "model not found") intact for
 * debugging.
 */

const PATTERNS: Array<[RegExp, string]> = [
  // Bearer / Authorization tokens
  [/\b[Bb]earer\s+[A-Za-z0-9._\-]+/g, 'Bearer [redacted]'],
  [/\bAuthorization\s*[:=]\s*\S+/gi, 'Authorization: [redacted]'],
  // key=... / api_key=... / token=... in query strings or bodies
  [/\b(api[_-]?key|key|token|secret|password|access[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9._\-]{6,}["']?/gi, '$1=[redacted]'],
  // Common provider key prefixes (OpenAI sk-, Google AIza, our myllm-, etc.)
  [/\bsk-[A-Za-z0-9]{16,}/g, 'sk-[redacted]'],
  [/\bAIza[A-Za-z0-9_\-]{20,}/g, 'AIza[redacted]'],
  [/\b(?:myllm|gsk|csk|nvapi|r8|hf)[-_][A-Za-z0-9]{16,}/gi, '[redacted-key]'],
  // Cloudflare "account_id:token" pairs
  [/\b[a-f0-9]{32}:[A-Za-z0-9._\-]{20,}/g, '[redacted-cf-key]'],
  // Email addresses (PII)
  [/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]'],
  // Long bare hex / base64-ish blobs (>=32 chars) that are almost always keys
  [/\b[A-Za-z0-9_\-]{40,}\b/g, '[redacted-token]'],
];

export function redactSecrets(input: string | null | undefined): string | null {
  if (input == null) return null;
  let out = String(input);
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  // Cap stored error length — provider stack traces can be huge.
  return out.length > 500 ? out.slice(0, 500) + '…' : out;
}
