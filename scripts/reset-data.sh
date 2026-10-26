#!/usr/bin/env bash
# Deletes ALL imported invoices, rejections, import history and archived files, for a clean demo.
# User accounts are kept. Asks for confirmation first.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$ROOT/.env"; set +a

echo "Cette commande supprime définitivement :"
echo "  - toutes les factures enregistrées, les rejets et l'historique des imports"
echo "  - le journal d'audit"
echo "  - les fichiers archivés (data/processed, data/rejected)"
echo "Les comptes utilisateurs sont conservés."
read -r -p "Tapez EFFACER pour confirmer : " answer
[ "$answer" = "EFFACER" ] || { echo "Annulé."; exit 1; }

PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -q -c \
  "TRUNCATE automation.rejections, automation.supplier_invoices, automation.import_runs, automation.audit_log RESTART IDENTITY;"
find "$ROOT/data/processed" "$ROOT/data/rejected" -type f ! -name '.gitkeep' -delete
echo "Données effacées. Les comptes utilisateurs sont conservés."
