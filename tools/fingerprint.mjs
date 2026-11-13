// Stamps index.html with a fingerprint of each code and style file, so a browser fetches a file again
// as soon as it changes. GitHub Pages lets browsers keep every file for 10 minutes, and a page that
// has loaded a module keeps using it even after a reload. With the fingerprints, a reload after a
// publish loads exactly the files that changed.
//
// Run `node tools/fingerprint.mjs` after changing anything in src/. The tests fail until it has run.
// Module imports go through an import map, so the modules themselves keep plain import paths.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const START = '<!-- fingerprints: written by tools/fingerprint.mjs -->';
const END = '<!-- end of fingerprints -->';

export function fingerprints(dir = root) {
  return Object.fromEntries(readdirSync(`${dir}/src`).filter(name => /\.(mjs|css)$/.test(name)).sort()
    .map(name => [name, createHash('sha256').update(readFileSync(`${dir}/src/${name}`)).digest('hex').slice(0, 10)]));
}

// The page with every style sheet, module script and module import pointing at its fingerprinted address.
export function stamp(html, prints) {
  const versioned = name => `./src/${name}?v=${prints[name]}`;
  const map = Object.fromEntries(Object.keys(prints).filter(name => name.endsWith('.mjs')).map(name => [`./src/${name}`, versioned(name)]));
  const block = `${START}\n  <script type="importmap">${JSON.stringify({ imports: map }, null, 2).replaceAll('\n', '\n  ')}</script>\n  ${END}`;
  let page = html.replace(/<link rel="stylesheet" href="\.\/src\/([\w-]+\.css)(\?v=\w+)?">/g, (_, name) => `<link rel="stylesheet" href="${versioned(name)}">`)
    .replace(/<script type="module" src="\.\/src\/([\w-]+\.mjs)(\?v=\w+)?"><\/script>/g, (_, name) => `<script type="module" src="${versioned(name)}"></script>`);
  // The import map must come before the first module script; it goes right after the style sheets.
  if (page.includes(START)) page = page.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block);
  else page = page.replace(/(<link rel="stylesheet"[^\n]*\n)(?![\s\S]*<link rel="stylesheet")/, `$1  ${block}\n`);
  return page;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = `${root}/index.html`;
  const before = readFileSync(file, 'utf8');
  const after = stamp(before, fingerprints());
  if (after !== before) writeFileSync(file, after);
  console.log(after === before ? 'index.html is up to date.' : 'index.html stamped.');
}
