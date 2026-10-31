/* studio/src/engine/shape.js —— 形状代数
 *
 * 这个模块负责：形状的表示（r×c 与元素数 n）、形状比较，以及报错文案里的形状串。
 */

export const sh = (r, c) => ({ r, c, n: r * c });
export const same = (a, b) => !!a && !!b && a.r === b.r && a.c === b.c;
export const fmtShape = s => (s ? (s.r === 1 ? `1×${s.c}` : `${s.r}×${s.c}`) : '?');
