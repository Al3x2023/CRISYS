import os
import qrcode

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "qr_codes")
BASE_URL = os.getenv("QR_BASE_URL", "http://192.168.1.71:5173/orden?mesa=")
TOTAL_MESAS = int(os.getenv("TOTAL_MESAS", "1"))


def ensure_output_dir():
    os.makedirs(OUTPUT_DIR, exist_ok=True)


def make_qr_for_table(table_number: int):
    url = f"{BASE_URL}{table_number}"
    img = qrcode.make(url)
    filepath = os.path.join(OUTPUT_DIR, f"mesa_{table_number}.png")
    img.save(filepath)
    return filepath, url


def main():
    ensure_output_dir()
    print(f"Generando códigos QR en: {OUTPUT_DIR}")
    for mesa in range(1, TOTAL_MESAS + 1):
        path, url = make_qr_for_table(mesa)
        print(f"Mesa {mesa}: {url} -> {path}")


if __name__ == "__main__":
    main()