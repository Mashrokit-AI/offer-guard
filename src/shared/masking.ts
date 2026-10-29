/** Mask a secret for logs: short prefix/suffix only, never the middle. */
export function maskSecret(value: string | undefined | null): string {
  if (!value || value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/** Strip the access_token query value from a URL before logging/journaling. */
export function redactUrl(rawUrl: string): string {
  return rawUrl.replace(/([?&]access_token=)[^&]*/g, '$1***');
}

/** Replace every occurrence of known secrets in free text with their masks. */
export function redactText(text: string, secrets: Array<string | undefined | null>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length <= 8) continue;
    out = out.split(secret).join(maskSecret(secret));
  }
  return redactUrl(out);
}
