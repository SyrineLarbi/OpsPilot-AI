// OpsPilot · Factures
// Local web app: scan or upload an invoice, check the summary it reads (N° facture, fournisseur, date, total),
// pick the department, and the document is filed in the Drive. Dashboard by department. Several companies, each with its own data.
// Listens on 127.0.0.1 only. Start with: node server.mjs  (or ./scripts/dev.sh)
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { readText, parseFields } from './extract.mjs';
import { checkSummary, CURRENCIES } from './rules.mjs';
import { createDrive } from './drive.mjs';
import { buildRegister } from './export.mjs';
import {
  COOKIE, createSession, currentUser, destroySession, failureLimiter, hashPassword, sessionCookie, verifyPassword,
} from './auth.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PUBLIC = path.join(import.meta.dirname, 'public');
const env = loadEnv(path.join(ROOT, '.env'));
const PORT = Number(process.env.CONSOLE_PORT ?? env.CONSOLE_PORT ?? 4000);
const DRAFTS = path.join(ROOT, 'data', 'drafts');
const MAX_BYTES = 15 * 1024 * 1024;
const DRAFT_HOURS = 24;
// accepted documents, recognised by extension AND by their first bytes
const TYPES = {
  pdf: { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  jpg: { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  jpeg: { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  png: { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
};

// DATE columns as plain 'YYYY-MM-DD' strings: no time-zone shift anywhere (browser, Excel)
pg.types.setTypeParser(1082, (v) => v);

const db = new pg.Pool({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, max: 6 });
fs.mkdirSync(DRAFTS, { recursive: true });
const loginGuard = failureLimiter(10);
const drive = createDrive({ root: ROOT, mode: env.DRIVE_MODE || 'demo' });

function loadEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

/* ---------------- helpers ---------------- */

/** Keeps letters (incl. accents), digits, dot, dash, underscore, space, parentheses. */
function safeName(raw) {
  return path.basename(String(raw ?? '')).normalize('NFC').replace(/[^\p{L}\p{N}._\- ()]/gu, '_').trim().slice(-120);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Requête trop volumineuse.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'JSON invalide.')); } });
    req.on('error', reject);
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > limit) return reject(new HttpError(413, 'Fichier trop volumineux (15 Mo maximum).'));
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Fichier trop volumineux (15 Mo maximum).')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
};

function sendPage(res, file) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  fs.createReadStream(file).pipe(res);
}

