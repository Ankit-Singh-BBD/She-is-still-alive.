/**
 * Sanitizes auth tokens to prevent HTTP header syntax errors and invalid values
 */
export function sanitizeAuthToken(rawToken?: string | null): string | undefined {
  if (!rawToken || typeof rawToken !== 'string') return undefined;
  const clean = rawToken.replace(/[\r\n\t]/g, '').trim();
  if (!clean || clean === 'undefined' || clean === 'null' || clean === '[object Object]') {
    return undefined;
  }
  // Check that token consists of valid HTTP header token characters
  if (!/^[A-Za-z0-9_\-.]+$/.test(clean)) {
    return undefined;
  }
  return clean;
}
