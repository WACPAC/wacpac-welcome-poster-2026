#!/usr/bin/env node
/**
 * index.html を headless Chrome で開き、A4 1枚の PDF に保存する。
 * 用法: npm run pdf
 *       node scripts/print-pdf.mjs [出力パス]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const indexHtml = path.join(root, 'index.html');
const outPdf = path.resolve(root, process.argv[2] || 'wacpac-poster.pdf');

if (!fs.existsSync(indexHtml)) {
  console.error('index.html が見つかりません:', indexHtml);
  process.exit(1);
}

const fileUrl = pathToFileURL(indexHtml).href;

const launchOpts = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--font-render-hinting=none',
  ],
};

let browser;
try {
  browser = await puppeteer.launch(launchOpts);
} catch (err) {
  const msg = String(err?.message ?? err);
  if (msg.includes('Could not find Chrome')) {
    console.warn(
      'Puppeteer 用 Chrome が ~/.cache/puppeteer にありません。システムの Google Chrome を試します…',
    );
    try {
      browser = await puppeteer.launch({ ...launchOpts, channel: 'chrome' });
    } catch {
      console.error(
        'Chrome を起動できませんでした。次でブラウザを入れてから再度 npm run pdf を実行してください:\n' +
          '  npm run pdf:chrome\n' +
          '（または npm install をやり直すと postinstall で取得されます）',
      );
      process.exit(1);
    }
  } else {
    throw err;
  }
}

const page = await browser.newPage();

await page.goto(fileUrl, {
  waitUntil: 'networkidle2',
  timeout: 120_000,
});

await page.evaluate(() => document.fonts?.ready ?? Promise.resolve());

/**
 * file:// 表示時、外部 QR 画像が PDF 取得直前までデコードされないことがある。
 * Node 側で取得して data URL に差し替えれば印刷に間に合う。
 */
async function inlineRemoteQrImage() {
  const qrSrc = await page
    .$eval('img.header-qr', (el) => el.getAttribute('src') || '')
    .catch(() => '');
  if (!qrSrc || !/^https?:\/\//i.test(qrSrc)) return;

  const res = await fetch(qrSrc, { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) {
    console.warn('QR 画像の取得に失敗しました:', res.status, qrSrc);
    return;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = (res.headers.get('content-type') || 'image/png').split(';')[0].trim();
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  await page.evaluate((url) => {
    const el = document.querySelector('img.header-qr');
    if (el) el.src = url;
  }, dataUrl);
}

await inlineRemoteQrImage();

await page.waitForFunction(
  () => {
    const imgs = [...document.images];
    return imgs.length === 0 || imgs.every((img) => img.complete);
  },
  { timeout: 30_000 },
);

await page.waitForFunction(
  () => {
    const qr = document.querySelector('img.header-qr');
    return !qr || (qr.complete && qr.naturalWidth > 0);
  },
  { timeout: 15_000 },
);

await page.pdf({
  path: outPdf,
  preferCSSPageSize: true,
  printBackground: true,
  margin: { top: 0, right: 0, bottom: 0, left: 0 },
});

await browser.close();

console.log('PDF を書き出しました:', outPdf);
