/**
 * TimrX Smart Prompt Enhancer — Browser Bundle
 * ──────────────────────────────────────────────
 * Self-contained IIFE that exposes window.TimrxPromptEnhancer.
 * LOCAL deterministic + randomized prompt enhancement.
 * No server-side LLM dependency. Fast, offline-capable.
 *
 * Modules bundled:
 *   - variations.js  → phrase banks
 *   - providers.js   → provider-specific enhancers
 *   - safety.js      → safety softening
 *   - scoring.js     → quality scoring
 *   - enhancer.js    → orchestrator
 *
 * API:
 *   TimrxPromptEnhancer.enhance(prompt, { provider, mode })
 *   TimrxPromptEnhancer.quickScore(prompt, provider)
 *   TimrxPromptEnhancer.getProviderInfo(provider)
 *   TimrxPromptEnhancer.detectMode({ hasImage, hasEndImage })
 *   TimrxPromptEnhancer.sanitizePrompt(prompt, provider)
 *   TimrxPromptEnhancer.detectIssues(prompt)
 */
(function (global) {
  'use strict';

  // ════════════════════════════════════════════════════════════════
  // VARIATIONS — Randomized Phrase Banks
  // ════════════════════════════════════════════════════════════════

  var CAMERA_MOVES = [
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

  var LIGHTING = [
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

  var STYLES = [
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

  var ENVIRONMENTS = [
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

  var MOTION_QUALITY = [
    'smooth fluid motion',
    'steady elegant camera movement',
    'ultra-smooth stabilized footage',
    'buttery-smooth motion',
    'professional Steadicam quality',
    'graceful continuous movement',
  ];

  var DETAIL_ENHANCERS = [
    'rich atmospheric depth',
    'fine surface detail visible',
    'subtle particle effects in the air',
    'gentle depth-of-field bokeh',
    'micro-detail textures',
    'layered visual depth',
    'natural material reflections',
    'subtle environmental storytelling',
  ];

  var TRANSITION_PHRASES = [
    'seamless morph between scenes',
    'fluid transformation from first frame to last',
    'smooth interpolation with natural motion',
    'organic transition preserving spatial coherence',
    'elegant blend between start and end compositions',
    'gradual metamorphosis with consistent lighting',
  ];

  var ANIMATE_PHRASES = [
    'subtle life-like motion added to the still image',
    'gentle animation preserving the original composition',
    'natural movement emerging from the photograph',
    'camera slowly exploring the scene from the image',
    'bringing the still frame to life with cinematic motion',
    'parallax depth effect animating the layers',
  ];

  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // ════════════════════════════════════════════════════════════════
  // SAFETY — Client-Side Prompt Softening
  // ════════════════════════════════════════════════════════════════

  var SAFETY_RULES = [
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
    [/\b(nude|naked|nudity)\b/gi, 'minimal attire'],
    [/\b(sexy|seductive)\b/gi, 'elegant'],
    [/\b(explicit)\b/gi, 'vivid'],
    [/\b(dialogue|speaking|says?|talks?)\b/gi, 'gestures'],
    [/\b(narrat(?:ion|or|es?))\b/gi, 'visual storytelling'],
    [/\b(voiceover|voice[\s-]?over)\b/gi, 'visual narration'],
    [/\b(music plays|soundtrack|audio)\b/gi, 'rhythmic visual energy'],
    [/\b(text overlay|subtitle(?:s)?|caption(?:s)?)\b/gi, 'visual emphasis'],
    [/\b(played by|starring|featuring)\s+[A-Z][a-z]+\s+[A-Z][a-z]+/g, ''],
    [/\s{2,}/g, ' '],
    [/\.\s*\./g, '.'],
    [/,\s*\./g, '.'],
    [/^\s*[,.]/, ''],
  ];

  function sanitizePrompt(prompt, provider) {
    if (!prompt || typeof prompt !== 'string') return '';
    var result = prompt;
    for (var i = 0; i < SAFETY_RULES.length; i++) {
      result = result.replace(SAFETY_RULES[i][0], SAFETY_RULES[i][1]);
    }
    result = result.replace(/\s{2,}/g, ' ').trim();
    if (result.endsWith(',')) result = result.slice(0, -1).trim();
    return result;
  }

  function detectIssues(prompt) {
    if (!prompt) return [];
    var issues = [];
    if (/\b(explo(?:sion|de)|gun|shoot|blood|gore|kill|murder|stab|weapon)\b/i.test(prompt)) {
      issues.push('Contains violent language (will be softened)');
    }
    if (/\b(nude|naked|explicit|sexy)\b/i.test(prompt)) {
      issues.push('Contains explicit language (will be softened)');
    }
    if (/\b(dialogue|voiceover|narration|music plays|text overlay)\b/i.test(prompt)) {
      issues.push('Contains audio/text references (not supported by video generators)');
    }
    if (prompt.length > 800) {
      issues.push('Prompt is very long \u2014 shorter prompts often produce better results');
    }
    return issues;
  }

  // ════════════════════════════════════════════════════════════════
  // SCORING — Prompt Quality Heuristics
  // ════════════════════════════════════════════════════════════════

  var POSITIVE_SIGNALS = [
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

  var NEGATIVE_SIGNALS = [
    { pattern: /\b(explosion|gun|blood|kill|murder|weapon)\b/i, weight: -10, label: 'unsafe content' },
    { pattern: /\b(dialogue|voiceover|music\s+plays|text\s+overlay)\b/i, weight: -8, label: 'non-visual reference' },
    { pattern: /\b(make it|I want|please|can you)\b/i, weight: -5, label: 'conversational language' },
    { pattern: /\b(and then|next|after that|finally)\b/i, weight: -4, label: 'multi-scene complexity' },
  ];

  function scorePrompt(prompt, provider) {
    if (!prompt || typeof prompt !== 'string') {
      return { score: 0, grade: 'empty', signals: [], suggestions: ['Add a prompt to get started'] };
    }
    var trimmed = prompt.trim();
    var score = 30;
    var signals = [];
    var suggestions = [];

    var wordCount = trimmed.split(/\s+/).length;
    if (wordCount < 3) {
      score -= 10;
      suggestions.push('Add more detail \u2014 describe the scene, camera, and lighting');
    } else if (wordCount >= 8 && wordCount <= 40) {
      score += 10;
    } else if (wordCount > 60) {
      score -= 5;
      suggestions.push('Consider shortening \u2014 focused prompts often work better');
    }

    var sentences = trimmed.split(/[.!?]+/).filter(function(s) { return s.trim().length > 0; }).length;
    if (sentences >= 2 && sentences <= 4) score += 5;
    else if (sentences > 6) {
      score -= 5;
      suggestions.push('Too many scenes \u2014 try describing one clear moment');
    }

    for (var i = 0; i < POSITIVE_SIGNALS.length; i++) {
      if (POSITIVE_SIGNALS[i].pattern.test(trimmed)) {
        score += POSITIVE_SIGNALS[i].weight;
        signals.push(POSITIVE_SIGNALS[i].label);
      }
    }
    for (var j = 0; j < NEGATIVE_SIGNALS.length; j++) {
      if (NEGATIVE_SIGNALS[j].pattern.test(trimmed)) {
        score += NEGATIVE_SIGNALS[j].weight;
        signals.push(NEGATIVE_SIGNALS[j].label);
      }
    }

    if (signals.indexOf('camera direction') === -1) {
      suggestions.push('Add camera movement (e.g., "slow orbit", "tracking shot")');
    }
    if (signals.indexOf('lighting detail') === -1) {
      suggestions.push('Describe lighting (e.g., "golden hour", "dramatic rim light")');
    }
    if (signals.indexOf('cinematic style') === -1 && signals.indexOf('quality descriptor') === -1) {
      suggestions.push('Add a style hint (e.g., "cinematic", "photorealistic")');
    }

    if (provider === 'fal_seedance' && wordCount > 30) {
      score -= 5;
      suggestions.push('fal Seedance works best with shorter prompts (1\u20132 sentences)');
    }
    if (provider === 'vertex' && signals.indexOf('unsafe content') !== -1) {
      score -= 10;
      suggestions.push('Vertex/Veo may reject violent or unsafe content');
    }

    score = Math.max(0, Math.min(100, score));

    var grade;
    if (score >= 80) grade = 'excellent';
    else if (score >= 60) grade = 'good';
    else if (score >= 40) grade = 'fair';
    else if (score >= 20) grade = 'weak';
    else grade = 'poor';

    return { score: score, grade: grade, signals: signals, suggestions: suggestions };
  }

  function getScoreLabel(score) {
    if (score >= 80) return 'Strong prompt';
    if (score >= 60) return 'Good prompt';
    if (score >= 40) return 'Could be stronger';
    if (score >= 20) return 'Needs more detail';
    return 'Very basic';
  }

  // ════════════════════════════════════════════════════════════════
  // PROVIDERS — Provider-Specific Enhancement
  // ════════════════════════════════════════════════════════════════

  var PROVIDER_CONFIG = {
    vertex: {
      name: 'Google Veo',
      maxPromptLength: 480,
      style: 'clean',
      sentenceTarget: [2, 3],
    },
    seedance: {
      name: 'Seedance',
      maxPromptLength: 800,
      style: 'dynamic',
      sentenceTarget: [3, 5],
    },
    fal_seedance: {
      name: 'fal Seedance',
      maxPromptLength: 350,
      style: 'concise',
      sentenceTarget: [1, 2],
    },
  };

  // ── Sentence builders ──────────────────────────────────────

  function _cameraSentence() {
    return pickRandom(CAMERA_MOVES) + ', ' + pickRandom(MOTION_QUALITY);
  }

  function _lightingSentence() {
    return pickRandom(LIGHTING) + ' with ' + pickRandom(ENVIRONMENTS);
  }

  function _styleSentence() {
    return pickRandom(STYLES) + ', ' + pickRandom(DETAIL_ENHANCERS);
  }

  function _enforceLength(text, maxLen) {
    if (text.length <= maxLen) return text;
    var truncated = text.slice(0, maxLen);
    var lastPeriod = truncated.lastIndexOf('.');
    if (lastPeriod > text.length * 0.5) {
      return truncated.slice(0, lastPeriod + 1);
    }
    return truncated.trim() + '.';
  }

  // ── Vertex enhancer ────────────────────────────────────────

  var VERTEX_CLOSERS = [
    'Professional cinematography',
    'Cinematic visual quality',
    'Clean cinematic composition',
    'Polished film-grade visuals',
  ];

  function enhanceForVertex(userPrompt, mode) {
    var parts = [userPrompt.replace(/[.!?]$/, '')];
    if (mode === 'image_transition') {
      parts.push(pickRandom(TRANSITION_PHRASES));
      parts.push(_cameraSentence());
    } else if (mode === 'animate_image') {
      parts.push(pickRandom(ANIMATE_PHRASES));
      parts.push(pickRandom(LIGHTING));
    } else {
      parts.push(_cameraSentence());
      parts.push(pickRandom(LIGHTING));
    }
    parts.push(pickRandom(VERTEX_CLOSERS));
    var result = parts.join('. ') + '.';
    return _enforceLength(result, PROVIDER_CONFIG.vertex.maxPromptLength);
  }

  // ── Seedance enhancer ──────────────────────────────────────

  var SEEDANCE_CLOSERS = [
    'Dramatic cinematic energy throughout',
    'Bold visual storytelling with dynamic motion',
    'Intense atmospheric presence',
    'Powerful cinematic impact',
    'Rich layered visual narrative',
  ];

  function enhanceForSeedance(userPrompt, mode) {
    var parts = [userPrompt.replace(/[.!?]$/, '')];
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
    parts.push(pickRandom(SEEDANCE_CLOSERS));
    var result = parts.join('. ') + '.';
    return _enforceLength(result, PROVIDER_CONFIG.seedance.maxPromptLength);
  }

  // ── fal Seedance enhancer ──────────────────────────────────

  function enhanceForFalSeedance(userPrompt, mode) {
    var parts = [userPrompt.replace(/[.!?]$/, '')];
    if (mode === 'image_transition') {
      parts.push(pickRandom(TRANSITION_PHRASES));
    } else if (mode === 'animate_image') {
      parts.push(pickRandom(ANIMATE_PHRASES));
    } else {
      if (Math.random() > 0.5) {
        parts.push(pickRandom(CAMERA_MOVES));
      } else {
        parts.push(pickRandom(LIGHTING));
      }
    }
    var result = parts.join(', ') + '.';
    return _enforceLength(result, PROVIDER_CONFIG.fal_seedance.maxPromptLength);
  }

  // ── Enhancer map ───────────────────────────────────────────

  var ENHANCERS = {
    vertex: enhanceForVertex,
    seedance: enhanceForSeedance,
    fal_seedance: enhanceForFalSeedance,
  };

  // ════════════════════════════════════════════════════════════════
  // ORCHESTRATOR — Main enhance() function
  // ════════════════════════════════════════════════════════════════

  function detectMode(opts) {
    opts = opts || {};
    if (opts.hasEndImage) return 'image_transition';
    if (opts.hasImage) return 'animate_image';
    return 'text_to_video';
  }

  function enhance(rawPrompt, options) {
    options = options || {};
    var provider = options.provider || 'vertex';
    var mode = options.mode || 'text_to_video';
    var original = (rawPrompt || '').trim();

    if (!original) {
      return {
        enhanced: '',
        original: '',
        provider: provider,
        mode: mode,
        score: { score: 0, grade: 'empty', signals: [], suggestions: ['Add a prompt to get started'] },
        scoreLabel: 'Empty prompt',
        safety: [],
      };
    }

    // 1. Pre-enhancement safety scan
    var safetyIssues = detectIssues(original);

    // 2. Pre-sanitize
    var sanitized = sanitizePrompt(original, provider);

    // 3. Pick enhancer
    var enhanceFn = ENHANCERS[provider] || ENHANCERS.vertex;

    // 4. Enhance
    var enhanced = enhanceFn(sanitized, mode);

    // 5. Post-enhancement safety pass
    enhanced = sanitizePrompt(enhanced, provider);

    // 6. Score
    var scoreResult = scorePrompt(enhanced, provider);
    var label = getScoreLabel(scoreResult.score);

    return {
      enhanced: enhanced,
      original: original,
      provider: provider,
      mode: mode,
      score: scoreResult,
      scoreLabel: label,
      safety: safetyIssues,
    };
  }

  function quickScore(prompt, provider) {
    var result = scorePrompt(prompt, provider || 'vertex');
    result.label = getScoreLabel(result.score);
    return result;
  }

  function getProviderInfo(provider) {
    return PROVIDER_CONFIG[provider] || PROVIDER_CONFIG.vertex;
  }

  // ════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════════

  global.TimrxPromptEnhancer = {
    enhance: enhance,
    quickScore: quickScore,
    getProviderInfo: getProviderInfo,
    detectMode: detectMode,
    sanitizePrompt: sanitizePrompt,
    detectIssues: detectIssues,
    // Expose internals for template integration
    _pickRandom: pickRandom,
    _CAMERA_MOVES: CAMERA_MOVES,
    _LIGHTING: LIGHTING,
    _STYLES: STYLES,
    _ENVIRONMENTS: ENVIRONMENTS,
    _PROVIDER_CONFIG: PROVIDER_CONFIG,
  };

})(typeof window !== 'undefined' ? window : this);
