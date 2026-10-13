#!/usr/bin/env python3
"""
Manga Translator PT-BR — Exemplo de Integração com Modelos Reais de OCR e Tradução
==================================================================================
Este arquivo demonstra como estruturar seu backend Python real com modelos locais de código aberto:
- Detecção e OCR: manga-ocr ou paddleocr ou comic-text-detector
- Tradução: MarianMT (Helsinki-NLP/opus-mt-tc-big-en-pt) ou Ollama local (ex: Qwen 2.5 / Llama 3)

Para rodar este exemplo completo no futuro (quando instalar os pacotes):
    pip install fastapi uvicorn pillow manga-ocr transformers sentencepiece
"""

import io
import time
import base64
import re
from PIL import Image
from http.server import HTTPServer, BaseHTTPRequestHandler
import json

HOST = "127.0.0.1"
PORT = 8765

# --- Exemplo de inicialização de modelos (carregados uma única vez na inicialização) ---
# try:
#     from manga_ocr import MangaOcr
#     mocr = MangaOcr()
#     from transformers import MarianMTModel, MarianTokenizer
#     model_name = "Helsinki-NLP/opus-mt-tc-big-en-pt"
#     tokenizer = MarianTokenizer.from_pretrained(model_name)
#     translator = MarianMTModel.from_pretrained(model_name)
# except Exception as e:
#     print(f"Modo mock ativo: {e}")


def translate_text_ptbr(text_en: str) -> str:
    """Traduz texto de inglês para pt-BR localmente sem APIs comerciais."""
    # Exemplo real com MarianMT:
    # batch = tokenizer([text_en], return_tensors="pt", padding=True)
    # gen = translator.generate(**batch)
    # return tokenizer.batch_decode(gen, skip_special_tokens=True)[0]
    
    # Dicionário de exemplo para teste rápido
    sample_dict = {
        "WHAT ARE YOU DOING?": "O que você está fazendo?",
        "I CANNOT BELIEVE THIS...": "Eu não acredito nisso...",
        "WAIT A MINUTE!": "Espere um momento!",
        "IS THIS REAL?": "Isso é real?",
        "WE MUST GO NOW!": "Nós temos que ir agora!"
    }
    return sample_dict.get(text_en.strip().upper(), text_en)


def detect_bubbles_and_ocr(pil_img: Image.Image):
    """
    Localiza balões de texto e extrai o texto em inglês.
    Retorna lista de dicionários com 'box' normalizado [0..1000] e 'text_pt'.
    """
    w, h = pil_img.size

    # Exemplo de balões encontrados com coordenadas normalizadas de 0 a 1000
    detected = [
        {"en": "WHAT ARE YOU DOING?", "box": [120, 85, 260, 110], "confidence": 0.96},
        {"en": "I CANNOT BELIEVE THIS...", "box": [580, 220, 310, 130], "confidence": 0.94},
        {"en": "WAIT A MINUTE!", "box": [180, 520, 280, 95], "confidence": 0.98}
    ]

    results = []
    for item in detected:
        translated = translate_text_ptbr(item["en"])
        results.append({
            "text": translated,
            "box": item["box"],
            "confidence": item["confidence"]
        })
    return results, w, h


class RealPipelineHandler(BaseHTTPRequestHandler):
    def _set_headers(self, status=200):
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()

    def do_OPTIONS(self):
        self._set_headers(204)

    def do_GET(self):
        if self.path == "/health":
            self._set_headers(200)
            self.wfile.write(json.dumps({"status": "ok", "service": "manga-real-pipeline"}).encode())
        else:
            self._set_headers(404)

    def do_POST(self):
        if self.path == "/translate":
            start_t = time.time()
            content_length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))

            img_base64 = re.sub(r"^data:image\/[a-zA-Z]+;base64,", "", payload.get("image", ""))
            raw_bytes = base64.b64decode(img_base64)
            pil_image = Image.open(io.BytesIO(raw_bytes)).convert("RGB")

            translations, orig_w, orig_h = detect_bubbles_and_ocr(pil_image)

            elapsed_ms = int((time.time() - start_t) * 1000)
            response = {
                "translations": translations,
                "image": {
                    "width": orig_w,
                    "height": orig_h
                },
                "processing_ms": elapsed_ms
            }

            self._set_headers(200)
            self.wfile.write(json.dumps(response, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    server = HTTPServer((HOST, PORT), RealPipelineHandler)
    print(f"Backend com Pipeline Real pronto em http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
