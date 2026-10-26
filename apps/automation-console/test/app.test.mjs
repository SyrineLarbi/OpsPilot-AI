// End-to-end tests against the running app (./scripts/dev.sh). Creates two temporary companies and removes them afterwards.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { hashPassword } from '../auth.mjs';
import { parseAmount, parseDate, parseFields } from '../extract.mjs';
import { checkSummary } from '../rules.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const BASE = process.env.OPSPILOT_URL ?? 'http://localhost:4000';
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')
  .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
const db = new pg.Client({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME });
const TAG = `t${Date.now().toString(36)}`;
const PASSWORD = 'test-password-123';
const companies = [];

async function makeCompany(name) {
  const { rows: [c] } = await db.query('INSERT INTO automation.companies (name) VALUES ($1) RETURNING id', [name]);
  await db.query(`INSERT INTO automation.departments (company_id, name) VALUES ($1, 'Logistique'), ($1, 'Finance')`, [c.id]);
  await db.query(`INSERT INTO automation.users (email, name, password_hash, role, company_id) VALUES ($1, 'Test', $2, 'admin', $3)`,
    [`${TAG}-${c.id}@test.local`, hashPassword(PASSWORD), c.id]);
  companies.push(c.id);
  const res = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-opspilot': '1' },
    body: JSON.stringify({ email: `${TAG}-${c.id}@test.local`, password: PASSWORD }) });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (p, opts = {}) => {
    const isFile = Buffer.isBuffer(opts.body);
    const r = await fetch(BASE + p, { ...opts, headers: { cookie, 'x-opspilot': '1', ...(opts.body && !isFile ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body && !isFile ? JSON.stringify(opts.body) : opts.body });
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), type };
  };
  return { id: c.id, call };
}

let A, B;
before(async () => {
  await db.connect();
  A = await makeCompany(`Société A ${TAG}`);
  B = await makeCompany(`Société B ${TAG}`);
});

after(async () => {
  await db.query('DELETE FROM automation.supplier_invoices WHERE company_id = ANY($1)', [companies]);
  await db.query('DELETE FROM automation.users WHERE company_id = ANY($1)', [companies]);
  await db.query('DELETE FROM automation.audit_log WHERE company_id = ANY($1)', [companies]);
  await db.query('DELETE FROM automation.companies WHERE id = ANY($1)', [companies]);
  await db.end();
});

