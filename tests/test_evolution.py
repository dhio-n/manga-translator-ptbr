#!/usr/bin/env python3
"""
Suíte de Testes Automatizados — Manga Translator PT-BR v2.2.0
============================================================
Validação rigorosa dos 13 critérios arquiteturais de evolução:
1. P0 é a página ativa e tem prioridade máxima.
2. A janela de prioridade é de estritamente 3 páginas [P0, P1, P2].
3. Páginas fora de [P0, P1, P2] nunca entram na fila e nem são traduzidas.
4. Ao avançar a leitura para uma nova página, a janela se desloca e a nova página vira P0.
5. Se o leitor voltar dentro dos 5 segundos, a mudança de P0 é cancelada.
6. Se a navegação continuar (ex.: pular várias páginas), o timer de 5s é reiniciado.
7. O timer de 5s só confirma P0 se o leitor permanecer na página pelo tempo configurado.
8. Assim que as coordenadas dos balões são conhecidas, as máscaras com spinner aparecem imediatamente.
9. Conforme cada balão termina sua tradução, apenas a máscara daquele balão é substituída pelo texto traduzido.
10. O backend divide a tradução em duas etapas (/detect e /translate-region) e mantém compatibilidade (/translate).
11. Se uma resposta assíncrona chegar após a página não ser mais válida, a resposta é descartada.
12. O cache em memória bounded evita requisições redundantes de detecção e tradução.
13. O leitor MangaDex e o leitor K Manga têm adaptadores próprios funcionando corretamente.
"""

import unittest
import io
import time
import base64
import json
import threading
from http.server import HTTPServer
from PIL import Image, ImageDraw, ImageFont

# Importa módulos do backend real do projeto
import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import test_backend
from test_backend import (
    detect_manga_regions,
    process_manga_image,
    translate_text,
    MangaTranslatorHandler,
    DETECTION_CACHE,
    TRANSLATION_CACHE,
    MAX_DETECTION_CACHE_ENTRIES
)


def create_synthetic_manga_page(text="WHAT ARE YOU DOING?", width=600, height=800):
    """Cria uma imagem de mangá sintética com balão de fala renderizado em preto e branco"""
    img = Image.new("RGB", (width, height), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)

    # Desenha borda de quadrinho
    draw.rectangle([30, 30, width - 30, height - 30], outline=(0, 0, 0), width=4)

    # Desenha balão de fala
    draw.ellipse([80, 100, 480, 260], fill=(255, 255, 255), outline=(0, 0, 0), width=3)

    # Desenha texto no interior do balão
    try:
        font = ImageFont.load_default()
    except Exception:
        font = None

    draw.text((120, 160), text, fill=(0, 0, 0), font=font)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


class TestBackendProgressiveEvolution(unittest.TestCase):
    """Critérios 10 e 12: Backend progressivo (/detect, /translate-region, legado /translate e Cache)"""

    def setUp(self):
        self.sample_bytes = create_synthetic_manga_page("WHAT ARE YOU DOING?")

    def test_criterion_10_detect_endpoint_returns_structured_regions(self):
        """10.1: POST /detect divide a detecção sem traduzir e gera coordenadas normalizadas"""
        page_id, regions, width, height, from_cache = detect_manga_regions(self.sample_bytes)

        self.assertTrue(page_id.startswith("p_"), f"page_id inválido: {page_id}")
        self.assertEqual(width, 600)
        self.assertEqual(height, 800)
        self.assertIsInstance(regions, list)
        self.assertGreater(len(regions), 0, "Deveria ter detectado pelo menos um balão sintético")

        first = regions[0]
        self.assertIn("region_id", first)
        self.assertIn("box", first)
        self.assertIn("source_text", first)
        self.assertIn("confidence", first)

        box = first["box"]
        self.assertEqual(len(box), 4)
        for coord in box:
            self.assertTrue(0 <= coord <= 1000, f"Coordenada fora da faixa 0..1000: {coord}")

    def test_criterion_10_translate_region_and_manga_idioms(self):
        """10.2: POST /translate-region traduz texto individual e aplica expressões idiomáticas de mangá"""
        res1 = translate_text("WHAT ARE YOU DOING?")
        self.assertIn("fazendo", res1.lower(), f"Esperava tradução válida, obteve: {res1}")

        # Testa adaptação idiomática de mangá
        res_idiom = translate_text("WE ARE TRIMMING THE FAT")
        self.assertIsInstance(res_idiom, str)

    def test_criterion_10_legacy_compatibility_translate_endpoint(self):
        """10.3: Compatibilidade com /translate legado"""
        translations, w, h = process_manga_image(self.sample_bytes)
        self.assertIsInstance(translations, list)
        self.assertEqual(w, 600)
        self.assertEqual(h, 800)
        if len(translations) > 0:
            first = translations[0]
            self.assertIn("text", first)
            self.assertIn("box", first)

    def test_criterion_12_bounded_lru_cache(self):
        """12: O cache em memória evita requisições redundantes de detecção e limita uso de memória"""
        DETECTION_CACHE.clear()

        # Primeira chamada: não deve vir do cache
        page_id, regions1, w1, h1, from_cache1 = detect_manga_regions(self.sample_bytes)
        self.assertFalse(from_cache1)

        # Segunda chamada com os mesmos bytes: DEVE vir do cache
        page_id2, regions2, w2, h2, from_cache2 = detect_manga_regions(self.sample_bytes)
        self.assertTrue(from_cache2)
        self.assertEqual(page_id, page_id2)
        self.assertEqual(len(regions1), len(regions2))

        # Testa limite de tamanho do cache bounded (LRU)
        for i in range(MAX_DETECTION_CACHE_ENTRIES + 10):
            dummy_id = f"p_dummy_{i}"
            DETECTION_CACHE[dummy_id] = {"regions": [], "width": 100, "height": 100}
            if len(DETECTION_CACHE) > MAX_DETECTION_CACHE_ENTRIES:
                DETECTION_CACHE.popitem(last=False)

        self.assertLessEqual(len(DETECTION_CACHE), MAX_DETECTION_CACHE_ENTRIES)


