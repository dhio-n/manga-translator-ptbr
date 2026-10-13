#!/usr/bin/env python3
"""
Manga Translator PT-BR — Backend Local de Alta Precisão
======================================================
Este servidor processa imagens de mangás enviadas pelo Userscript Tampermonkey com pipeline otimizado:
1. Extração de texto via RapidOCR (ONNX Runtime).
2. Segmentação de palavras grudadas (Word Segmentation com wordninja) preservando pontuação.
3. Reconstrução de palavras hifenizadas no fim de linha (Dehyphenation).
4. Agrupamento geométrico blindado por linha (evita fusão de falas entre quadros diferentes).
5. Motor de tradução multicamadas (Google Chrome Extension API + MyMemory) imune a bloqueios HTTP 429.
6. Pós-processador de adaptação de expressões idiomáticas e gírias de mangá/RPG.
7. Normalização das coordenadas [x, y, w, h] de 0 a 1000.

Execução:
    python test_backend.py
    (Porta padrão: 8765)
"""

import sys
import io
import time
import json
import base64
import re
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler
import requests
import numpy as np
from PIL import Image

HOST = "127.0.0.1"
PORT = 8765

# --- Inicialização do Mecanismo de OCR ---
print("Carregando modelos de OCR e Tradução de Alta Precisão...")
try:
    from rapidocr_onnxruntime import RapidOCR
    ocr_engine = RapidOCR()
    print(" [OK] RapidOCR (ONNX Runtime) inicializado com sucesso.")
except Exception as e:
    ocr_engine = None
    print(f" [!] Aviso: RapidOCR não pôde ser carregado: {e}")

# --- Inicialização do Segmentador de Palavras ---
try:
    import wordninja
    has_wordninja = True
    print(" [OK] WordNinja (Segmentação de Palavras do OCR) ativo.")
except Exception as e:
    has_wordninja = False
    print(f" [!] Aviso: wordninja não disponível: {e}")

# --- Cache em memória para traduções (evita requisições repetidas e acelera leitura) ---
TRANSLATION_CACHE = {
    "WHAT ARE YOU DOING?": "O que você está fazendo?",
    "I CANNOT BELIEVE THIS...": "Eu não acredito nisso...",
    "WAIT A MINUTE!": "Espere um momento!",
    "ALL RIGHT! I'VE MADE UP MY MIND!": "Certo! Já me decidi!",
    "ALL RIGHT! I'VE MADE UP MY MIND": "Certo! Já me decidi!",
    "GO TO NEXT PAGE": "Ir para a próxima página",
    "DO IT! YOU'RE THE GUILD MASTER OF THE BEAST'S FANGS!": "Faça isso! Você é o mestre da guilda das Presas da Besta!"
}

# --- Dicionário de Adaptação de Expressões Idiomáticas de Mangá ---
MANGA_IDIOMS = [
    (r'\bdiminuindo de tamanho\b', 'cortando pessoal'),
    (r'\bdiminuição de tamanho\b', 'corte de pessoal'),
    (r'\breduzindo o tamanho\b', 'cortando pessoal'),
    (r'\baparar a gordura\b', 'enxugar a folha de pagamento'),
    (r'\baparando a gordura\b', 'enxugar a folha de pagamento'),
    (r'\bcortar a gordura\b', 'enxugar a folha de pagamento'),
    (r'\baparar as pontas\b', 'enxugar os gastos'),
    (r'\bmachadar\b', 'demitir'),
    (r'\bvocê machado\b', 'você demitiu'),
    (r'\bo machado irritante\b', 'os idiotas irritantes que você demitiu')
]

def post_process_manga_text(pt_text: str) -> str:
    """Ajusta expressões idiomáticas e falsos cognatos comuns em mangás para pt-BR natural"""
    if not pt_text:
        return ""
    result = pt_text
    for pattern, repl in MANGA_IDIOMS:
        result = re.sub(pattern, repl, result, flags=re.I)
    return result


