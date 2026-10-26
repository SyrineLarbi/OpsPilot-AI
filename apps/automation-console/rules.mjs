// Checks the summary of one invoice before it is saved. Messages are shown to the user, so they are in French.
import { parseAmount, parseDate } from './extract.mjs';

export const CURRENCIES = ['TND', 'EUR', 'USD'];

const str = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/** Returns { errors: string[], invoice } — `invoice` holds normalised values (meaningful only without errors). */
export function checkSummary(body, departments) {
  const errors = [];
  const invoice = {
    invoice_number: str(body.invoice_number, 60),
    supplier_name: str(body.supplier_name, 120),
    supplier_tax_id: str(body.supplier_tax_id, 40).replace(/\s/g, '') || null,
    invoice_date: parseDate(str(body.invoice_date, 10)),
    amount_ttc: typeof body.amount_ttc === 'number' ? body.amount_ttc : parseAmount(body.amount_ttc),
    currency: str(body.currency, 3).toUpperCase(),
    department: str(body.department, 60),
  };
  if (!invoice.invoice_number) errors.push('Indiquez le numéro de facture.');
  if (!invoice.supplier_name) errors.push('Indiquez le fournisseur.');
  if (!invoice.invoice_date) errors.push('La date de facture est absente ou invalide.');
  else if (invoice.invoice_date > new Date(Date.now() + 86400000).toISOString().slice(0, 10)) errors.push('La date de facture est dans le futur.');
  if (!(invoice.amount_ttc > 0)) errors.push('Le total doit être un montant positif.');
  else invoice.amount_ttc = Math.round(invoice.amount_ttc * 1000) / 1000;
  if (!CURRENCIES.includes(invoice.currency)) errors.push(`Devise non prise en charge (acceptées : ${CURRENCIES.join(', ')}).`);
  if (!invoice.department) errors.push('Choisissez un département.');
  else if (departments && !departments.includes(invoice.department)) errors.push(`Le département « ${invoice.department} » n'existe pas. Un administrateur peut l'ajouter dans Paramètres.`);
  return { errors, invoice };
}
