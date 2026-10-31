// 这个模块负责：图纸的本地文件读写——保存 / 另存为 / 下载 / 打开，以及加载后的状态重建。

import { $ } from './dom.js';
import { S, setSelection } from './store.js';
import { syncHyper, resetRun } from './runner.js';
import { fitView } from './render.js';
import { toast } from './modal.js';

export const canFS = typeof window.showSaveFilePicker === 'function';
export const JSON_TYPES = [{ description: '图纸 JSON', accept: { 'application/json': ['.json'] } }];
export const CPP_TYPES = [{ description: 'C++ 头文件', accept: { 'text/x-c++hdr': ['.hpp', '.cpp'] } }];

export function specText() { return JSON.stringify({ v: 1, name: S.curName || null, spec: S.spec }, null, 2); }

export async function writeHandle(h, text) {
  const w = await h.createWritable();
  await w.write(text);
  await w.close();
}

export async function saveCurrent() {
  if (S.curFile) {
    try { await writeHandle(S.curFile, specText()); toast('已保存 → ' + S.curFile.name); return true; }
    catch (e) { toast('保存失败：' + e.message); return false; }
  }
  return saveAs();
}

export async function saveAs() {
  if (!canFS) { downloadText((S.curName || 'drawing') + '.json', specText()); return true; }
  try {
    const h = await window.showSaveFilePicker({ suggestedName: (S.curName || 'drawing') + '.json', types: JSON_TYPES });
    await writeHandle(h, specText());
    S.curFile = h; S.curName = h.name.replace(/\.json$/i, '');
    document.title = 'pc-studio · ' + h.name;
    toast('已保存 → ' + h.name);
    return true;
  } catch (e) {
    if (e.name !== 'AbortError') toast('保存失败：' + e.message);
    return false;
  }
}

export function downloadText(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('已下载 ' + name);
}

export async function openFile() {
  if (!canFS) { $('#pk-file').click(); return; }
  try {
    const [h] = await window.showOpenFilePicker({ types: JSON_TYPES, multiple: false });
    applyLoaded(await (await h.getFile()).text(), h);
  } catch (e) { if (e.name !== 'AbortError') toast('打开失败：' + e.message); }
}

export function applyLoaded(txt, handle) {
  try {
    const j = JSON.parse(txt);
    const sp = j.spec || j;
    if (!sp || !Array.isArray(sp.nodes)) throw new Error('不是图纸文件');
    loadSpec(sp, handle ? handle.name.replace(/\.json$/i, '') : null);
    if (handle) { S.curFile = handle; document.title = 'pc-studio · ' + handle.name; }
    toast('已加载 ' + (S.curName || '图纸'));
  } catch (e) { toast('加载失败：' + e.message); }
}

// 导出窗口里的「保存…」
export async function saveTextAs(kind, text) {
  const name = kind === 'cpp' ? 'model.hpp' : (S.curName || 'drawing') + '.json';
  if (!canFS) { downloadText(name, text); return; }
  try {
    const h = await window.showSaveFilePicker({ suggestedName: name, types: kind === 'cpp' ? CPP_TYPES : JSON_TYPES });
    await writeHandle(h, text);
    toast('已保存 → ' + h.name);
  } catch (e) { if (e.name !== 'AbortError') toast('保存失败：' + e.message); }
}

export function afterLoad() {
  S.it = 0; S.hist = []; S.lastF = 0; S.lastE0 = 0; S.rt = null;
  setSelection([], null);
  syncHyper();
  resetRun(); fitView();
}

export function loadSpec(sp, name) {
  S.spec = JSON.parse(JSON.stringify(sp));
  if (!S.spec.dims) S.spec.dims = [64];
  if (name !== undefined) {
    S.curName = name;
    document.title = 'pc-studio' + (name ? ' · ' + name : ' · 预测编码图编辑器');
  }
  afterLoad();
}

// 没有 File System Access API 时的兜底：<input type=file>
export function bindFilePicker() {
  $('#pk-file').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => applyLoaded(fr.result, null);
    fr.readAsText(f);
    e.target.value = '';
  });
}
