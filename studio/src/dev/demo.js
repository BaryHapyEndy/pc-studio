// 这个模块负责：#demo 演示图——加两个「监视」组件、按 hash 开设置浮窗、跑若干步，给截图用。

import * as PC from '../engine/index.js';
import { S, selectNode } from '../ui/store.js';
import { addNode } from '../ui/palette.js';
import { connect } from '../ui/interaction.js';
import { resetRun, stepOnce, paintRun } from '../ui/runner.js';
import { fitView } from '../ui/render.js';
import { showCtx } from '../ui/clipboard.js';

export function runDemo() {
  const xi = S.spec.nodes.find(n => n.type === 'x');
  const e0 = S.spec.nodes.find(n => n.type === 'E' && (n.l || 0) === 0) || S.spec.nodes.find(n => n.type === 'E');
  const mon = addNode('MON', { x: 1000, y: 300 });
  if (e0) connect(e0.id, 'out', mon.id, 'v');
  const mon2 = addNode('MON', { x: 1000, y: 500 });
  const p0 = S.spec.nodes.find(n => n.type === 'V' && PC.tname(n) === 'P0');
  if (p0) connect(p0.id, 'out', mon2.id, 'v');
  resetRun();
  fitView();
  if (location.hash.includes('set')) document.querySelector('#ls-head').click();
  const n = +(location.hash.match(/run=(\d+)/) || [0, 250])[1];
  for (let i = 0; i < n; i++) stepOnce();
  paintRun();
  if (location.hash.includes('ctx')) {
    const nd = document.querySelector(`.node[data-id="${mon.id}"]`);
    selectNode(mon.id);
    const bb = nd.getBoundingClientRect();
    showCtx(bb.left + 30, bb.top + 12, true);
  }
}