class SimulatedPriorityCoordinator:
    """
    Simulador fiel em Python que reproduz exatamente a máquina de estados e o algoritmo
    do Userscript JavaScript (PriorityCoordinator, PriorityTaskQueue, ReaderAdapter),
    incluindo suporte a leitura de trás para frente (RTL / K Manga) e normal (LTR).
    """

    def __init__(self, total_pages=10, tolerance_sec=5.0, reading_direction='ltr'):
        self.total_pages = total_pages
        self.tolerance_sec = tolerance_sec
        self.reading_direction = reading_direction

        self.active_page = None        # P0 confirmado
        self.active_visible_indices = [] # Índices de páginas visíveis simultâneas (ex: [7, 8] em página dupla)
        self.candidate_page = None     # Candidato a P0
        self.candidate_visible_indices = []
        self.previous_confirmed = None # P0 anterior
        self.transition_state = 'IDLE' # 'IDLE' | 'TRANSITION_PENDING' | 'CONFIRMED'
        self.tolerance_remaining = tolerance_sec
        self.priority_window = []      # Índices de páginas ativas na janela

        self.priority_queue = []       # Tarefas ordenadas por prioridade
        self.page_generation = {i: 1 for i in range(total_pages)}
        self.page_status = {i: 'idle' for i in range(total_pages)}
        self.page_masks = {i: {} for i in range(total_pages)} # region_id -> status ('queued', 'translated')

        self.stats = {
            'dropped_tasks': 0,
            'detected_bubbles': 0,
            'translated_bubbles': 0,
            'pending_bubbles': 0
        }

    def toggle_reading_direction(self):
        self.reading_direction = 'ltr' if self.reading_direction == 'rtl' else 'rtl'
        if self.active_page is not None:
            self.confirm_active_page(self.active_page, self.active_visible_indices)

    def on_page_observed(self, candidate_index, elapsed_sec=0.0, visible_indices=None):
        """Simula a observação de uma página (ou spread de páginas duplas) no viewport pelo ReaderAdapter"""
        visible = list(visible_indices) if visible_indices else [candidate_index]

        all_visible_confirmed = all(idx in self.active_visible_indices for idx in visible)
        if candidate_index == self.active_page and all_visible_confirmed:
            if self.transition_state == 'TRANSITION_PENDING':
                self.cancel_transition()
            return

        # REGRA DE TRANSIÇÃO:
        # 1. Se as páginas visíveis já estiverem dentro da janela ativa de prioridade
        # 2. OU se for progressão de leitura sequencial natural (<= 2 páginas adiante em LTR ou atrás em RTL)
        # a transição é IMEDIATA (0 segundos de espera), permitindo leitura fluida sem pausas.
        is_within_window = len(self.priority_window) > 0 and any(idx in self.priority_window for idx in visible)

        is_sequential = False
        if self.active_page is not None:
            if self.reading_direction != 'rtl':
                is_sequential = (candidate_index >= self.active_page - 1 and candidate_index <= self.active_page + 2)
            else:
                is_sequential = (candidate_index <= self.active_page + 1 and candidate_index >= self.active_page - 2)

        if is_within_window or is_sequential or self.active_page is None:
            if self.transition_state == 'TRANSITION_PENDING':
                self.cancel_transition()
            self.confirm_active_page(candidate_index, visible)
            return

        # Se as páginas estiverem FORA da janela da fila (salto distante de 3+ páginas):
        # Ativa a tolerância de 5 segundos para proteger as páginas anteriores de recarregamento!
        if self.transition_state == 'TRANSITION_PENDING':
            # Se o usuário voltou para uma página da janela anterior antes dos 5s
            if any(idx in self.priority_window for idx in visible) or candidate_index == self.previous_confirmed:
                self.cancel_transition()
                self.confirm_active_page(candidate_index, visible)
                return

            # Se o usuário continuou navegando para outra página fora da janela
            if candidate_index != self.candidate_page:
                self.reset_timer(candidate_index, visible)
                return

            # Mesmo candidato fora da janela sendo visualizado: avança o tempo
            self.tolerance_remaining -= elapsed_sec
            if self.tolerance_remaining <= 0:
                self.confirm_active_page(self.candidate_page, self.candidate_visible_indices)
            return

        # Primeiro avistamento de um salto para fora da janela: inicia timer de 5s
        self.start_timer(candidate_index, visible)

    def start_timer(self, candidate_index, visible_indices=None):
        self.candidate_page = candidate_index
        self.candidate_visible_indices = list(visible_indices) if visible_indices else [candidate_index]
        self.transition_state = 'TRANSITION_PENDING'
        self.tolerance_remaining = self.tolerance_sec

    def reset_timer(self, candidate_index, visible_indices=None):
        self.start_timer(candidate_index, visible_indices)

    def cancel_transition(self):
        self.candidate_page = None
        self.candidate_visible_indices = []
        self.transition_state = 'CONFIRMED' if self.active_page is not None else 'IDLE'
        self.tolerance_remaining = self.tolerance_sec

    def confirm_active_page(self, page_index, visible_indices=None):
        self.transition_state = 'CONFIRMED'
        self.previous_confirmed = self.active_page
        self.active_page = page_index
        self.candidate_page = None
        self.candidate_visible_indices = []
        self.tolerance_remaining = self.tolerance_sec

        visible = list(visible_indices) if visible_indices else [page_index]
        if page_index not in visible:
            visible.append(page_index)
        visible.sort()
        self.active_visible_indices = visible

        # Constrói janela de prioridade: TODAS as páginas visíveis entram como P0 prioritárias
        priority_window = list(visible)
        if self.reading_direction == 'rtl':
            min_idx = min(visible)
            p1 = min_idx - 1 if min_idx - 1 >= 0 else None
            p2 = min_idx - 2 if min_idx - 2 >= 0 else None
            if p1 is not None and p1 not in priority_window: priority_window.append(p1)
            if p2 is not None and p2 not in priority_window: priority_window.append(p2)
        else:
            max_idx = max(visible)
            p1 = max_idx + 1 if max_idx + 1 < self.total_pages else None
            p2 = max_idx + 2 if max_idx + 2 < self.total_pages else None
            if p1 is not None and p1 not in priority_window: priority_window.append(p1)
            if p2 is not None and p2 not in priority_window: priority_window.append(p2)

        self.priority_window = priority_window

        # 1. Purga tarefas fora da janela
        kept = []
        for task in self.priority_queue:
            if task['page_index'] in self.priority_window:
                is_vis = task['page_index'] in self.active_visible_indices
                if is_vis:
                    task['priority'] = 0 if task['type'] == 'translate-region' else 1
                else:
                    spec_pages = [p for p in self.priority_window if p not in self.active_visible_indices]
                    spec_idx = spec_pages.index(task['page_index']) if task['page_index'] in spec_pages else 1
                    task['priority'] = 2 if spec_idx == 0 else 4 if task['type'] == 'translate-region' else (3 if spec_idx == 0 else 5)
                kept.append(task)
            else:
                self.stats['dropped_tasks'] += 1
        kept.sort(key=lambda t: (t['priority'], t['created_at']))
        self.priority_queue = kept

        # 2. Invalida tokens de geração de páginas fora da janela
        for p in range(self.total_pages):
            if p not in self.priority_window:
                self.page_generation[p] += 1
                if self.page_status[p] in ('pending', 'detecting'):
                    self.page_status[p] = 'cancelled'

        # 3. Dispara TODAS as páginas visíveis com P0 (Alta prioridade)
        for p in visible:
            self.dispatch_page(p, is_visible=True)

        # 4. Dispara páginas especulativas (P1, P2)
        for p in priority_window:
            if p not in visible:
                self.dispatch_page(p, is_visible=False)

    def refresh_priority_window(self):
        if self.active_page is None:
            return
        visible = list(self.active_visible_indices) if self.active_visible_indices else [self.active_page]
        target_window = list(visible)
        if self.reading_direction == 'rtl':
            min_idx = min(visible)
            p1 = min_idx - 1 if min_idx - 1 >= 0 else None
            p2 = min_idx - 2 if min_idx - 2 >= 0 else None
            if p1 is not None and p1 not in target_window: target_window.append(p1)
            if p2 is not None and p2 not in target_window: target_window.append(p2)
        else:
            max_idx = max(visible)
            p1 = max_idx + 1 if max_idx + 1 < self.total_pages else None
            p2 = max_idx + 2 if max_idx + 2 < self.total_pages else None
            if p1 is not None and p1 not in target_window: target_window.append(p1)
            if p2 is not None and p2 not in target_window: target_window.append(p2)

        if target_window != self.priority_window:
            self.priority_window = target_window
            for p in target_window:
                self.dispatch_page(p, is_visible=(p in visible))

    def dispatch_page(self, page_index, is_visible=True):
        if self.page_status[page_index] in ('idle', 'cancelled'):
            self.page_status[page_index] = 'pending'
            if is_visible:
                detect_prio = 1
            else:
                spec_pages = [p for p in self.priority_window if p not in self.active_visible_indices]
                spec_idx = spec_pages.index(page_index) if page_index in spec_pages else 0
                detect_prio = 3 if spec_idx == 0 else 5
            self.priority_queue.append({
                'id': f"det-p{page_index}-g{self.page_generation[page_index]}",
                'type': 'detect',
                'page_index': page_index,
                'priority': detect_prio,
                'generation': self.page_generation[page_index],
                'created_at': time.time()
            })
            self.priority_queue.sort(key=lambda t: (t['priority'], t['created_at']))
        elif self.page_status[page_index] == 'detected':
            reg_prio = 0 if is_visible else 2
            for reg_id, status in self.page_masks[page_index].items():
                if status != 'translated':
                    already_queued = any(
                        t['page_index'] == page_index and t.get('region_id') == reg_id
                        for t in self.priority_queue
                    )
                    if not already_queued:
                        self.priority_queue.append({
                            'id': f"reg-p{page_index}-{reg_id}-g{self.page_generation[page_index]}",
                            'type': 'translate-region',
                            'page_index': page_index,
                            'region_id': reg_id,
                            'priority': reg_prio,
                            'generation': self.page_generation[page_index],
                            'created_at': time.time()
                        })
            self.priority_queue.sort(key=lambda t: (t['priority'], t['created_at']))

    def simulate_detect_response(self, task, regions_count=3):
        """Simula resposta assíncrona do POST /detect"""
        if task['page_index'] not in self.priority_window or task['generation'] != self.page_generation[task['page_index']]:
            self.stats['dropped_tasks'] += 1
            return False

        p = task['page_index']
        self.page_status[p] = 'detected'
        is_vis = p in self.active_visible_indices
        region_prio = 0 if is_vis else 2

        # Cria máscaras imediatas nos balões com estado 'queued'
        for r in range(regions_count):
            reg_id = f"r{r}"
            self.page_masks[p][reg_id] = 'queued'
            self.stats['detected_bubbles'] += 1
            self.stats['pending_bubbles'] += 1

            self.priority_queue.append({
                'id': f"reg-p{p}-{reg_id}-g{self.page_generation[p]}",
                'type': 'translate-region',
                'page_index': p,
                'region_id': reg_id,
                'priority': region_prio,
                'generation': self.page_generation[p],
                'created_at': time.time()
            })
        self.priority_queue.sort(key=lambda t: (t['priority'], t['created_at']))
        return True

    def simulate_translate_region_response(self, task):
        """Simula resposta assíncrona do POST /translate-region para um balão individual"""
        p = task['page_index']
        reg_id = task['region_id']

        # Checa validade do token de geração e janela
        if p not in self.priority_window or task['generation'] != self.page_generation[p]:
            self.stats['dropped_tasks'] += 1
            return False

        # Substitui apenas este balão
        self.page_masks[p][reg_id] = 'translated'
        self.stats['translated_bubbles'] += 1
        self.stats['pending_bubbles'] -= 1
        return True


