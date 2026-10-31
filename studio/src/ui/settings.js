// 这个模块负责：界面设置的 localStorage 读写、把设置应用到画布，以及左侧「设置」浮窗的表单与开关。

import { $, el } from './dom.js';
import { S } from './store.js';
import { paintRun } from './runner.js';

export const SET_KEY = 'pcstudio.settings';
export const DEFAULT_SETTINGS = { wheel: 0.15, grid: true, cell: 4 };

export function loadSettings() {
  try { Object.assign(S.settings, JSON.parse(localStorage.getItem(SET_KEY) || '{}')); } catch (e) {}
}
export function saveSettings() { try { localStorage.setItem(SET_KEY, JSON.stringify(S.settings)); } catch (e) {} }
export function applySettings() {
  const st = $('#stage');
  if (st) st.classList.toggle('nogrid', !S.settings.grid);
}

export function bindSettingsPop() {
  $('#ls-head').addEventListener('click', () => $('#setpop').classList.toggle('on'));
  $('#set-close').addEventListener('click', () => $('#setpop').classList.remove('on'));
}

export function buildSettings() {
  const box = $('#set-body');
  box.innerHTML = '';

  const r1 = el('div', 'setrow');
  r1.appendChild(el('label', null, '滚轮灵敏度'));
  const s1 = el('input'); s1.type = 'range'; s1.min = 3; s1.max = 40; s1.step = 1;
  s1.value = Math.round(S.settings.wheel * 100);
  const v1 = el('b', null, S.settings.wheel.toFixed(2));
  s1.addEventListener('input', () => {
    S.settings.wheel = +s1.value / 100;
    v1.textContent = S.settings.wheel.toFixed(2);
    saveSettings();
  });
  r1.appendChild(s1); r1.appendChild(v1);
  box.appendChild(r1);

  const r2 = el('div', 'setrow');
  r2.appendChild(el('label', null, '显示网格'));
  const c2 = el('input'); c2.type = 'checkbox'; c2.checked = S.settings.grid;
  c2.addEventListener('change', () => { S.settings.grid = c2.checked; applySettings(); saveSettings(); });
  r2.appendChild(c2);
  box.appendChild(r2);

  const r3 = el('div', 'setrow');
  r3.appendChild(el('label', null, '监视格'));
  const s3 = el('input'); s3.type = 'range'; s3.min = 2; s3.max = 8; s3.step = 1;
  s3.value = S.settings.cell || 4;
  const v3 = el('b', null, (S.settings.cell || 4) + 'px');
  s3.addEventListener('input', () => {
    S.settings.cell = +s3.value; v3.textContent = S.settings.cell + 'px'; saveSettings(); paintRun();
  });
  r3.appendChild(s3); r3.appendChild(v3);
  box.appendChild(r3);

  box.appendChild(el('div', 'hint', '左键拖动＝框选，右键拖动＝平移，滚轮＝缩放<br>右键点组件＝删除 / 复制 / 粘贴'));
}

// 模块一加载就把上次的设置合并进 S.settings（只合并、不覆盖默认值）
loadSettings();
