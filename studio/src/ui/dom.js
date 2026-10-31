// 这个模块负责：最底层的 DOM 小工具（查询 / 建元素 / 绑事件 / 建 SVG 元素），不依赖任何别的模块。

export const $ = s => document.querySelector(s);

export function el(t, cls, html) {
  const e = document.createElement(t);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

export function on(target, type, fn, opts) { target.addEventListener(type, fn, opts); return fn; }

export function svgEl(tag) { return document.createElementNS('http://www.w3.org/2000/svg', tag); }
