"""Generate a synthetic supplier-invoice CSV with deliberate errors."""
import csv, random, sys
from datetime import date, timedelta

SUPPLIERS = [
    ("Medina Food Distribution", "1234567A/M/000"),
    ("Sahel Packaging SARL",     "2345678B/P/000"),
    ("Cap Bon Beverages",        "3456789C/A/000"),
    ("Atlas Cleaning Supplies",  "4567890D/M/000"),
    ("Carthage Logistics",       "5678901E/N/000"),
]
VAT_RATES = [19, 13, 7]

def make_row(i):
    name, tax_id = random.choice(SUPPLIERS)
    inv_date = date.today() - timedelta(days=random.randint(0, 75))  # recent, so « Ce mois » has data
    ht = round(random.uniform(150, 25000), 3)
    rate = random.choice(VAT_RATES)
    vat = round(ht * rate / 100, 3)
    return {
        "invoice_number": f"INV-{2026}-{i:05d}",
        "supplier_name": name,
        "supplier_tax_id": tax_id,
        "invoice_date": inv_date.isoformat(),
        "due_date": (inv_date + timedelta(days=random.choice([30, 45, 60]))).isoformat(),
        "currency": "TND",
        "amount_ht": f"{ht:.3f}",
        "vat_rate": str(rate),
        "vat_amount": f"{vat:.3f}",
        "amount_ttc": f"{ht + vat:.3f}",
    }

def corrupt(row):
    kind = random.choice(["missing", "bad_date", "bad_total", "negative", "currency", "due_before"])
    if kind == "missing":    row["supplier_tax_id"] = ""
    if kind == "bad_date":   row["invoice_date"] = "31/02/2026"
    if kind == "bad_total":  row["amount_ttc"] = f"{float(row['amount_ttc']) + 50:.3f}"
    if kind == "negative":   row["amount_ht"] = "-120.000"
    if kind == "currency":   row["currency"] = "XYZ"
    if kind == "due_before": row["due_date"] = "2025-01-01"
    return row

def main(n=50, error_rate=0.10, out="data/samples/invoices_sample.csv"):
    rows = [make_row(i) for i in range(1, n + 1)]
    for row in random.sample(rows[1:], k=max(1, int(n * error_rate))):
        corrupt(row)
    rows.append(dict(rows[0]))  # one exact duplicate of a valid row
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=rows[0].keys())
        w.writeheader(); w.writerows(rows)
    print(f"wrote {len(rows)} rows to {out}")

if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 50)
