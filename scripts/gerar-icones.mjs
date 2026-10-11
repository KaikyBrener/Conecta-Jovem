#!/usr/bin/env node
// Gera os PNGs do logotipo a partir dos SVGs de src/assets/logo (script avulso, rodado à mão):
//   node scripts/gerar-icones.mjs
// Usa o Chromium do Playwright que o projeto já tem (npx playwright install chromium). Não altera os SVGs.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = new URL('../', import.meta.url);
const read = (rel) => readFile(new URL(rel, root), 'utf8');
const out = (rel) => fileURLToPath(new URL(rel, root));

const icone = await read('src/assets/logo/icone.svg');
const horizontal = await read('src/assets/logo/logo-horizontal.svg');

// proporção do logo horizontal lida do próprio arquivo (viewBox="0 0 L A")
const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(horizontal);
if (!viewBox) throw new Error('logo-horizontal.svg sem viewBox');
const EMAIL_WIDTH = 600;
const emailHeight = Math.round((EMAIL_WIDTH * Number(viewBox[2])) / Number(viewBox[1]));

// O iOS pinta de preto o que for transparente no apple-touch-icon: o fundo repete o gradiente do próprio ícone.
const GRADIENTE = 'linear-gradient(135deg, #4F46E5, #06B6D4)';

const alvos = [
  { arquivo: 'public/apple-touch-icon.png', svg: icone, largura: 180, altura: 180, fundo: GRADIENTE },
  { arquivo: 'public/icon-192.png', svg: icone, largura: 192, altura: 192, fundo: null },
  { arquivo: 'public/icon-512.png', svg: icone, largura: 512, altura: 512, fundo: null },
  { arquivo: 'public/email-logo.png', svg: horizontal, largura: EMAIL_WIDTH, altura: emailHeight, fundo: '#ffffff' },
];

const browser = await chromium.launch();
try {
  for (const { arquivo, svg, largura, altura, fundo } of alvos) {
    const page = await browser.newPage({ viewport: { width: largura, height: altura }, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><html><head><style>
        html, body { margin: 0; width: ${largura}px; height: ${altura}px; background: ${fundo ?? 'transparent'}; }
        svg { display: block; width: ${largura}px; height: ${altura}px; }
      </style></head><body>${svg}</body></html>`,
    );
    const png = await page.screenshot({ type: 'png', omitBackground: fundo === null });
    await writeFile(out(arquivo), png);
    await page.close();
    console.log(`${arquivo}  ${largura}x${altura}  ${png.length} bytes`);
  }
} finally {
  await browser.close();
}