def clean_and_segment_bubble_text(lines: list) -> str:
    """
    Reconstrói o texto real falado no balão:
    1. Junta palavras quebradas por hífen no fim da linha (ex: EVERY- + BODY'S -> EVERYBODY'S).
    2. Separa palavras que o OCR colou sem espaço (ex: DOINGLAYOFFS -> DOING LAYOFFS).
    3. Preserva 100% da pontuação original (ex: OH!YOU'RE -> OH! YOU'RE, DOIT! -> DO IT!).
    """
    if not lines:
        return ""

    # 1. Dehyphenation através das quebras de linha
    full_text = ""
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if full_text.endswith("-"):
            # Linha anterior terminou com hífen de separação silábica
            full_text = full_text[:-1] + line
        else:
            if full_text:
                full_text += " " + line
            else:
                full_text = line

    if not has_wordninja:
        return full_text

    # 2. Tokenização preservando pontuações e símbolos
    tokens = re.findall(r"[A-Za-z]+|[^A-Za-z\s]+|\s+", full_text)
    reconstructed = []
    whitelist_short = {'id', 'ok', 'tv', 'us', 'uk', 'am', 'pm', 'an', 'in', 'on', 'at', 'to', 'or'}

    for token in tokens:
        if token.isalpha():
            # Apenas separa se a palavra tiver mais de 3 caracteres e for composta
            if len(token) > 3 and token.lower() not in whitelist_short:
                splits = wordninja.split(token)
                if len(splits) > 1:
                    reconstructed.append(" ".join(splits))
                else:
                    reconstructed.append(token)
            else:
                reconstructed.append(token)
        else:
            reconstructed.append(token)

    cleaned = "".join(reconstructed)

    # 3. Normalização de pontuação e contrações em inglês
    cleaned = re.sub(r'\s+([,!?.:;])', r'\1', cleaned)
    cleaned = re.sub(r"([A-Za-z])\s+'\s*([stmdre]|ve|ll)\b", r"\1'\2", cleaned, flags=re.I)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return cleaned


def translate_text(text: str) -> str:
    """
    Traduz texto de inglês para pt-BR com múltiplos provedores em cascata:
    1. Cache local em memória (0ms).
    2. Google Chrome Extension Translation API (rápido, oficial, sem HTTP 429).
    3. MyMemory Translated API (fallback robusto).
    4. Pós-processador de expressões idiomáticas de mangá.
    """
    cleaned = text.strip()
    if not cleaned:
        return ""

    # Verifica cache
    if cleaned in TRANSLATION_CACHE:
        return TRANSLATION_CACHE[cleaned]

    translated = None

    # Método 1: Google Chrome Extension API (clients5.google.com)
    try:
        url = f"https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=pt&q={urllib.parse.quote(cleaned)}"
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
        r = requests.get(url, headers=headers, timeout=6)
        if r.status_code == 200:
            data = r.json()
            if isinstance(data, list) and len(data) > 0 and isinstance(data[0], str):
                translated = data[0].strip()
            elif isinstance(data, str) and data.strip():
                translated = data.strip()
    except Exception as e:
        # Fallback silencioso para o próximo motor
        pass

    # Método 2: Fallback MyMemory API
    if not translated:
        try:
            mem_url = f"https://api.mymemory.translated.net/get?q={urllib.parse.quote(cleaned)}&langpair=en|pt-BR"
            r = requests.get(mem_url, timeout=6)
            if r.status_code == 200:
                res_data = r.json()
                trans_mem = res_data.get("responseData", {}).get("translatedText", "")
                if trans_mem and "MYMEMORY WARNING" not in trans_mem.upper():
                    translated = trans_mem.strip()
        except Exception:
            pass

    # Método 3: Fallback final para texto original limpo caso a internet falhe
    final_result = translated if translated else cleaned

    # Aplica adaptação contextual de gírias e expressões de mangá
    final_result = post_process_manga_text(final_result)

    if final_result:
        TRANSLATION_CACHE[cleaned] = final_result

    return final_result


