CREATE SCHEMA IF NOT EXISTS automation;

-- one row per file processed
CREATE TABLE IF NOT EXISTS automation.import_runs (
  id             SERIAL PRIMARY KEY,
  file_name      TEXT NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_rows     INT,
  valid_rows     INT,
  rejected_rows  INT,
  duplicate_rows INT
);

-- verified invoices
CREATE TABLE IF NOT EXISTS automation.supplier_invoices (
  id              SERIAL PRIMARY KEY,
  invoice_number  TEXT NOT NULL,
  supplier_name   TEXT NOT NULL,
  supplier_tax_id TEXT NOT NULL,
  invoice_date    DATE NOT NULL,
  due_date        DATE NOT NULL,
  currency        CHAR(3) NOT NULL,
  amount_ht       NUMERIC(14,3) NOT NULL,
  vat_rate        NUMERIC(5,2) NOT NULL,
  vat_amount      NUMERIC(14,3) NOT NULL,
  amount_ttc      NUMERIC(14,3) NOT NULL,
  source_file     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (supplier_tax_id, invoice_number)          -- blocks duplicates
);

-- rows that failed validation, with the reasons
CREATE TABLE IF NOT EXISTS automation.rejections (
  id          SERIAL PRIMARY KEY,
  source_file TEXT NOT NULL,
  row_number  INT  NOT NULL,
  raw_data    JSONB NOT NULL,
  errors      TEXT[] NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- console (apps/automation-console) ----------
-- what happened to each rejected row: still to handle, corrected by a user, or deliberately ignored
ALTER TABLE automation.rejections ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE automation.rejections ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE automation.rejections ADD COLUMN IF NOT EXISTS resolved_by TEXT;
ALTER TABLE automation.rejections ADD COLUMN IF NOT EXISTS resolution_note TEXT;
ALTER TABLE automation.rejections ADD COLUMN IF NOT EXISTS invoice_id INT REFERENCES automation.supplier_invoices(id);
DO $$ BEGIN
  ALTER TABLE automation.rejections ADD CONSTRAINT rejections_status_check CHECK (status IN ('pending', 'corrected', 'ignored'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS rejections_status_idx ON automation.rejections (status);

-- NULL = saved by the automation; otherwise the email of the user who entered/corrected it
ALTER TABLE automation.supplier_invoices ADD COLUMN IF NOT EXISTS created_by TEXT;

CREATE TABLE IF NOT EXISTS automation.users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS automation.sessions (
  token_hash TEXT PRIMARY KEY,               -- sha256 of the cookie value; the raw token is never stored
  user_id    INT NOT NULL REFERENCES automation.users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS automation.audit_log (
  id         SERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_email TEXT,
  action     TEXT NOT NULL,
  details    JSONB
);

-- ---------- document storage (Google Drive; demo mode stores locally) ----------
ALTER TABLE automation.import_runs ADD COLUMN IF NOT EXISTS drive_file_id TEXT;
ALTER TABLE automation.import_runs ADD COLUMN IF NOT EXISTS drive_url TEXT;
ALTER TABLE automation.import_runs ADD COLUMN IF NOT EXISTS drive_synced_at TIMESTAMPTZ;
ALTER TABLE automation.supplier_invoices ADD COLUMN IF NOT EXISTS drive_url TEXT;

-- ---------- v2: one summary per document, classified by department, several companies (no n8n) ----------
CREATE TABLE IF NOT EXISTS automation.companies (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  currency   CHAR(3) NOT NULL DEFAULT 'TND',          -- pre-selected when a scan shows no currency
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS automation.departments (
  company_id INT NOT NULL REFERENCES automation.companies(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  PRIMARY KEY (company_id, name)
);

ALTER TABLE automation.users ADD COLUMN IF NOT EXISTS company_id INT REFERENCES automation.companies(id);
ALTER TABLE automation.supplier_invoices ADD COLUMN IF NOT EXISTS company_id INT REFERENCES automation.companies(id);
ALTER TABLE automation.supplier_invoices ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE automation.audit_log ADD COLUMN IF NOT EXISTS company_id INT;

-- a summary only needs: number, supplier, date, total, department (the rest is kept when known)
ALTER TABLE automation.supplier_invoices
  ALTER COLUMN supplier_tax_id DROP NOT NULL, ALTER COLUMN due_date DROP NOT NULL,
  ALTER COLUMN amount_ht DROP NOT NULL, ALTER COLUMN vat_rate DROP NOT NULL, ALTER COLUMN vat_amount DROP NOT NULL;

-- data created before companies existed goes to one demo company (rename it in « Paramètres »)
DO $$
DECLARE cid INT;
BEGIN
  IF EXISTS (SELECT 1 FROM automation.users WHERE company_id IS NULL)
     OR EXISTS (SELECT 1 FROM automation.supplier_invoices WHERE company_id IS NULL) THEN
    INSERT INTO automation.companies (name) VALUES ('Société démo') ON CONFLICT (name) DO NOTHING;
    SELECT id INTO cid FROM automation.companies WHERE name = 'Société démo';
    UPDATE automation.users SET company_id = cid WHERE company_id IS NULL;
    UPDATE automation.supplier_invoices SET company_id = cid WHERE company_id IS NULL;
    INSERT INTO automation.departments (company_id, name)
      SELECT cid, d FROM unnest(ARRAY['Achats', 'Finance', 'Informatique', 'Logistique', 'Marketing', 'Ressources humaines', 'Services généraux']) AS d
      ON CONFLICT DO NOTHING;
  END IF;
END $$;

ALTER TABLE automation.users ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE automation.supplier_invoices ALTER COLUMN company_id SET NOT NULL;

-- duplicates are checked inside one company only
ALTER TABLE automation.supplier_invoices DROP CONSTRAINT IF EXISTS supplier_invoices_supplier_tax_id_invoice_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS supplier_invoices_company_supplier_number_key
  ON automation.supplier_invoices (company_id, lower(supplier_name), invoice_number);
CREATE INDEX IF NOT EXISTS supplier_invoices_company_date_idx ON automation.supplier_invoices (company_id, invoice_date);
CREATE INDEX IF NOT EXISTS supplier_invoices_drive_url_idx ON automation.supplier_invoices (drive_url);
