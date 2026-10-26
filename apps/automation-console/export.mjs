// « Exporter Excel »: the detailed invoice register for accounting (Synthèse + Factures sheets).
// The screen shows a short summary; this file carries every detail known for each invoice.
import ExcelJS from 'exceljs';

const BRAND = 'FF4F46E5';
const MONEY = '#,##0.000';
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');
/** DATE columns arrive as 'YYYY-MM-DD' strings; build UTC dates so Excel never shifts them by a day. */
const xlDate = (iso) => (isDay(iso) ? new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))) : null);
const monthLabel = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const PERIOD_LABEL = { month: 'ce mois', quarter: 'ce trimestre', year: 'cette année' };

function styleHeader(row) {
  row.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
    c.alignment = { vertical: 'middle', wrapText: true };
  });
  row.height = 22;
}

function sectionTitle(ws, text) {
  ws.addRow([]);
  ws.addRow([text]).font = { bold: true, size: 12, color: { argb: BRAND } };
}

function addTable(ws, header, rows, formats) {
  styleHeader(ws.addRow(header));
  for (const values of rows) {
    const r = ws.addRow(values);
    formats.forEach((fmt, i) => { if (fmt) r.getCell(i + 1).numFmt = fmt; });
  }
}

/** `scope` = { where, params } already restricted to the user's company and the on-screen filters. */
export async function buildRegister(db, scope, { user, sp, baseUrl }) {
  const q = (sql) => db.query(sql, scope.params).then((r) => r.rows);
  const T = `FROM automation.supplier_invoices ${scope.where}`;
  const SUMS = `count(*)::int AS count, coalesce(sum(amount_ht),0)::float AS ht, coalesce(sum(vat_amount),0)::float AS vat,
                coalesce(sum(amount_ttc),0)::float AS ttc`;
  const [rows, [totals], [due], byDep, byVat, bySupplier, byMonth] = await Promise.all([
    q(`SELECT invoice_number, supplier_name, supplier_tax_id, invoice_date, due_date, currency, amount_ht::float,
              vat_rate::float, vat_amount::float, amount_ttc::float, department, source_file, created_by, drive_url
       ${T} ORDER BY invoice_date, supplier_name, invoice_number LIMIT 100000`),
    q(`SELECT ${SUMS}, count(*) FILTER (WHERE amount_ht IS NULL)::int AS without_vat ${T}`),
    q(`SELECT count(*) FILTER (WHERE due_date < current_date)::int AS overdue_count,
              coalesce(sum(amount_ttc) FILTER (WHERE due_date < current_date),0)::float AS overdue_ttc,
              count(*) FILTER (WHERE due_date BETWEEN current_date AND current_date + 7)::int AS week_count,
              coalesce(sum(amount_ttc) FILTER (WHERE due_date BETWEEN current_date AND current_date + 7),0)::float AS week_ttc ${T}`),
    q(`SELECT coalesce(department, 'Non classé') AS name, ${SUMS} ${T} GROUP BY 1 ORDER BY ttc DESC`),
    q(`SELECT vat_rate::float AS rate, ${SUMS} ${T} GROUP BY vat_rate ORDER BY vat_rate NULLS LAST`),
    q(`SELECT max(supplier_name) AS name, max(supplier_tax_id) AS tax_id, ${SUMS} ${T} GROUP BY lower(supplier_name) ORDER BY ttc DESC`),
    q(`SELECT to_char(invoice_date, 'YYYY-MM') AS month, ${SUMS} ${T} GROUP BY 1 ORDER BY 1`),
  ]);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'OpsPilot AI';
  wb.created = new Date();
  const today = new Date().toISOString().slice(0, 10);

  /* --- Synthèse --- */
  const s = wb.addWorksheet('Synthèse', { views: [{ showGridLines: false }] });
  s.columns = [{ width: 38 }, { width: 12 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 10 }];
  s.addRow([`Registre des factures fournisseurs · ${user.company_name}`]).font = { bold: true, size: 16, color: { argb: BRAND } };
  s.addRow([`Généré le ${new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Tunis' })} par ${user.name} · OpsPilot AI`]).font = { color: { argb: 'FF64748B' } };
  const filters = [`Période : ${PERIOD_LABEL[sp.get('period')] ?? 'toutes les dates'}`];
  if (sp.get('department')) filters.push(`Département : ${sp.get('department') === '__none' ? 'Non classé' : sp.get('department')}`);
  if (sp.get('q')) filters.push(`Recherche : « ${sp.get('q')} »`);
  if (sp.get('supplier')) filters.push(`Fournisseur : ${sp.get('supplier')}`);
  const fr = (d) => d.split('-').reverse().join('/');
  if (sp.get('from') || sp.get('to')) filters.push(`Dates de facture : ${sp.get('from') ? `du ${fr(sp.get('from'))}` : ''} ${sp.get('to') ? `au ${fr(sp.get('to'))}` : ''}`.trim());
  if (sp.has('ids')) filters.push(`Sélection manuelle : ${sp.get('ids').split(',').length} facture(s)`);
  for (const line of filters) s.addRow([line]).font = { italic: true, color: { argb: 'FF334155' } };
  if (totals.without_vat) {
    s.addRow([`${totals.without_vat} facture(s) sans détail HT / TVA : seuls leurs totaux TTC sont comptés.`]).font = { italic: true, color: { argb: 'FFB45309' } };
  }

  sectionTitle(s, 'Totaux');
  addTable(s, ['', 'Factures', 'Montant HT', 'TVA', 'Total TTC'],
    [['Ensemble des factures', totals.count, totals.ht, totals.vat, totals.ttc]], [null, null, MONEY, MONEY, MONEY]);
  addTable(s, ['Échéances', 'Factures', 'Total TTC'],
    [['Échues (non réglées à ce jour)', due.overdue_count, due.overdue_ttc], ['À échoir dans les 7 jours', due.week_count, due.week_ttc]],
    [null, null, MONEY]);

  sectionTitle(s, 'Dépenses par département');
  addTable(s, ['Département', 'Factures', 'Montant HT', 'TVA', 'Total TTC', 'Part'],
    byDep.map((x) => [x.name, x.count, x.ht, x.vat, x.ttc, totals.ttc ? x.ttc / totals.ttc : 0]), [null, null, MONEY, MONEY, MONEY, '0.0%']);

  sectionTitle(s, 'TVA déductible par taux');
  addTable(s, ['Taux de TVA', 'Factures', 'Base HT', 'TVA', 'Total TTC'],
    [...byVat.map((v) => [v.rate === null ? 'Non renseigné' : `${v.rate.toLocaleString('fr-FR')} %`, v.count, v.ht, v.vat, v.ttc]),
      ['Total', totals.count, totals.ht, totals.vat, totals.ttc]],
    [null, null, MONEY, MONEY, MONEY]);
  s.lastRow.font = { bold: true };

  sectionTitle(s, 'Dépenses par fournisseur');
  addTable(s, ['Fournisseur', 'Factures', 'Montant HT', 'TVA', 'Total TTC', 'Part'],
    bySupplier.map((x) => [x.tax_id ? `${x.name} (${x.tax_id})` : x.name, x.count, x.ht, x.vat, x.ttc, totals.ttc ? x.ttc / totals.ttc : 0]),
    [null, null, MONEY, MONEY, MONEY, '0.0%']);

  if (byMonth.length > 1) {
    sectionTitle(s, 'Évolution mensuelle');
    addTable(s, ['Mois', 'Factures', 'Montant HT', 'TVA', 'Total TTC'],
      byMonth.map((m) => [monthLabel(m.month), m.count, m.ht, m.vat, m.ttc]), [null, null, MONEY, MONEY, MONEY]);
  }

  /* --- Factures (one row per invoice, filterable in Excel) --- */
  const d = wb.addWorksheet('Factures', { views: [{ state: 'frozen', ySplit: 1 }] });
  d.columns = [
    { header: 'N° facture', key: 'invoice_number', width: 20 },
    { header: 'Fournisseur', key: 'supplier_name', width: 28 },
    { header: 'Matricule fiscal', key: 'supplier_tax_id', width: 18 },
    { header: 'Département', key: 'department', width: 20 },
    { header: 'Date facture', key: 'invoice_date', width: 13, style: { numFmt: 'dd/mm/yyyy' } },
    { header: 'Échéance', key: 'due_date', width: 13, style: { numFmt: 'dd/mm/yyyy' } },
    { header: 'Devise', key: 'currency', width: 8 },
    { header: 'Montant HT', key: 'amount_ht', width: 15, style: { numFmt: MONEY } },
    { header: 'Taux TVA', key: 'vat_rate', width: 10, style: { numFmt: '0" %"' } },
    { header: 'Montant TVA', key: 'vat_amount', width: 14, style: { numFmt: MONEY } },
    { header: 'Total TTC', key: 'amount_ttc', width: 15, style: { numFmt: MONEY } },
    { header: 'Statut échéance', key: 'due_status', width: 15 },
    { header: 'Saisie', key: 'entry', width: 28 },
    { header: 'Fichier source', key: 'source_file', width: 30 },
    { header: 'Document (Drive)', key: 'drive', width: 20 },
  ];
  styleHeader(d.getRow(1));
  for (const r of rows) {
    d.addRow({
      ...r,
      department: r.department ?? 'Non classé',
      invoice_date: xlDate(r.invoice_date), due_date: xlDate(r.due_date),
      due_status: !r.due_date ? '' : r.due_date < today ? 'Échue' : 'À échoir',
      entry: r.created_by ? `Saisie par ${r.created_by}` : 'Import automatique',
      drive: r.drive_url ? { text: 'Ouvrir le document', hyperlink: /^https?:/.test(r.drive_url) ? r.drive_url : baseUrl + r.drive_url } : '',
    });
  }
  const last = rows.length + 1;
  if (rows.length) {
    d.autoFilter = { from: { row: 1, column: 1 }, to: { row: last, column: d.columns.length } };
    // SUBTOTAL(109, …) totals follow the filters the user applies inside Excel
    const t = d.addRow({ invoice_number: 'TOTAL (lignes visibles)' });
    for (const [col, key] of [['H', 'amount_ht'], ['J', 'vat_amount'], ['K', 'amount_ttc']]) {
      t.getCell(key).value = { formula: `SUBTOTAL(109,${col}2:${col}${last})`, result: rows.reduce((a, x) => a + (x[key] ?? 0), 0) };
    }
    t.font = { bold: true };
    t.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF0FF' } }; });
  }
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), count: rows.length };
}