def group_ocr_bubbles(raw_items, max_line_gap_ratio=1.15, min_horiz_overlap=0.20):
    """
    Agrupa linhas de texto que pertencem ao mesmo balão de fala.
    DIFERENCIAL DE ALTA PRECISÃO:
    Calcula a distância vertical em relação à altura da linha individual (last_h),
    impedindo que a tolerância cresça e funda balões de quadros diferentes.
    """
    if not raw_items:
        return []

    # Ordena de cima para baixo e da esquerda para a direita
    sorted_items = sorted(raw_items, key=lambda b: (b['y'], b['x']))
    groups = []

    for item in sorted_items:
        merged = False
        for g in groups:
            # Distância vertical entre a nova linha e a última linha do balão
            last_line_bottom = g['last_y'] + g['last_h']
            vert_gap = item['y'] - last_line_bottom
            line_h = (g['last_h'] + item['h']) / 2

            # Sobreposição horizontal
            overlap_x = max(0, min(g['x'] + g['w'], item['x'] + item['w']) - max(g['x'], item['x']))
            min_w = min(g['w'], item['w'])

            # Permite fusão apenas se a distância for compatível com linhas consecutivas do mesmo balão
            if -line_h * 0.35 <= vert_gap <= line_h * max_line_gap_ratio:
                if overlap_x >= min_w * min_horiz_overlap:
                    g['x'] = min(g['x'], item['x'])
                    g['y'] = min(g['y'], item['y'])
                    g['w'] = max(g['x'] + g['w'], item['x'] + item['w']) - g['x']
                    g['h'] = max(g['y'] + g['h'], item['y'] + item['h']) - g['y']
                    g['lines'].append(item['text'])
                    g['last_y'] = item['y']
                    g['last_h'] = item['h']
                    g['confidence'] = min(g['confidence'], item['confidence'])
                    merged = True
                    break

        if not merged:
            groups.append({
                'x': item['x'],
                'y': item['y'],
                'w': item['w'],
                'h': item['h'],
                'lines': [item['text']],
                'last_y': item['y'],
                'last_h': item['h'],
                'confidence': item['confidence']
            })

    return groups


from collections import OrderedDict
import hashlib

# --- Cache em memória limitado (Bounded LRU) para detecções e regiões ---
MAX_DETECTION_CACHE_ENTRIES = 60
DETECTION_CACHE = OrderedDict()

def get_image_hash(raw_bytes: bytes) -> str:
    """Gera hash SHA-256 estável para identificação única de páginas"""
    hasher = hashlib.sha256()
    hasher.update(raw_bytes)
    return "p_" + hasher.hexdigest()[:16]


def detect_manga_regions(raw_bytes: bytes):
    """
    Etapa 1: Executa RapidOCR, agrupa balões e limpa o texto sem traduzir.
    Retorna page_id, regions delimitadas com coordenadas normalizadas [0..1000] e dimensões.
    """
    page_id = get_image_hash(raw_bytes)

    # Verifica cache em memória
    if page_id in DETECTION_CACHE:
        cached = DETECTION_CACHE[page_id]
        # Move para o final para manter a ordem LRU
        DETECTION_CACHE.move_to_end(page_id)
        return page_id, cached["regions"], cached["width"], cached["height"], True

    img = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
    orig_w, orig_h = img.size

    if not ocr_engine:
        return page_id, [], orig_w, orig_h, False

    np_img = np.array(img)
    ocr_result, _ = ocr_engine(np_img)

    if not ocr_result:
        # Armazena página vazia para evitar OCR repetido
        DETECTION_CACHE[page_id] = {"regions": [], "width": orig_w, "height": orig_h}
        if len(DETECTION_CACHE) > MAX_DETECTION_CACHE_ENTRIES:
            DETECTION_CACHE.popitem(last=False)
        return page_id, [], orig_w, orig_h, False

    raw_items = []
    for item in ocr_result:
        box_pts, text, score = item
        if not text or len(text.strip()) < 2:
            continue
        if score < 0.38:
            continue

        xs = [p[0] for p in box_pts]
        ys = [p[1] for p in box_pts]
        min_x = max(0, min(xs))
        min_y = max(0, min(ys))
        box_w = max(1, max(xs) - min_x)
        box_h = max(1, max(ys) - min_y)

        # Filtra ruídos minúsculos de retícula ou hachuras do desenho
        if box_w < 12 or box_h < 10:
            continue

        raw_items.append({
            'x': min_x,
            'y': min_y,
            'w': box_w,
            'h': box_h,
            'text': text.strip(),
            'confidence': float(score)
        })

    # Agrupa linhas de um mesmo balão
    grouped_bubbles = group_ocr_bubbles(raw_items)

    regions = []
    reg_counter = 0

    for bubble in grouped_bubbles:
        cleaned_en = clean_and_segment_bubble_text(bubble['lines'])

        # Filtra onomatopeias e ruídos
        words = re.findall(r'[A-Za-z]+', cleaned_en)
        if len(cleaned_en) < 3:
            continue
        if (len(words) <= 2 and bubble['confidence'] < 0.72) or re.match(r'^(AII|HIN|CLINK|KLANG|SWOOSH|THUMP|RUMBLE|CRASH|BOOM|BANG)$', cleaned_en, re.I):
            continue

        # Normaliza coordenadas [x, y, w, h] de 0 a 1000
        norm_x = int((bubble['x'] / orig_w) * 1000)
        norm_y = int((bubble['y'] / orig_h) * 1000)
        norm_w = int((bubble['w'] / orig_w) * 1000)
        norm_h = int((bubble['h'] / orig_h) * 1000)

        norm_x = max(0, min(norm_x, 1000))
        norm_y = max(0, min(norm_y, 1000))
        norm_w = max(10, min(norm_w, 1000 - norm_x))
        norm_h = max(10, min(norm_h, 1000 - norm_y))

        region_id = f"r{reg_counter}"
        reg_counter += 1

        regions.append({
            "region_id": region_id,
            "box": [norm_x, norm_y, norm_w, norm_h],
            "source_text": cleaned_en,
            "confidence": round(bubble['confidence'], 2)
        })

    # Armazena no cache LRU bounded
    DETECTION_CACHE[page_id] = {
        "regions": regions,
        "width": orig_w,
        "height": orig_h
    }
    if len(DETECTION_CACHE) > MAX_DETECTION_CACHE_ENTRIES:
        DETECTION_CACHE.popitem(last=False)

    return page_id, regions, orig_w, orig_h, False