test('parsing helpers', () => {
  assert.equal(parseAmount('6 741,603'), 6741.603);
  assert.equal(parseAmount('1,234.56'), 1234.56);
  assert.equal(parseAmount('1.234.567'), 1234567);
  assert.equal(parseDate('03/01/2026'), '2026-01-03');
  assert.equal(parseDate('31/02/2026'), null);
  const { fields, missing } = parseFields('Café Plus SARL\nFacture N° F-2026/17\nDate : 05.03.2026\nNet à payer : 1 250,500 DT');
  assert.deepEqual([fields.invoice_number, fields.supplier_name, fields.invoice_date, fields.amount_ttc, fields.currency, missing.length],
    ['F-2026/17', 'Café Plus SARL', '2026-03-05', 1250.5, 'TND', 0]);
  assert.match(checkSummary({ invoice_number: 'X', supplier_name: 'Y', invoice_date: '2026-01-01', amount_ttc: '10', currency: 'TND', department: 'Autre' }, ['Finance']).errors[0], /n'existe pas/);
});

test('upload a PDF, check the summary, save it to the Drive', async () => {
  const pdf = fs.readFileSync(path.join(ROOT, 'data/samples/pdf/facture_P0001.pdf'));
  const scan = await A.call('/api/scan?name=facture_P0001.pdf', { method: 'POST', body: pdf });
  assert.equal(scan.status, 201);
  assert.deepEqual(scan.body.missing, []);
  assert.equal(scan.body.fields.invoice_number, 'FAC-2026-P0001');
  assert.equal(scan.body.fields.amount_ttc, 3912.547);

  // the draft belongs to company A only
  assert.equal((await B.call(scan.body.preview_url)).status, 404);
  assert.equal((await A.call(scan.body.preview_url)).type, 'application/pdf');

  const missingDep = await A.call('/api/invoices', { method: 'POST', body: { ...scan.body.fields, draft_id: scan.body.draft_id } });
  assert.equal(missingDep.status, 422);

  const saved = await A.call('/api/invoices', { method: 'POST', body: { ...scan.body.fields, department: 'Logistique', draft_id: scan.body.draft_id } });
  assert.equal(saved.status, 201);
  assert.match(saved.body.drive_url, /^\/drive\/file\//);
  assert.equal((await A.call(saved.body.drive_url)).type, 'application/pdf');
  assert.equal((await B.call(saved.body.drive_url)).status, 404, 'company B must not open company A documents');

  // same invoice again → duplicate; the same number in another company is fine
  const again = await A.call('/api/scan?name=facture_P0001.pdf', { method: 'POST', body: pdf });
  const dup = await A.call('/api/invoices', { method: 'POST', body: { ...again.body.fields, department: 'Finance', draft_id: again.body.draft_id } });
  assert.equal(dup.status, 409);
  const other = await B.call('/api/scan?name=facture_P0001.pdf', { method: 'POST', body: pdf });
  assert.equal((await B.call('/api/invoices', { method: 'POST', body: { ...other.body.fields, department: 'Finance', draft_id: other.body.draft_id } })).status, 201);
});

test('a photo is read with OCR and the department is suggested from the supplier', async () => {
  const { execFileSync } = await import('node:child_process');
  const jpg = execFileSync('pdftoppm', ['-r', '150', '-l', '1', '-jpeg', path.join(ROOT, 'data/samples/pdf/facture_P0002.pdf')]);
  const pdf1 = parseFields(execFileSync('pdftotext', [path.join(ROOT, 'data/samples/pdf/facture_P0002.pdf'), '-']).toString()).fields;
  const scan = await A.call('/api/scan?name=photo.jpg', { method: 'POST', body: jpg });
  assert.equal(scan.status, 201);
  assert.equal(scan.body.ocr, true);
  assert.equal(scan.body.fields.invoice_number, pdf1.invoice_number);
  assert.equal(scan.body.fields.amount_ttc, pdf1.amount_ttc);
  if (pdf1.supplier_name === 'Sahel Packaging SARL') assert.equal(scan.body.fields.department, 'Logistique');
  assert.equal((await A.call(`/api/drafts/${scan.body.draft_id}/discard`, { method: 'POST' })).status, 200);
});

test('rejects files that are not what they claim to be', async () => {
  const r = await A.call('/api/scan?name=fake.pdf', { method: 'POST', body: Buffer.from('hello world') });
  assert.equal(r.status, 400);
});

test('dashboard, list, edit, export and settings are per company', async () => {
  const dash = await A.call('/api/dashboard?period=all');
  assert.equal(dash.body.kpis.invoices, 1);
  assert.equal(dash.body.departments[0].department, 'Logistique');
  assert.equal(dash.body.months.length, 12);

  const [inv] = (await A.call('/api/invoices?department=Logistique')).body;
  assert.equal(inv.invoice_number, 'FAC-2026-P0001');
  assert.equal((await B.call('/api/invoices?q=FAC-2026-P0001')).body.length, 1, 'B sees only its own copy');

  assert.equal((await B.call(`/api/invoices/${inv.id}`, { method: 'POST', body: { ...inv, department: 'Finance' } })).status, 404);
  assert.equal((await A.call(`/api/invoices/${inv.id}`, { method: 'POST', body: { ...inv, department: 'Finance' } })).status, 200);
  assert.equal((await A.call('/api/invoices?department=Finance')).body.length, 1);

  // HT / TVA / échéance read from the PDF were kept for the register
  const { rows: [full] } = await db.query('SELECT amount_ht::float, vat_amount::float, due_date FROM automation.supplier_invoices WHERE id = $1', [inv.id]);
  assert.ok(full.amount_ht > 0 && full.vat_amount > 0 && full.due_date, 'accounting details stored');

  const ExcelJS = (await import('exceljs')).default;
  const readSheet = async (buf) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; };
  const byFilter = await A.call('/api/invoices/export.xlsx', { method: 'POST', body: { supplier: 'sahel packaging sarl' } });
  assert.equal(byFilter.status, 200);
  let wb = await readSheet(byFilter.body);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Synthèse', 'Factures']);
  const header = wb.getWorksheet('Factures').getRow(1).values.slice(1);
  assert.ok(['Matricule fiscal', 'Département', 'Montant HT', 'Montant TVA', 'Échéance'].every((c) => header.includes(c)));
  assert.equal(wb.getWorksheet('Factures').rowCount, 3, 'header + 1 invoice + total row');

  const none = await A.call('/api/invoices/export.xlsx', { method: 'POST', body: { supplier: 'Inconnu' } });
  assert.equal((await readSheet(none.body)).getWorksheet('Factures').rowCount, 1);

  const theirs = (await B.call('/api/invoices?q=FAC-2026-P0001')).body[0];
  const picked = await A.call('/api/invoices/export.xlsx', { method: 'POST', body: { ids: [inv.id, theirs.id] } });
  wb = await readSheet(picked.body);
  assert.equal(wb.getWorksheet('Factures').rowCount, 3, 'selection export never includes another company\'s invoice');

  const blocked = await A.call('/api/config', { method: 'POST', body: { name: `Société A ${TAG}`, currency: 'TND', departments: ['Logistique'] } });
  assert.equal(blocked.status, 409, 'cannot remove a department that still has invoices');
  const ok = await A.call('/api/config', { method: 'POST', body: { name: `Société A2 ${TAG}`, currency: 'EUR', departments: ['Finance', 'Marketing'] } });
  assert.equal(ok.status, 200);
  const cfg = (await A.call('/api/config')).body;
  assert.deepEqual([cfg.company.name, cfg.company.currency, cfg.departments.map((d) => d.name)], [`Société A2 ${TAG}`, 'EUR', ['Finance', 'Marketing']]);
  assert.deepEqual((await B.call('/api/config')).body.departments.map((d) => d.name), ['Finance', 'Logistique']);

  assert.equal((await A.call(`/api/invoices/${inv.id}/delete`, { method: 'POST' })).status, 200);
  assert.equal((await A.call('/api/dashboard?period=all')).body.kpis.invoices, 0);
});
