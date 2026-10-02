import assert from 'node:assert/strict';
import { createPanelNavigator } from '../server/panel-navigation.mjs';

// Library callers read only result.control. A pending navigation must remain
// queued until the regular exchange consumer can execute and acknowledge it.
const navigator = createPanelNavigator(async (_operation, args) => ({ requests: [],
  ...(args.responses?.some(r => r.id === '$freecanvas/control') ? { control: { documents: [] } } : {})
}));
const view = { document_id: null, navigation: true, ready: true, active: true, switching: false, ui_version: '0.5.4' };
navigator.observe('panel', view);
const pending = navigator.navigate({ panel_id: 'panel', document_id: 'target' });
pending.catch(() => {});
try {
  for (const operation of ['list', 'rename']) {
    const result = await navigator.exchange({ session: 'panel', responses: [{ id: '$freecanvas/control', result: { operation } }] });
    assert.deepEqual(result.requests, [], 'Library replies must not consume pending navigation');
  }
  const delivered = await navigator.exchange({ session: 'panel', responses: [], view });
  assert.equal(delivered.requests.length, 1);
  assert.equal(delivered.requests[0].command, 'freecanvas_navigate');
  assert.equal(delivered.requests[0].args.document_id, 'target');
  const duplicate = await navigator.exchange({ session: 'panel', responses: [], view });
  assert.equal(duplicate.requests.length, 0, 'A sent navigation is not replayed while waiting for acknowledgement');
  await navigator.exchange({ session: 'panel', responses: [{ id: delivered.requests[0].id, result: { document_id: 'target', ready: true } }], view: { ...view, document_id: 'target' } });
  assert.equal((await pending).document_id, 'target');
  console.log('PASS Home library replies preserve pending navigation; regular polling delivers it once and waits for the target acknowledgement');
} finally { navigator.detach('panel'); await pending.catch(() => {}); }
