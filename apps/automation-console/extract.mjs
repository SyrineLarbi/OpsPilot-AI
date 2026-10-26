// Reads an invoice document (PDF, scanned PDF or photo) and pulls out the summary fields.
// Everything runs locally: pdftotext / pdftoppm (poppler-utils) for PDFs, tesseract.js (French + English) for images.
// Nothing is guessed silently: fields that were not found are listed in `missing` so the user checks them.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createWorker } from 'tesseract.js';

const run = promisify(execFile);
const LANG_DIR = path.join(import.meta.dirname, '.ocr-lang');

/** tesseract.js reads all languages from one folder: gather the bundled npm data files there once. */
function prepareLanguages() {
  fs.mkdirSync(LANG_DIR, { recursive: true });
  for (const lang of ['fra', 'eng']) {
    const target = path.join(LANG_DIR, `${lang}.traineddata.gz`);
    if (!fs.existsSync(target)) {
      fs.copyFileSync(path.join(import.meta.dirname, 'node_modules', '@tesseract.js-data', lang, '4.0.0_best_int', `${lang}.traineddata.gz`), target);
    }
  }
}

let workerPromise = null;
function ocrWorker() {
  if (!workerPromise) {
    prepareLanguages();
    workerPromise = createWorker(['fra', 'eng'], 1, { langPath: LANG_DIR, cacheMethod: 'none', gzip: true });
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

/** OCR jobs run one at a time on a single worker. */
let ocrQueue = Promise.resolve();
function ocr(image) {
  const job = ocrQueue.then(async () => (await (await ocrWorker()).recognize(image)).data.text);
  ocrQueue = job.catch(() => {});
  return job;
}

export async function readText(file) {
  if (!/\.pdf$/i.test(file)) return { text: await ocr(file), ocr: true };

  const { stdout } = await run('pdftotext', ['-l', '3', file, '-'], { maxBuffer: 20 * 1024 * 1024 });
  if (stdout.replace(/\s/g, '').length >= 20) return { text: stdout, ocr: false };

  // scanned PDF: no text layer, so render the first pages and read them
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opspilot-ocr-'));
  try {
    await run('pdftoppm', ['-r', '250', '-l', '2', '-png', file, path.join(dir, 'page')]);
    let text = '';
    for (const png of fs.readdirSync(dir).sort()) text += (await ocr(path.join(dir, png))) + '\n';
    return { text, ocr: true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------------- field parsing ---------------- */

const NUM = '(\\d[\\d .,\\u00a0\\u202f]*\\d|\\d)';
const DATE = '(\\d{1,2}[\\/.\\-]\\d{1,2}[\\/.\\-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2})';

/** 1 234,567 / 1.234,56 / 1,234.56 / 1234.5 → 1234.567 */
export function parseAmount(s) {
  if (!s) return null;
  let v = String(s).replace(/[\s  ]/g, '');
  const lastSep = Math.max(v.lastIndexOf(','), v.lastIndexOf('.'));
  if (lastSep >= 0 && v.length - lastSep - 1 <= 3 && (v.includes(',') || v.split('.').length === 2)) {
    v = v.slice(0, lastSep).replace(/[.,]/g, '') + '.' + v.slice(lastSep + 1);
  } else {
    v = v.replace(/[.,]/g, '');
  }
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 03/01/2026, 3-1-26, 03.01.2026, 2026-01-03 → '2026-01-03' (day first, as on Tunisian/French invoices) */
export function parseDate(s) {
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let [y, mo, d] = m ? [m[1], m[2], m[3]] : [];
  if (!m) {
    m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
    if (!m) return null;
    [d, mo, y] = [m[1], m[2], m[3].length === 2 ? `20${m[3]}` : m[3]];
  }
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return !isNaN(Date.parse(iso)) && new Date(iso).toISOString().startsWith(iso) ? iso : null;
}

const firstMatch = (text, patterns) => {
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return '';
};

/** Last match wins for totals: the grand total is usually printed at the bottom. */
const lastMatch = (text, re) => [...text.matchAll(re)].map((m) => m[1]).pop() ?? '';

export function parseFields(raw, defaultCurrency = 'TND') {
  const text = String(raw ?? '').replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const invoiceNumber = firstMatch(text, [
    /(?:N[°ºo]\.?\s*(?:de\s*)?facture|Num[ée]ro\s*(?:de\s*)?facture|Facture\s*N[°ºo]\.?|Invoice\s*(?:No\.?|Number|#))\s*:?\s*([A-Z0-9][A-Z0-9\-\/_.]*\d[A-Z0-9\-\/_]*)/i,
    /\b(?:FACTURE|INVOICE)\s+([A-Z]{1,5}[\-\/]?\d[A-Z0-9\-\/]*)/,
  ]);

  const supplier = firstMatch(text, [/(?:Fournisseur|Supplier|Vendeur)\s*:\s*(.+)/i])
    || lines.find((l) => /[A-Za-zÀ-ÿ]{3}/.test(l) && !/^(facture|invoice|date|n[°º])/i.test(l)) || '';

  const taxId = firstMatch(text, [/(?:Matricule\s*fiscal|M\.?\s*F\.?|Tax\s*ID)\s*:?\s*([0-9]{6,8}[A-Z](?:\s*\/\s*[A-Z](?:\s*\/\s*[A-Z])?\s*\/\s*\d{3})?)/i]);

  const invoiceDate = parseDate(firstMatch(text, [
    new RegExp(`(?:Date\\s*(?:de\\s*)?facture|Date\\s*d['’]?\\s*[ée]mission|Invoice\\s*date|Date)\\s*:?\\s*${DATE}`, 'i'),
    new RegExp(DATE),
  ]));

  const total = parseAmount(
    lastMatch(text, new RegExp(`(?:Total\\s*TTC|Net\\s*[àa]\\s*payer|Montant\\s*TTC|Total\\s*[àa]\\s*payer|Total\\s*g[ée]n[ée]ral|Amount\\s*due|Grand\\s*total)\\s*(?:\\([^)]*\\))?\\s*:?\\s*(?:TND|DT|EUR|€|USD|\\$)?\\s*${NUM}`, 'gi'))
    || lastMatch(text, new RegExp(`\\bTotal\\b\\s*:?\\s*(?:TND|DT|EUR|€|USD|\\$)?\\s*${NUM}`, 'gi')),
  );

  let currency = firstMatch(text, [/(?:Devise|Currency)\s*:?\s*([A-Z]{3})/i]).toUpperCase();
  if (!currency) {
    if (/€|\bEUR\b/.test(text)) currency = 'EUR';
    else if (/\bUSD\b|\$/.test(text)) currency = 'USD';
    else if (/\bTND\b|\bDT\b|dinars?/i.test(text)) currency = 'TND';
    else currency = defaultCurrency;
  }

  const fields = {
    invoice_number: invoiceNumber.slice(0, 60),
    supplier_name: supplier.replace(/\s+/g, ' ').slice(0, 120),
    supplier_tax_id: taxId.replace(/\s+/g, ''),
    invoice_date: invoiceDate ?? '',
    amount_ttc: total ?? '',
    currency,
  };
  const missing = ['invoice_number', 'supplier_name', 'invoice_date', 'amount_ttc'].filter((k) => fields[k] === '');

  // accounting details: not shown on screen, kept for the Excel register
  const vat = text.match(new RegExp(`(?:TVA|VAT)\\s*(?:\\(\\s*)?(\\d{1,2}(?:[.,]\\d+)?)\\s*%\\s*\\)?\\s*:?\\s*${NUM}`, 'i'));
  const details = {
    amount_ht: parseAmount(lastMatch(text, new RegExp(`(?:Total\\s*HT|Montant\\s*HT|Total\\s*hors\\s*taxes?)\\s*:?\\s*(?:TND|DT|EUR|€|USD|\\$)?\\s*${NUM}`, 'gi'))),
    vat_rate: vat ? Number(vat[1].replace(',', '.')) : null,
    vat_amount: vat ? parseAmount(vat[2]) : null,
    due_date: parseDate(firstMatch(text, [new RegExp(`(?:Date\\s*d['’]?\\s*[ée]ch[ée]ance|[ÉE]ch[ée]ance|Due\\s*date)\\s*:?\\s*${DATE}`, 'i')])),
  };
  return { fields, missing, details };
}