/** Streams a stored document; same-origin framing only, so the review dialog can preview PDFs. */
function sendDocument(res, file, name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  const type = TYPES[ext]?.mime ?? (ext === 'csv' ? 'text/csv; charset=utf-8' : 'application/octet-stream');
  res.writeHead(200, {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'",
    'Content-Disposition': `${TYPES[ext] ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  fs.createReadStream(file).pipe(res);
}

const audit = (user, action, details = {}) =>
  db.query('INSERT INTO automation.audit_log (user_email, company_id, action, details) VALUES ($1, $2, $3, $4)',
    [user?.email ?? null, user?.company_id ?? null, action, details]).catch(() => {});

const requireAdmin = (user) => { if (user.role !== 'admin') throw new HttpError(403, 'Réservé aux administrateurs.'); };

async function departmentsOf(companyId) {
  const { rows } = await db.query('SELECT name FROM automation.departments WHERE company_id = $1 ORDER BY name', [companyId]);
  return rows.map((r) => r.name);
}

/* ---------------- filters (always scoped to the user's company) ---------------- */

const PERIODS = {
  month: `invoice_date >= date_trunc('month', current_date)`,
  quarter: `invoice_date >= date_trunc('quarter', current_date)`,
  year: `invoice_date >= date_trunc('year', current_date)`,
  last12: `invoice_date >= date_trunc('month', current_date) - interval '11 months'`,
};

function scope(user, sp, { period = true, department = true } = {}) {
  const params = [user.company_id];
  const where = ['company_id = $1'];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (period && PERIODS[sp.get('period')]) where.push(PERIODS[sp.get('period')]);
  const dep = sp.get('department');
  if (department && dep === '__none') where.push('department IS NULL');
  else if (department && dep) where.push(`department = ${p(dep.slice(0, 60))}`);
  const q = (sp.get('q') ?? '').trim().slice(0, 100);
  if (q) {
    const like = p(`%${q}%`);
    where.push(`(invoice_number ILIKE ${like} OR supplier_name ILIKE ${like} OR coalesce(department, '') ILIKE ${like})`);
  }
  // table filters
  const supplier = (sp.get('supplier') ?? '').trim().slice(0, 120);
  if (supplier) where.push(`lower(supplier_name) = lower(${p(supplier)})`);
  const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '') && !isNaN(Date.parse(v));
  if (isDay(sp.get('from'))) where.push(`invoice_date >= ${p(sp.get('from'))}`);
  if (isDay(sp.get('to'))) where.push(`invoice_date <= ${p(sp.get('to'))}`);
  // export of hand-picked rows (still limited to the user's company by the first condition)
  const ids = (sp.get('ids') ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 5000);
  if (sp.has('ids')) where.push(`id = ANY(${p(ids)}::int[])`);
  return { where: 'WHERE ' + where.join(' AND '), params, p };
}

/* ---------------- read models ---------------- */

async function dashboard(user, sp) {
  const all = scope(user, sp);
  const cur = all.p(user.company_currency);
  const byDep = scope(user, sp, { department: false });
  const curDep = byDep.p(user.company_currency);
  const months = scope(user, sp, { period: false });
  const curMonths = months.p(user.company_currency);

  const [kpis, departments, monthly] = await Promise.all([
    db.query(`SELECT count(*)::int AS invoices,
                     coalesce(sum(amount_ttc) FILTER (WHERE currency = ${cur}), 0)::float AS total,
                     count(*) FILTER (WHERE currency <> ${cur})::int AS other_currency,
                     count(DISTINCT lower(supplier_name))::int AS suppliers,
                     count(*) FILTER (WHERE department IS NULL)::int AS unclassified
              FROM automation.supplier_invoices ${all.where}`, all.params),
    db.query(`SELECT department, count(*)::int AS invoices,
                     coalesce(sum(amount_ttc) FILTER (WHERE currency = ${curDep}), 0)::float AS total
              FROM automation.supplier_invoices ${byDep.where}
              GROUP BY department ORDER BY total DESC, department NULLS LAST`, byDep.params),
    db.query(`SELECT to_char(m, 'YYYY-MM') AS month, coalesce(t.total, 0)::float AS total, coalesce(t.invoices, 0)::int AS invoices
              FROM generate_series(date_trunc('month', current_date) - interval '11 months', date_trunc('month', current_date), interval '1 month') AS m
              LEFT JOIN (SELECT date_trunc('month', invoice_date) AS m, count(*) AS invoices,
                                sum(amount_ttc) FILTER (WHERE currency = ${curMonths}) AS total
                         FROM automation.supplier_invoices ${months.where} GROUP BY 1) t USING (m)
              ORDER BY m`, months.params),
  ]);
  return { currency: user.company_currency, kpis: kpis.rows[0], departments: departments.rows, months: monthly.rows };
}

const INVOICE_COLUMNS = `id, invoice_number, supplier_name, supplier_tax_id, invoice_date, amount_ttc::float, currency,
  department, drive_url, source_file, created_by, created_at`;

async function invoices(user, sp, limit) {
  const { where, params } = scope(user, sp);
  const { rows } = await db.query(
    `SELECT ${INVOICE_COLUMNS} FROM automation.supplier_invoices ${where}
     ORDER BY invoice_date DESC, id DESC LIMIT ${limit}`, params);
  return rows;
}

/* ---------------- scan → draft → save ---------------- */

const draftPath = (id) => path.join(DRAFTS, `${id}.json`);

function loadDraft(user, id) {
  if (!/^[a-f0-9]{32}$/.test(String(id ?? ''))) throw new HttpError(404, 'Document introuvable. Recommencez le scan.');
  if (!fs.existsSync(draftPath(id))) throw new HttpError(404, 'Document expiré ou introuvable. Recommencez le scan.');
  const draft = JSON.parse(fs.readFileSync(draftPath(id), 'utf8'));
  if (draft.company_id !== user.company_id) throw new HttpError(404, 'Document introuvable.');
  return draft;
}

function removeDraft(draft) {
  fs.rmSync(path.join(DRAFTS, draft.file), { force: true });
  fs.rmSync(draftPath(draft.id), { force: true });
}

async function scan(req, url, user) {
  const name = safeName(url.searchParams.get('name')) || 'document';
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!TYPES[ext]) throw new HttpError(400, 'Formats acceptés : PDF, JPG ou PNG.');
  const body = await readBody(req, MAX_BYTES);
  if (!body.length) throw new HttpError(400, 'Le fichier est vide.');
  if (!TYPES[ext].magic.every((b, i) => body[i] === b)) throw new HttpError(400, "Le contenu du fichier ne correspond pas à son extension.");

  const id = crypto.randomBytes(16).toString('hex');
  const file = `${id}.${ext}`;
  fs.writeFileSync(path.join(DRAFTS, file), body);

  let text = '', ocr = false;
  try {
    ({ text, ocr } = await readText(path.join(DRAFTS, file)));
  } catch (err) {
    console.error('Lecture du document :', err.message); // the user can still type the summary by hand
  }
  const { fields, missing, details } = parseFields(text, user.company_currency);

  // same supplier as before → same department as last time
  const { rows: [prev] } = fields.supplier_name
    ? await db.query(`SELECT department FROM automation.supplier_invoices
                      WHERE company_id = $1 AND lower(supplier_name) = lower($2) AND department IS NOT NULL
                      ORDER BY id DESC LIMIT 1`, [user.company_id, fields.supplier_name])
    : { rows: [] };
  // HT / TVA / échéance are not shown on screen; they are kept for the Excel register when the document gives them
  const draft = { id, file, name, details, company_id: user.company_id, user: user.email, created_at: new Date().toISOString() };
  fs.writeFileSync(draftPath(id), JSON.stringify(draft));
  audit(user, 'document.scanned', { name, size: body.length, ocr, missing });
  return {
    draft_id: id, name, preview_url: `/drafts/${id}`, is_pdf: ext === 'pdf', ocr,
    fields: { ...fields, department: prev?.department ?? '' }, missing, text_found: text.replace(/\s/g, '').length > 0,
  };
}

const DUPLICATE = (inv) => new HttpError(409, 'Doublon', {
  errors: [`La facture ${inv.invoice_number} de ${inv.supplier_name} est déjà enregistrée.`],
});

/** Keeps the HT / TVA read on the document only if they add up to the total the user confirmed. */
function accountingDetails(d = {}, invoice) {
  const consistent = d.amount_ht > 0 && d.vat_amount >= 0 && Math.abs(d.amount_ht + d.vat_amount - invoice.amount_ttc) <= 0.01;
  return {
    amount_ht: consistent ? d.amount_ht : null,
    vat_rate: consistent && d.vat_rate !== null ? d.vat_rate : null,
    vat_amount: consistent ? d.vat_amount : null,
    due_date: d.due_date && d.due_date >= invoice.invoice_date ? d.due_date : null,
  };
}

async function saveInvoice(user, body) {
  const draft = loadDraft(user, body.draft_id);
  const { errors, invoice } = checkSummary(body, await departmentsOf(user.company_id));
  if (errors.length) throw new HttpError(422, 'Vérifiez le résumé.', { errors });

  const x = accountingDetails(draft.details, invoice);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO automation.supplier_invoices
         (company_id, invoice_number, supplier_name, supplier_tax_id, invoice_date, currency, amount_ttc, department, source_file, created_by,
          amount_ht, vat_rate, vat_amount, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT DO NOTHING RETURNING id`,
      [user.company_id, invoice.invoice_number, invoice.supplier_name, invoice.supplier_tax_id, invoice.invoice_date,
       invoice.currency, invoice.amount_ttc, invoice.department, draft.name, user.email, x.amount_ht, x.vat_rate, x.vat_amount, x.due_date]);
    if (!ins.rows.length) throw DUPLICATE(invoice);
    // file the document only once the summary is accepted; a Drive failure cancels the save
    const { url } = await drive.upload(path.join(DRAFTS, draft.file), draft.name);
    await client.query('UPDATE automation.supplier_invoices SET drive_url = $2 WHERE id = $1', [ins.rows[0].id, url]);
    await client.query('COMMIT');
    removeDraft(draft);
    audit(user, 'invoice.saved', { invoice_id: ins.rows[0].id, invoice_number: invoice.invoice_number, department: invoice.department });
    return { id: ins.rows[0].id, drive_url: url };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function updateInvoice(user, id, body) {
  const { errors, invoice } = checkSummary(body, await departmentsOf(user.company_id));
  if (errors.length) throw new HttpError(422, 'Vérifiez le résumé.', { errors });
  let res;
  try {
    res = await db.query(
      `UPDATE automation.supplier_invoices SET invoice_number = $3, supplier_name = $4, invoice_date = $5, amount_ttc = $6,
              currency = $7, department = $8
       WHERE id = $1 AND company_id = $2 RETURNING id`,
      [id, user.company_id, invoice.invoice_number, invoice.supplier_name, invoice.invoice_date, invoice.amount_ttc, invoice.currency, invoice.department]);
  } catch (e) {
    if (e.code === '23505') throw DUPLICATE(invoice);
    throw e;
  }
  if (!res.rowCount) throw new HttpError(404, 'Facture introuvable.');
  let alsoClassified = 0;
  if (body.apply_to_supplier) {
    ({ rowCount: alsoClassified } = await db.query(
      `UPDATE automation.supplier_invoices SET department = $3
       WHERE company_id = $1 AND lower(supplier_name) = lower($2) AND department IS NULL`,
      [user.company_id, invoice.supplier_name, invoice.department]));
  }
  audit(user, 'invoice.updated', { invoice_id: id, department: invoice.department, also_classified: alsoClassified });
  return { ok: true, also_classified: alsoClassified };
}

async function deleteInvoice(user, id) {
  const { rows: [r] } = await db.query(
    'DELETE FROM automation.supplier_invoices WHERE id = $1 AND company_id = $2 RETURNING invoice_number, supplier_name',
    [id, user.company_id]);
  if (!r) throw new HttpError(404, 'Facture introuvable.');
  await db.query('UPDATE automation.rejections SET invoice_id = NULL WHERE invoice_id = $1', [id]).catch(() => {});
  audit(user, 'invoice.deleted', { invoice_id: id, ...r });
  return { ok: true };
}

/* ---------------- company settings (admins) ---------------- */

async function config(user) {
  const [departments, users] = await Promise.all([
    db.query(`SELECT d.name, count(i.id)::int AS invoices FROM automation.departments d
              LEFT JOIN automation.supplier_invoices i ON i.company_id = d.company_id AND i.department = d.name
              WHERE d.company_id = $1 GROUP BY d.name ORDER BY d.name`, [user.company_id]),
    user.role === 'admin'
      ? db.query('SELECT email, name, role, last_login_at FROM automation.users WHERE company_id = $1 ORDER BY name', [user.company_id])
      : { rows: [] },
  ]);
  return {
    company: { name: user.company_name, currency: user.company_currency },
    departments: departments.rows, users: users.rows, currencies: CURRENCIES,
    me: { name: user.name, email: user.email, role: user.role },
  };
}

async function saveConfig(user, body) {
  requireAdmin(user);
  const name = String(body.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const currency = String(body.currency ?? '').toUpperCase();
  const wanted = [...new Set((Array.isArray(body.departments) ? body.departments : [])
    .map((d) => String(d).trim().replace(/\s+/g, ' ').slice(0, 60)).filter(Boolean))];
  if (name.length < 2) throw new HttpError(422, 'Indiquez le nom de la société.');
  if (!CURRENCIES.includes(currency)) throw new HttpError(422, 'Devise non prise en charge.');
  if (!wanted.length) throw new HttpError(422, 'Ajoutez au moins un département.');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE automation.companies SET name = $2, currency = $3 WHERE id = $1', [user.company_id, name, currency]);
    const { rows: used } = await client.query(
      `SELECT DISTINCT department FROM automation.supplier_invoices WHERE company_id = $1 AND department <> ALL($2::text[])`,
      [user.company_id, wanted]);
    if (used.length) {
      throw new HttpError(409, `Impossible de retirer ${used.map((u) => `« ${u.department} »`).join(', ')} : des factures y sont classées.`);
    }
    await client.query('DELETE FROM automation.departments WHERE company_id = $1 AND name <> ALL($2::text[])', [user.company_id, wanted]);
    await client.query(`INSERT INTO automation.departments (company_id, name) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`, [user.company_id, wanted]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') throw new HttpError(409, 'Une autre société porte déjà ce nom.');
    throw e;
  } finally {
    client.release();
  }
  audit(user, 'company.updated', { name, currency, departments: wanted });
  return { ok: true };
}

const newPassword = () => crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 10) + '-' + crypto.randomInt(10, 99);

async function addUser(user, body) {
  requireAdmin(user);
  const email = String(body.email ?? '').trim().toLowerCase();
  const name = String(body.name ?? '').trim().slice(0, 80);
  const role = body.role === 'admin' ? 'admin' : 'user';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(422, 'Adresse e-mail invalide.');
  if (name.length < 2) throw new HttpError(422, 'Indiquez le nom.');
  const password = newPassword();
  const { rowCount } = await db.query(
    `INSERT INTO automation.users (email, name, password_hash, role, company_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (email) DO NOTHING`,
    [email, name, hashPassword(password), role, user.company_id]);
  if (!rowCount) throw new HttpError(409, 'Cette adresse e-mail a déjà un compte.');
  audit(user, 'user.created', { email, role });
  return { email, password };
}

/* ---------------- routing ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    let m;
    // documents: only visible to users of the company they belong to
    if (req.method === 'GET' && (m = p.match(/^\/drive\/file\/([A-Za-z0-9_-]{22})$/))) {
      const user = await currentUser(db, req);
      if (!user) { res.writeHead(302, { Location: '/login' }); return res.end(); }
      const { rowCount } = await db.query('SELECT 1 FROM automation.supplier_invoices WHERE drive_url = $1 AND company_id = $2 LIMIT 1',
        [`/drive/file/${m[1]}`, user.company_id]);
      const f = rowCount ? drive.find(m[1]) : null;
      if (!f) return send(res, 404, { error: 'Document introuvable dans le Drive.' });
      return sendDocument(res, f.path, f.name);
    }
    if (req.method === 'GET' && (m = p.match(/^\/drafts\/([a-f0-9]{32})$/))) {
      const user = await currentUser(db, req);
      if (!user) return send(res, 401, { error: 'Session expirée.' });
      const draft = loadDraft(user, m[1]);
      return sendDocument(res, path.join(DRAFTS, draft.file), draft.name);
    }
    if (req.method === 'GET' && p === '/login') return sendPage(res, path.join(PUBLIC, 'login.html'));
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      if (!(await currentUser(db, req))) { res.writeHead(302, { Location: '/login' }); return res.end(); }
      return sendPage(res, path.join(PUBLIC, 'index.html'));
    }
    if (!p.startsWith('/api/')) return send(res, 404, { error: 'Page introuvable.' });

    // every state-changing request must carry this header: blocks cross-site form posts (CSRF)
    if (req.method !== 'GET' && req.headers['x-opspilot'] !== '1') throw new HttpError(403, 'Requête refusée.');

    if (req.method === 'POST' && p === '/api/login') {
      const ip = req.socket.remoteAddress;
      if (loginGuard.blocked(ip)) throw new HttpError(429, 'Trop de tentatives. Réessayez dans 15 minutes.');
      const { email, password } = await readJson(req);
      const { rows: [u] } = await db.query('SELECT * FROM automation.users WHERE email = lower($1)', [String(email ?? '').trim()]);
      if (!u || !verifyPassword(String(password ?? ''), u.password_hash)) {
        loginGuard.fail(ip);
        audit({ email: String(email ?? '').slice(0, 120) }, 'login.failed');
        throw new HttpError(401, 'E-mail ou mot de passe incorrect.');
      }
      loginGuard.clear(ip);
      const { token, maxAge } = await createSession(db, u.id);
      await db.query('UPDATE automation.users SET last_login_at = now() WHERE id = $1', [u.id]);
      audit(u, 'login');
      return send(res, 200, { name: u.name }, { 'Set-Cookie': sessionCookie(token, maxAge) });
    }

    const user = await currentUser(db, req);
    if (!user) throw new HttpError(401, 'Session expirée. Veuillez vous reconnecter.');

    if (req.method === 'POST' && p === '/api/logout') {
      await destroySession(db, req);
      return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }
    if (req.method === 'POST' && p === '/api/me/password') {
      const { current, next } = await readJson(req);
      const { rows: [u] } = await db.query('SELECT password_hash FROM automation.users WHERE id = $1', [user.id]);
      if (!verifyPassword(String(current ?? ''), u.password_hash)) throw new HttpError(422, 'Mot de passe actuel incorrect.');
      if (String(next ?? '').length < 10) throw new HttpError(422, 'Le nouveau mot de passe doit contenir au moins 10 caractères.');
      await db.query('UPDATE automation.users SET password_hash = $2 WHERE id = $1', [user.id, hashPassword(String(next))]);
      audit(user, 'password.changed');
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/config') return send(res, 200, await config(user));
    if (req.method === 'POST' && p === '/api/config') return send(res, 200, await saveConfig(user, await readJson(req)));
    if (req.method === 'POST' && p === '/api/users') return send(res, 201, await addUser(user, await readJson(req)));
    if (req.method === 'GET' && p === '/api/dashboard') return send(res, 200, await dashboard(user, url.searchParams));
    if (req.method === 'GET' && p === '/api/invoices') {
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      return send(res, 200, await invoices(user, url.searchParams, limit));
    }
    if (req.method === 'GET' && p === '/api/suppliers') {
      const { rows } = await db.query(`SELECT max(supplier_name) AS name FROM automation.supplier_invoices WHERE company_id = $1
                                       GROUP BY lower(supplier_name) ORDER BY 1`, [user.company_id]);
      return send(res, 200, rows.map((r) => r.name));
    }
    if (req.method === 'POST' && p === '/api/invoices/export.xlsx') {
      // POST so a large selection of ids fits; the body carries the same keys as the list's query string
      const body = await readJson(req, 256 * 1024);
      const sp = new URLSearchParams();
      for (const k of ['period', 'department', 'q', 'supplier', 'from', 'to']) if (typeof body[k] === 'string' && body[k]) sp.set(k, body[k]);
      if (Array.isArray(body.ids) && body.ids.length) sp.set('ids', body.ids.join(','));
      const { buffer, count } = await buildRegister(db, scope(user, sp), {
        user, sp, baseUrl: env.CONSOLE_URL ?? `http://localhost:${PORT}`,
      });
      audit(user, 'export.register', { count, selected: sp.has('ids'), ...Object.fromEntries([...sp].filter(([k]) => k !== 'ids')) });
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="registre_factures_${new Date().toISOString().slice(0, 10)}.xlsx"`,
      });
      return res.end(buffer);
    }
    if (req.method === 'POST' && p === '/api/scan') return send(res, 201, await scan(req, url, user));
    if (req.method === 'POST' && p === '/api/invoices') return send(res, 201, await saveInvoice(user, await readJson(req)));
    if (req.method === 'POST' && (m = p.match(/^\/api\/invoices\/(\d+)$/))) return send(res, 200, await updateInvoice(user, Number(m[1]), await readJson(req)));
    if (req.method === 'POST' && (m = p.match(/^\/api\/invoices\/(\d+)\/delete$/))) return send(res, 200, await deleteInvoice(user, Number(m[1])));
    if (req.method === 'POST' && (m = p.match(/^\/api\/drafts\/([a-f0-9]{32})\/discard$/))) {
      removeDraft(loadDraft(user, m[1]));
      return send(res, 200, { ok: true });
    }

    throw new HttpError(404, 'Ressource introuvable.');
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra });
    console.error(err);
    send(res, 500, { error: 'Erreur interne. Consultez le journal du serveur.' });
  }
});

/** Scans that were never saved are removed after DRAFT_HOURS. */
function cleanDrafts() {
  const limit = Date.now() - DRAFT_HOURS * 3600 * 1000;
  for (const f of fs.readdirSync(DRAFTS)) {
    const file = path.join(DRAFTS, f);
    if (fs.statSync(file).mtimeMs < limit) fs.rmSync(file, { force: true });
  }
}

// the schema is idempotent: applying it on start keeps every install up to date
await db.query(fs.readFileSync(path.join(ROOT, 'automation', 'schema.sql'), 'utf8'));
cleanDrafts();
setInterval(cleanDrafts, 3600 * 1000);
server.listen(PORT, '127.0.0.1', () => console.log(`OpsPilot · Factures : http://localhost:${PORT}`));
