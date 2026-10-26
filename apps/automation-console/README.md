# OpsPilot · Factures

Local web app for supplier invoices. Everything the user sees is in French; this README is for developers.
Runs at **http://localhost:4000** (bound to 127.0.0.1). No n8n: all processing happens in this app.

## Workflow

1. **Scan or upload** — « Scanner » opens the camera (photo of the invoice); « Importer un fichier » or drag & drop takes a PDF, JPG or PNG (15 MB max, several files are handled one after the other).
2. **Read** — text PDFs are read with `pdftotext`; scanned PDFs and photos go through local OCR (`pdftoppm` + tesseract.js, French + English). Nothing leaves the machine.
3. **Check the summary** — N° facture, fournisseur, date de facture, total TTC + devise, **département**. Fields not found are highlighted. The department is pre-selected when the supplier was already classified.
4. **Save** — the document is filed in the Drive (demo mode: `data/drive-demo`) and the invoice keeps the Drive link. Duplicates (same supplier + number in the same company) are refused.

Unsaved scans stay in `data/drafts` and are removed after 24 h (or as soon as the dialog is closed).

## Screen

One page: add-an-invoice bar, period filter, 3 key figures, **spending by department** (click a bar to filter everything) and **by month**, then the invoice list (search, Excel export, click a row to edit / classify / delete).

## Several companies

Each company has its own settings (name, default currency, departments), users, invoices and documents. Every query is scoped to the logged-in user's company; Drive links and drafts are checked against it too.

```bash
cd apps/automation-console
npm run setup                                     # new company + its first admin (asks the questions)
node create-user.mjs a@b.tn "Nom" user "Société"  # extra user from the command line
```

Company admins manage name, currency, departments and users from **Paramètres** in the app. A department that still has invoices cannot be removed.
Invoices created before multi-company support were attached to « Société démo » (rename it in Paramètres).

## Run & test

```bash
./scripts/dev.sh                        # database + app
cd apps/automation-console && npm test  # needs the app running; uses two temporary companies, cleans up after
```

The schema (`automation/schema.sql`) is idempotent and applied at every start.

## Files

| File | Role |
| --- | --- |
| `server.mjs` | HTTP server, API, company scoping |
| `extract.mjs` | PDF text / OCR and field parsing |
| `rules.mjs` | summary validation |
| `drive.mjs` | document storage (demo Drive) |
| `auth.mjs` | scrypt passwords, sessions |
| `setup-company.mjs`, `create-user.mjs` | command-line setup |
| `public/index.html` | the whole UI (no external resources) |

The previous n8n pipeline and console are kept for reference in `legacy/`.
