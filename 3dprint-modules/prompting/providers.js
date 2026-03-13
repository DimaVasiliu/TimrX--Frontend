/**
 * Provider-Specific Prompt Rules & Enhancers
 * ────────────────────────────────────────────
 * Each provider has different strengths, limits, and safe-word preferences.
 * This module defines per-provider configuration and the core enhance functions.
 *
 * @module providers
 */

import {
  CAMERA_MOVES, LIGHTING, STYLES, ENVIRONMENTS, MOTION_QUALITY,
  DETAIL_ENHANCERS, TRANSITION_PHRASES, ANIMATE_PHRASES,
  pickRandom, pickRandomN,
} from './variations.js';

// ── Provider Configurations ────────────────────────────────────

export const PROVIDER_CONFIG = {
  vertex: {
    name: 'Google Veo',
    maxPromptLength: 480,
    // Vertex/Veo is strict: no violence, no real people, no audio refs
    style: 'clean',          // clean, cinematic descriptions
    sentenceTarget: [2, 3],  // 2-3 sentences
    avoidWords: ['explosion', 'blood', 'gore', 'kill', 'death', 'gun', 'weapon',
                 'nude', 'naked', 'dialogue', 'narration', 'voiceover', 'music plays',
                 'text overlay', 'subtitle'],
    preferWords: ['burst of energy', 'shockwave', 'impact force', 'dynamic motion'],
  },
  seedance: {
    name: 'Seedance',
    maxPromptLength: 800,
    style: 'dynamic',        // bold, dramatic, action-friendly
    sentenceTarget: [3, 5],  // 3-5 sentences allowed
    avoidWords: ['nude', 'naked', 'explicit'],
    preferWords: [],
  },
  fal_seedance: {
    name: 'fal Seedance',
    maxPromptLength: 350,
    style: 'concise',        // short and punchy
    sentenceTarget: [1, 2],  // 1-2 sentences max
    avoidWords: ['nude', 'naked', 'explicit'],
    preferWords: [],
  },
};

// ── Sentence Builders ──────────────────────────────────────────

/**
 * Build a camera + motion sentence fragment.
 */
function _cameraSentence() {
  return pickRandom(CAMERA_MOVES) + ', ' + pickRandom(MOTION_QUALITY);
}

/**
 * Build a lighting + atmosphere sentence fragment.
 */
function _lightingSentence() {
  return pickRandom(LIGHTING) + ' with ' + pickRandom(ENVIRONMENTS);
}

/**
 * Build a style + detail sentence fragment.
 */
function _styleSentence() {
  return pickRandom(STYLES) + ', ' + pickRandom(DETAIL_ENHANCERS);
}

// ── Core Enhancement Logic ─────────────────────────────────────

/**
 * Enhance a prompt for Vertex (Google Veo).
 * Clean, cinematic, safe language. 2-3 sentences.
 *
 * @param {string} userPrompt - Raw user input
 * @param {string} mode - 'text_to_video' | 'animate_image' | 'image_transition'
 * @returns {string}
 */
export function enhanceForVertex(userPrompt, mode = 'text_to_video') {
  const parts = [userPrompt.replace(/[.!?]$/, '')];

  if (mode === 'image_transition') {
    parts.push(pickRandom(TRANSITION_PHRASES));
    parts.push(_cameraSentence());
  } else if (mode === 'animate_image') {
    parts.push(pickRandom(ANIMATE_PHRASES));
    parts.push(pickRandom(LIGHTING));
  } else {
    // text_to_video
    parts.push(_cameraSentence());
    parts.push(pickRandom(LIGHTING));
  }

  // Vertex prefers clean, professional descriptors
  parts.push(pickRandom([
    'Professional cinematography',
    'Cinematic visual quality',
    'Clean cinematic composition',
    'Polished film-grade visuals',
  ]));

  let result = parts.join('. ') + '.';
  return _enforceLength(result, PROVIDER_CONFIG.vertex.maxPromptLength);
}

/**
 * Enhance a prompt for Seedance.
 * Bold, dynamic, can handle complex motion. 3-5 sentences.
 *
 * @param {string} userPrompt
 * @param {string} mode
 * @returns {string}
 */
export function enhanceForSeedance(userPrompt, mode = 'text_to_video') {
  const parts = [userPrompt.replace(/[.!?]$/, '')];

  if (mode === 'image_transition') {
    parts.push(pickRandom(TRANSITION_PHRASES));
    parts.push(_cameraSentence());
    parts.push(_lightingSentence());
  } else if (mode === 'animate_image') {
    parts.push(pickRandom(ANIMATE_PHRASES));
    parts.push(_cameraSentence());
    parts.push(pickRandom(LIGHTING));
  } else {
    parts.push(_cameraSentence());
    parts.push(_lightingSentence());
    parts.push(_styleSentence());
  }

  // Seedance handles dramatic language well
  parts.push(pickRandom([
    'Dramatic cinematic energy throughout',
    'Bold visual storytelling with dynamic motion',
    'Intense atmospheric presence',
    'Powerful cinematic impact',
    'Rich layered visual narrative',
  ]));

  let result = parts.join('. ') + '.';
  return _enforceLength(result, PROVIDER_CONFIG.seedance.maxPromptLength);
}

/**
 * Enhance a prompt for fal Seedance.
 * Short and punchy. 1-2 sentences max.
 *
 * @param {string} userPrompt
 * @param {string} mode
 * @returns {string}
 */
export function enhanceForFalSeedance(userPrompt, mode = 'text_to_video') {
  const parts = [userPrompt.replace(/[.!?]$/, '')];

  if (mode === 'image_transition') {
    parts.push(pickRandom(TRANSITION_PHRASES));
  } else if (mode === 'animate_image') {
    parts.push(pickRandom(ANIMATE_PHRASES));
  } else {
    // Pick just ONE enrichment — camera OR lighting, not both
    if (Math.random() > 0.5) {
      parts.push(pickRandom(CAMERA_MOVES));
    } else {
      parts.push(pickRandom(LIGHTING));
    }
  }

  let result = parts.join(', ') + '.';
  return _enforceLength(result, PROVIDER_CONFIG.fal_seedance.maxPromptLength);
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Truncate prompt to maxLen at the nearest sentence boundary.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function _enforceLength(text, maxLen) {
  if (text.length <= maxLen) return text;

  // Try to cut at last sentence boundary before maxLen
  const truncated = text.slice(0, maxLen);
  const lastPeriod = truncated.lastIndexOf('.');
  if (lastPeriod > text.length * 0.5) {
    return truncated.slice(0, lastPeriod + 1);
  }
  return truncated.trim() + '.';
}
