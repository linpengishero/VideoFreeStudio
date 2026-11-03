// Build a dependency-free Vue-compatible runtime module owned by this plugin.
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const here = new URL('.', import.meta.url);
const [source, css, dialogCss] = await Promise.all([
  readFile(new URL('./CanvasApplication.js', here), 'utf8'),
  readFile(new URL('./CanvasApplication.css', here), 'utf8'),
  readFile(new URL('./Dialog.css', here), 'utf8'),
]);
await mkdir(new URL('./dist/', here), { recursive: true });
await writeFile(new URL('./dist/index.js', here),
  `const CANVAS_STYLES = ${JSON.stringify(css + '\n' + dialogCss)};\n${source}`, 'utf8');
