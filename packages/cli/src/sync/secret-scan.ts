/**
 * Client-side secret scanning for prompt text.
 *
 * Scans prompt text for secrets before syncing to cloud. The client is
 * the trust boundary --- server-side scanning would mean the secret has
 * already been transmitted.
 *
 * See doc/analysis/team-app/06-sync-strategy.md -- Secret Scanning.
 */

export interface SecretPattern {
  name: string;
  pattern: RegExp;
}

export interface ScanResult {
  safe: boolean;
  redactedText: string;
  detectedSecrets: string[];
}

/** Built-in secret patterns. */
const BUILTIN_PATTERNS: SecretPattern[] = [
  // API keys & tokens
  { name: "AWS access key",       pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "AWS secret key",       pattern: /(?:aws_secret|secret_key)\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}/ },
  { name: "Generic API key",      pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{20,}['"]?/ },
  { name: "Generic secret",       pattern: /(?:secret|password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/ },
  { name: "Generic token",        pattern: /(?:token)\s*[:=]\s*['"]?[A-Za-z0-9_.\-]{20,}['"]?/ },
  { name: "Bearer token",         pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/ },
  { name: "GitHub PAT",           pattern: /gh[ps]_[A-Za-z0-9_]{36,}/ },
  { name: "Slack token",          pattern: /xox[bporas]-[A-Za-z0-9-]+/ },
  { name: "OpenAI API key",       pattern: /sk-[A-Za-z0-9]{48}/ },
  { name: "Anthropic API key",    pattern: /sk-ant-[A-Za-z0-9\-]{90,}/ },
  { name: "Private key header",   pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+|DSA\s+|PGP\s+)?PRIVATE\s+KEY-----/ },
  { name: "JWT",                  pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/ },

  // Connection strings
  { name: "Database URL",         pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^\s'"]+/ },
  { name: "SMTP credentials",     pattern: /smtp:\/\/[^\s'"]+/ },

  // High-entropy strings (likely secrets)
  { name: "Hex secret (32+)",     pattern: /(?:secret|key|token|password)\s*[:=]\s*['"]?[a-f0-9]{32,}['"]?/i },
];

/** Mutable pattern list: built-in + any custom patterns added at runtime. */
let activePatterns: SecretPattern[] = [...BUILTIN_PATTERNS];

/**
 * Add custom secret patterns (e.g. from ~/.claude-stats/config.json).
 * Custom patterns are appended to the built-in list.
 */
export function addCustomPatterns(patterns: SecretPattern[]): void {
  activePatterns = [...BUILTIN_PATTERNS, ...patterns];
}

/** Reset to built-in patterns only (useful for testing). */
export function resetPatterns(): void {
  activePatterns = [...BUILTIN_PATTERNS];
}

/**
 * Scan text for secrets. Returns true if any secrets are found.
 */
export function containsSecrets(text: string): boolean {
  for (const { pattern } of activePatterns) {
    if (pattern.test(text)) return true;
  }
  return false;
}

/**
 * Scan text and redact any detected secrets.
 * Returns a ScanResult with the redacted text and list of matched pattern names.
 */
export function scanPrompt(text: string): ScanResult {
  const detected: string[] = [];
  let redacted = text;

  for (const { name, pattern } of activePatterns) {
    // Use a global copy for replacement
    const globalPattern = new RegExp(pattern.source, "g" + (pattern.flags.replace(/g/g, "")));
    if (globalPattern.test(redacted)) {
      detected.push(name);
      // Reset lastIndex after test, then replace
      globalPattern.lastIndex = 0;
      redacted = redacted.replace(globalPattern, `[REDACTED:${name}]`);
    }
  }

  return {
    safe: detected.length === 0,
    redactedText: redacted,
    detectedSecrets: detected,
  };
}

/**
 * Redact secrets from text. Convenience wrapper around scanPrompt.
 */
export function redactSecrets(text: string): string {
  return scanPrompt(text).redactedText;
}
