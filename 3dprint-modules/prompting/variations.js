/**
 * Randomized Phrase Banks for Video Prompt Enhancement
 * ─────────────────────────────────────────────────────
 * Controlled variation pools organized by category.
 * Each pool is an array of short, composable phrases.
 * The enhancer picks randomly from each relevant pool
 * to produce diverse but high-quality prompts.
 *
 * @module variations
 */

// ── Camera Movement ────────────────────────────────────────────
export const CAMERA_MOVES = [
  'slow cinematic tracking shot',
  'gentle orbit around the subject',
  'smooth dolly-in with shallow depth of field',
  'crane shot rising above the scene',
  'lateral tracking at eye level',
  'slow push-in toward the focal point',
  'steady wide establishing shot with subtle drift',
  'low-angle upward tilt',
  'sweeping half-circle arc',
  'slow pull-back revealing the full scene',
  'overhead descending crane shot',
  'smooth handheld follow',
  'elegant Steadicam glide',
  'slow zoom with parallax shift',
  'gentle pan across the scene',
  'floating camera drift',
];

// ── Lighting ───────────────────────────────────────────────────
export const LIGHTING = [
  'dramatic cinematic lighting',
  'soft golden backlighting',
  'neon reflections and ambient glow',
  'moody contrast with rim light',
  'warm golden hour warmth',
  'cool blue twilight atmosphere',
  'high-contrast chiaroscuro',
  'natural overcast diffused light',
  'volumetric light rays through haze',
  'dramatic side-lighting with deep shadows',
  'clean studio three-point lighting',
  'subtle ambient occlusion',
  'pulsing neon accents',
  'soft diffused editorial lighting',
  'cold moonlight atmosphere',
  'warm firelight glow',
];

// ── Visual Style ───────────────────────────────────────────────
export const STYLES = [
  'photorealistic cinematic quality',
  'filmic with subtle grain and color grading',
  'clean commercial aesthetic',
  'atmospheric and moody',
  'vivid and saturated',
  'muted desaturated documentary feel',
  'dreamy soft-focus aesthetic',
  'sharp hyper-detailed realism',
  'bold high-contrast look',
  'elegant minimalist composition',
  'rich cinematic color palette',
  'professional broadcast quality',
];

// ── Environment / Atmosphere ───────────────────────────────────
export const ENVIRONMENTS = [
  'atmospheric haze',
  'dark studio void',
  'blurred urban backdrop',
  'misty morning fog',
  'rain-slicked city streets',
  'lush natural setting',
  'clean white cyclorama',
  'starlit night sky',
  'industrial concrete space',
  'warm interior with natural light',
  'underwater caustics',
  'dense forest canopy',
];

// ── Motion Quality ─────────────────────────────────────────────
export const MOTION_QUALITY = [
  'smooth fluid motion',
  'steady elegant camera movement',
  'ultra-smooth stabilized footage',
  'buttery-smooth motion',
  'professional Steadicam quality',
  'graceful continuous movement',
];

// ── Detail Enhancers (appended for richness) ───────────────────
export const DETAIL_ENHANCERS = [
  'rich atmospheric depth',
  'fine surface detail visible',
  'subtle particle effects in the air',
  'gentle depth-of-field bokeh',
  'micro-detail textures',
  'layered visual depth',
  'natural material reflections',
  'subtle environmental storytelling',
];

// ── Transition-Specific Phrases ────────────────────────────────
export const TRANSITION_PHRASES = [
  'seamless morph between scenes',
  'fluid transformation from first frame to last',
  'smooth interpolation with natural motion',
  'organic transition preserving spatial coherence',
  'elegant blend between start and end compositions',
  'gradual metamorphosis with consistent lighting',
];

// ── Animate-Image-Specific Phrases ─────────────────────────────
export const ANIMATE_PHRASES = [
  'subtle life-like motion added to the still image',
  'gentle animation preserving the original composition',
  'natural movement emerging from the photograph',
  'camera slowly exploring the scene from the image',
  'bringing the still frame to life with cinematic motion',
  'parallax depth effect animating the layers',
];

/**
 * Pick a random element from an array.
 * @param {Array} arr
 * @returns {*}
 */
export function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Pick N unique random elements from an array.
 * @param {Array} arr
 * @param {number} n
 * @returns {Array}
 */
export function pickRandomN(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}
