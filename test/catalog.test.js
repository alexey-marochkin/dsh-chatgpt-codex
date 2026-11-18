import { selectModels } from '../core.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogRows, speedProvider } from '../catalog.js';

test('диагностика отличает неизвестные модели и разрешает только объявленные скорости', () => {
  const rows = catalogRows({ models: [
    {slug:'known',visibility:'list',service_tiers:[{id:'default'},{id:'priority'},{id:'ultrafast'},{id:'unknown'}]},
    {slug:'new',visibility:'list'}, {slug:'hidden',visibility:'hide'}
  ] }, [{id:'known'}]);
  assert.deepEqual(rows, [{id:'known',supported:true,tiers:['default','priority','ultrafast'],efforts:[]},{id:'new',supported:false,tiers:['default'],efforts:[]}]);
});

test('скорость доходит до payload, сохраняет обработчик, reasoning и инструменты', async () => {
  let options;
  const provider = speedProvider({streamSimple: (_m,_c,o) => {options=o; return 'stream';}}, () => 'priority');
  assert.equal(provider.streamSimple({id:'m'}, {}, {reasoning:'high',onPayload: body => ({...body,tools:['tool']})}), 'stream');
  assert.equal(options.reasoning, 'high');
  assert.deepEqual(await options.onPayload({model:'m'}), {model:'m',tools:['tool'],service_tier:'priority'});
});

test('выбор скорости фиксируется при начале запроса', async () => {
  let speed = 'ultrafast';
  let options;
  const provider = speedProvider({streamSimple: (_m,_c,o) => {options=o;}}, () => speed);
  provider.streamSimple({id:'m'}, {}, {});
  speed = 'default';
  assert.equal((await options.onPayload({})).service_tier, 'ultrafast');
});


test('уровни рассуждения пересекаются с каталогом без подмены minimal на low', () => {
  const known = [{ id:'m',reasoning:true,thinkingLevelMap:{minimal:'low',xhigh:'xhigh',max:'max'} }];
  const catalog = {models:[{slug:'m',visibility:'list',supported_reasoning_levels:[{effort:'low'},{effort:'high'},{effort:'minimal'},{effort:'ultra'}]}]};
  assert.deepEqual(catalogRows(catalog, known)[0].efforts, ['low','high']);
  const model = selectModels(catalog, known)[0];
  assert.equal(model.thinkingLevelMap.low, 'low');
  assert.equal(model.thinkingLevelMap.medium, null);
  assert.equal(model.thinkingLevelMap.minimal, null);
  assert.equal(model.thinkingLevelMap.off, null);
});
