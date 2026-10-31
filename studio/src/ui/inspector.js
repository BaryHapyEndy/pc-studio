// 这个模块负责：右栏检视器——选中节点的名称 / 形状 / 层号 / 参数，以及「删除节点」。

import * as PC from '../engine/index.js';
import { $, el } from './dom.js';
import { S, notify, setSelection, usedNames } from './store.js';
import { toast } from './modal.js';

export function renderInspector() {
  const box = $('#insp');
  box.innerHTML = '<h4>检视器</h4>';
  const n = S.spec.nodes.find(x => x.id === S.sel);
  if (!n) { box.appendChild(el('div', 'empty', '点一个节点看它的语义、形状、以及它产生的 op。')); return; }
  const c = PC.LIBMAP[n.type];
  box.appendChild(el('div', 'kv', `<span>${c.name}</span><b>${n.type}</b>`));
  box.appendChild(el('div', 'hint', c.note || ''));

  const addRow = (label, input) => {
    const r = el('div', 'row'); r.appendChild(el('label', null, label)); r.appendChild(input); box.appendChild(r);
  };
  // 状态组件：名字和形状都由用户定
  if (c.state) {
    const nm = el('input'); nm.type = 'text'; nm.value = PC.tname(n); nm.style.width = '116px';
    nm.addEventListener('change', () => {
      const want = nm.value.trim();
      if (!want) { nm.value = PC.tname(n); return; }
      if (usedNames().has(want) && want !== PC.tname(n)) { toast('这个名字已经被占了'); nm.value = PC.tname(n); return; }
      n.name = want; notify('reset');
    });
    addRow('名称', nm);

    const shp = PC.stateShape(S.spec, n);
    const box = el('div', 'shp');
    const rIn = el('input'); rIn.type = 'number'; rIn.min = 1; rIn.step = 1; rIn.value = shp.r;
    const cIn = el('input'); cIn.type = 'number'; cIn.min = 1; cIn.step = 1; cIn.value = shp.c;
    const apply = () => {
      const r = Math.max(1, +rIn.value | 0), cc = Math.max(1, +cIn.value | 0);
      n.shape = { r, c: cc };
      notify('reset');
    };
    rIn.addEventListener('change', apply); cIn.addEventListener('change', apply);
    box.appendChild(rIn); box.appendChild(el('span', null, '×')); box.appendChild(cIn);
    addRow('形状', box);
    box.appendChild(el('span', 'dim2', ''));
    box.parentElement.appendChild(el('div', 'hint', '算子连上来之后会按这个形状校验；改形状会重建整个计划。'));
  }
  if (n.type === 'EM') {
    const inp = el('input'); inp.type = 'number'; inp.value = n.l || 1; inp.min = 1;
    inp.addEventListener('change', () => { n.l = Math.max(1, +inp.value | 0); notify('reset'); });
    addRow('层号（只影响张量命名）', inp);
  }
  if (c.params && c.params.includes('s')) {
    const inp = el('input'); inp.type = 'number'; inp.step = 0.01; inp.value = n.s == null ? 0.1 : n.s;
    inp.addEventListener('change', () => { n.s = +inp.value; notify('render'); });
    addRow('系数 s', inp);
  }
  if (c.params && c.params.includes('c')) {
    const inp = el('input'); inp.type = 'number'; inp.step = 0.1; inp.value = n.c == null ? 1 : n.c;
    inp.addEventListener('change', () => { n.c = +inp.value; notify('render'); });
    addRow('裁剪 c', inp);
  }

  // 它产生的 op
  if (S.rt && S.rt.pr) {
    box.appendChild(el('div', 'grp', '它产生的 op（按相位）'));
    const t = S.rt.pr.tensors.find(t => t.name === (PC.tname ? PC.tname(n) : ''));
    if (t) box.appendChild(el('div', 'kv', `<span>张量 ${t.name}</span><b>${PC.fmtShape(t.shape)} · off ${t.off} B</b>`));
  }
  const del = el('button', 'btn danger', '删除节点');
  del.style.marginTop = '8px';
  del.addEventListener('click', () => {
    S.spec.nodes = S.spec.nodes.filter(x => x.id !== n.id);
    S.spec.edges = S.spec.edges.filter(e => e.from[0] !== n.id && e.to[0] !== n.id);
    setSelection([], null); notify('reset');
  });
  box.appendChild(del);
}
