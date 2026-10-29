// Render tools/card.html to public/card.png (the default link preview) with headless Edge; no packages needed.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = 'D:/_edge-card-profile';
const html = new URL('./card.html', import.meta.url).href;
const out = fileURLToPath(new URL('../public/card.png', import.meta.url));
try {
  execFileSync(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`,
    '--window-size=1200,630', '--virtual-time-budget=4000', `--screenshot=${out}`, html], { stdio: 'ignore' });
} finally { rmSync(profile, { recursive: true, force: true }); }
console.log(`wrote ${out}`);
