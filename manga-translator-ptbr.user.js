// ==UserScript==
// @name         Manga Translator PT-BR
// @namespace    https://github.com/manga-translator-ptbr
// @version      2.2.1
// @description  Traduz balões de mangás em inglês para português brasileiro via backend Python local com janela de 3 páginas, prioridade P0, máscaras imediatas e micro-spinners.
// @author       Senior Front-End Engineer
// @match        https://mangadex.org/*
// @match        https://chapmanganelo.com/*
// @match        https://ww6.manganelo.tv/*
// @match        https://mangakakalot.com/*
// @match        https://kmanga.kodansha.com/*
// @match        *://*/*
// @connect      127.0.0.1
// @connect      localhost
// @connect      cdn.kmanga.kodansha.com
// @connect      *.kodansha.com
// @connect      *
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';

  /* ==========================================================================
     0. INTERCEPTAÇÃO DE CORS EM DOCUMENT-START (SUPORTE A K MANGA & DRM CANVASES)
     ========================================================================== */
  (function installCorsHook() {
    const win = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    if (!win || win.__mt_cors_hook_installed__) return;
    win.__mt_cors_hook_installed__ = true;

    const isKodansha = () => {
      try {
        const host = win.location.hostname || '';
        return host.includes('kmanga') || host.includes('kodansha');
      } catch (e) {
        return false;
      }
    };

    const isTargetImageUrl = (url) => {
      if (typeof url !== 'string' || !url) return false;
      const lower = url.toLowerCase();
      return lower.includes('kmanga.kodansha.com') ||
             lower.includes('kodansha.com') ||
             isKodansha();
    };

    // 1. Hook HTMLImageElement.prototype.src setter
    try {
      const proto = win.HTMLImageElement ? win.HTMLImageElement.prototype : null;
      if (proto) {
        const origSrcDescriptor = Object.getOwnPropertyDescriptor(proto, 'src') ||
          Object.getOwnPropertyDescriptor(win.Element.prototype, 'src');

        if (origSrcDescriptor && origSrcDescriptor.set) {
          Object.defineProperty(proto, 'src', {
            set: function (val) {
              try {
                if (isTargetImageUrl(val) || isKodansha()) {
                  if (!this.crossOrigin) {
                    this.crossOrigin = 'anonymous';
                  }
                }
              } catch (e) {}
              return origSrcDescriptor.set.call(this, val);
            },
            get: function () {
              return origSrcDescriptor.get.call(this);
            },
            configurable: true,
            enumerable: true
          });
        }

        // 2. Hook setAttribute('src', ...)
        const origSetAttribute = proto.setAttribute;
        if (origSetAttribute) {
          proto.setAttribute = function (name, val) {
            if (typeof name === 'string' && name.toLowerCase() === 'src') {
              try {
                if (isTargetImageUrl(val) || isKodansha()) {
                  if (!this.crossOrigin) {
                    this.crossOrigin = 'anonymous';
                  }
                }
              } catch (e) {}
            }
            return origSetAttribute.call(this, name, val);
          };
        }
      }
    } catch (err) {
      console.warn('[MangaTranslator] Erro ao registrar hook em HTMLImageElement:', err);
    }

    // 3. Hook window.Image constructor
    try {
      const OrigImage = win.Image;
      if (OrigImage) {
        const PatchedImage = function (width, height) {
          const img = new OrigImage(width, height);
          try {
            if (isKodansha()) {
              img.crossOrigin = 'anonymous';
            }
          } catch (e) {}
          return img;
        };
        PatchedImage.prototype = OrigImage.prototype;
        win.Image = PatchedImage;
      }
    } catch (err) {
      console.warn('[MangaTranslator] Erro ao registrar hook em window.Image:', err);
    }

    // 4. Hook document.createElement('img')
    try {
      const doc = win.document;
      if (doc && doc.createElement) {
        const origCreateElement = doc.createElement.bind(doc);
        doc.createElement = function (tagName, options) {
          const el = origCreateElement(tagName, options);
          if (el && typeof tagName === 'string' && tagName.toLowerCase() === 'img') {
            if (isKodansha()) {
              try { el.crossOrigin = 'anonymous'; } catch (e) {}
            }
          }
          return el;
        };
      }
    } catch (err) {
      console.warn('[MangaTranslator] Erro ao registrar hook em document.createElement:', err);
    }

    // 5. Hook CanvasRenderingContext2D.prototype.drawImage
    try {
      if (win.CanvasRenderingContext2D && win.CanvasRenderingContext2D.prototype) {
        const origDrawImage = win.CanvasRenderingContext2D.prototype.drawImage;
        win.CanvasRenderingContext2D.prototype.drawImage = function (...args) {
          const result = origDrawImage.apply(this, args);
          try {
            if (this.canvas && this.canvas.width >= 200 && this.canvas.height >= 250) {
              this.canvas.__mt_rendered = true;
            }
          } catch (e) {}
          return result;
        };
      }
    } catch (err) {}
  })();

  /* ==========================================================================
     1. ESTILOS GLOBAIS E INJEÇÃO DE CSS (MÁSCARAS E MICRO-SPINNERS)
     ========================================================================== */

  function injectGlobalStyles() {
    if (document.getElementById('mt-global-styles')) return;
    const style = document.createElement('style');
    style.id = 'mt-global-styles';
    style.textContent = `
      @keyframes mt-spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      .mt-bubble-mask {
        position: absolute;
        background-color: #ffffff !important;
        border-radius: 4px;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.42);
        box-sizing: border-box;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        overflow: hidden;
        pointer-events: none;
        user-select: text;
        transition: background-color 0.25s ease, box-shadow 0.25s ease;
        z-index: 2;
      }
      .mt-bubble-mask.mt-bubble-translated {
        padding: 2px 4px;
        line-height: 1.18;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
        font-weight: 600;
        color: #111111;
        text-align: center;
      }
      .mt-micro-spinner {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        opacity: 0.85;
        animation: mt-spin 0.75s linear infinite;
      }
      .mt-fade-in {
        animation: mt-fade-in-anim 0.22s ease-in forwards;
      }
      @keyframes mt-fade-in-anim {
        from { opacity: 0; transform: scale(0.96); }
        to { opacity: 1; transform: scale(1); }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ==========================================================================
     2. CONFIGURAÇÃO CENTRALIZADA E ESTADO GLOBAL (JANELA DE 3 PÁGINAS)
     ========================================================================== */

  const STORAGE_KEY = 'manga_translator_ptbr_config_v2';

  const DEFAULT_CONFIG = {
    backendDetectUrl: 'http://127.0.0.1:8765/detect',
    backendTranslateRegionUrl: 'http://127.0.0.1:8765/translate-region',
    backendUrl: 'http://127.0.0.1:8765/translate',
    healthCheckUrl: 'http://127.0.0.1:8765/health',
    targetLang: 'pt-BR',
    minImageWidth: 250,
    minImageHeight: 300,
    maxImagesPerChapter: 120,
    maxConcurrentRequests: 2,
    requestDelayMs: 150,
    requestTimeoutMs: 25000,
    windowToleranceMs: 5000,   // Tolerância de 5 segundos para confirmação de P0
    readingDirection: (function() {
      try {
        const host = window.location.hostname || '';
        return (host.includes('kmanga') || host.includes('kodansha')) ? 'rtl' : 'ltr';
      } catch (e) {
        return 'ltr';
      }
    })(),                      // 'ltr' (Normal / Frente) ou 'rtl' (Trás para frente / K Manga)
    autoTranslate: true,
    showTranslations: true,
    boxPaddingPx: 3,          // Margem extra em pixels para cobrir texto original
    fontSizeScale: 1.0,        // Escala de ajuste de fonte (0.6 a 1.8)
    maxRetries: 3,
    retryDelayBaseMs: 1500,
    debug: false
  };

  let savedConfig = {};
  try {
    const raw = typeof GM_getValue === 'function' ? GM_getValue(STORAGE_KEY, null) : null;
    if (raw) savedConfig = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    console.warn('[MangaTranslator] Erro ao recuperar configurações:', e);
  }

  const CONFIG = Object.assign({}, DEFAULT_CONFIG, savedConfig);

  function persistConfig() {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(STORAGE_KEY, JSON.stringify({
          autoTranslate: CONFIG.autoTranslate,
          showTranslations: CONFIG.showTranslations,
          boxPaddingPx: CONFIG.boxPaddingPx,
          fontSizeScale: CONFIG.fontSizeScale,
          readingDirection: CONFIG.readingDirection
        }));
      }
    } catch (e) {
      console.warn('[MangaTranslator] Erro ao salvar configurações:', e);
    }
  }

  // Estado global reativo com Observabilidade Total
  const STATE = {
    backendStatus: 'checking', // 'online' | 'offline' | 'checking'
    isPaused: false,
    activeRequests: 0,

    // Detecção desacoplada do leitor
    readerType: 'generic',        // 'mangadex' | 'kmanga' | 'generic'
    readerCertainty: 'uncertain', // 'confident' | 'fallback' | 'uncertain'
    allPages: [],                 // Array de { index, element, label }

    // Janela de Prioridade e Máquina de Estados de 5 segundos
    activePageIndex: null,        // P0 confirmado
    activePageElement: null,      // Elemento DOM da página P0 confirmada
    activeVisibleIndices: [],     // Índices visíveis simultâneos (ex: [7, 8] em páginas duplas)
    isDoublePage: false,          // Flag indicando modo de página dupla ativo
    candidatePageIndex: null,     // Candidato a P0 durante a tolerância de 5s
    candidateElement: null,       // Elemento da página candidata
    candidateVisibleIndices: [],  // Candidatos visíveis durante o timer de 5s
    previousConfirmedIndex: null, // P0 anterior para rollback em caso de retorno
    transitionState: 'IDLE',      // 'IDLE' | 'TRANSITION_PENDING' | 'CONFIRMED'
    toleranceRemainingSec: 5,     // Contagem regressiva em segundos
    toleranceTimer: null,         // Identificador do temporizador de 5s
    priorityWindow: [],           // Índices de páginas ativas na janela

    // Fila com Prioridade Real e Tokens de Geração
    priorityQueue: [],            // Fila de tarefas ordenadas por nível de prioridade (0..5)
    globalGeneration: 0,          // Contador global de gerações

    // Observabilidade & Métricas
    stats: {
      detectedPages: 0,
      detectedBubbles: 0,
      translatedBubbles: 0,
      pendingBubbles: 0,
      failedBubbles: 0,
      droppedTasks: 0,
      avgDetectionMs: 0,
      avgTranslationMs: 0,
      totalDetectionSamples: 0,
      totalTranslationSamples: 0
    },

    lastError: null,
    renderedImages: new Set(),       // Set<HTMLImageElement | HTMLCanvasElement>
    imageMeta: new WeakMap()         // WeakMap<Element, PageMeta>
  };

  /* ==========================================================================
     3. METADADOS E VALIDAÇÃO DE IMAGENS DO DOM
     ========================================================================== */

  function getElementNaturalDimensions(el) {
    if (!el || !el.tagName) {
      return { naturalWidth: 0, naturalHeight: 0, rect: { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 } };
    }
    const tag = el.tagName.toUpperCase();
    const isImg = tag === 'IMG';
    const rect = el.getBoundingClientRect();
    let natW = 0;
    let natH = 0;

    if (isImg) {
      natW = el.naturalWidth || el.width || 0;
      natH = el.naturalHeight || el.height || 0;
    } else {
      natW = el.width || 0;
      natH = el.height || 0;
    }

    if (!natW || natW <= 0) natW = Math.round(rect.width) || 0;
    if (!natH || natH <= 0) natH = Math.round(rect.height) || 0;

    return { naturalWidth: natW, naturalHeight: natH, rect };
  }

  function getImageMeta(el) {
    let meta = STATE.imageMeta.get(el);
    if (!meta) {
      const isCanvas = (el.tagName || '').toUpperCase() === 'CANVAS';
      meta = {
        id: 'mt-img-' + Math.random().toString(36).substring(2, 9),
        index: null,
        status: 'idle', // 'idle' | 'detecting' | 'detected' | 'translating' | 'done' | 'failed' | 'cancelled'
        generationToken: 1,
        retries: 0,
        src: el.currentSrc || el.src || (isCanvas ? 'canvas-source' : ''),
        backendPageId: null,
        container: null,
        regions: [],
        regionBoxes: {}, // Map<region_id, HTMLElement>
        resizeObserver: null,
        originalDimensions: { width: 0, height: 0 }
      };
      STATE.imageMeta.set(el, meta);
    }
    return meta;
  }

  function isValidMangaElement(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toUpperCase();
    if (tag !== 'IMG' && tag !== 'CANVAS') return false;

    // Ignora elementos da própria UI do script
    if (el.closest('#mt-panel-root') || el.closest('#mt-overlay-root')) return false;

    const isImg = tag === 'IMG';
    const src = isImg ? (el.currentSrc || el.src || '') : 'canvas-element';
    if (isImg && (!src || src.startsWith('data:image/svg'))) return false;

    const { naturalWidth: naturalW, naturalHeight: naturalH } = getElementNaturalDimensions(el);
    if (naturalW === 0 && naturalH === 0) return false;

    if (naturalW < CONFIG.minImageWidth || naturalH < CONFIG.minImageHeight) {
      return false;
    }

    const ratio = naturalW / naturalH;
    if (ratio > 3.2 || ratio < 0.15) {
      return false;
    }

    const classIdStr = `${el.className || ''} ${el.id || ''} ${el.parentElement ? (el.parentElement.className || '') : ''}`.toLowerCase();
    const blacklist = ['avatar', 'thumb', 'logo', 'icon', 'banner', 'ad-', 'advert', 'sponsor', 'badge', 'widget', 'comment', 'promo'];
    for (const term of blacklist) {
      if (classIdStr.includes(term)) return false;
    }

    const srcLower = src.toLowerCase();
    const adKeywords = ['/ads/', '/ad/', 'ads_', 'advert', 'banner', 'pixel', 'tracking', 'promo_'];
    for (const kw of adKeywords) {
      if (srcLower.includes(kw)) return false;
    }

    return true;
  }

  async function getImageDataUrl(el) {
    return new Promise((resolve, reject) => {
      const tag = (el.tagName || '').toUpperCase();

      if (tag === 'CANVAS') {
        try {
          const dataUrl = el.toDataURL('image/jpeg', 0.88);
          return resolve(dataUrl);
        } catch (e) {
          const isTainted = e.message && e.message.includes('Tainted');
          const errMsg = isTainted
            ? 'Canvas em cache sem CORS. Pressione Ctrl+F5 para recarregar sem cache.'
            : 'Canvas protegido: ' + e.message;
          return reject(new Error(errMsg));
        }
      }

      try {
        const { naturalWidth: naturalW, naturalHeight: naturalH } = getElementNaturalDimensions(el);
        if (!naturalW || !naturalH) {
          throw new Error('Dimensões naturais da imagem indisponíveis.');
        }

        const canvas = document.createElement('canvas');
        canvas.width = naturalW;
        canvas.height = naturalH;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(el, 0, 0, naturalW, naturalH);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
        canvas.width = 0;
        canvas.height = 0;
        return resolve(dataUrl);
      } catch (canvasErr) {
        const src = el.currentSrc || el.src;
        if (!src) {
          return reject(new Error('Atributo src/currentSrc inexistente na imagem.'));
        }

        GM_xmlhttpRequest({
          method: 'GET',
          url: src,
          responseType: 'blob',
          timeout: CONFIG.requestTimeoutMs,
          onload: function (res) {
            if (res.status >= 200 && res.status < 300 && res.response) {
              const reader = new FileReader();
              reader.onloadend = function () {
                resolve(reader.result);
              };
              reader.onerror = function () {
                reject(new Error('Falha ao converter Blob da imagem para Base64 DataURL.'));
              };
              reader.readAsDataURL(res.response);
            } else {
              reject(new Error(`Falha HTTP (${res.status}) ao obter imagem no fallback.`));
            }
          },
          onerror: function () {
            reject(new Error('Erro de rede ao baixar imagem via GM_xmlhttpRequest.'));
          },
          ontimeout: function () {
            reject(new Error('Tempo limite excedido ao obter imagem no fallback.'));
          }
        });
      }
    });
  }

  /* ==========================================================================
     4. MOTOR DE POSICIONAMENTO RESPONSIVO E MÁSCARAS IMEDIATAS (OVERLAYS)
     ========================================================================== */

  let overlayRoot = null;

  function ensureOverlayRoot() {
    if (!document.body) return null;
    if (!overlayRoot || !document.body.contains(overlayRoot)) {
      overlayRoot = document.getElementById('mt-overlay-root');
      if (!overlayRoot) {
        overlayRoot = document.createElement('div');
        overlayRoot.id = 'mt-overlay-root';
        overlayRoot.style.cssText = `
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          pointer-events: none;
          z-index: 2147483640;
          overflow: hidden;
        `;
        document.body.appendChild(overlayRoot);
      }
    }
    return overlayRoot;
  }

  function getImageContentRect(img) {
    const { naturalWidth, naturalHeight, rect } = getElementNaturalDimensions(img);

    let style = null;
    try {
      style = window.getComputedStyle(img);
    } catch (e) {}

    const objectFit = style ? (style.objectFit || 'fill') : 'fill';

    let contentWidth = rect.width;
    let contentHeight = rect.height;
    let contentLeft = rect.left;
    let contentTop = rect.top;

    if ((objectFit === 'contain' || objectFit === 'scale-down') &&
        rect.width > 0 && rect.height > 0 && naturalWidth > 0 && naturalHeight > 0) {
      const imgRatio = naturalWidth / naturalHeight;
      const boxRatio = rect.width / rect.height;
      if (imgRatio > boxRatio) {
        contentHeight = rect.width / imgRatio;
        contentTop += (rect.height - contentHeight) / 2;
      } else {
        contentWidth = rect.height * imgRatio;
        contentLeft += (rect.width - contentWidth) / 2;
      }
    }

    const paddingLeft = style ? (parseFloat(style.paddingLeft) || 0) : 0;
    const paddingTop = style ? (parseFloat(style.paddingTop) || 0) : 0;

    return {
      left: Math.round(contentLeft + paddingLeft),
      top: Math.round(contentTop + paddingTop),
      width: Math.max(0, Math.round(contentWidth)),
      height: Math.max(0, Math.round(contentHeight))
    };
  }

  function updateContainerPosition(img, container) {
    if (!img.isConnected || !container) return;

    const contentRect = getImageContentRect(img);

    if (contentRect.width < 80 || contentRect.height < 80) {
      container.style.display = 'none';
      return;
    }

    const inViewport = (
      contentRect.top + contentRect.height > 10 &&
      contentRect.top < window.innerHeight - 10 &&
      contentRect.left + contentRect.width > 10 &&
      contentRect.left < window.innerWidth - 10
    );

    if (!inViewport || !CONFIG.showTranslations) {
      container.style.display = 'none';
      return;
    }

    container.style.display = 'block';
    container.style.left = `${contentRect.left}px`;
    container.style.top = `${contentRect.top}px`;
    container.style.width = `${contentRect.width}px`;
    container.style.height = `${contentRect.height}px`;

    const pad = CONFIG.boxPaddingPx;

    const boxes = container.querySelectorAll('.mt-bubble-mask');
    boxes.forEach(box => {
      const normX = parseFloat(box.dataset.normX) || 0;
      const normY = parseFloat(box.dataset.normY) || 0;
      const normW = parseFloat(box.dataset.normW) || 100;
      const normH = parseFloat(box.dataset.normH) || 100;

      const pixelX = Math.round((normX / 1000) * contentRect.width);
      const pixelY = Math.round((normY / 1000) * contentRect.height);
      const pixelW = Math.max(34, Math.round((normW / 1000) * contentRect.width) + pad * 2);
      const pixelH = Math.max(22, Math.round((normH / 1000) * contentRect.height) + pad * 2);

      box.style.left = `${pixelX - pad}px`;
      box.style.top = `${pixelY - pad}px`;
      box.style.width = `${pixelW}px`;
      box.style.height = `${pixelH}px`;

      if (box.classList.contains('mt-bubble-translated')) {
        adjustBoxFontSize(box, contentRect.width, contentRect.height);
      }
    });
  }

  function adjustBoxFontSize(box, containerW, containerH) {
    const normW = parseFloat(box.dataset.normW) || 100;
    const normH = parseFloat(box.dataset.normH) || 100;
    const text = box.dataset.text || '';
    const textLen = Math.max(text.length, 1);

    const pixelW = Math.max(34, (normW / 1000) * containerW);
    const pixelH = Math.max(22, (normH / 1000) * containerH);

    const area = pixelW * pixelH;
    let estimatedSize = Math.sqrt((area * 0.65) / textLen);
    const maxByHeight = pixelH * 0.65;

    const words = text.split(/\s+/);
    const longestWordLen = Math.max(...words.map(w => w.length), 1);
    const maxByWordWidth = (pixelW * 0.95) / (longestWordLen * 0.58);

    let targetSize = Math.min(estimatedSize, maxByHeight, maxByWordWidth);
    targetSize = Math.max(9, Math.min(targetSize, 34));
    const finalSize = Math.max(9, Math.round(targetSize * CONFIG.fontSizeScale));

    box.style.fontSize = `${finalSize}px`;
  }

  function createMicroSpinner() {
    const spinner = document.createElement('span');
    spinner.className = 'mt-micro-spinner';
    spinner.setAttribute('aria-label', 'Traduzindo...');

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '9');
    circle.setAttribute('stroke', '#94a3b8');
    circle.setAttribute('stroke-width', '2.5');
    circle.setAttribute('opacity', '0.35');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M12 3a9 9 0 0 1 9 9');
    path.setAttribute('stroke', '#0284c7');
    path.setAttribute('stroke-width', '2.5');
    path.setAttribute('stroke-linecap', 'round');

    svg.appendChild(circle);
    svg.appendChild(path);
    spinner.appendChild(svg);
    return spinner;
  }

  /**
   * Renderiza IMEDIATAMENTE as máscaras brancas com micro-spinners sobre os balões detectados.
   * Cobre o texto original logo no término do OCR, fornecendo feedback tátil e instantâneo.
   */
  function renderBubbleMasks(img, regions) {
    const meta = getImageMeta(img);

    if (meta.container && meta.container.parentNode) {
      meta.container.parentNode.removeChild(meta.container);
    }

    const root = ensureOverlayRoot();
    if (!root) return;

    const container = document.createElement('div');
    container.className = 'mt-image-overlay';
    container.id = meta.id;
    container.__targetImg = img;
    container.style.cssText = `
      position: absolute;
      pointer-events: none;
      overflow: hidden;
      display: none;
    `;

    meta.container = container;
    meta.regionBoxes = {};

    regions.forEach(reg => {
      const [normX, normY, normW, normH] = reg.box;

      const boxElem = document.createElement('div');
      boxElem.className = 'mt-bubble-mask';
      boxElem.dataset.normX = normX;
      boxElem.dataset.normY = normY;
      boxElem.dataset.normW = normW;
      boxElem.dataset.normH = normH;
      boxElem.dataset.regionId = reg.region_id;
      boxElem.dataset.sourceText = reg.source_text;
      boxElem.dataset.status = 'queued';

      // Micro-spinner SVG criado via DOM (100% imune a TrustedHTML e CSP restritivo do MangaDex)
      const spinner = createMicroSpinner();
      boxElem.appendChild(spinner);

      container.appendChild(boxElem);
      meta.regionBoxes[reg.region_id] = boxElem;
    });

    root.appendChild(container);
    STATE.renderedImages.add(img);

    updateContainerPosition(img, container);

    if (window.ResizeObserver && !meta.resizeObserver) {
      meta.resizeObserver = new ResizeObserver(() => {
        updateContainerPosition(img, container);
      });
      try { meta.resizeObserver.observe(img); } catch (e) {}
      if (img.parentElement) {
        try { meta.resizeObserver.observe(img.parentElement); } catch (e) {}
      }
    }
  }

  /**
   * Substitui APENAS o micro-spinner do balão individual pelo texto traduzido final
   * com animação suave de fade-in assim que a resposta daquele balão específico chega.
   */
  function updateBubbleWithTranslation(img, regionId, translatedText) {
    const meta = getImageMeta(img);
    if (!meta || !meta.regionBoxes) return;

    const boxElem = meta.regionBoxes[regionId];
    if (!boxElem) return;

    // Remove micro-spinner
    boxElem.textContent = '';
    boxElem.classList.add('mt-bubble-translated', 'mt-fade-in');
    boxElem.dataset.status = 'translated';
    boxElem.dataset.text = translatedText;

    const span = document.createElement('span');
    span.textContent = translatedText;
    span.style.maxWidth = '100%';
    boxElem.appendChild(span);

    const contentRect = getImageContentRect(img);
    adjustBoxFontSize(boxElem, contentRect.width, contentRect.height);
  }

  let layoutUpdateTimer = null;
  function handleLayoutUpdate() {
    if (layoutUpdateTimer) return;
    layoutUpdateTimer = setTimeout(() => {
      layoutUpdateTimer = null;
      STATE.renderedImages.forEach(img => {
        if (!img.isConnected) {
          const meta = STATE.imageMeta.get(img);
          if (meta && meta.container && meta.container.parentNode) {
            meta.container.parentNode.removeChild(meta.container);
          }
          STATE.renderedImages.delete(img);
          return;
        }
        const meta = STATE.imageMeta.get(img);
        if (meta && meta.container) {
          updateContainerPosition(img, meta.container);
        }
      });
    }, 40);
  }

  window.addEventListener('scroll', handleLayoutUpdate, { passive: true, capture: true });
  window.addEventListener('resize', handleLayoutUpdate, { passive: true });

  /* ==========================================================================
     5. COMUNICAÇÃO PROGRESSIVA COM O BACKEND PYTHON LOCAL
     ========================================================================== */

  function checkBackendHealth() {
    STATE.backendStatus = 'checking';
    updateUiPanel();

    if (typeof GM_xmlhttpRequest !== 'function') {
      STATE.backendStatus = 'offline';
      updateUiPanel();
      return;
    }

    GM_xmlhttpRequest({
      method: 'GET',
      url: CONFIG.healthCheckUrl,
      timeout: 5000,
      onload: function (res) {
        if (res.status >= 200 && res.status < 300) {
          STATE.backendStatus = 'online';
        } else {
          STATE.backendStatus = 'offline';
        }
        updateUiPanel();
      },
      onerror: function () {
        STATE.backendStatus = 'offline';
        updateUiPanel();
      },
      ontimeout: function () {
        STATE.backendStatus = 'offline';
        updateUiPanel();
      }
    });
  }

  /**
   * Etapa 1: POST /detect
   * Envia a imagem e recebe os balões detectados imediatamente
   */
  function sendDetectRequest(dataUrl) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ image: dataUrl });

      GM_xmlhttpRequest({
        method: 'POST',
        url: CONFIG.backendDetectUrl,
        headers: { 'Content-Type': 'application/json' },
        data: payload,
        timeout: CONFIG.requestTimeoutMs,
        onload: function (res) {
          if (res.status >= 200 && res.status < 300) {
            try {
              const data = JSON.parse(res.responseText);
              resolve(data);
            } catch (err) {
              reject(new Error(`JSON inválido no /detect: ${err.message}`));
            }
          } else {
            reject(new Error(`POST /detect HTTP ${res.status}: ${res.responseText.substring(0, 80)}`));
          }
        },
        onerror: () => reject(new Error('Falha de conexão no POST /detect.')),
        ontimeout: () => reject(new Error('Timeout de requisição no POST /detect.'))
      });
    });
  }

  /**
   * Etapa 2: POST /translate-region
   * Traduz um balão individual progressivamente
   */
  function sendTranslateRegionRequest(pageId, regionId, text) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        page_id: pageId,
        region_id: regionId,
        text: text,
        target_lang: CONFIG.targetLang
      });

      GM_xmlhttpRequest({
        method: 'POST',
        url: CONFIG.backendTranslateRegionUrl,
        headers: { 'Content-Type': 'application/json' },
        data: payload,
        timeout: CONFIG.requestTimeoutMs,
        onload: function (res) {
          if (res.status >= 200 && res.status < 300) {
            try {
              const data = JSON.parse(res.responseText);
              resolve(data);
            } catch (err) {
              reject(new Error(`JSON inválido no /translate-region: ${err.message}`));
            }
          } else {
            reject(new Error(`POST /translate-region HTTP ${res.status}: ${res.responseText.substring(0, 80)}`));
          }
        },
        onerror: () => reject(new Error('Falha de conexão no POST /translate-region.')),
        ontimeout: () => reject(new Error('Timeout de requisição no POST /translate-region.'))
      });
    });
  }

  /* ==========================================================================
     6. ADAPTADOR DE LEITORES DESACOPLADO (READER ADAPTER)
     ========================================================================== */

  const ReaderAdapter = {
    detectReaderType() {
      const host = window.location.hostname || '';
      if (host.includes('mangadex.org')) return 'mangadex';
      if (host.includes('kmanga') || host.includes('kodansha')) return 'kmanga';
      return 'generic';
    },

    getAllPages() {
      const type = this.detectReaderType();
      STATE.readerType = type;
      let elements = [];

      if (type === 'mangadex') {
        const query = '.reader--page img, .viewer-page img, [data-page] img, .reader--container img';
        elements = Array.from(document.querySelectorAll(query)).filter(isValidMangaElement);
      } else if (type === 'kmanga') {
        const query = '.swiper-slide canvas, #reader-container canvas, canvas';
        elements = Array.from(document.querySelectorAll(query)).filter(isValidMangaElement);
      }

      // Fallback genérico para qualquer leitor
      if (elements.length === 0) {
        elements = Array.from(document.querySelectorAll('img, canvas')).filter(isValidMangaElement);
      }

      if (type === 'kmanga' || type === 'mangadex') {
        // Para Swiper e leitores baseados em slides, a ordem na árvore do DOM é canônica e imune a CSS transforms
        elements.sort((a, b) => {
          if (a.compareDocumentPosition) {
            return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
          }
          return 0;
        });
      } else {
        // Ordenação geométrica segura para leitores de rolagem vertical/livre
        elements.sort((a, b) => {
          const rA = a.getBoundingClientRect();
          const rB = b.getBoundingClientRect();
          const topDiff = (rA.top + window.scrollY) - (rB.top + window.scrollY);
          if (Math.abs(topDiff) > 50) return topDiff;
          return (rA.left + window.scrollX) - (rB.left + window.scrollX);
        });
      }

      const pages = elements.map((el, idx) => {
        const meta = getImageMeta(el);
        meta.index = idx;
        return { index: idx, element: el, label: `Página ${idx + 1}` };
      });

      STATE.allPages = pages;
      STATE.stats.detectedPages = pages.length;
      return pages;
    },

    detectVisiblePages(pages) {
      if (!pages || pages.length === 0) return [];
      const viewW = window.innerWidth;
      const viewH = window.innerHeight;
      const visible = [];

      for (const page of pages) {
        if (!page.element || !page.element.isConnected) continue;
        const rect = page.element.getBoundingClientRect();
        const visibleW = Math.max(0, Math.min(rect.right, viewW) - Math.max(rect.left, 0));
        const visibleH = Math.max(0, Math.min(rect.bottom, viewH) - Math.max(rect.top, 0));
        const visibleArea = visibleW * visibleH;

        const totalArea = Math.max(1, rect.width * rect.height);
        const visibleRatio = visibleArea / totalArea;

        // Critério seguro para página visível na tela (individual ou dupla)
        const isCenterFocused = rect.top <= viewH * 0.58 && rect.bottom >= viewH * 0.42 && visibleW >= 100;

        if (isCenterFocused ||
            (visibleArea >= 35000 && visibleW >= 120 && visibleH >= 150) ||
            (visibleRatio >= 0.20 && visibleArea >= 20000 && visibleW >= 100)) {
          visible.push({
            page,
            index: page.index,
            element: page.element,
            visibleArea,
            rect
          });
        }
      }

      visible.sort((a, b) => a.index - b.index);
      return visible;
    },

    detectActivePageCandidate(pages) {
      if (!pages || pages.length === 0) {
        return { candidateIndex: null, element: null, visibleIndices: [], isDoublePage: false, certainty: 'uncertain' };
      }

      const visibleList = this.detectVisiblePages(pages);
      const visibleIndices = visibleList.map(v => v.index);
      const type = STATE.readerType;

      if (visibleList.length > 0) {
        let primaryPage = null;

        // 1. Prioriza match com slide/container explicitamente ativo
        if (type === 'kmanga') {
          const activeSlideCanvas = document.querySelector('.swiper-slide-active canvas, .swiper-slide-duplicate-active canvas');
          if (activeSlideCanvas) {
            const match = visibleList.find(v => v.element === activeSlideCanvas);
            if (match) primaryPage = match.page;
          }
        } else if (type === 'mangadex') {
          const activeContainer = document.querySelector('.reader--page[data-active="true"] img, .viewer-page.active img');
          if (activeContainer) {
            const match = visibleList.find(v => v.element === activeContainer);
            if (match) primaryPage = match.page;
          }
        }

        // 2. Fallback: seleciona a página no centro do viewport ou de maior área visível
        if (!primaryPage) {
          const centerY = window.innerHeight / 2;
          const sortedByCenter = [...visibleList].sort((a, b) => {
            const centerA = (a.rect.top + a.rect.bottom) / 2;
            const centerB = (b.rect.top + b.rect.bottom) / 2;
            const distA = Math.abs(centerA - centerY);
            const distB = Math.abs(centerB - centerY);
            if (Math.abs(distA - distB) > 70) return distA - distB;
            return b.visibleArea - a.visibleArea;
          });
          primaryPage = sortedByCenter[0].page;
        }

        return {
          candidateIndex: primaryPage.index,
          element: primaryPage.element,
          visibleIndices: visibleIndices,
          isDoublePage: visibleIndices.length > 1,
          certainty: 'confident'
        };
      }

      // Fallback secundário se bounding rect estiver transitório durante animação
      if (type === 'kmanga') {
        const activeSlideCanvas = document.querySelector('.swiper-slide-active canvas, .swiper-slide-duplicate-active canvas');
        if (activeSlideCanvas && isValidMangaElement(activeSlideCanvas)) {
          const found = pages.find(p => p.element === activeSlideCanvas);
          if (found) {
            return {
              candidateIndex: found.index,
              element: found.element,
              visibleIndices: [found.index],
              isDoublePage: false,
              certainty: 'confident'
            };
          }
        }
      }

      return { candidateIndex: null, element: null, visibleIndices: [], isDoublePage: false, certainty: 'uncertain' };
    }
  };

  /* ==========================================================================
     7. COORDENADOR DE PRIORIDADES E MÁQUINA DE ESTADOS (TOLERÂNCIA DE 5S)
     ========================================================================== */

  const PriorityCoordinator = {
    onPageCandidateObserved(candidateIndex, element, certainty, visibleIndices) {
      STATE.readerCertainty = certainty;

      if (candidateIndex === null || certainty === 'uncertain') {
        updateUiPanel();
        return;
      }

      const visible = (Array.isArray(visibleIndices) && visibleIndices.length > 0)
        ? visibleIndices
        : [candidateIndex];

      const allVisibleConfirmed = visible.every(idx => STATE.activeVisibleIndices && STATE.activeVisibleIndices.includes(idx));
      const isSameElement = !STATE.activePageElement || STATE.activePageElement === element;

      // Se a página já for P0 atualmente confirmada e o elemento é idêntico
      if (candidateIndex === STATE.activePageIndex && allVisibleConfirmed && isSameElement) {
        if (STATE.transitionState === 'TRANSITION_PENDING') {
          this.cancelCandidateTransition();
        }
        // Atualiza a janela se novas páginas (P1, P2) foram inseridas no DOM
        this.refreshPriorityWindow();
        return;
      }

      // CRITÉRIO DE TRANSIÇÃO IMEDIATA (0 segundos de espera):
      // Leitura fluida sem pausas:
      // 1. Primeira confirmação do leitor (activePageIndex === null)
      // 2. A página visível já está dentro da janela ativa de prioridade
      // 3. Progressão de leitura sequencial natural:
      //    - Fluxo Normal (LTR): avançou até +2 páginas em relação à confirmada atual ou recuou 1 página (releitura)
      //    - Fluxo Trás p/ Frente (RTL): avançou até -2 páginas ou recuou 1 página (+1)
      const isRTL = CONFIG.readingDirection === 'rtl';
      const curP0 = STATE.activePageIndex;

      const isWithinCurrentWindow = STATE.priorityWindow.length > 0 &&
        visible.some(idx => STATE.priorityWindow.includes(idx));

      let isNaturalSequentialReading = false;
      if (curP0 !== null) {
        if (!isRTL) {
          isNaturalSequentialReading = (candidateIndex >= curP0 - 1 && candidateIndex <= curP0 + 2);
        } else {
          isNaturalSequentialReading = (candidateIndex <= curP0 + 1 && candidateIndex >= curP0 - 2);
        }
      }

      if (isWithinCurrentWindow || isNaturalSequentialReading || curP0 === null) {
        if (STATE.transitionState === 'TRANSITION_PENDING') {
          this.cancelCandidateTransition();
        }
        this.confirmActivePage(candidateIndex, element, visible);
        return;
      }

      // SALTO DISTANTE (ex: pulou mais de 2 páginas fora da janela ativa):
      // Ativa a tolerância de 5 segundos para proteger as páginas anteriores
      if (STATE.transitionState === 'TRANSITION_PENDING') {
        // Usuário retornou para a janela ativa ou posição anterior antes dos 5s
        if (visible.some(idx => STATE.priorityWindow.includes(idx)) || candidateIndex === STATE.previousConfirmedIndex) {
          if (CONFIG.debug) console.log('[Coordinator] Retorno detectado antes dos 5s: cancelando salto.');
          this.cancelCandidateTransition();
          this.confirmActivePage(candidateIndex, element, visible);
          return;
        }

        // Usuário continuou navegando para outra página distante: reinicia o timer de 5s
        if (candidateIndex !== STATE.candidatePageIndex) {
          if (CONFIG.debug) console.log(`[Coordinator] Salto continuou para p${candidateIndex + 1}: reiniciando tolerância de 5s.`);
          this.resetCandidateTimer(candidateIndex, element, visible);
          return;
        }

        return;
      }

      // Primeiro avistamento de um salto distante: ativa os 5 segundos
      if (CONFIG.debug) {
        console.log(`[Coordinator] Salto distante fora da janela ativa detectado para p${candidateIndex + 1}: ativando tolerância de 5s.`);
      }
      this.startToleranceTimer(candidateIndex, element, visible);
    },

    startToleranceTimer(candidateIndex, element, visibleIndices) {
      this.clearToleranceTimer();

      STATE.candidatePageIndex = candidateIndex;
      STATE.candidateElement = element;
      STATE.candidateVisibleIndices = visibleIndices || [candidateIndex];
      STATE.transitionState = 'TRANSITION_PENDING';
      STATE.toleranceRemainingSec = 5;

      updateUiPanel();

      STATE.toleranceTimer = setInterval(() => {
        STATE.toleranceRemainingSec--;
        if (STATE.toleranceRemainingSec <= 0) {
          this.clearToleranceTimer();
          this.confirmActivePage(STATE.candidatePageIndex, STATE.candidateElement, STATE.candidateVisibleIndices);
        } else {
          updateUiPanel();
        }
      }, 1000);
    },

    resetCandidateTimer(candidateIndex, element, visibleIndices) {
      this.startToleranceTimer(candidateIndex, element, visibleIndices);
    },

    clearToleranceTimer() {
      if (STATE.toleranceTimer) {
        clearInterval(STATE.toleranceTimer);
        STATE.toleranceTimer = null;
      }
    },

    cancelCandidateTransition() {
      this.clearToleranceTimer();
      STATE.candidatePageIndex = null;
      STATE.candidateElement = null;
      STATE.candidateVisibleIndices = [];
      STATE.transitionState = STATE.activePageIndex !== null ? 'CONFIRMED' : 'IDLE';
      updateUiPanel();
    },

    revertToPreviousConfirmed() {
      if (STATE.previousConfirmedIndex !== null) {
        const pages = STATE.allPages;
        const page = pages[STATE.previousConfirmedIndex];
        if (page) {
          this.confirmActivePage(page.index, page.element);
        }
      }
    },

    /**
     * Confirmação definitiva de P0 e páginas visíveis (com suporte a páginas duplas):
     * 1. Estabelece a janela de prioridade contendo TODAS as páginas visíveis (P0) + especulativas (P1, P2).
     * 2. Descarta e invalida todas as tarefas fora da janela.
     * 3. Dispara todas as páginas visíveis com prioridade máxima imediata.
     */
    confirmActivePage(pageIndex, element, visibleIndices) {
      this.clearToleranceTimer();

      STATE.transitionState = 'CONFIRMED';
      STATE.previousConfirmedIndex = STATE.activePageIndex;
      STATE.activePageIndex = pageIndex;
      STATE.activePageElement = element || (STATE.allPages[pageIndex] ? STATE.allPages[pageIndex].element : null);
      STATE.candidatePageIndex = null;
      STATE.candidateElement = null;
      STATE.candidateVisibleIndices = [];

      const pages = STATE.allPages;
      const isRTL = CONFIG.readingDirection === 'rtl';

      // 1. Identifica todas as páginas atualmente visíveis no viewport
      let visible = (Array.isArray(visibleIndices) && visibleIndices.length > 0)
        ? [...visibleIndices]
        : (ReaderAdapter.detectVisiblePages ? ReaderAdapter.detectVisiblePages(pages).map(p => p.index) : [pageIndex]);

      if (!visible.includes(pageIndex)) {
        visible.push(pageIndex);
      }
      visible.sort((a, b) => a - b);
      STATE.activeVisibleIndices = visible;
      STATE.isDoublePage = visible.length > 1;

      // 2. Constrói a janela de prioridade: TODAS as páginas visíveis com P0 prioritário + especulativas (P1, P2)
      let priorityWindow = [...visible];

      if (isRTL) {
        const minIdx = Math.min(...visible);
        const P1 = (minIdx - 1 >= 0 && minIdx - 1 < pages.length) ? minIdx - 1 : null;
        const P2 = (minIdx - 2 >= 0 && minIdx - 2 < pages.length) ? minIdx - 2 : null;
        if (P1 !== null && !priorityWindow.includes(P1)) priorityWindow.push(P1);
        if (P2 !== null && !priorityWindow.includes(P2)) priorityWindow.push(P2);
      } else {
        const maxIdx = Math.max(...visible);
        const P1 = (maxIdx + 1 < pages.length) ? maxIdx + 1 : null;
        const P2 = (maxIdx + 2 < pages.length) ? maxIdx + 2 : null;
        if (P1 !== null && !priorityWindow.includes(P1)) priorityWindow.push(P1);
        if (P2 !== null && !priorityWindow.includes(P2)) priorityWindow.push(P2);
      }

      STATE.priorityWindow = priorityWindow;

      if (CONFIG.debug) {
        const dirLabel = isRTL ? 'RTL (Trás p/ Frente)' : 'LTR (Normal)';
        const doubleLabel = STATE.isDoublePage ? ` | PÁGINA DUPLA [${visible.map(i => i + 1).join(', ')}]` : '';
        console.log(`[Coordinator] Confirmado: p${pageIndex + 1} (${dirLabel})${doubleLabel} | Janela: [${STATE.priorityWindow.map(i => i + 1).join(', ')}]`);
      }

      // 3. Purga e invalidação estrita de tarefas fora da janela ativa
      PriorityTaskQueue.purgeOutOfWindowTasks(STATE.priorityWindow);

      // 4. Invalida tokens de geração de páginas fora da janela
      pages.forEach((p, idx) => {
        if (!STATE.priorityWindow.includes(idx)) {
          const meta = STATE.imageMeta.get(p.element);
          if (meta) {
            meta.generationToken++;
            if (meta.status === 'pending' || meta.status === 'detecting') {
              meta.status = 'cancelled';
            }
          }
        }
      });

      // 5. Enfileira TODAS as páginas visíveis com Alta Prioridade (P0)
      visible.forEach(idx => {
        this.dispatchPage(idx, true);
      });

      // 6. Enfileira páginas especulativas (P1, P2)
      priorityWindow.forEach(idx => {
        if (!visible.includes(idx)) {
          this.dispatchPage(idx, false);
        }
      });

      updateUiPanel();
      PriorityTaskQueue.processQueue();
    },

    refreshPriorityWindow() {
      if (STATE.activePageIndex === null) return;
      const pages = STATE.allPages;
      if (!pages || pages.length === 0) return;

      const isRTL = CONFIG.readingDirection === 'rtl';
      const visible = (STATE.activeVisibleIndices && STATE.activeVisibleIndices.length > 0)
        ? STATE.activeVisibleIndices
        : [STATE.activePageIndex];

      let targetWindow = [...visible];
      if (isRTL) {
        const minIdx = Math.min(...visible);
        const P1 = (minIdx - 1 >= 0 && minIdx - 1 < pages.length) ? minIdx - 1 : null;
        const P2 = (minIdx - 2 >= 0 && minIdx - 2 < pages.length) ? minIdx - 2 : null;
        if (P1 !== null && !targetWindow.includes(P1)) targetWindow.push(P1);
        if (P2 !== null && !targetWindow.includes(P2)) targetWindow.push(P2);
      } else {
        const maxIdx = Math.max(...visible);
        const P1 = (maxIdx + 1 < pages.length) ? maxIdx + 1 : null;
        const P2 = (maxIdx + 2 < pages.length) ? maxIdx + 2 : null;
        if (P1 !== null && !targetWindow.includes(P1)) targetWindow.push(P1);
        if (P2 !== null && !targetWindow.includes(P2)) targetWindow.push(P2);
      }

      const currentWindow = STATE.priorityWindow || [];
      const hasNew = targetWindow.some(idx => !currentWindow.includes(idx));
      if (hasNew || currentWindow.length !== targetWindow.length) {
        STATE.priorityWindow = targetWindow;
        targetWindow.forEach(idx => {
          this.dispatchPage(idx, visible.includes(idx));
        });
        updateUiPanel();
        PriorityTaskQueue.processQueue();
      }
    },

    dispatchPage(pageIndex, isVisible) {
      const pages = STATE.allPages;
      if (pageIndex < 0 || pageIndex >= pages.length) return;

      const page = pages[pageIndex];
      if (!page || !page.element) return;
      const meta = getImageMeta(page.element);

      // Se já traduzido com sucesso, garante overlays visíveis
      if (meta.status === 'done') {
        if (meta.container) updateContainerPosition(page.element, meta.container);
        return;
      }

      // Prioridade: páginas visíveis recebem 1 (P0 detecção), especulativas recebem 3 (P1) ou 5 (P2)
      let detectPriority = 1;
      let regionPriority = 0;
      if (!isVisible) {
        const specIndex = STATE.priorityWindow.filter(idx => !STATE.activeVisibleIndices.includes(idx)).indexOf(pageIndex);
        detectPriority = specIndex === 0 ? 3 : 5;
        regionPriority = specIndex === 0 ? 2 : 4;
      }

      // Caso 1: Página nova ou cancelada: enfileira para detecção OCR
      if (meta.status === 'idle' || meta.status === 'cancelled') {
        meta.status = 'pending';
        PriorityTaskQueue.enqueue({
          id: `det-${meta.id}-${meta.generationToken}`,
          type: 'detect',
          pageIndex: pageIndex,
          element: page.element,
          priority: detectPriority,
          generationToken: meta.generationToken,
          createdAt: Date.now()
        });
        return;
      }

      // Caso 2: Balões já foram detectados: garante máscaras e enfileira balões não traduzidos
      if (meta.status === 'detected' && Array.isArray(meta.regions) && meta.regions.length > 0) {
        renderBubbleMasks(page.element, meta.regions);

        let queuedCount = 0;
        meta.regions.forEach(reg => {
          const box = meta.regionBoxes ? meta.regionBoxes[reg.region_id] : null;
          const isTranslated = box && box.dataset.status === 'translated';
          const alreadyInQueue = STATE.priorityQueue.some(t =>
            t.pageIndex === pageIndex && t.region && t.region.region_id === reg.region_id
          );

          if (!isTranslated && !alreadyInQueue) {
            queuedCount++;
            PriorityTaskQueue.enqueue({
              id: `reg-${meta.id}-${reg.region_id}-${meta.generationToken}`,
              type: 'translate-region',
              pageIndex: pageIndex,
              element: page.element,
              region: reg,
              priority: regionPriority,
              generationToken: meta.generationToken,
              createdAt: Date.now()
            });
          }
        });

        if (queuedCount > 0) {
          updateUiPanel();
          PriorityTaskQueue.processQueue();
        }
        return;
      }

      // Caso 3: Falha anterior mas agora é a página visível (P0): dá retry automático
      if (isVisible && meta.status === 'failed') {
        meta.status = 'pending';
        PriorityTaskQueue.enqueue({
          id: `det-${meta.id}-${meta.generationToken}`,
          type: 'detect',
          pageIndex: pageIndex,
          element: page.element,
          priority: 1,
          generationToken: meta.generationToken,
          createdAt: Date.now()
        });
      }
    },

    translateCurrentPageNow() {
      // Bypassa imediatamente a tolerância de 5 segundos
      this.clearToleranceTimer();
      const pages = ReaderAdapter.getAllPages();
      const candidate = ReaderAdapter.detectActivePageCandidate(pages);

      if (candidate.candidateIndex !== null && candidate.element) {
        const vis = candidate.visibleIndices || [candidate.candidateIndex];
        console.log(`[Coordinator] Tradução imediata forçada (Alt+T): Páginas [${vis.map(i=>i+1).join(', ')}]`);
        this.confirmActivePage(candidate.candidateIndex, candidate.element, vis);
      } else {
        alert('Manga Translator: Nenhuma página de mangá visível no centro da tela.');
      }
    }
  };

  /* ==========================================================================
     8. FILA DE PRIORIDADE REAL COM TOKENS DE GERAÇÃO (PRIORITY QUEUE)
     ========================================================================== */

  const PriorityTaskQueue = {
    enqueue(task) {
      STATE.priorityQueue.push(task);
      // Ordenação rigorosa por nível de prioridade (0..5), depois FIFO (createdAt)
      STATE.priorityQueue.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt - b.createdAt;
      });
      updateUiPanel();
    },

    purgeOutOfWindowTasks(activeWindow) {
      const kept = [];
      const visible = STATE.activeVisibleIndices || [];

      for (const task of STATE.priorityQueue) {
        if (activeWindow.includes(task.pageIndex)) {
          // Atualiza o nível de prioridade: todas as páginas visíveis recebem prioridade máxima
          const isVisible = visible.includes(task.pageIndex);
          if (isVisible) {
            task.priority = task.type === 'translate-region' ? 0 : 1;
          } else {
            const specIdx = activeWindow.filter(idx => !visible.includes(idx)).indexOf(task.pageIndex);
            if (task.type === 'translate-region') {
              task.priority = specIdx === 0 ? 2 : 4;
            } else {
              task.priority = specIdx === 0 ? 3 : 5;
            }
          }
          kept.push(task);
        } else {
          // Descarta tarefa fora da janela ativa
          STATE.stats.droppedTasks++;
        }
      }
      kept.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt - b.createdAt;
      });
      STATE.priorityQueue = kept;
    },

    async processQueue() {
      if (STATE.isPaused || !CONFIG.autoTranslate) return;

      while (STATE.activeRequests < CONFIG.maxConcurrentRequests && STATE.priorityQueue.length > 0) {
        // P0 tem prioridade absoluta: P1/P2 só rodam se houver capacidade ociosa e ZERO tarefas P0 na fila
        const hasP0Task = STATE.priorityQueue.some(t => t.priority <= 1);
        const nextTask = STATE.priorityQueue[0];

        // Se a próxima tarefa for P1/P2 mas existirem tarefas P0, aguarda ou prioriza P0
        if (!hasP0Task || nextTask.priority <= 1) {
          const task = STATE.priorityQueue.shift();
          if (!task) break;

          // Validação 1: Página deve estar estritamente na Janela [P0, P1, P2]
          if (!STATE.priorityWindow.includes(task.pageIndex)) {
            STATE.stats.droppedTasks++;
            continue;
          }

          // Validação 2: Token de geração deve corresponder (imune a race conditions)
          const meta = getImageMeta(task.element);
          if (!meta || meta.generationToken !== task.generationToken) {
            STATE.stats.droppedTasks++;
            continue;
          }

          // Validação 3: Elemento deve estar conectado ao DOM
          if (!task.element.isConnected) {
            STATE.stats.droppedTasks++;
            continue;
          }

          if (CONFIG.requestDelayMs > 0 && STATE.activeRequests > 0) {
            await new Promise(r => setTimeout(r, CONFIG.requestDelayMs));
          }

          this.dispatchTask(task);
        } else {
          break;
        }
      }

      updateUiPanel();
    },

    dispatchTask(task) {
      if (task.type === 'detect') {
        this.executeDetect(task);
      } else if (task.type === 'translate-region') {
        this.executeTranslateRegion(task);
      }
    },

    async executeDetect(task) {
      const meta = getImageMeta(task.element);
      meta.status = 'detecting';
      STATE.activeRequests++;
      updateUiPanel();

      try {
        const dataUrl = await getImageDataUrl(task.element);

        // Validação de geração após conversão assíncrona
        if (!STATE.priorityWindow.includes(task.pageIndex) || meta.generationToken !== task.generationToken) {
          STATE.stats.droppedTasks++;
          return;
        }

        const data = await sendDetectRequest(dataUrl);

        // Validação de geração após resposta do backend
        if (!STATE.priorityWindow.includes(task.pageIndex) || meta.generationToken !== task.generationToken) {
          STATE.stats.droppedTasks++;
          return;
        }

        // Estatísticas de detecção
        if (data.detection_ms) {
          STATE.stats.totalDetectionSamples++;
          STATE.stats.avgDetectionMs = Math.round(
            ((STATE.stats.avgDetectionMs * (STATE.stats.totalDetectionSamples - 1)) + data.detection_ms) / STATE.stats.totalDetectionSamples
          );
        }

        meta.backendPageId = data.page_id;
        meta.regions = data.regions || [];
        meta.status = meta.regions.length > 0 ? 'detected' : 'done';

        STATE.stats.detectedBubbles += meta.regions.length;
        STATE.stats.pendingBubbles += meta.regions.length;

        // Renderiza IMEDIATAMENTE as máscaras brancas com micro-spinners sobre os balões
        if (meta.regions.length > 0) {
          renderBubbleMasks(task.element, meta.regions);

          // Determina a prioridade das regiões baseada na visibilidade e janela ativa
          const visible = STATE.activeVisibleIndices || [];
          const isVisible = visible.includes(task.pageIndex);
          let regionPriority = 0;
          if (!isVisible) {
            const specIdx = STATE.priorityWindow.filter(idx => !visible.includes(idx)).indexOf(task.pageIndex);
            regionPriority = specIdx === 0 ? 2 : 4;
          }

          // Enfileira cada balão individualmente para tradução progressiva
          meta.regions.forEach(reg => {
            PriorityTaskQueue.enqueue({
              id: `reg-${meta.id}-${reg.region_id}-${meta.generationToken}`,
              type: 'translate-region',
              pageIndex: task.pageIndex,
              element: task.element,
              region: reg,
              priority: regionPriority,
              generationToken: meta.generationToken,
              createdAt: Date.now()
            });
          });
        }
      } catch (err) {
        console.error(`[MangaTranslator] Erro ao detectar balões na página ${task.pageIndex + 1}:`, err.message);
        meta.status = 'failed';
        STATE.lastError = err.message;
      } finally {
        STATE.activeRequests--;
        updateUiPanel();
        PriorityTaskQueue.processQueue();
      }
    },

    async executeTranslateRegion(task) {
      const meta = getImageMeta(task.element);
      STATE.activeRequests++;
      updateUiPanel();

      try {
        const data = await sendTranslateRegionRequest(
          meta.backendPageId || '',
          task.region.region_id,
          task.region.source_text
        );

        // Validação rigorosa de geração: se a página foi abandonada ou invalidada, descarta
        if (!STATE.priorityWindow.includes(task.pageIndex) || meta.generationToken !== task.generationToken) {
          STATE.stats.droppedTasks++;
          return;
        }

        // Estatísticas de tradução
        if (data.processing_ms) {
          STATE.stats.totalTranslationSamples++;
          STATE.stats.avgTranslationMs = Math.round(
            ((STATE.stats.avgTranslationMs * (STATE.stats.totalTranslationSamples - 1)) + data.processing_ms) / STATE.stats.totalTranslationSamples
          );
        }

        // Atualiza APENAS este balão com o texto traduzido final
        updateBubbleWithTranslation(task.element, task.region.region_id, data.translated_text);

        STATE.stats.translatedBubbles++;
        STATE.stats.pendingBubbles = Math.max(0, STATE.stats.pendingBubbles - 1);

        // Se todos os balões da página foram traduzidos, marca a página como done
        const allDone = meta.regions.every(r => {
          const box = meta.regionBoxes[r.region_id];
          return box && box.dataset.status === 'translated';
        });
        if (allDone) meta.status = 'done';
      } catch (err) {
        console.error(`[MangaTranslator] Erro no balão ${task.region.region_id}:`, err.message);
        STATE.stats.failedBubbles++;
        STATE.stats.pendingBubbles = Math.max(0, STATE.stats.pendingBubbles - 1);
      } finally {
        STATE.activeRequests--;
        updateUiPanel();
        PriorityTaskQueue.processQueue();
      }
    }
  };

  function clearQueue() {
    STATE.priorityQueue.forEach(t => {
      STATE.stats.droppedTasks++;
    });
    STATE.priorityQueue = [];
    STATE.stats.pendingBubbles = 0;
    updateUiPanel();
    console.log('[MangaTranslator] Fila limpa com sucesso.');
  }

  function retryFailedBubbles() {
    STATE.stats.failedBubbles = 0;
    const pages = STATE.allPages;
    STATE.priorityWindow.forEach(idx => {
      const p = pages[idx];
      if (p) {
        const meta = getImageMeta(p.element);
        meta.status = 'idle';
        PriorityCoordinator.dispatchPage(idx, STATE.priorityWindow.indexOf(idx));
      }
    });
    updateUiPanel();
    PriorityTaskQueue.processQueue();
  }

  /* ==========================================================================
     9. PAINEL DE CONTROLE FLUTUANTE E OBSERVABILIDADE (UI)
     ========================================================================== */

  let uiPanelRoot = null;
  let isPanelMinimized = false;

  let ttPolicy = null;
  try {
    if (typeof window.trustedTypes !== 'undefined' && window.trustedTypes.createPolicy) {
      ttPolicy = window.trustedTypes.createPolicy('mt_trusted_html_v2', {
        createHTML: (string) => string
      });
    }
  } catch (e) {}

  function setSafeHTML(element, htmlString) {
    if (!element) return;
    if (ttPolicy) {
      try {
        element.innerHTML = ttPolicy.createHTML(htmlString);
        return;
      } catch (err) {}
    }
    // Se Trusted Types estiver ativo no documento (como no MangaDex), usa DOMParser diretamente
    if (typeof window.trustedTypes !== 'undefined') {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlString, 'text/html');
        element.textContent = '';
        while (doc.body.firstChild) {
          element.appendChild(doc.body.firstChild);
        }
        return;
      } catch (domErr) {}
    }
    try {
      element.innerHTML = htmlString;
    } catch (trustedTypesError) {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlString, 'text/html');
        element.textContent = '';
        while (doc.body.firstChild) {
          element.appendChild(doc.body.firstChild);
        }
      } catch (domErr) {
        console.error('[MangaTranslator] Erro ao renderizar DOM seguro:', domErr);
      }
    }
  }

  function ensureUiPanel() {
    if (!document.body) return;
    const existing = document.getElementById('mt-panel-root');
    if (!existing) {
      createUiPanel();
    } else if (uiPanelRoot && !document.body.contains(uiPanelRoot)) {
      document.body.appendChild(uiPanelRoot);
    }
  }

  function createUiPanel() {
    if (document.getElementById('mt-panel-root')) return;
    if (!document.body) return;

    uiPanelRoot = document.createElement('div');
    uiPanelRoot.id = 'mt-panel-root';
    uiPanelRoot.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      color: #f3f4f6;
      background: rgba(23, 26, 33, 0.96);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(12px);
      user-select: none;
      width: 310px;
      transition: width 0.18s ease, padding 0.18s ease;
      box-sizing: border-box;
    `;

    renderUiPanelContent();
    document.body.appendChild(uiPanelRoot);
    enableDragging(uiPanelRoot);
  }

  function renderUiPanelContent() {
    if (!uiPanelRoot) return;

    if (isPanelMinimized) {
      uiPanelRoot.style.width = 'auto';
      uiPanelRoot.style.padding = '0';
      setSafeHTML(uiPanelRoot, `
        <div id="mt-min-badge" style="display:flex; align-items:center; gap:8px; padding:8px 12px; cursor:pointer; background:rgba(30, 41, 59, 0.95); border-radius:12px;">
          <span style="font-size:16px;">📖</span>
          <span style="font-weight:600; font-size:12px; color:#38bdf8;">Manga PT-BR (v2.2.1)</span>
          <span style="width:8px; height:8px; border-radius:50%; background:${getHealthColor()};"></span>
        </div>
      `);
      const badge = uiPanelRoot.querySelector('#mt-min-badge');
      if (badge) badge.onclick = () => { isPanelMinimized = false; renderUiPanelContent(); };
      return;
    }

    uiPanelRoot.style.width = '310px';

    const isRTL = CONFIG.readingDirection === 'rtl';
    const dirArrow = isRTL ? '◀' : '▶';

    const visiblePages = (STATE.activeVisibleIndices && STATE.activeVisibleIndices.length > 0)
      ? STATE.activeVisibleIndices
      : (STATE.activePageIndex !== null ? [STATE.activePageIndex] : []);

    const isDouble = STATE.isDoublePage;
    const visibleStr = visiblePages.length > 0
      ? visiblePages.map(idx => `P${idx + 1}`).join(' + ') + (isDouble ? ' (Dupla)' : '')
      : '-';

    const p0Label = STATE.transitionState === 'CONFIRMED'
      ? `<strong style="color:#4ade80;">${visibleStr} (Confirmada)</strong>`
      : (STATE.transitionState === 'TRANSITION_PENDING'
          ? `<strong style="color:#facc15;">P${(STATE.candidatePageIndex !== null ? STATE.candidatePageIndex + 1 : '-')} (Salto: ${STATE.toleranceRemainingSec}s)</strong>`
          : `<span style="color:#9ca3af;">Nenhuma</span>`);

    const windowLabel = STATE.priorityWindow.length > 0
      ? STATE.priorityWindow.map((idx) => {
          const isVis = visiblePages.includes(idx);
          return isVis ? `<strong style="color:#4ade80;">p${idx + 1}</strong>` : `p${idx + 1}`;
        }).join(` ${dirArrow} `)
      : 'Vazia';

    // Contagem da fila por nível de prioridade
    const qP0 = STATE.priorityQueue.filter(t => t.priority <= 1).length;
    const qP1 = STATE.priorityQueue.filter(t => t.priority === 2 || t.priority === 3).length;
    const qP2 = STATE.priorityQueue.filter(t => t.priority >= 4).length;

    setSafeHTML(uiPanelRoot, `
      <div style="padding: 12px 14px;">
        <!-- Header -->
        <div id="mt-panel-header" style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.12); padding-bottom: 8px; margin-bottom: 10px; cursor: move;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-size: 15px;">📖</span>
            <strong style="color: #38bdf8; font-size: 13px;">Manga Translator PT-BR</strong>
            <span style="font-size: 10px; background: rgba(56, 189, 248, 0.2); color: #38bdf8; padding: 1px 5px; border-radius: 4px;">v2.2.1</span>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span id="mt-btn-check" title="Verificar Backend" style="cursor: pointer; font-size: 12px;">🔄</span>
            <span id="mt-btn-min" title="Minimizar" style="cursor: pointer; font-size: 14px; font-weight: bold; line-height: 1;">−</span>
          </div>
        </div>

        <!-- Estado do Backend & Leitor -->
        <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 11px;">
          <div>Backend: <span style="color:${getHealthColor()}; font-weight:600;">${getHealthText()}</span></div>
          <div>Leitor: <strong style="color:#e5e7eb; text-transform:capitalize;">${STATE.readerType}</strong> (${STATE.readerCertainty === 'confident' ? '<span style="color:#4ade80;">OK</span>' : '<span style="color:#facc15;">Incerto</span>'})</div>
        </div>

        <!-- Janela de Prioridade -->
        <div style="background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 6px 8px; margin-bottom: 8px; font-size: 11px;">
          <div style="margin-bottom: 3px; display: flex; justify-content: space-between; align-items: center;">
            <div>P0 Ativo: ${p0Label}</div>
            <div style="font-size: 10px; font-weight: 600; color: ${isRTL ? '#c084fc' : '#93c5fd'};">
              ${isRTL ? '◀ Trás p/ Frente (RTL)' : '▶ Normal (LTR)'}
            </div>
          </div>
          <div style="color: #9ca3af; font-size: 10px;">Janela [P0, P1, P2]: <strong style="color:#38bdf8;">[ ${windowLabel} ]</strong></div>
        </div>

        <!-- Estatísticas da Fila e Balões -->
        <div style="background: rgba(0,0,0,0.35); border-radius: 6px; padding: 6px 8px; margin-bottom: 8px; font-size: 11px; display: grid; grid-template-columns: 1fr 1fr; gap: 5px;">
          <div>Detectados: <strong style="color:#e5e7eb;">${STATE.stats.detectedBubbles}</strong></div>
          <div>Traduzidos: <strong style="color:#4ade80;">${STATE.stats.translatedBubbles}</strong></div>
          <div>Pendentes: <strong style="color:#facc15;">${STATE.stats.pendingBubbles}</strong></div>
          <div>Falhas: <strong style="color:#f87171;">${STATE.stats.failedBubbles}</strong></div>
        </div>

        <!-- Métricas da Fila de Prioridades e Desempenho -->
        <div style="background: rgba(0,0,0,0.3); border-radius: 6px; padding: 5px 8px; margin-bottom: 8px; font-size: 10px; color:#9ca3af; display: flex; justify-content: space-between;">
          <div>Fila: P0: <strong style="color:#facc15;">${qP0}</strong> | P1: ${qP1} | P2: ${qP2}</div>
          <div>Descartadas: <strong style="color:#fca5a5;">${STATE.stats.droppedTasks}</strong></div>
        </div>

        <div style="background: rgba(0,0,0,0.3); border-radius: 6px; padding: 5px 8px; margin-bottom: 8px; font-size: 10px; color:#9ca3af; display: flex; justify-content: space-between;">
          <div>Méd. OCR: <strong style="color:#e5e7eb;">${STATE.stats.avgDetectionMs}ms</strong></div>
          <div>Méd. Balão: <strong style="color:#e5e7eb;">${STATE.stats.avgTranslationMs}ms</strong></div>
        </div>

        ${STATE.lastError ? `
          <div style="background: rgba(153, 27, 27, 0.45); border: 1px solid rgba(248, 113, 113, 0.4); border-radius: 6px; padding: 5px 8px; margin-bottom: 8px; font-size: 10px; color: #fca5a5; word-break: break-word;">
            <strong>Último Erro:</strong> ${STATE.lastError}
          </div>
        ` : ''}

        <!-- Botões de Ação -->
        <div style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px;">
          <button id="mt-btn-now" style="width: 100%; padding: 7px 10px; border-radius: 6px; border: none; background: #0284c7; color: #fff; cursor: pointer; font-size: 11px; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 5px; box-shadow: 0 2px 6px rgba(2, 132, 199, 0.4);">
            <span>⚡</span> <span>Traduzir Página Visível (P0 Imediato / Alt+T)</span>
          </button>

          <!-- Botão de Alternar Direção de Leitura (LTR / RTL) -->
          <button id="mt-btn-direction" style="width: 100%; padding: 6px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: ${isRTL ? '#6d28d9' : '#1e3a8a'}; color: #fff; cursor: pointer; font-size: 11px; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 6px; box-shadow: 0 1px 4px rgba(0,0,0,0.3);">
            <span>${isRTL ? '◀' : '▶'}</span>
            <span>Direção: ${isRTL ? 'Trás p/ Frente (RTL / K Manga)' : 'Normal (LTR)'}</span>
          </button>

          <div style="display: flex; gap: 6px;">
            <button id="mt-btn-pause" style="flex: 1; padding: 6px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: ${STATE.isPaused ? '#ca8a04' : '#374151'}; color: #fff; cursor: pointer; font-size: 11px; font-weight: 500;">
              ${STATE.isPaused ? '▶ Retomar' : '⏸ Pausar'}
            </button>
            <button id="mt-btn-toggle-view" style="flex: 1; padding: 6px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: ${CONFIG.showTranslations ? '#2563eb' : '#d97706'}; color: #fff; cursor: pointer; font-size: 11px; font-weight: 600;">
              ${CONFIG.showTranslations ? '👁 Ocultar' : '👁 Mostrar'}
            </button>
          </div>

          <div style="display: flex; gap: 6px;">
            <button id="mt-btn-retry" style="flex: 1; padding: 6px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: #374151; color: #fff; cursor: pointer; font-size: 11px; font-weight: 500;">
              🔄 Repetir (${STATE.stats.failedBubbles})
            </button>
            <button id="mt-btn-auto" style="flex: 1; padding: 6px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: ${CONFIG.autoTranslate ? '#15803d' : '#991b1b'}; color: #fff; cursor: pointer; font-size: 11px; font-weight: 500;">
              Auto: ${CONFIG.autoTranslate ? 'ON' : 'OFF'}
            </button>
          </div>

          <button id="mt-btn-clear" style="width: 100%; padding: 5px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); background: #7f1d1d; color: #fecaca; cursor: pointer; font-size: 11px; font-weight: 500; display: flex; align-items: center; justify-content: center; gap: 4px;">
            <span>🗑</span> <span>Limpar Fila (${STATE.priorityQueue.length})</span>
          </button>
        </div>

        <!-- Ajustes Finos (Fonte e Margem) -->
        <div style="border-top: 1px solid rgba(255,255,255,0.12); padding-top: 8px; font-size: 11px; color: #9ca3af;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
            <span>Escala Fonte (${Math.round(CONFIG.fontSizeScale * 100)}%):</span>
            <div style="display:flex; gap:4px;">
              <button id="mt-btn-font-dec" style="padding:1px 7px; border-radius:4px; background:#4b5563; color:#fff; border:none; cursor:pointer;">-</button>
              <button id="mt-btn-font-inc" style="padding:1px 7px; border-radius:4px; background:#4b5563; color:#fff; border:none; cursor:pointer;">+</button>
            </div>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span>Margem Balão (${CONFIG.boxPaddingPx}px):</span>
            <div style="display:flex; gap:4px;">
              <button id="mt-btn-pad-dec" style="padding:1px 7px; border-radius:4px; background:#4b5563; color:#fff; border:none; cursor:pointer;">-</button>
              <button id="mt-btn-pad-inc" style="padding:1px 7px; border-radius:4px; background:#4b5563; color:#fff; border:none; cursor:pointer;">+</button>
            </div>
          </div>
        </div>
      </div>
    `);

    bindUiEvents();
  }

  function getHealthColor() {
    if (STATE.backendStatus === 'online') return '#4ade80';
    if (STATE.backendStatus === 'offline') return '#f87171';
    return '#facc15';
  }

  function getHealthText() {
    if (STATE.backendStatus === 'online') return 'Online';
    if (STATE.backendStatus === 'offline') return 'Desconectado';
    return 'Verificando...';
  }

  function bindUiEvents() {
    if (!uiPanelRoot) return;

    const btnNow = uiPanelRoot.querySelector('#mt-btn-now');
    if (btnNow) btnNow.onclick = () => PriorityCoordinator.translateCurrentPageNow();

    const btnMin = uiPanelRoot.querySelector('#mt-btn-min');
    if (btnMin) btnMin.onclick = () => { isPanelMinimized = true; renderUiPanelContent(); };

    const btnCheck = uiPanelRoot.querySelector('#mt-btn-check');
    if (btnCheck) btnCheck.onclick = () => checkBackendHealth();

    const btnPause = uiPanelRoot.querySelector('#mt-btn-pause');
    if (btnPause) {
      btnPause.onclick = () => {
        STATE.isPaused = !STATE.isPaused;
        if (!STATE.isPaused) PriorityTaskQueue.processQueue();
        renderUiPanelContent();
      };
    }

    const btnToggleView = uiPanelRoot.querySelector('#mt-btn-toggle-view');
    if (btnToggleView) {
      btnToggleView.onclick = () => {
        CONFIG.showTranslations = !CONFIG.showTranslations;
        persistConfig();
        if (!CONFIG.showTranslations) {
          if (overlayRoot) {
            const overlays = overlayRoot.querySelectorAll('.mt-image-overlay');
            overlays.forEach(o => { o.style.display = 'none'; });
          }
        } else {
          handleLayoutUpdate();
        }
        renderUiPanelContent();
      };
    }

    const btnRetry = uiPanelRoot.querySelector('#mt-btn-retry');
    if (btnRetry) btnRetry.onclick = () => retryFailedBubbles();

    const btnClear = uiPanelRoot.querySelector('#mt-btn-clear');
    if (btnClear) btnClear.onclick = () => clearQueue();

    const btnAuto = uiPanelRoot.querySelector('#mt-btn-auto');
    if (btnAuto) {
      btnAuto.onclick = () => {
        CONFIG.autoTranslate = !CONFIG.autoTranslate;
        persistConfig();
        if (CONFIG.autoTranslate) PriorityTaskQueue.processQueue();
        renderUiPanelContent();
      };
    }

    const btnFontDec = uiPanelRoot.querySelector('#mt-btn-font-dec');
    if (btnFontDec) {
      btnFontDec.onclick = () => {
        CONFIG.fontSizeScale = Math.max(0.6, Number((CONFIG.fontSizeScale - 0.1).toFixed(1)));
        persistConfig();
        handleLayoutUpdate();
        renderUiPanelContent();
      };
    }

    const btnFontInc = uiPanelRoot.querySelector('#mt-btn-font-inc');
    if (btnFontInc) {
      btnFontInc.onclick = () => {
        CONFIG.fontSizeScale = Math.min(1.8, Number((CONFIG.fontSizeScale + 0.1).toFixed(1)));
        persistConfig();
        handleLayoutUpdate();
        renderUiPanelContent();
      };
    }

    const btnPadDec = uiPanelRoot.querySelector('#mt-btn-pad-dec');
    if (btnPadDec) {
      btnPadDec.onclick = () => {
        CONFIG.boxPaddingPx = Math.max(0, CONFIG.boxPaddingPx - 1);
        persistConfig();
        handleLayoutUpdate();
        renderUiPanelContent();
      };
    }

    const btnPadInc = uiPanelRoot.querySelector('#mt-btn-pad-inc');
    if (btnPadInc) {
      btnPadInc.onclick = () => {
        CONFIG.boxPaddingPx = Math.min(12, CONFIG.boxPaddingPx + 1);
        persistConfig();
        handleLayoutUpdate();
        renderUiPanelContent();
      };
    }

    const btnDirection = uiPanelRoot.querySelector('#mt-btn-direction');
    if (btnDirection) {
      btnDirection.onclick = () => toggleReadingDirection();
    }
  }

  function toggleReadingDirection() {
    CONFIG.readingDirection = CONFIG.readingDirection === 'rtl' ? 'ltr' : 'rtl';
    persistConfig();
    console.log(`[MangaTranslator] Direção de leitura alterada para: ${CONFIG.readingDirection.toUpperCase()}`);
    if (STATE.activePageIndex !== null) {
      const pages = STATE.allPages;
      const curPage = pages[STATE.activePageIndex];
      PriorityCoordinator.confirmActivePage(STATE.activePageIndex, curPage ? curPage.element : null, STATE.activeVisibleIndices);
    } else {
      updateUiPanel();
    }
  }

  function updateUiPanel() {
    renderUiPanelContent();
  }

  function enableDragging(panel) {
    let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;
    let isDragging = false;

    panel.addEventListener('mousedown', (e) => {
      const header = e.target.closest('#mt-panel-header');
      if (!header || e.target.tagName === 'SPAN' || e.target.tagName === 'BUTTON') return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      const rect = panel.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;

      panel.style.bottom = 'auto';
      panel.style.right = 'auto';
      panel.style.left = `${initialLeft}px`;
      panel.style.top = `${initialTop}px`;

      const onMouseMove = (moveEvt) => {
        if (!isDragging) return;
        const deltaX = moveEvt.clientX - startX;
        const deltaY = moveEvt.clientY - startY;
        panel.style.left = `${Math.max(10, Math.min(window.innerWidth - panel.offsetWidth - 10, initialLeft + deltaX))}px`;
        panel.style.top = `${Math.max(10, Math.min(window.innerHeight - panel.offsetHeight - 10, initialTop + deltaY))}px`;
      };

      const onMouseUp = () => {
        isDragging = false;
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
  }

  /* ==========================================================================
     10. WATCHDOGS DE NAVEGAÇÃO E INICIALIZAÇÃO
     ========================================================================== */

  function evaluateActiveReaderState() {
    const pages = ReaderAdapter.getAllPages();
    const candidate = ReaderAdapter.detectActivePageCandidate(pages);
    PriorityCoordinator.onPageCandidateObserved(
      candidate.candidateIndex,
      candidate.element,
      candidate.certainty,
      candidate.visibleIndices
    );
    // Garante que páginas recém-carregadas no DOM completem a janela [P0, P1, P2]
    PriorityCoordinator.refreshPriorityWindow();
  }

  // Monitoramento de interação do usuário (scroll, teclado, toque, cliques)
  ['scroll', 'resize', 'click', 'keydown', 'wheel', 'touchend'].forEach(evt => {
    window.addEventListener(evt, () => {
      evaluateActiveReaderState();
      handleLayoutUpdate();
    }, { passive: true, capture: true });
  });

  // Watchdog periódico suave a cada 350ms para manter sincronia
  setInterval(() => {
    evaluateActiveReaderState();
    if (CONFIG.showTranslations && STATE.renderedImages.size > 0) {
      handleLayoutUpdate();
    }
  }, 350);

  function init() {
    if (window.__manga_translator_v2_initialized__) return;
    window.__manga_translator_v2_initialized__ = true;

    injectGlobalStyles();
    ensureOverlayRoot();
    ensureUiPanel();
    checkBackendHealth();

    // Primeira avaliação de páginas
    setTimeout(evaluateActiveReaderState, 500);

    // Watchdog de UI e integridade
    setInterval(() => {
      ensureOverlayRoot();
      ensureUiPanel();
      if (!isPanelMinimized) checkBackendHealth();
    }, 4000);

    // Atalho global Alt + T para traduzir imediatamente a página visível
    window.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 't' || e.key === 'T')) {
        PriorityCoordinator.translateCurrentPageNow();
      }
    });

    // Suporte a SPA (Single Page Application no MangaDex)
    try {
      const origPush = history.pushState;
      history.pushState = function () {
        origPush.apply(this, arguments);
        setTimeout(evaluateActiveReaderState, 350);
      };
      const origReplace = history.replaceState;
      history.replaceState = function () {
        origReplace.apply(this, arguments);
        setTimeout(evaluateActiveReaderState, 350);
      };
      window.addEventListener('popstate', () => {
        setTimeout(evaluateActiveReaderState, 350);
      });
    } catch (e) {}

    // Comandos de menu Tampermonkey
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Manga Translator: Traduzir Página Ativa (Alt+T)', () => {
        PriorityCoordinator.translateCurrentPageNow();
      });
      GM_registerMenuCommand('Manga Translator: Alternar Direção de Leitura (LTR/RTL)', () => {
        toggleReadingDirection();
      });
      GM_registerMenuCommand('Manga Translator: Alternar Visibilidade', () => {
        CONFIG.showTranslations = !CONFIG.showTranslations;
        persistConfig();
        handleLayoutUpdate();
        updateUiPanel();
      });
    }

    console.log('[MangaTranslator] v2.2.1 Inicializado com Leitura Contínua Fluida, Janela Dinâmica e Máscaras Imediatas.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
