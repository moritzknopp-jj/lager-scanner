// Turns the artifact build's index.html into the page fragment claude.ai publishes:
// the platform adds <!doctype>, <head> and <body> itself, so only title, styles and body content go in.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || 'dist-artifact');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
const css = [...html.matchAll(/<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)"[^>]*>/g)].map((m) => fs.readFileSync(path.join(dir, m[1]), 'utf8')).join('\n');
const scripts = [...html.matchAll(/<script type="module"[^>]*src="\.\/(assets\/[^"]+\.js)"[^>]*><\/script>/g)].map((m) => m[1]);
const fonts = html.match(/<link rel="stylesheet" href="(https:\/\/fonts\.googleapis\.com[^"]+)">/)?.[1];
const page = `<title>Lager Scanner</title>
<meta name="claude:viewport-fit-sides" content="cover">
${fonts ? `<link rel="stylesheet" href="${fonts.replace(/&amp;/g, '&')}">` : ''}
<style>
${css}
</style>
${body.replace(/<script type="module"[\s\S]*?<\/script>/g, '').trim()}
${scripts.map((s) => `<script type="module" src="./${s}"></script>`).join('\n')}
`;
fs.writeFileSync(path.join(dir, 'page.html'), page);
const files = fs.readdirSync(path.join(dir, 'assets')).filter((f) => f.endsWith('.js'));
// The publisher rejects a literal U+FFFD (ExcelJS has some); as an escape it means the same to JavaScript.
for (const f of files) {
  const p = path.join(dir, 'assets', f);
  const js = fs.readFileSync(p, 'utf8');
  if (js.includes('\uFFFD')) fs.writeFileSync(p, js.replaceAll('\uFFFD', '\\uFFFD'));
}
fs.writeFileSync(path.join(dir, 'files.json'), JSON.stringify(Object.fromEntries(files.map((f) => [`assets/${f}`, path.join(dir, 'assets', f)])), null, 2));
console.log('page.html', page.length, 'bytes;', files.length, 'script files');
