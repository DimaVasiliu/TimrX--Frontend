/**
 * Smart Prompt Enhancer — Main Orchestrator
 * ───────────────────────────────────────────
 * LOCAL, deterministic + randomized JS prompt enhancement.
 * No server-side LLM dependency. Fast, offline-capable.
 *
 * Usage:
 *   import { enhance } from './enhancer.js';
 *   const result = enhance('a cat walking', { provider: 'vertex', mode: 'text_to_video' });
 *   // result.enhanced  — the enhanced prompt string
 *   // result.score     — quality score object
 *   // result.safety    — list of safety issues found (pre-softening)
 *   // result.provider  — provider used
 *
 * @module enhancer
 */

import { enhanceForVertex, enhanceForSeedance, enhanceForFalSeedance, PROVIDER_CONFIG } from './providers.js';
import { sanitizePrompt, detectIssues } from './safety.js';
import { scorePrompt, getScoreLabel } from './scoring.js';

// ── Provider → Enhancer mapping ────────────────────────────────

const ENHANCERS = {
  vertex:       enhanceForVertex,
  seedance:     enhanceForSeedance,
  fal_seedance: enhanceForFalSeedance,
};

/**
 * Detect the video generation mode from UI context.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.hasImage] - Whether an image is attached
 * @param {boolean} [opts.hasEndImage] - Whether a second image is attached (transition)
 * @returns {'text_to_video' | 'animate_image' | 'image_transition'}
 */
export function detectMode(opts = {}) {
  if (opts.hasEndImage) return 'image_transition';
  if (opts.hasImage) return 'animate_image';
  return 'text_to_video';
}

/**
 * Enhance a user prompt using local deterministic + randomized logic.
 *
 * @param {string} rawPrompt - The user's raw prompt text
 * @param {Object} [options]
 * @param {string} [options.provider='vertex'] - Target provider
 * @param {string} [options.mode='text_to_video'] - Generation mode
 * @returns {{ enhanced: string, original: string, provider: string, mode: string, score: Object, scoreLabel: string, safety: string[] }}
 */
export function enhance(rawPrompt, options = {}) {
  const provider = options.provider || 'vertex';
  const mode = options.mode || 'text_to_video';
  const original = (rawPrompt || '').trim();

  if (!original) {
    return {
      enhanced: '',
      original: '',
      provider,
      mode,
      score: { score: 0, grade: 'empty', signals: [], suggestions: ['Add a prompt to get started'] },
      scoreLabel: 'Empty prompt',
      safety: [],
    };
  }

  // 1. Pre-enhancement safety scan
  const safetyIssues = detectIssues(original);

  // 2. Pre-sanitize the input
  const sanitized = sanitizePrompt(original, provider);

  // 3. Pick the right enhancer (fallback to vertex)
  const enhanceFn = ENHANCERS[provider] || ENHANCERS.vertex;

  // 4. Run the enhancement
  let enhanced = enhanceFn(sanitized, mode);

  // 5. Post-enhancement safety pass (catch anything the enhancer introduced)
  enhanced = sanitizePrompt(enhanced, provider);

  // 6. Score the result
  const score = scorePrompt(enhanced, provider);
  const scoreLabel = getScoreLabel(score.score);

  return {
    enhanced,
    original,
    provider,
    mode,
    score,
    scoreLabel,
    safety: safetyIssues,
  };
}

/**
 * Score a prompt without enhancing it.
 * Useful for real-time UI feedback as the user types.
 *
 * @param {string} prompt
 * @param {string} [provider='vertex']
 * @returns {{ score: number, grade: string, signals: string[], suggestions: string[], label: string }}
 */
export function quickScore(prompt, provider = 'vertex') {
  const result = scorePrompt(prompt, provider);
  return { ...result, label: getScoreLabel(result.score) };
}

/**
 * Get provider info for UI display.
 *
 * @param {string} provider
 * @returns {{ name: string, maxPromptLength: number, style: string, sentenceTarget: number[] }}
 */
export function getProviderInfo(provider) {
  return PROVIDER_CONFIG[provider] || PROVIDER_CONFIG.vertex;
}
