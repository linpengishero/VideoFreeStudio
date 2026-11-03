// Deterministically rasterize the plugin-owned SVG for the application catalog.
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../frontend/node_modules/playwright/index.mjs';

const svg = await readFile(new URL('../assets/icon.svg', import.meta.url), 'utf8');
const candidates = process.platform === 'win32' ? [
  path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
let executablePath;
for (const candidate of candidates) {
  try { await access(candidate); executablePath = candidate; break; } catch { /* Try the next installed browser. */ }
}
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 64, height: 64 }, deviceScaleFactor: 2 });
  await page.setContent(`<style>*{margin:0}html,body{width:64px;height:64px;background:transparent}svg{display:block;width:64px;height:64px}</style>${svg}`);
  await page.screenshot({ path: fileURLToPath(new URL('../assets/icon.png', import.meta.url)), omitBackground: true });
} finally {
  await browser.close();
}
