const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('popup warns about the old collector instead of showing Active', () => {
  const elements = new Map();
  const context = vm.createContext({ document: {
    addEventListener() {}, getElementById(id) {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    },
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../popup.js'), 'utf8'), context);
  vm.runInContext('updateStatus({enabled:true}, {connections:2, pushOk:10})', context);
  assert.equal(elements.get('statusBadge').textContent, 'Reload page');
  assert.match(elements.get('runtimeStatus').textContent, /old reporting script/);
  vm.runInContext('updateStatus({enabled:true}, {transportVersion:2, connections:2})', context);
  assert.equal(elements.get('statusBadge').textContent, 'Active');
  vm.runInContext('updateStatus({enabled:false}, {connections:2})', context);
  assert.equal(elements.get('statusBadge').textContent, 'Disabled');
});
