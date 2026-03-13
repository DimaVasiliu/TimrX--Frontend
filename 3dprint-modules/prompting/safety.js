/**
 * Client-Side Prompt Safety Softening
 * ─────────────────────────────────────
 * Lightweight regex-based filter that softens or removes
 * problematic language before sending to any provider.
 * Runs BEFORE enhancement and AFTER enhancement as a final pass.
 *
 * @module safety
 */

// ── Replacement Rules ──────────────────────────────────────────
// Each rule: [pattern (regex), replacement string]
const SAFETY_RULES = [
  // Violence softening
  [/\b(explo(?:sion|de|ding|des))\b/gi, 'burst of energy'],
  [/\b(blow(?:s|ing)?\s+up)\b/gi, 'dramatic impact'],
  [/\b(gun(?:s|fire|shot)?)\b/gi, 'device'],
  [/\b(shoot(?:s|ing)?)\b/gi, 'direct'],
  [/\b(bullet(?:s)?)\b/gi, 'projectile'],
  [/\b(blood(?:y)?)\b/gi, 'red mist'],
  [/\b(gore|gory)\b/gi, 'dramatic'],
  [/\b(kill(?:s|ing|ed)?)\b/gi, 'defeat'],
  [/\b(murder(?:s|ing|ed)?)\b/gi, 'confront'],
  [/\b(death|dying|dies)\b/gi, 'fade'],
  [/\b(stab(?:s|bing|bed)?)\b/gi, 'strike'],
  [/\b(weapon(?:s)?)\b/gi, 'tool'],

  // Explicit content
  [/\b(nude|naked|nudity)\b/gi, 'minimal attire'],
  [/\b(sexy|seductive)\b/gi, 'elegant'],
  [/\b(explicit)\b/gi, 'vivid'],

  // Audio/dialogue (problematic for video-only generators)
  [/\b(dialogue|speaking|says?|talks?)\b/gi, 'gestures'],
  [/\b(narrat(?:ion|or|es?))\b/gi, 'visual storytelling'],
  [/\b(voiceover|voice[\s-]?over)\b/gi, 'visual narration'],
  [/\b(music plays|soundtrack|audio)\b/gi, 'rhythmic visual energy'],
  [/\b(text overlay|subtitle(?:s)?|caption(?:s)?)\b/gi, 'visual emphasis'],

  // Real people names (common patterns) — remove possessive forms too
  [/\b(played by|starring|featuring)\s+[A-Z][a-z]+\s+[A-Z][a-z]+/g, ''],

  // Cleanup artifacts
  [/\s{2,}/g, ' '],           // double spaces
  [/\.\s*\./g, '.'],          // double periods
  [/,\s*\./g, '.'],           // comma-period
  [/^\s*[,.]/, ''],           // leading punctuation
];

/**
 * Apply safety softening to a prompt string.
 *
 * @param {string} prompt - The prompt to sanitize
 * @param {string} [provider='vertex'] - Provider name (Vertex is strictest)
 * @returns {string} Sanitized prompt
 */
export function sanitizePrompt(prompt, provider = 'vertex') {
  if (!prompt || typeof prompt !== 'string') return '';

  let result = prompt;

  for (const [pattern, replacement] of SAFETY_RULES) {
    result = result.replace(pattern, replacement);
  }

  // Final cleanup
  result = result.replace(/\s{2,}/g, ' ').trim();

  // Remove trailing comma if present
  if (result.endsWith(',')) {
    result = result.slice(0, -1).trim();
  }

  return result;
}

/**
 * Check if a prompt contains potentially problematic content.
 * Returns an array of issue descriptions (empty if clean).
 *
 * @param {string} prompt
 * @returns {string[]} List of detected issues
 */
export function detectIssues(prompt) {
  if (!prompt) return [];
  const issues = [];
  const lower = prompt.toLowerCase();

  if (/\b(explo(?:sion|de)|gun|shoot|blood|gore|kill|murder|stab|weapon)\b/i.test(lower)) {
    issues.push('Contains violent language (will be softened)');
  }
  if (/\b(nude|naked|explicit|sexy)\b/i.test(lower)) {
    issues.push('Contains explicit language (will be softened)');
  }
  if (/\b(dialogue|voiceover|narration|music plays|text overlay)\b/i.test(lower)) {
    issues.push('Contains audio/text references (not supported by video generators)');
  }
  if (prompt.length > 800) {
    issues.push('Prompt is very long — shorter prompts often produce better results');
  }

  return issues;
}