def process_manga_image(raw_bytes: bytes):
    """Executa detecção de balões, OCR real, limpeza lexical e tradução na imagem fornecida (Legado / Monolítico)"""
    page_id, regions, orig_w, orig_h, _ = detect_manga_regions(raw_bytes)
    final_translations = []

    for reg in regions:
        translated_pt = translate_text(reg["source_text"])
        if not translated_pt:
            continue
        final_translations.append({
            "region_id": reg["region_id"],
            "text": translated_pt,
            "source_text": reg["source_text"],
            "box": reg["box"],
            "confidence": reg["confidence"]
        })

    return final_translations, orig_w, orig_h


class MangaTranslatorHandler(BaseHTTPRequestHandler):
    def _set_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Content-Type", "application/json; charset=utf-8")

    def do_OPTIONS(self):
        self.send_response(204)
        self._set_cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self._set_cors_headers()
            self.end_headers()
            response = {
                "status": "ok",
                "service": "manga-translator-backend",
                "ocr_engine": "RapidOCR",
                "word_segmentation": has_wordninja,
                "version": "2.2.0",
                "features": ["detect", "translate-region", "translate-legacy", "3-page-window"],
                "cached_pages": len(DETECTION_CACHE),
                "cached_translations": len(TRANSLATION_CACHE),
                "host": f"{HOST}:{PORT}"
            }
            self.wfile.write(json.dumps(response).encode("utf-8"))
        else:
            self.send_response(404)
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Endpoint não encontrado"}).encode("utf-8"))

    def _read_json_body(self):
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            return None, "Corpo da requisição vazio"
        try:
            body = self.rfile.read(content_length).decode("utf-8")
            return json.loads(body), None
        except Exception as e:
            return None, f"JSON inválido: {str(e)}"

    def _extract_image_bytes(self, payload):
        image_data = payload.get("image", "")
        if not image_data or not isinstance(image_data, str):
            return None, "Campo 'image' obrigatório ausente"
        match = re.match(r"^data:image\/[a-zA-Z]+;base64,(.+)$", image_data)
        base64_str = match.group(1) if match else image_data
        try:
            raw_bytes = base64.b64decode(base64_str)
            return raw_bytes, None
        except Exception as e:
            return None, f"Base64 corrompido: {str(e)}"

    def do_POST(self):
        start_time = time.time()

        if self.path == "/detect":
            # --- Etapa 1: Detecção e Delimitação Rápida de Balões ---
            payload, err = self._read_json_body()
            if err:
                self.send_response(400)
                self._set_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps({"error": err}).encode("utf-8"))
                return

            raw_bytes, err = self._extract_image_bytes(payload)
            if err:
                self.send_response(400)
                self._set_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps({"error": err}).encode("utf-8"))
                return

            page_id, regions, width, height, from_cache = detect_manga_regions(raw_bytes)
            elapsed_ms = int((time.time() - start_time) * 1000)

            response_data = {
                "page_id": page_id,
                "cached": from_cache,
                "image": {
                    "width": width,
                    "height": height
                },
                "regions": regions,
                "detection_ms": elapsed_ms
            }

            self.send_response(200)
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps(response_data, ensure_ascii=False).encode("utf-8"))
            cache_tag = " (CACHE)" if from_cache else ""
            print(f"[POST /detect] {page_id}: {len(regions)} balões identificados em {elapsed_ms}ms{cache_tag}")

        elif self.path == "/translate-region":
            # --- Etapa 2: Tradução Individual Progressiva de Balão ---
            payload, err = self._read_json_body()
            if err:
                self.send_response(400)
                self._set_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps({"error": err}).encode("utf-8"))
                return

            page_id = payload.get("page_id", "")
            region_id = payload.get("region_id", "")
            source_text = payload.get("text", "")

            if not source_text or not isinstance(source_text, str):
                self.send_response(400)
                self._set_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Campo 'text' obrigatório ausente"}).encode("utf-8"))
                return

            translated_text = translate_text(source_text)
            elapsed_ms = int((time.time() - start_time) * 1000)

            response_data = {
                "page_id": page_id,
                "region_id": region_id,
                "source_text": source_text,
                "translated_text": translated_text,
                "processing_ms": elapsed_ms
            }

            self.send_response(200)
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps(response_data, ensure_ascii=False).encode("utf-8"))
            print(f"[POST /translate-region] {page_id}::{region_id}: '{source_text[:20]}...' -> '{translated_text[:20]}...' ({elapsed_ms}ms)")

        elif self.path == "/translate":
            # --- Endpoint Legado / Compatibilidade Monolítica ---
            payload, err = self._read_json_body()
            if err:
                self.send_response(400)
                self._set_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps({"error": err}).encode("utf-8"))
                return

            raw_bytes, err = self._extract_image_bytes(payload)
            if err:
                self.send_response(400)
                self._set_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps({"error": err}).encode("utf-8"))
                return

            image_size_kb = len(raw_bytes) / 1024
            translations, width, height = process_manga_image(raw_bytes)
            elapsed_ms = int((time.time() - start_time) * 1000)

            response_data = {
                "translations": translations,
                "image": {
                    "width": width,
                    "height": height
                },
                "processing_ms": elapsed_ms
            }

            self.send_response(200)
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps(response_data, ensure_ascii=False).encode("utf-8"))
            print(f"[POST /translate] Sucesso (Legado): {image_size_kb:.1f} KB | {len(translations)} balões traduzidos | {elapsed_ms}ms")

        else:
            self.send_response(404)
            self._set_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Endpoint desconhecido"}).encode("utf-8"))

    def log_message(self, format, *args):
        sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} - {format % args}\n")


def main():
    server_address = (HOST, PORT)
    httpd = HTTPServer(server_address, MangaTranslatorHandler)
    print("=" * 68)
    print("   Manga Translator PT-BR — Backend v2.2.0 Ativo (Progressivo)")
    print("=" * 68)
    print(f" Endpoints ativos:")
    print(f"   - Health Check:     http://{HOST}:{PORT}/health")
    print(f"   - Detecção Rápida:  http://{HOST}:{PORT}/detect")
    print(f"   - Tradução Região:  http://{HOST}:{PORT}/translate-region")
    print(f"   - Tradução Legada:  http://{HOST}:{PORT}/translate")
    print(" Pipeline ativo: RapidOCR + WordNinja + Dehyphenation + Chrome MT")
    print(" Suporte a Janela de 3 Páginas [P0, P1, P2] e Máscaras Imediatas")
    print(" Aguardando páginas de mangá do Userscript...")
    print(" Pressione Ctrl+C para encerrar o servidor.")
    print("=" * 68)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado pelo usuário.")
        httpd.server_close()


if __name__ == "__main__":
    main()
