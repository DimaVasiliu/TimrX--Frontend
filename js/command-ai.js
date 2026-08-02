/* =============================================================================
   COMMAND AI — natural language into a real generation
   -----------------------------------------------------------------------------
   "Generate an image of an ethereal human silhouette, 9:16, 4K"

   CREDIT SAFETY:
   The backend owns planning, provider validation, quoting, idempotency, and
   reservations. This module only renders the signed plan and calls execute
   after explicit confirmation. It never computes or deducts credits locally.
   ========================================================================== */
(function () {
  'use strict';

  var CHAT_API = (window.TIMRX_ENV && window.TIMRX_ENV.chatApiBase) ||
                 window.TIMRX_API_BASE || 'https://chat.timrx.live';

  /* Labels used by the confirmation surface. Execution is handled by the
     authenticated command endpoint, not by simulated panel clicks. */
  var INTENTS = {
    image:   { panel: 'image',   btn: 'generateImageBtn',    label: 'Image' },
    model:   { panel: 'model',   btn: 'generateModelBtn',    label: '3D model' },
    video:   { panel: 'video',   btn: 'generateVideoBtn',    label: 'Video' },
    remesh:  { panel: 'remesh',  btn: 'applyRemeshBtn',      label: 'Remesh' },
    texture: { panel: 'texture', btn: 'generateTextureBtn',  label: 'Texture' },
    rig:     { panel: 'rig',     btn: 'startRigBtn',         label: 'Rig' },
    animate: { panel: 'animate', btn: 'applyAnimationBtn2',  label: 'Animate' }
  };

  /* Where the prompt goes, per panel. */
  var PROMPT_FIELD = {
    image: 'imagePrompt', model: 'modelPrompt',
    video: 'videoTextPrompt', texture: 'texturePrompt'
  };

  /* Controls the model is allowed to set, per intent. Values are NOT listed
     here on purpose — they are read from the live <select> options at parse
     time, so this cannot drift from what the panels actually offer. That drift
     is what broke the rail lookups and the tray selectors earlier. */
  var TUNABLE = {
    image: ['imageAIProvider', 'imageOperation', 'imageShape', 'imageQuality', 'imageModelVariant'],
    model: ['modelAIModel', 'modelPoseMode', 'modelSymmetry', 'modelModelType', 'modelBatchCount'],
    video: ['videoAIProvider', 'videoDuration', 'videoAspectRatio', 'videoQuality', 'videoStylePreset'],
    remesh: ['remeshTopology', 'remeshTargetPolycount'],
    texture: [], rig: [], animate: []
  };

  var bar, input, panel, listEl;
  var pending = null;          // the parsed plan awaiting confirmation
  var parsing = false;

  // ------------------------------------------------------------------ helpers
  function q(id) { return document.getElementById(id); }

  /* Read the live option vocabulary for a panel. Must run while that panel is
     rendered, so callers activate the panel first. */
  function readVocabulary(intent) {
    var out = {};
    (TUNABLE[intent] || []).forEach(function (id) {
      var el = q(id);
      if (!el) return;
      if (el.tagName === 'SELECT') {
        out[id] = Array.prototype.map.call(el.options, function (o) {
          return { value: o.value, label: o.textContent.trim() };
        });
      } else {
        out[id] = { type: el.type || 'text', min: el.min, max: el.max };
      }
    });
    return out;
  }

  /* Match the model's loose value ("9:16", "4K", "Meshy 6") to a real option.
     Never invents: if nothing matches, the control is left untouched. */
  function resolveOption(opts, want) {
    if (!opts || !want) return null;
    var w = String(want).toLowerCase().trim();
    var exact = opts.find(function (o) { return o.value.toLowerCase() === w; });
    if (exact) return exact.value;
    var byLabel = opts.find(function (o) { return o.label.toLowerCase() === w; });
    if (byLabel) return byLabel.value;
    var loose = opts.find(function (o) {
      return o.label.toLowerCase().indexOf(w) > -1 || o.value.toLowerCase().indexOf(w) > -1;
    });
    return loose ? loose.value : null;
  }

  /* Write a control the way a human would: set it, fire change so every
     listener (cost recalculation included) runs, and mirror into
     GenerationState which is the single source of truth for generation. */
  function applyControl(id, value, mode) {
    var el = q(id);
    if (!el) return false;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    try {
      if (window.GenerationState && window.GenerationState.setSetting) {
        window.GenerationState.setSetting(mode, id, value);
      }
    } catch (e) { /* state module owns its own validation */ }
    return true;
  }

  /* The cost the EXISTING machinery arrived at — never computed here. */
  function readCost(intent) {
    var btn = q(INTENTS[intent].btn);
    var badge = btn && btn.querySelector('.btn-cost-badge');
    var footer = document.querySelector('#leftStack .gen-credits');
    var txt = (badge && badge.textContent) || (footer && footer.textContent) || '';
    var n = txt.replace(/[^\d]/g, '');
    return {
      credits: n ? parseInt(n, 10) : null,
      disabled: !!(btn && btn.disabled),
      missing: !btn
    };
  }

  // -------------------------------------------------------------------- parse
  function toolSchema(vocab) {
    return {
      name: 'create_generation',
      description: 'Turn a user request into a TimrX generation with concrete settings.',
      parameters: {
        type: 'object',
        properties: {
          intent: { type: 'string', enum: Object.keys(INTENTS),
                    description: 'Which generator to run.' },
          prompt: { type: 'string',
                    description: 'The creative prompt, with formatting instructions removed.' },
          settings: {
            type: 'object',
            description: 'Control id → option value. Only ids and values from the ' +
                         'supplied vocabulary may be used. Omit anything not requested.',
            additionalProperties: { type: 'string' }
          }
        },
        required: ['intent', 'prompt']
      },
      vocabulary: vocab
    };
  }

  async function parse(text) {
    var api = window.TimrXApi && window.TimrXApi.apiFetch;
    if (typeof api !== 'function') throw new Error('workspace API is not ready');
    var result = await api('/api/_mod/command/plan', {
      method: 'POST',
      body: { text: text },
      timeout: 45000,
      retry: false
    });
    if (!result.ok || !result.data || !result.data.ok) {
      throw new Error(result.error || result.data?.message || 'planning failed');
    }
    return result.data;
  }

  async function chat(messages) {
    var res = await fetch(CHAT_API + '/api/chat', {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages, temperature: 0 })
    });
    if (!res.ok) throw new Error('chat ' + res.status);
    var data = await res.json();
    return data.reply || data.content || data.message ||
           (data.choices && data.choices[0] && data.choices[0].message &&
            data.choices[0].message.content) || '';
  }

  // ------------------------------------------------------------------ confirm
  function stage(plan) {
    pending = {
      plan: plan.plan,
      quote: plan.quote,
      plan_token: plan.plan_token,
      cost: plan.quote,
      applied: []
    };
    render(pending);
  }

  function render(p) {
    if (!listEl) return;
    var cfg = INTENTS[p.plan.intent] || { label: p.plan.intent };
    var costTxt = p.cost.credits != null ? p.cost.credits + ' credits' : 'cost unavailable';
    var blocked = !p.quote.available || p.cost.credits <= 0;
    var settings = Object.keys(p.plan).filter(function (key) {
      return !['intent', 'prompt'].includes(key) && p.plan[key] !== '' && p.plan[key] != null;
    }).map(function (key) {
      return '<span class="cmdai__chip">' + esc(key.replaceAll('_', ' ') + ': ' + p.plan[key]) + '</span>';
    }).join('');

    listEl.innerHTML =
      '<div class="cmdai" role="group" aria-label="Confirm generation">' +
        '<div class="cmdai__head">' +
          '<span class="cmdai__kind">' + esc(cfg.label) + '</span>' +
          '<span class="cmdai__cost' + (blocked ? ' is-blocked' : '') + '">' + esc(costTxt) + '</span>' +
        '</div>' +
        '<p class="cmdai__prompt">' + esc(p.plan.prompt) + '</p>' +
        (settings ? '<div class="cmdai__chips">' + settings + '</div>' : '') +
        (p.plan.rejected && p.plan.rejected.length
          ? '<p class="cmdai__note">Ignored (not offered by this provider): ' +
            esc(p.plan.rejected.join(', ')) + '</p>' : '') +
        '<div class="cmdai__actions">' +
          '<button type="button" class="cmdai__btn cmdai__btn--go" data-cmdai="run"' +
            (blocked ? ' disabled' : '') + '>' +
            (blocked ? esc(p.quote.availability_error || 'Not ready') : 'Generate · ' + esc(costTxt)) + '</button>' +
          '<button type="button" class="cmdai__btn" data-cmdai="edit">Edit in panel</button>' +
        '</div>' +
        '<p class="cmdai__fine">The server rechecks provider availability and reserves the quoted credits only after you confirm.</p>' +
      '</div>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
    });
  }

  /* Execute only after the user confirms the server-generated quote. */
  async function run() {
    if (!pending) return;
    if (!pending.quote.available || pending.quote.credits <= 0) return;
    var button = listEl && listEl.querySelector('[data-cmdai="run"]');
    if (button) { button.disabled = true; button.textContent = 'Starting…'; }
    var api = window.TimrXApi && window.TimrXApi.apiFetch;
    if (typeof api !== 'function') return;
    var refreshed = await api('/api/_mod/command/quote', {
      method: 'POST', body: { plan_token: pending.plan_token }, retry: false
    });
    if (!refreshed.ok || !refreshed.data?.ok) {
      if (button) { button.disabled = false; button.textContent = 'Quote unavailable'; }
      throw new Error(refreshed.error || 'quote failed');
    }
    pending.plan_token = refreshed.data.plan_token;
    pending.quote = refreshed.data.quote;
    var key = (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : 'cmd-' + Date.now());
    var result = await api('/api/_mod/command/execute', {
      method: 'POST', body: { plan_token: pending.plan_token, idempotency_key: key },
      headers: { 'Idempotency-Key': key }, timeout: 30000, retry: false
    });
    if (!result.ok || !result.data?.ok) {
      if (button) { button.disabled = false; button.textContent = result.error || 'Could not start'; }
      throw new Error(result.error || result.data?.message || 'generation failed');
    }
    registerCommandJob(result.data, pending.plan);
    if (window.TimrXCommand && window.TimrXCommand.close) window.TimrXCommand.close();
    pending = null;
  }

  function registerCommandJob(data, plan) {
    var id = data.job_id || data.id;
    if (!id) return;
    var meta = {
      type: plan.intent, kind: plan.intent, stage: 'queued', status: 'queued',
      prompt: plan.prompt, provider: plan.provider, model: plan.model,
      reservation_id: data.reservation_id, created_at: Date.now()
    };
    if (window.savePendingMeta) window.savePendingMeta(id, meta);
    if (window.addActiveJob) window.addActiveJob(id);
    if (plan.intent === 'model' && window.watchJob) window.watchJob(id);
    if (plan.intent === 'image' && window.watchImageJob) window.watchImageJob(id, data.reservation_id, meta);
    if (plan.intent === 'video' && window.watchVideoJob) window.watchVideoJob(id, data.reservation_id, meta);
  }

  function looksLikeGenerationRequest(text) {
    if (!text || text.length < 3) return false;
    if (/\b(generate|create|make|render|build|turn|animate|remesh|texture|rig)\b/i.test(text)) {
      return true;
    }

    // Also accept natural commands such as "an image of..." or
    // "video from..." without forcing users to start with a verb.
    return /\b(image|picture|model|mesh|3d|video|clip)\b/i.test(text) &&
           /\b(of|from|with|using|in|at|for)\b/i.test(text);
  }

  function handleGenerationEnter(e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.repeat) return false;
    var text = input.value.trim();
    if (text.length < 3 || parsing) return false;

    // command-palette.js also handles Enter on the panel. Stop the event here
    // during capture so a generation request cannot accidentally activate a
    // filtered navigation row at the same time.
    e.preventDefault();
    e.stopImmediatePropagation();
    parsing = true;
    listEl.innerHTML = '<p class="cmdai__thinking">Reading your request…</p>';

    parse(text).then(function (plan) {
      if (!plan) {
        listEl.innerHTML = '<p class="cmdai__thinking">Not a generation request.</p>';
        return;
      }
      stage(plan);
    }).catch(function (err) {
      listEl.innerHTML = '<p class="cmdai__thinking">Could not reach the assistant (' +
                         esc(err.message) + ').</p>';
    }).finally(function () {
      parsing = false;
    });
    return true;
  }

  // --------------------------------------------------------------------- wire
  function boot() {
    panel = document.querySelector('.ws-cmd__panel');
    input = q('wsCmdInput');
    listEl = q('wsCmdList');
    if (!panel || !input || !listEl) return;

    input.addEventListener('keydown', handleGenerationEnter, true);

    listEl.addEventListener('click', function (e) {
      var a = e.target.closest('[data-cmdai]');
      if (!a) return;
      e.preventDefault();
      if (a.dataset.cmdai === 'run') {
        run().catch(function (err) {
          listEl.innerHTML = '<p class="cmdai__thinking">' + esc(err.message || 'Could not start generation.') + '</p>';
        });
      }
      if (a.dataset.cmdai === 'edit') {
        if (window.TimrXCommand) window.TimrXCommand.close();
        if (window.TimrXSheet) window.TimrXSheet.open();
        pending = null;
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else { boot(); }

  window.TimrXCommandAI = { parse: parse, stage: stage, run: run,
                            _readCost: readCost, _resolve: resolveOption };
})();