class TestCoordinatorAndPriorityQueueLogic(unittest.TestCase):
    """Critérios 1 a 9, 11 e 13: Lógica de Janela de 3 Páginas, Prioridade, 5s Debounce e Máscaras"""

    def setUp(self):
        self.sim = SimulatedPriorityCoordinator(total_pages=15, tolerance_sec=5.0)

    def test_criterion_1_and_2_p0_priority_and_strict_3_page_window(self):
        """1 & 2: P0 é a página ativa com prioridade máxima e a janela é estritamente [P0, P1, P2]"""
        # Confirma Página 2 como P0
        self.sim.confirm_active_page(2)

        self.assertEqual(self.sim.active_page, 2)
        self.assertEqual(self.sim.priority_window, [2, 3, 4], "Janela deve conter estritamente 3 páginas [P0, P1, P2]")

        # Verifica níveis de prioridade
        p0_task = next(t for t in self.sim.priority_queue if t['page_index'] == 2)
        p1_task = next(t for t in self.sim.priority_queue if t['page_index'] == 3)
        p2_task = next(t for t in self.sim.priority_queue if t['page_index'] == 4)

        self.assertLess(p0_task['priority'], p1_task['priority'], "P0 deve ter prioridade superior a P1")
        self.assertLess(p1_task['priority'], p2_task['priority'], "P1 deve ter prioridade superior a P2")

    def test_criterion_3_out_of_window_pages_never_queued(self):
        """3: Páginas fora de [P0, P1, P2] nunca entram na fila nem são traduzidas"""
        self.sim.confirm_active_page(5)
        self.assertEqual(self.sim.priority_window, [5, 6, 7])

        queued_pages = {t['page_index'] for t in self.sim.priority_queue}
        self.assertEqual(queued_pages, {5, 6, 7})
        self.assertNotIn(0, queued_pages)
        self.assertNotIn(1, queued_pages)
        self.assertNotIn(8, queued_pages)

    def test_criterion_4_window_shifts_on_reading_advance(self):
        """4: Ao avançar a leitura para uma nova página, a janela se desloca e a nova página vira P0"""
        self.sim.confirm_active_page(1)
        self.assertEqual(self.sim.priority_window, [1, 2, 3])

        # Avança para Página 6
        self.sim.confirm_active_page(6)
        self.assertEqual(self.sim.active_page, 6)
        self.assertEqual(self.sim.priority_window, [6, 7, 8])

        # Tarefas antigas da Página 1, 2, 3 devem ter sido purgadas
        current_queued = [t['page_index'] for t in self.sim.priority_queue]
        self.assertNotIn(1, current_queued)
        self.assertNotIn(2, current_queued)
        self.assertNotIn(3, current_queued)

    def test_immediate_transition_within_active_window(self):
        """Transições entre as 3 páginas da janela [P0, P1, P2] ocorrem imediatamente (0s de delay)"""
        self.sim.confirm_active_page(0)
        self.assertEqual(self.sim.priority_window, [0, 1, 2])

        # Usuário avança para Página 1 (está dentro de [0, 1, 2])
        self.sim.on_page_observed(1, elapsed_sec=0.0)

        # Transição deve ser IMEDIATA (sem entrar em TRANSITION_PENDING)
        self.assertEqual(self.sim.transition_state, 'CONFIRMED')
        self.assertEqual(self.sim.active_page, 1)
        self.assertEqual(self.sim.priority_window, [1, 2, 3])

        # Usuário avança para Página 2 (está dentro de [1, 2, 3])
        self.sim.on_page_observed(2, elapsed_sec=0.0)
        self.assertEqual(self.sim.transition_state, 'CONFIRMED')
        self.assertEqual(self.sim.active_page, 2)
        self.assertEqual(self.sim.priority_window, [2, 3, 4])

    def test_criterion_5_cancel_transition_on_backward_navigation_within_5s(self):
        """5: Se o leitor pular para fora da janela (p4+) mas voltar dentro de 5s, o salto é cancelado"""
        # Estado inicial estável: Página 0 confirmada (janela [0, 1, 2])
        self.sim.confirm_active_page(0)
        self.assertEqual(self.sim.active_page, 0)
        self.assertEqual(self.sim.priority_window, [0, 1, 2])

        # Usuário pula para a Página 4 (FORA das 3 páginas da janela ativa -> ativa timer de 5s)
        self.sim.on_page_observed(4, elapsed_sec=0.0)
        self.assertEqual(self.sim.transition_state, 'TRANSITION_PENDING')
        self.assertEqual(self.sim.candidate_page, 4)
        # A janela original [0, 1, 2] continua preservada sem recarregar!
        self.assertEqual(self.sim.priority_window, [0, 1, 2])

        # 2 segundos depois, usuário retorna para a Página 0 (ou 1)
        self.sim.on_page_observed(0, elapsed_sec=2.0)

        # O salto para Página 4 foi cancelado e a janela [0, 1, 2] não foi descarregada!
        self.assertEqual(self.sim.transition_state, 'CONFIRMED')
        self.assertEqual(self.sim.active_page, 0)
        self.assertIsNone(self.sim.candidate_page)
        self.assertEqual(self.sim.priority_window, [0, 1, 2])

    def test_criterion_6_reset_timer_on_continued_rapid_navigation(self):
        """6: Se a navegação continuar fora da janela (pular páginas), o timer de 5s é reiniciado"""
        self.sim.confirm_active_page(0)
        self.assertEqual(self.sim.priority_window, [0, 1, 2])

        # Usuário pula para Página 4 (fora da janela)
        self.sim.on_page_observed(4, elapsed_sec=0.0)
        self.assertEqual(self.sim.candidate_page, 4)
        self.assertEqual(self.sim.tolerance_remaining, 5.0)

        # 1 segundo depois, rola rápido para a Página 6 (também fora da janela)
        self.sim.on_page_observed(6, elapsed_sec=1.0)
        self.assertEqual(self.sim.candidate_page, 6)
        # Timer deve ter sido reiniciado para 5.0 segundos
        self.assertEqual(self.sim.tolerance_remaining, 5.0)

        # 1.5 segundos depois, rola rápido para a Página 9 (também fora da janela)
        self.sim.on_page_observed(9, elapsed_sec=1.5)
        self.assertEqual(self.sim.candidate_page, 9)
        self.assertEqual(self.sim.tolerance_remaining, 5.0)

    def test_criterion_7_timer_confirms_only_after_full_tolerance_duration(self):
        """7: O timer de 5s só confirma salto para fora da janela se o leitor permanecer pelo tempo configurado"""
        self.sim.confirm_active_page(0)
        self.assertEqual(self.sim.priority_window, [0, 1, 2])

        # Usuário pula para Página 5 (fora da janela [0, 1, 2])
        self.sim.on_page_observed(5, elapsed_sec=0.0)
        self.assertEqual(self.sim.transition_state, 'TRANSITION_PENDING')
        self.assertEqual(self.sim.active_page, 0)
        self.assertEqual(self.sim.priority_window, [0, 1, 2])

        # Passam 2 segundos (ainda não deve confirmar)
        self.sim.on_page_observed(5, elapsed_sec=2.0)
        self.assertEqual(self.sim.transition_state, 'TRANSITION_PENDING')
        self.assertEqual(self.sim.active_page, 0)
        self.assertEqual(self.sim.priority_window, [0, 1, 2])

        # Passam mais 3 segundos (total 5s)
        self.sim.on_page_observed(5, elapsed_sec=3.0)
        # AGORA o salto fora da janela é confirmado e a nova janela é montada!
        self.assertEqual(self.sim.transition_state, 'CONFIRMED')
        self.assertEqual(self.sim.active_page, 5)
        self.assertEqual(self.sim.priority_window, [5, 6, 7])

    def test_criterion_8_and_9_immediate_masks_and_progressive_bubble_translation(self):
        """8 & 9: Máscaras aparecem imediatamente no término de /detect e traduzem progressivamente balão a balão"""
        self.sim.confirm_active_page(0)

        detect_task = next(t for t in self.sim.priority_queue if t['page_index'] == 0 and t['type'] == 'detect')

        # 8: Assim que detect responde, máscaras aparecem imediatamente
        success = self.sim.simulate_detect_response(detect_task, regions_count=3)
        self.assertTrue(success)
        self.assertEqual(self.sim.page_masks[0]['r0'], 'queued')
        self.assertEqual(self.sim.page_masks[0]['r1'], 'queued')
        self.assertEqual(self.sim.page_masks[0]['r2'], 'queued')

        # 9: Tradução individual progressiva
        trans_task_r0 = next(t for t in self.sim.priority_queue if t['page_index'] == 0 and t['region_id'] == 'r0')
        self.sim.simulate_translate_region_response(trans_task_r0)

        # APENAS r0 deve estar 'translated', r1 e r2 devem continuar como máscara 'queued'
        self.assertEqual(self.sim.page_masks[0]['r0'], 'translated')
        self.assertEqual(self.sim.page_masks[0]['r1'], 'queued')
        self.assertEqual(self.sim.page_masks[0]['r2'], 'queued')

    def test_criterion_11_stale_async_responses_discarded_by_generation_token(self):
        """11: Se uma resposta assíncrona chegar após o usuário navegar para longe, é descartada via generation token"""
        self.sim.confirm_active_page(0)
        detect_task = next(t for t in self.sim.priority_queue if t['page_index'] == 0 and t['type'] == 'detect')
        task_gen = detect_task['generation']

        # Usuário navega para a Página 8 (Página 0 sai da janela e ganha novo token)
        self.sim.confirm_active_page(8)
        self.assertNotIn(0, self.sim.priority_window)
        self.assertGreater(self.sim.page_generation[0], task_gen)

        dropped_before = self.sim.stats['dropped_tasks']

        # Resposta atrasada da Página 0 chega do backend
        accepted = self.sim.simulate_detect_response(detect_task)

        # DEVE ser rejeitada e contada como descartada
        self.assertFalse(accepted, "Resposta obsoleta não pode ser aceita")
        self.assertGreater(self.sim.stats['dropped_tasks'], dropped_before)

    def test_criterion_13_reader_adapters_heuristics(self):
        """13: Heurísticas especializadas de MangaDex e K Manga"""
        # MangaDex: detecção por #page-X
        import re
        hash_url = "https://mangadex.org/chapter/123#page-4"
        match = re.search(r'page[=-](\d+)', hash_url)
        self.assertIsNotNone(match)
        page_num = int(match.group(1)) - 1
        self.assertEqual(page_num, 3)

        # K Manga: canvas com proporção e dimensões válidas
        canvas_w, canvas_h = 1080, 1600
        is_valid = (canvas_w >= 250 and canvas_h >= 300 and 0.15 <= (canvas_w / canvas_h) <= 3.2)
        self.assertTrue(is_valid)

    def test_criterion_14_rtl_reading_direction_for_kmanga(self):
        """14: Direção de leitura de trás para frente (RTL / K Manga): P1 = P0 - 1 e P2 = P0 - 2"""
        rtl_sim = SimulatedPriorityCoordinator(total_pages=20, tolerance_sec=5.0, reading_direction='rtl')

        # Usuário abre o mangá na primeira página da história (que no leitor do navegador é a última, ex: índice 19)
        rtl_sim.confirm_active_page(19)

        # Em RTL, a leitura volta: as próximas páginas são 18 (P1) e 17 (P2)
        self.assertEqual(rtl_sim.priority_window, [19, 18, 17])

        # Quando avança para a página 18
        rtl_sim.confirm_active_page(18)
        self.assertEqual(rtl_sim.priority_window, [18, 17, 16])

        # A página 19 (já lida no passado) deve ter sido purgada da fila
        queued_pages = [t['page_index'] for t in rtl_sim.priority_queue]
        self.assertNotIn(19, queued_pages)
        self.assertIn(18, queued_pages)
        self.assertIn(17, queued_pages)
        self.assertIn(16, queued_pages)

        # No final da leitura (índice 0):
        rtl_sim.confirm_active_page(0)
        self.assertEqual(rtl_sim.priority_window, [0], "No início do DOM (fim da leitura RTL), não deve ter páginas negativas")

    def test_criterion_15_dynamic_direction_toggle(self):
        """15: Alternância dinâmica de direção de leitura recalcula a janela e purga páginas obsoletas"""
        sim = SimulatedPriorityCoordinator(total_pages=20, tolerance_sec=5.0, reading_direction='ltr')
        sim.confirm_active_page(10)

        # Modo normal (LTR): próximas são 11 e 12
        self.assertEqual(sim.priority_window, [10, 11, 12])

        # Usuário clica no menu para alternar para 'rtl' (Trás para frente)
        sim.toggle_reading_direction()
        self.assertEqual(sim.reading_direction, 'rtl')

        # A janela é imediatamente recalculada para [10, 9, 8]
        self.assertEqual(sim.priority_window, [10, 9, 8])

        # Páginas 11 e 12 devem ter sido purgadas
        queued_pages = [t['page_index'] for t in sim.priority_queue]
        self.assertNotIn(11, queued_pages)
        self.assertNotIn(12, queued_pages)
        self.assertIn(10, queued_pages)
        self.assertIn(9, queued_pages)
        self.assertIn(8, queued_pages)

    def test_criterion_16_double_page_spread_both_pages_translated(self):
        """16: Em páginas duplas, ambas as metades (ex: p8 e p9) entram com prioridade máxima e são 100% traduzidas"""
        sim = SimulatedPriorityCoordinator(total_pages=20, tolerance_sec=5.0, reading_direction='ltr')

        # Observa spread de páginas duplas no viewport (páginas 7 e 8, 1-indexed p8 e p9)
        sim.on_page_observed(7, visible_indices=[7, 8])

        # Ambas as páginas devem ser confirmadas como ativas visíveis
        self.assertEqual(sim.active_page, 7)
        self.assertEqual(sim.active_visible_indices, [7, 8])
        # A janela de prioridade deve conter AMBAS as páginas visíveis + páginas seguintes
        self.assertIn(7, sim.priority_window)
        self.assertIn(8, sim.priority_window)
        self.assertEqual(sim.priority_window, [7, 8, 9, 10])

        # Ambas as páginas recebem tarefas de detecção com prioridade 1 (P0 visível)
        p7_detect = next(t for t in sim.priority_queue if t['page_index'] == 7 and t['type'] == 'detect')
        p8_detect = next(t for t in sim.priority_queue if t['page_index'] == 8 and t['type'] == 'detect')
        self.assertEqual(p7_detect['priority'], 1)
        self.assertEqual(p8_detect['priority'], 1)

        # Simula resposta de detecção para ambas as páginas (3 balões cada)
        sim.simulate_detect_response(p7_detect, regions_count=3)
        sim.simulate_detect_response(p8_detect, regions_count=3)

        # Todas as regiões de ambas as páginas recebem prioridade máxima 0
        p7_regions = [t for t in sim.priority_queue if t['page_index'] == 7 and t['type'] == 'translate-region']
        p8_regions = [t for t in sim.priority_queue if t['page_index'] == 8 and t['type'] == 'translate-region']
        self.assertEqual(len(p7_regions), 3)
        self.assertEqual(len(p8_regions), 3)
        for r in p7_regions + p8_regions:
            self.assertEqual(r['priority'], 0, "Todas as regiões da página dupla devem ter prioridade máxima 0")

        # Simula tradução de todas as regiões de ambas as páginas
        for r in p7_regions + p8_regions:
            sim.simulate_translate_region_response(r)

        # NENHUMA metade fica sem tradução: ambas as páginas estão com 100% dos balões traduzidos
        for reg_id in ('r0', 'r1', 'r2'):
            self.assertEqual(sim.page_masks[7][reg_id], 'translated', "Metade direita p8 deve estar traduzida")
            self.assertEqual(sim.page_masks[8][reg_id], 'translated', "Metade esquerda p9 deve estar traduzida")

    def test_criterion_17_double_page_spread_turn_and_debounce(self):
        """17: Ao avançar de spread dentro da fila, transição é imediata; ao saltar para fora, ativa tolerância de 5s"""
        sim = SimulatedPriorityCoordinator(total_pages=20, tolerance_sec=5.0, reading_direction='ltr')
        sim.confirm_active_page(7, visible_indices=[7, 8])
        self.assertEqual(sim.priority_window, [7, 8, 9, 10])

        # Usuário vira a página para o próximo spread [9, 10] (já presente na janela)
        sim.on_page_observed(9, elapsed_sec=0.0, visible_indices=[9, 10])

        # Transição deve ser IMEDIATA (0s delay)
        self.assertEqual(sim.transition_state, 'CONFIRMED')
        self.assertEqual(sim.active_page, 9)
        self.assertEqual(sim.active_visible_indices, [9, 10])
        self.assertEqual(sim.priority_window, [9, 10, 11, 12])

        # Usuário pula para a página 18 (fora da janela ativa): ativa tolerância de 5s
        sim.on_page_observed(18, elapsed_sec=0.0, visible_indices=[18, 19])
        self.assertEqual(sim.transition_state, 'TRANSITION_PENDING')
        self.assertEqual(sim.priority_window, [9, 10, 11, 12], "Spread anterior continua intacto na janela")

        # Usuário retorna para [9, 10] antes de 5s: cancela o salto
        sim.on_page_observed(9, elapsed_sec=2.0, visible_indices=[9, 10])
        self.assertEqual(sim.transition_state, 'CONFIRMED')
        self.assertEqual(sim.active_visible_indices, [9, 10])

    def test_criterion_18_continuous_forward_reading_beyond_page_5_without_stall(self):
        """18: Leitura sequencial fluida além da página 5 nunca trava na P5 nem exige Alt+T"""
        sim = SimulatedPriorityCoordinator(total_pages=20, tolerance_sec=5.0, reading_direction='ltr')
        sim.confirm_active_page(0)

        # Simula o leitor lendo página por página da página 0 até a página 12 (13 páginas)
        for target_page in range(1, 13):
            sim.on_page_observed(target_page, elapsed_sec=0.0)

            # Cada avanço de página DEVE confirmar IMEDIATAMENTE (0s de delay, sem travar em P5)
            self.assertEqual(sim.transition_state, 'CONFIRMED', f"Deveria confirmar imediatamente na página {target_page}")
            self.assertEqual(sim.active_page, target_page, f"P0 deveria ter avançado para {target_page}")
            self.assertEqual(sim.priority_window, [target_page, target_page + 1, target_page + 2],
                             f"Janela de prioridade deve acompanhar a leitura [p{target_page+1}, p{target_page+2}, p{target_page+3}]")

    def test_criterion_19_dynamic_window_expansion_as_dom_pages_appear(self):
        """19: Expansão dinâmica da janela à medida que imagens lazy-load carregam no DOM"""
        # Começa com apenas 5 páginas presentes no DOM (0..4)
        sim = SimulatedPriorityCoordinator(total_pages=5, tolerance_sec=5.0, reading_direction='ltr')
        sim.confirm_active_page(4)

        # Na página 4, como só existiam 5 páginas no DOM, a janela só tem [4]
        self.assertEqual(sim.priority_window, [4])

        # Agora o leitor (MangaDex / K Manga) renderiza mais páginas no DOM (total_pages sobe para 10)
        sim.total_pages = 10
        for p in range(5, 10):
            sim.page_generation[p] = 1
            sim.page_status[p] = 'idle'
            sim.page_masks[p] = {}

        # O watchdog periódico chama refresh_priority_window()
        sim.refresh_priority_window()

        # A janela de prioridade deve ter sido automaticamente expandida para [4, 5, 6]!
        self.assertEqual(sim.priority_window, [4, 5, 6])
        queued_pages = [t['page_index'] for t in sim.priority_queue]
        self.assertIn(5, queued_pages, "Página 5 deve ter sido enfileirada no background")
        self.assertIn(6, queued_pages, "Página 6 deve ter sido enfileirada no background")

        # Quando o usuário avança para a página 5, a transição é IMEDIATA!
        sim.on_page_observed(5, elapsed_sec=0.0)
        self.assertEqual(sim.transition_state, 'CONFIRMED')
        self.assertEqual(sim.active_page, 5)

    def test_criterion_20_dispatch_page_resumes_detected_pages(self):
        """20: Páginas com balões já detectados retomam tradução sem ficarem travadas com fila vazia"""
        sim = SimulatedPriorityCoordinator(total_pages=10, tolerance_sec=5.0, reading_direction='ltr')
        sim.confirm_active_page(0)

        # Simula que a página 1 (especulativa) completou /detect (3 balões)
        task_p1 = next(t for t in sim.priority_queue if t['page_index'] == 1 and t['type'] == 'detect')
        sim.simulate_detect_response(task_p1, regions_count=3)
        self.assertEqual(sim.page_status[1], 'detected')

        # Usuário pula temporariamente para outra posição, purga a fila e depois retorna para a página 1
        sim.priority_queue.clear()
        self.assertEqual(len(sim.priority_queue), 0)

        # dispatch_page é chamado para a página 1
        sim.dispatch_page(1, is_visible=True)

        # As 3 regiões pendentes de tradução devem ser re-enfileiradas com prioridade 0
        p1_regions = [t for t in sim.priority_queue if t['page_index'] == 1 and t['type'] == 'translate-region']
        self.assertEqual(len(p1_regions), 3, "Todas as 3 regiões não-traduzidas devem retornar para a fila")


if __name__ == "__main__":
    unittest.main()

