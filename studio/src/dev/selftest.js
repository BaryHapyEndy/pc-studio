// 这个模块负责：#selftest 交互自检——用合成事件把框选/平移/缩放/菜单/剪线全跑一遍并打 TEST 日志，给无头浏览器用。

import * as PC from '../engine/index.js';
import { S, setSelection, selectNode } from '../ui/store.js';
import { addNode } from '../ui/palette.js';
import { connect } from '../ui/interaction.js';
import { resetRun } from '../ui/runner.js';
import { setMode, newDrawing, loadPreset } from '../ui/menu.js';
import { showCtx, hideCtx, pasteClip, deleteSelected } from '../ui/clipboard.js';
import { canFS, saveTextAs } from '../ui/file-io.js';
import { setToast } from '../ui/modal.js';

export function runSelftest() {
  const log = (...a) => console.log('TEST ' + a.join(' '));
  const at = (x, y) => document.elementFromPoint(x, y);
  const fire = (t, x, y, o) => (at(x, y) || document.body).dispatchEvent(new MouseEvent(t, Object.assign({ bubbles: true, clientX: x, clientY: y, button: 0 }, o)));
  try {
    // 1) 框选（从空白处左键拖到节点上）
    fire('mousedown', 620, 760);
    log('drag-kind', S.drag && S.drag.kind);
    fire('mousemove', 980, 500);
    log('marquee-box', document.querySelector('#marquee').style.cssText.replace(/\s+/g, ' '));
    if (location.hash.includes('hold')) { document.querySelector('#b-check').textContent = 'hold'; return; }
    fire('mouseup', 980, 500);
    log('marquee-selected', S.selSet.size);
    document.querySelector('#b-check').textContent = 'sel=' + S.selSet.size;

    // 2) 右键拖动平移
    const vx = S.view.x;
    fire('mousedown', 700, 300, { button: 2 });
    fire('mousemove', 760, 340);
    fire('mouseup', 760, 340, { button: 2 });
    log('pan-dx', Math.round(S.view.x - vx), 'drag-cleared', S.drag === null);

    // 3) 缩放条
    const r = document.querySelector('#z-range');
    r.value = 150; r.dispatchEvent(new Event('input', { bubbles: true }));
    log('zoom-k', S.view.k.toFixed(2), 'label', document.querySelector('#z-val').textContent);

    // 4) 滚轮（灵敏度取自设置）
    const k0 = S.view.k;
    document.querySelector('#stage').dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 700, clientY: 400, bubbles: true, cancelable: true }));
    log('wheel-dir', S.view.k > k0 ? 'in' : 'out', 'k', S.view.k.toFixed(3), 'sens', S.settings.wheel);

    // 5) 左右栏开关
    document.querySelector('#btn-left').click();
    log('left-hidden', document.querySelector('#main').classList.contains('hide-left'));
    document.querySelector('#btn-left').click();
    document.querySelector('#btn-right').click();
    log('right-hidden', document.querySelector('#main').classList.contains('hide-right'), 'ops-badge-kept', document.querySelector('#b-ops').textContent.trim());
    document.querySelector('#btn-right').click();

    // 6) 设置浮窗 + 折叠组件库
    document.querySelector('#ls-head').click();
    log('setpop-open', document.querySelector('#setpop').classList.contains('on'));
    const w0 = S.settings.wheel;
    const wr = document.querySelector('#set-body input[type=range]');
    wr.value = 24; wr.dispatchEvent(new Event('input', { bubbles: true }));
    log('wheel-sens', w0, '->', S.settings.wheel);
    document.querySelector('#set-close').click();
    document.querySelector('#lc-head').click();
    log('palette-collapsed', !document.querySelector('#lc-body').classList.contains('open'));
    document.querySelector('#lc-head').click();

    // 7) 监视组件：拖一个上去，接到 E0，出方阵
    const mon = addNode('MON', { x: 980, y: 640 });
    connect('E0', 'out', mon.id, 'v');
    log('mon-cells', document.querySelectorAll(`.mon[data-mon="${mon.id}"] i`).length, 'tensor', (S.rt.views[mon.id] || {}).name);

    // 8) 改形状 → 校验报错
    const m1 = S.spec.nodes.find(n => n.type === 'M' && (n.l || 0) === 1);
    const c0 = PC.stateShape(S.spec, m1).c;
    m1.shape = { r: 1, c: c0 + 5 };
    resetRun();
    log('shape-error', (S.rt.errors[0] || {}).msg || '无');

    // 9) 右键菜单 → 复制 → 粘贴
    const msgs = [];
    const oldToast = setToast(t => { msgs.push(t); oldToast(t); });
    selectNode(mon.id);
    const b1 = document.querySelector(`.node[data-id="${mon.id}"]`);
    const bb = b1.getBoundingClientRect();
    b1.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: bb.left + 20, clientY: bb.top + 10 }));
    log('ctx-items', [...document.querySelectorAll('#ctxmenu .ci')].map(d => d.textContent.trim()).join('|'));
    document.querySelectorAll('#ctxmenu .ci')[1].click();
    log('copied', S.clip ? S.clip.nodes.length : 0);
    const nBefore = S.spec.nodes.length;
    pasteClip();
    log('pasted', nBefore, '->', S.spec.nodes.length, 'sel', S.selSet.size);
    setToast(oldToast);

    // 10) 示例图纸从菜单切
    document.querySelector('#btn-file').click();
    document.querySelector('#filemenu .mi[data-act="ex1"]').click();
    log('example3-ops', document.querySelector('#b-ops').textContent.trim(), 'nodes', S.spec.nodes.length);
    document.querySelector('#btn-file').click();
    document.querySelector('#filemenu .mi[data-act="ex2"]').click();
    log('example1-ops', document.querySelector('#b-ops').textContent.trim(), 'nodes', S.spec.nodes.length);

    log('canFS', canFS, 'save-as-test', typeof saveTextAs);

    // 12) 新建图纸
    newDrawing();
    log('new-nodes', S.spec.nodes.length, 'ops', document.querySelector('#b-ops').textContent.trim());
    loadPreset(0);

    // 13) 右键拖动不弹菜单；右键单击才弹
    S.clip = { nodes: [S.spec.nodes[0]], edges: [] };
    fire('mousedown', 1250, 860, { button: 2 });
    log('pan-start', S.drag && S.drag.kind);
    fire('mousemove', 1300, 890);
    fire('mouseup', 1300, 890, { button: 2 });
    log('ctx-after-rightdrag', document.querySelector('#ctxmenu').classList.contains('on'));
    fire('mousedown', 1250, 860, { button: 2 });
    fire('mouseup', 1250, 860, { button: 2 });
    log('ctx-after-rightclick', document.querySelector('#ctxmenu').classList.contains('on'));
    hideCtx();

    // 14) 剪刀：横着划一条线剪断连线
    setMode('scissor');
    log('mode', S.mode);
    const paths = [...document.querySelectorAll('#wires path.hit')];
    const pathEl = paths[paths.length - 1];
    const mid = pathEl.getPointAtLength(pathEl.getTotalLength() * 0.5);
    const st2 = document.querySelector('#stage').getBoundingClientRect();
    const cx = mid.x * S.view.k + S.view.x + st2.left, cy = mid.y * S.view.k + S.view.y + st2.top;
    const nEdges = S.spec.edges.length;
    const wires = document.querySelector('#wires');
    wires.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cx - 26, clientY: cy, button: 0 }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: cy }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx + 26, clientY: cy }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx + 26, clientY: cy, button: 0 }));
    log('scissor-cut', nEdges, '->', S.spec.edges.length);
    setMode('select');
    log('mode-back', S.mode);

    // 11) 多选 + Delete
    setSelection(S.spec.nodes.slice(0, 2).map(n => n.id));
    const n0 = S.spec.nodes.length;
    deleteSelected();
    log('delete', n0, '->', S.spec.nodes.length);
  } catch (e) { console.log('TEST ERROR ' + e.message + ' @ ' + (e.stack || '').split('\n')[1]); }
}
