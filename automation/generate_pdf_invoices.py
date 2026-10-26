"""Generate synthetic French supplier-invoice PDFs (text-based), some with deliberate errors.

Usage: automation/.venv/bin/python automation/generate_pdf_invoices.py [count]
Writes to data/samples/pdf/. Prints which files contain an error.
"""
import random, sys
from datetime import date, timedelta
from pathlib import Path
from fpdf import FPDF

SUPPLIERS = [
    ("Medina Food Distribution", "1234567A/M/000", "Rue de Marseille 12, Tunis"),
    ("Sahel Packaging SARL", "2345678B/P/000", "Zone industrielle, Sousse"),
    ("Cap Bon Beverages", "3456789C/A/000", "Route de Kelibia, Nabeul"),
    ("Atlas Cleaning Supplies", "4567890D/M/000", "Avenue Habib Bourguiba, Sfax"),
]
PRODUCTS = ["Jus d'orange 1L", "Carton 40x30", "Nettoyant sol 5L", "Eau minérale 1,5L", "Concentré de tomate 400g"]
OUT = Path(__file__).resolve().parent.parent / "data" / "samples" / "pdf"


def money(x: float) -> str:
    """French/Tunisian format: 2 233,797"""
    return f"{x:,.3f}".replace(",", " ").replace(".", ",")


def make_invoice(n: int, error: str | None) -> Path:
    name, tax_id, address = random.choice(SUPPLIERS)
    inv_date = date.today() - timedelta(days=random.randint(0, 75))  # recent, so « Ce mois » has data
    due = inv_date + timedelta(days=random.choice([30, 45, 60]))
    rate = random.choice([19, 13, 7])
    lines = [(p, random.randint(5, 120), round(random.uniform(1.5, 45), 3)) for p in random.sample(PRODUCTS, 3)]
    ht = round(sum(q * pu for _, q, pu in lines), 3)
    vat = round(ht * rate / 100, 3)
    ttc = round(ht + vat, 3)
    inv_date_txt = inv_date.strftime("%d/%m/%Y")

    if error == "bad_total":
        ttc += 100
    if error == "missing_tax_id":
        tax_id = ""
    if error == "bad_date":
        inv_date_txt = "31/02/2026"

    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 18)
    pdf.cell(0, 10, name, new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", size=10)
    pdf.cell(0, 6, address, new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 6, f"Matricule fiscal : {tax_id}", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(6)
    pdf.set_font("Helvetica", "B", 14)
    pdf.cell(0, 8, "FACTURE", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", size=11)
    for label, value in [("N° facture", f"FAC-2026-P{n:04d}"), ("Date de facture", inv_date_txt),
                         ("Échéance", due.strftime("%d/%m/%Y")), ("Devise", "TND")]:
        pdf.cell(0, 7, f"{label} : {value}", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)

    pdf.set_font("Helvetica", "B", 10)
    for w, h in [(90, "Désignation"), (25, "Qté"), (35, "Prix unitaire"), (40, "Montant")]:
        pdf.cell(w, 8, h, border="B")
    pdf.ln()
    pdf.set_font("Helvetica", size=10)
    for desc, qty, pu in lines:
        pdf.cell(90, 7, desc)
        pdf.cell(25, 7, str(qty))
        pdf.cell(35, 7, money(pu))
        pdf.cell(40, 7, money(qty * pu), new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)

    pdf.set_font("Helvetica", size=11)
    for label, value in [("Total HT", money(ht)), (f"TVA ({rate} %)", money(vat))]:
        pdf.cell(0, 7, f"{label} : {value}", align="R", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 8, f"Total TTC : {money(ttc)}", align="R", new_x="LMARGIN", new_y="NEXT")

    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"facture_P{n:04d}.pdf"
    pdf.output(str(path))
    return path


def main(count: int = 6):
    errors = {count - 3: "bad_date", count - 2: "bad_total", count - 1: "missing_tax_id"} if count >= 4 else {}
    for n in range(1, count + 1):
        path = make_invoice(n, errors.get(n))
        print(f"{path.name}  {errors.get(n, 'ok')}")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 6)
