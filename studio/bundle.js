// 把 pcgraph.js 内联进 studio.html，产出一个可以直接双击打开的单文件
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(__dirname, 'studio.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, 'pcgraph.js'), 'utf8');
const tag = '<script src="pcgraph.js"></script>';
if (!html.includes(tag)) { console.error('没找到 <script src="pcgraph.js">'); process.exit(1); }
const out = html.replace(tag, '<script>\n' + js.replace(/<\/script>/g, '<\\/script>') + '\n</script>');
const dest = path.join(root, 'pc-studio.html');
fs.writeFileSync(dest, out);
console.log('wrote', dest, (out.length / 1024).toFixed(1) + ' KB');
