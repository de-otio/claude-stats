export type CharacterVerb =
  | 'Coded'
  | 'Investigated'
  | 'Researched'
  | 'Tested'
  | 'Reviewed'
  | 'Worked on';

/**
 * Infers a character verb from a tool histogram and optional bash command samples.
 *
 * Algorithm (in priority order):
 * 1. If Edit, Write, or MultiEdit has count > 0, return 'Coded'.
 * 2. Else if WebFetch or WebSearch is dominant, return 'Researched'.
 * 3. Else if any tool name starts with 'mcp__github__', return 'Reviewed'.
 * 4. Else if Bash is in histogram AND any bashCommandSamples matches test patterns, return 'Tested'.
 * 5. Else if Read, Grep, or Glob is dominant and no edits exist, return 'Investigated'.
 * 6. Otherwise return 'Worked on'.
 *
 * @param toolHistogram - Record mapping tool names to call counts
 * @param options - Optional configuration (bashCommandSamples for test detection)
 * @returns The inferred CharacterVerb
 */
export function inferCharacterVerb(
  toolHistogram: Readonly<Record<string, number>>,
  options?: {
    bashCommandSamples?: readonly string[];
  },
): CharacterVerb {
  // Rule 1: Edit, Write, MultiEdit → Coded
  if (
    (toolHistogram['Edit'] ?? 0) > 0 ||
    (toolHistogram['Write'] ?? 0) > 0 ||
    (toolHistogram['MultiEdit'] ?? 0) > 0
  ) {
    return 'Coded';
  }

  // Find dominant tool by count (to be used for subsequent rules)
  const dominantTool = findDominantTool(toolHistogram);

  // Rule 2: WebFetch or WebSearch dominant → Researched
  if (dominantTool === 'WebFetch' || dominantTool === 'WebSearch') {
    return 'Researched';
  }

  // Rule 3: Any tool starting with mcp__github__ → Reviewed
  if (hasGitHubMcp(toolHistogram)) {
    return 'Reviewed';
  }

  // Rule 4: Bash + test pattern in samples → Tested
  if ((toolHistogram['Bash'] ?? 0) > 0 && hasTestPattern(options?.bashCommandSamples)) {
    return 'Tested';
  }

  // Rule 5: Read, Grep, Glob dominant and no edits → Investigated
  if (dominantTool && ['Read', 'Grep', 'Glob'].includes(dominantTool)) {
    return 'Investigated';
  }

  // Rule 6: Otherwise → Worked on
  return 'Worked on';
}

/**
 * Finds the dominant tool (highest count) with priority tie-breaking.
 * Priority order: Edit, Write, MultiEdit, Read, Grep, Glob, WebFetch, WebSearch, Bash, ...others
 */
function findDominantTool(toolHistogram: Readonly<Record<string, number>>): string | null {
  const entries = Object.entries(toolHistogram);
  if (entries.length === 0) return null;

  const priority: Record<string, number> = {
    Edit: 0,
    Write: 1,
    MultiEdit: 2,
    Read: 3,
    Grep: 4,
    Glob: 5,
    WebFetch: 6,
    WebSearch: 7,
    Bash: 8,
  };

  let maxCount = -1;
  let dominant: string | null = null;
  let dominantPriority = Number.MAX_SAFE_INTEGER;

  for (const [tool, count] of entries) {
    const toolPriority = priority[tool] ?? Number.MAX_SAFE_INTEGER;

    // Higher count wins; on tie, lower priority wins
    if (count > maxCount || (count === maxCount && toolPriority < dominantPriority)) {
      maxCount = count;
      dominant = tool;
      dominantPriority = toolPriority;
    }
  }

  return dominant;
}

/**
 * Checks if histogram contains any tool starting with "mcp__github__"
 */
function hasGitHubMcp(toolHistogram: Readonly<Record<string, number>>): boolean {
  return Object.keys(toolHistogram).some(tool => tool.startsWith('mcp__github__'));
}

/**
 * Checks if any bash command sample matches the test pattern.
 * Pattern: /\b(npm test|pytest|vitest|jest|go test|cargo test)\b/
 */
function hasTestPattern(samples?: readonly string[]): boolean {
  if (!samples || samples.length === 0) return false;

  const testPattern = /\b(npm test|pytest|vitest|jest|go test|cargo test)\b/;
  return samples.some(sample => testPattern.test(sample));
}
