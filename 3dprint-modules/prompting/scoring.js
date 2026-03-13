/**
 * Prompt Quality Scoring Helper
 * ──────────────────────────────
 * Evaluates prompt quality on a 0-100 scale based on
 * structural heuristics (not AI). Useful for UI hints
 * and deciding whether to auto-enhance.
 *
 * @module scoring
 */

// ── Quality Signals ────────────────────────────────────────────

const POSITIVE_SIGNALS = [
  { pattern: /\b(cinematic|filmic|film[\s-]?grade)\b/i, weight: 8, label: 'cinematic style' },
  { pattern: /\b(camera|tracking|dolly|crane|orbit|pan|tilt|zoom)\b/i, weight: 10, label: 'camera direction' },
  { pattern: /\b(lighting|backlit|rim[\s-]?light|golden[\s-]?hour|chiaroscuro|shadow)\b/i, weight: 10, label: 'lighting detail' },
  { pattern: /\b(slow[\s-]?motion|timelapse|time[\s-]?lapse)\b/i, weight: 6, label: 'temporal direction' },
  { pattern: /\b(depth[\s-]?of[\s-]?field|bokeh|shallow[\s-]?focus)\b/i, weight: 7, label: 'focus detail' },
  { pattern: /\b(atmosphere|atmospheric|moody|dramatic)\b/i, weight: 5, label: 'mood descriptor' },
  { pattern: /\b(photorealistic|hyper[\s-]?detailed|4k|8k|high[\s-]?quality)\b/i, weight: 5, label: 'quality descriptor' },
  { pattern: /\b(smooth|fluid|elegant|graceful|steady)\b/i, weight: 4, label: 'motion quality' },
  { pattern: /\b(color[\s-]?grading|color[\s-]?palette|saturated|desaturated)\b/i, weight: 6, label: 'color direction' },
  { pattern: /\b(composition|foreground|background|midground|frame)\b/i, weight: 6, label: 'composition' },
];

const NEGATIVE_SIGNALS = [
  { pattern: /\b(explosion|gun|blood|kill|murder|weapon)\b/i, weight: -10, label: 'unsafe content' },
  { pattern: /\b(dialogue|voiceover|music\s+plays|text\s+overlay)\b/i, weight: -8, label: 'non-visual reference' },
  { pattern: /\b(make it|I want|please|can you)\b/i, weight: -5, label: 'conversational language' },
  { pattern: /\b(and then|next|after that|finally)\b/i, weight: -4, label: 'multi-scene complexity' },
];

/**
 * Score a prompt's quality for video generation.
 *
 * @param {string} prompt - The prompt to evaluate
 * @param {string} [provider='vertex'] - Target provider
 * @returns {{ score: number, grade: string, signals: string[], suggestions: string[] }}
 */
export function scorePrompt(prompt, provider = 'vertex') {
  if (!prompt || typeof prompt !== 'string') {
    return { score: 0, grade: 'empty', signals: [], suggestions: ['Add a prompt to get started'] };
  }

  const trimmed = prompt.trim();
  let score = 30; // base score for having any prompt
  const signals = [];
  const suggestions = [];

  // ── Length scoring ──────────────────────────────────────────
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount < 3) {
    score -= 10;
    suggestions.push('Add more detail — describe the scene, camera, and lighting');
  } else if (wordCount >= 8 && wordCount <= 40) {
    score += 10; // sweet spot
  } else if (wordCount > 60) {
    score -= 5;
    suggestions.push('Consider shortening — focused prompts often work better');
  }

  // ── Sentence count ─────────────────────────────────────────
  const sentences = trimmed.split(/[.!?]+/).filter(s => s.trim().length > 0).length;
  if (sentences >= 2 && sentences <= 4) {
    score += 5; // well structured
  } else if (sentences > 6) {
    score -= 5;
    suggestions.push('Too many scenes — try describing one clear moment');
  }

  // ── Positive signals ───────────────────────────────────────
  for (const sig of POSITIVE_SIGNALS) {
    if (sig.pattern.test(trimmed)) {
      score += sig.weight;
      signals.push(sig.label);
    }
  }

  // ── Negative signals ───────────────────────────────────────
  for (const sig of NEGATIVE_SIGNALS) {
    if (sig.pattern.test(trimmed)) {
      score += sig.weight; // negative weight
      signals.push(sig.label);
    }
  }

  // ── Missing elements → suggestions ─────────────────────────
  if (!signals.includes('camera direction')) {
    suggestions.push('Add camera movement (e.g., "slow orbit", "tracking shot")');
  }
  if (!signals.includes('lighting detail')) {
    suggestions.push('Describe lighting (e.g., "golden hour", "dramatic rim light")');
  }
  if (!signals.includes('cinematic style') && !signals.includes('quality descriptor')) {
    suggestions.push('Add a style hint (e.g., "cinematic", "photorealistic")');
  }

  // ── Provider-specific adjustments ──────────────────────────
  if (provider === 'fal_seedance' && wordCount > 30) {
    score -= 5;
    suggestions.push('fal Seedance works best with shorter prompts (1-2 sentences)');
  }
  if (provider === 'vertex' && signals.includes('unsafe content')) {
    score -= 10;
    suggestions.push('Vertex/Veo may reject violent or unsafe content');
  }

  // Clamp score
  score = Math.max(0, Math.min(100, score));

  // Grade
  let grade;
  if (score >= 80) grade = 'excellent';
  else if (score >= 60) grade = 'good';
  else if (score >= 40) grade = 'fair';
  else if (score >= 20) grade = 'weak';
  else grade = 'poor';

  return { score, grade, signals, suggestions };
}

/**
 * Get a short human-readable quality label.
 * @param {number} score
 * @returns {string}
 */
export function getScoreLabel(score) {
  if (score >= 80) return 'Strong prompt';
  if (score >= 60) return 'Good prompt';
  if (score >= 40) return 'Could be stronger';
  if (score >= 20) return 'Needs more detail';
  return 'Very basic';
}
