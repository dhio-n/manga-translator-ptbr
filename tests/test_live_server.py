#!/usr/bin/env python3
"""
Teste de Integração HTTP em Tempo Real — Manga Translator Backend v2.2.0
========================================================================
Testa os sockets e endpoints HTTP reais:
- GET /health
- POST /detect
- POST /translate-region
- POST /translate (legado)
- Tratamento de erros HTTP 400 (corpo inválido, base64 corrompido, campos ausentes)
- CORS Headers em todos os métodos e pre-flight OPTIONS
"""

import unittest
import threading
import time
import json
import base64
import requests
from http.server import HTTPServer

import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from test_backend import MangaTranslatorHandler
from tests.test_evolution import create_synthetic_manga_page

TEST_HOST = "127.0.0.1"
TEST_PORT = 8799  # Porta isolada para testes


class TestLiveHttpServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer((TEST_HOST, TEST_PORT), MangaTranslatorHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.3)
        cls.base_url = f"http://{TEST_HOST}:{TEST_PORT}"
        cls.img_bytes = create_synthetic_manga_page("WHAT ARE YOU DOING?", 500, 700)
        cls.b64_img = "data:image/jpeg;base64," + base64.b64encode(cls.img_bytes).decode('utf-8')

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_options_cors(self):
        """Pre-flight OPTIONS deve retornar 204 com cabeçalhos CORS completos"""
        r = requests.options(f"{self.base_url}/detect")
        self.assertEqual(r.status_code, 204)
        self.assertEqual(r.headers.get("Access-Control-Allow-Origin"), "*")
        self.assertIn("POST", r.headers.get("Access-Control-Allow-Methods", ""))

    def test_get_health(self):
        """GET /health retorna 200 OK com metadados e versão 2.2.0"""
        r = requests.get(f"{self.base_url}/health")
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertEqual(data.get("status"), "ok")
        self.assertEqual(data.get("version"), "2.2.0")
        self.assertIn("detect", data.get("features", []))
        self.assertIn("translate-region", data.get("features", []))

    def test_post_detect_live(self):
        """POST /detect recebe Base64 e retorna page_id, regiões e dimensões"""
        payload = {"image": self.b64_img}
        r = requests.post(f"{self.base_url}/detect", json=payload)
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertIn("page_id", data)
        self.assertIn("regions", data)
        self.assertEqual(data["image"]["width"], 500)
        self.assertEqual(data["image"]["height"], 700)
        self.assertGreaterEqual(len(data["regions"]), 1)

    def test_post_translate_region_live(self):
        """POST /translate-region traduz texto individual com sucesso"""
        payload = {
            "page_id": "p_test_123",
            "region_id": "r0",
            "text": "WHAT ARE YOU DOING?",
            "target_lang": "pt-BR"
        }
        r = requests.post(f"{self.base_url}/translate-region", json=payload)
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertEqual(data.get("region_id"), "r0")
        self.assertIn("fazendo", data.get("translated_text", "").lower())
        self.assertIn("processing_ms", data)

    def test_post_translate_legacy_live(self):
        """POST /translate legado continua funcionando sem quebras"""
        payload = {"image": self.b64_img}
        r = requests.post(f"{self.base_url}/translate", json=payload)
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertIn("translations", data)
        self.assertIn("image", data)
        self.assertIn("processing_ms", data)

    def test_error_handling_empty_and_bad_input(self):
        """Validação defensiva de erros: HTTP 400 em payloads inválidos"""
        # Corpo vazio
        r1 = requests.post(f"{self.base_url}/detect", data="")
        self.assertEqual(r1.status_code, 400)

        # Imagem ausente
        r2 = requests.post(f"{self.base_url}/detect", json={"outra_coisa": 123})
        self.assertEqual(r2.status_code, 400)

        # Base64 corrompido
        r3 = requests.post(f"{self.base_url}/detect", json={"image": "not-valid-base64!!!"})
        self.assertEqual(r3.status_code, 400)

        # Endpoint desconhecido
        r4 = requests.post(f"{self.base_url}/nao_existe", json={})
        self.assertEqual(r4.status_code, 404)


if __name__ == "__main__":
    unittest.main()
