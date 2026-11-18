import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Монтирует вкладку меню через публичный слот и управляет ответами сервера без настоящего аккаунта.
function fixture() {
  let plugin, menu, index = 0, refIndex = 0;
  const states = [], refs = [], effects = [], calls = [];
  let current = { provider: 'chatgpt-codex', model: 'model' };
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useSyncExternalStore: (_, snapshot) => snapshot(),
    useState(initial) { const i = index++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = value; }]; },
    useRef(initial) { return refs[refIndex++] ??= {current:initial}; },
    useEffect(fn) { effects.push(fn); }
  };
  const data = {hasCredential:true,configured:true,catalog:{rows:[{id:'model',supported:true,tiers:['default','priority']}]},speeds:{}};
  const send = async (action, body) => { calls.push({action,body}); if (action === 'speed') data.speeds[body.model] = body.tier; return structuredClone(data); };
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    setTimeout: () => 1, clearTimeout() {},
    window:{__ModuleLoader__:{load: entry => { plugin = entry.factory(name => name === 'react' ? react : {Tooltip:'tooltip'}); }}}
  });
  const scope = {slots:{inject: (_,fn) => fn(), register: (opts,component) => { if(opts.name === 'conversation.input.model.options') menu=component; }}};
  plugin.apply({effect(){},slots:{inject(){}},inject: (deps,fn) => deps.includes('modelDirectories') && fn(scope)});
  const props = {directory:{getSnapshot:()=>({current})},send,language:'ru',locked:false,reportFailure:assert.fail};
  const control = menu(props);
  const render = (extra={}) => { index=refIndex=0; return control.type({...control.props,...extra}); };
  return {data,calls,effects,render,menu,props,setCurrent: value => {current=value;}};
}

test('молния меню скрыта для чужого провайдера и недоступного Fast', async () => {
  const f=fixture();
  f.setCurrent({provider:'deepseek',model:'model'});
  assert.equal(f.menu(f.props),null);
  assert.equal(f.render(),null);
  f.effects[0](); await new Promise(resolve=>setImmediate(resolve));
  assert(f.render());
  f.data.catalog.rows[0].tiers=['default'];
  f.effects[0](); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.render(),null);
});

test('одна кнопка меняет Fast выбранной модели, заливку и доступное состояние', async () => {
  const f=fixture(); f.render(); f.effects[0](); await new Promise(resolve=>setImmediate(resolve));
  const toggle = () => f.render().children[1];
  let button = toggle().type(toggle().props).children[0];
  assert.equal(button.props.role,'switch');
  assert.equal(button.props['aria-checked'],false);
  assert.equal(button.children[0].props.fill,'none');
  await button.props.onClick();
  button=toggle().type(toggle().props).children[0];
  assert.equal(button.props['aria-checked'],true);
  assert.equal(button.children[0].props.fill,'currentColor');
  assert.equal(f.calls.filter(c=>c.action==='speed')[0].body.model,'model');
  assert.equal(f.calls.filter(c=>c.action==='speed')[0].body.tier,'priority');
  const locked=f.render({locked:true}).children[1];
  assert.equal(locked.props.disabled,true);
  await locked.props.onClick();
  assert.equal(f.calls.filter(c=>c.action==='speed').length,1);
  await button.props.onClick();
  assert.equal(f.data.speeds.model,'default');
});
