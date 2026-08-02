/* =============================================================================
   COMMAND AI — natural language into a real generation
   -----------------------------------------------------------------------------
   "Generate an image of an ethereal human silhouette, 9:16, 4K"

   CREDIT SAFETY — the load-bearing decision in this file:

   This module never prices anything and never deducts anything. It sets
   settings, lets the existing machinery recompute the cost, shows the user
   that number, and then CLICKS THE REAL GENERATE BUTTON. Credits are reserved
   server-side by exactly the same path as a manual click
   (credits.js → reservationId / insufficient), so there is one pricing
   authority and no parallel arithmetic that can drift from it.

   Consequences that fall out of that choice, all deliberate:
     · quality/duration/model changes are priced by updateButtonCosts(), which
       already reads /api/billing/action-costs — we just read the badge it fills
     · an insufficient balance raises the existing modal, not a bespoke one
     · if a provider changes its rate, this file needs no edit

   It also never fires without confirmation. A misparse that silently spends
   48 credits is far worse than one extra keystroke.
   ========================================================================== */
(function () {
  'use strict';

  var CHAT_API = (window.TIMRX_ENV && window.TIMRX_ENV.chatApiBase) ||
                 window.TIMRX_API_BASE || 'https://chat.timrx.live';

  /* Each intent maps to the button main.js already delegates on. Clicking it
     is what keeps the credit path identical to a manual generation. */
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
    /* Two passes. The first only decides the intent, because the option
       vocabulary differs per panel and we cannot send all of it. The second
       runs once the right panel is live and its real options are readable. */
    var sys1 = 'You route requests in a generative media tool. Reply with ONLY one ' +
               'word from: ' + Object.keys(INTENTS).join(', ') + '. ' +
               'If the request is not asking to create or modify media, reply: none.';

    var intentRes = await chat([
      { role: 'system', content: sys1 },
      { role: 'user', content: text }
    ]);
    var intent = String(intentRes || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!INTENTS[intent]) return null;

    // Bring the panel up so its real options exist to be read and set.
    if (window.TimrXWorkspace && window.TimrXWorkspace.activatePanel) {
      window.TimrXWorkspace.activatePanel(intent);
      await new Promise(function (r) { setTimeout(r, 260); });
    }

    var vocab = readVocabulary(intent);
    var sys2 = 'Extract a generation request as JSON: {"prompt": "...", "settings": {...}}.\n' +
      'settings keys MUST come from this vocabulary, and each value MUST be one of ' +
      'the listed option values. Omit any setting the user did not ask for. ' +
      'Strip formatting instructions (aspect ratio, quality, model name) out of prompt.\n' +
      'VOCABULARY:\n' + JSON.stringify(vocab, null, 0) + '\n' +
      'Reply with JSON only, no prose.';

    var raw = await chat([
      { role: 'system', content: sys2 },
      { role: 'user', content: text }
    ]);

    var parsed = {};
    try {
      parsed = JSON.parse(String(raw).replace(/^```(?:json)?|```$/gm, '').trim());
    } catch (e) {
      parsed = { prompt: text };     // fall back to the raw text as the prompt
    }

    // Resolve every proposed value against the real options; drop what does
    // not match rather than passing a guess through to a paid API call.
    var resolved = {}, rejected = [];
    Object.keys(parsed.settings || {}).forEach(function (id) {
      var opts = vocab[id];
      if (!Array.isArray(opts)) return;
      var val = resolveOption(opts, parsed.settings[id]);
      if (val !== null) resolved[id] = val;
      else rejected.push(id + '=' + parsed.settings[id]);
    });

    return {
      intent: intent,
      prompt: (parsed.prompt || text).trim(),
      settings: resolved,
      rejected: rejected,
      vocab: vocab
    };
  }

  async function chat(messages) {
    var res = await fetch(CHAT_API + '/api/chat', {
      method: 'POST',
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
    var cfg = INTENTS[plan.intent];

    // Fill the prompt field, then the settings, then let the cost settle.
    var pf = PROMPT_FIELD[plan.intent];
    if (pf && q(pf)) {
      q(pf).value = plan.prompt;
      q(pf).dispatchEvent(new Event('input', { bubbles: true }));
    }
    var applied = [];
    Object.keys(plan.settings).forEach(function (id) {
      if (applyControl(id, plan.settings[id], plan.intent)) {
        applied.push({ id: id, value: plan.settings[id] });
      }
    });

    if (window.WorkspaceCredits && window.WorkspaceCredits.updateButtonCosts) {
      window.WorkspaceCredits.updateButtonCosts();
    }

    setTimeout(function () {
      var cost = readCost(plan.intent);
      pending = { plan: plan, cost: cost, applied: applied };
      render(pending);
    }, 220);
  }

  function render(p) {
    if (!listEl) return;
    var cfg = INTENTS[p.plan.intent];
    var chips = p.applied.map(function (a) {
      var el = q(a.id);
      var label = el && el.selectedOptions && el.selectedOptions[0]
        ? el.selectedOptions[0].textContent.trim() : a.value;
      return '<span class="cmdai__chip">' + esc(label) + '</span>';
    }).join('');

    var costTxt = p.cost.credits != null ? p.cost.credits + ' credits' : 'cost pending';
    var blocked = p.cost.disabled;

    listEl.innerHTML =
      '<div class="cmdai" role="group" aria-label="Confirm generation">' +
        '<div class="cmdai__head">' +
          '<span class="cmdai__kind">' + esc(cfg.label) + '</span>' +
          '<span class="cmdai__cost' + (blocked ? ' is-blocked' : '') + '">' + esc(costTxt) + '</span>' +
        '</div>' +
        '<p class="cmdai__prompt">' + esc(p.plan.prompt) + '</p>' +
        (chips ? '<div class="cmdai__chips">' + chips + '</div>' : '') +
        (p.plan.rejected.length
          ? '<p class="cmdai__note">Ignored (not offered by this provider): ' +
            esc(p.plan.rejected.join(', ')) + '</p>' : '') +
        '<div class="cmdai__actions">' +
          '<button type="button" class="cmdai__btn cmdai__btn--go" data-cmdai="run"' +
            (blocked ? ' disabled' : '') + '>' +
            (blocked ? 'Not ready' : 'Generate · ' + esc(costTxt)) + '</button>' +
          '<button type="button" class="cmdai__btn" data-cmdai="edit">Edit in panel</button>' +
        '</div>' +
        '<p class="cmdai__fine">Runs the same Generate button as the panel — ' +
          'credits are reserved server-side at the current rate.</p>' +
      '</div>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
    });
  }

  /* The only thing that spends credits: the real button. */
  function run() {
    if (!pending) return;
    var btn = q(INTENTS[pending.plan.intent].btn);
    if (!btn || btn.disabled) return;
    if (window.TimrXCommand && window.TimrXCommand.close) window.TimrXCommand.close();
    pending = null;
    btn.click();
  }

  // --------------------------------------------------------------------- wire
  function boot() {
    panel = document.querySelector('.ws-cmd__panel');
    input = q('wsCmdInput');
    listEl = q('wsCmdList');
    if (!panel || !input || !listEl) return;

    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey) return;
      var text = input.value.trim();
      // Short text is almost certainly a palette filter, not a request.
      if (text.length < 12 || !/\b(generate|create|make|render|build|turn)\b/i.test(text)) return;
      e.preventDefault();
      e.stopPropagation();
      listEl.innerHTML = '<p class="cmdai__thinking">Reading your request…</p>';
      parse(text).then(function (plan) {
        if (!plan) { listEl.innerHTML = '<p class="cmdai__thinking">Not a generation request.</p>'; return; }
        stage(plan);
      }).catch(function (err) {
        listEl.innerHTML = '<p class="cmdai__thinking">Could not reach the assistant (' +
                           esc(err.message) + ').</p>';
      });
    }, true);

    listEl.addEventListener('click', function (e) {
      var a = e.target.closest('[data-cmdai]');
      if (!a) return;
      e.preventDefault();
      if (a.dataset.cmdai === 'run') run();
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
