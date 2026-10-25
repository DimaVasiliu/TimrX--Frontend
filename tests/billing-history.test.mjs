import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const hub = fs.readFileSync(new URL('../hub.js', import.meta.url), 'utf8');
const source = hub.slice(hub.indexOf('// Usage / transaction history.'), hub.indexOf('// ===== Floating sprites randomizer'));

class Element {
  constructor() {
    this.children = [];
    this.events = new Map();
    this.text = '';
    const classes = new Set();
    this.classList = { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(x => x.textContent).join(''); }
  appendChild(child) { this.children.push(child); }
  setAttribute() {}
  addEventListener(type, fn) { this.events.set(type, fn); }
  click() { this.events.get('click')?.({ target: this }); }
}

function setup() {
  const elements = new Map();
  const ids = ['dashboardActivityList', 'dashboardUsageBtn', 'dashboardUsageInlineBtn', 'usageHistoryModal',
    'usageHistoryClose', 'usageHistoryRefreshBtn', 'usageHistoryList', 'usageAvailableCredits',
    'usageReservedCredits', 'usageBalanceCredits'];
  ids.forEach(id => elements.set(id, new Element()));
  const events = new Map();
  const requests = [];
  const context = {
    document: { getElementById: id => elements.get(id), createElement: () => new Element(), addEventListener() {} },
    window: { addEventListener: (type, fn) => events.set(type, fn), setTimeout() {} },
    fetch: () => new Promise(resolve => requests.push(resolve)),
    console,
  };
  vm.runInNewContext(source, context);
  return {
    get: id => elements.get(id), requests,
    switchAccount: () => events.get('timrx:auth:switched')(),
    respond(index, credits, ok = true) {
      requests[index]({ ok, status: ok ? 200 : 503, json: async () => ok
        ? { ok: true, items: [], summary: { available_credits: credits, reserved_credits: 0, balance_credits: credits } }
        : { ok: false, error: 'BILLING_ACTIVITY_UNAVAILABLE' } });
    },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('failed refresh clears the previous balance instead of displaying zero or stale credits', async () => {
  const ui = setup();
  ui.get('dashboardUsageBtn').click();
  ui.respond(0, 975);
  await flush();
  assert.equal(ui.get('usageAvailableCredits').textContent, '975');
  ui.get('usageHistoryRefreshBtn').click();
  assert.equal(ui.get('usageAvailableCredits').textContent, '--');
  ui.respond(1, null, false);
  await flush();
  assert.equal(ui.get('usageAvailableCredits').textContent, '--');
  assert.match(ui.get('usageHistoryList').textContent, /unavailable/i);
});

test('a delayed response from the previous account cannot overwrite the new account balance', async () => {
  const ui = setup();
  ui.get('dashboardUsageBtn').click(); // old account's full request
  ui.switchAccount(); // new compact request, then new full request
  assert.equal(ui.requests.length, 3);
  ui.respond(2, 120);
  await flush();
  assert.equal(ui.get('usageAvailableCredits').textContent, '120');
  ui.respond(0, 975);
  await flush();
  assert.equal(ui.get('usageAvailableCredits').textContent, '120');
  ui.respond(1, 120);
  await flush();
});
