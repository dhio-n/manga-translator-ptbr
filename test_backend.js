/**
 * Manga Translator PT-BR — Backend de Teste Local (Node.js)
 * =========================================================
 * Este servidor espelha 100% o comportamento do test_backend.py para
 * permitir testes imediatos caso você execute com Node.js / agy-node.
 * 
 * Endpoints:
 * - GET  http://127.0.0.1:8765/health
 * - POST http://127.0.0.1:8765/translate
 * 
 * Execução: node test_backend.js (ou agy-node test_backend.js)
 */

const http = require('http');

const HOST = '127.0.0.1';
const PORT = 8765;

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

const server = http.createServer((req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'ok',
      service: 'manga-translator-backend',
      version: '1.0.0',
      host: `${HOST}:${PORT}`
    }));
    return;
  }

  // Tradução
  if (req.method === 'POST' && req.url === '/translate') {
    const startTime = Date.now();
    let body = '';

    req.on('data', chunk => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) { // Proteção contra payload excessivo
        res.writeHead(413);
        res.end(JSON.stringify({ error: 'Payload excessivo' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (!payload.image) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Campo 'image' obrigatório ausente." }));
          return;
        }

        const elapsed = Date.now() - startTime;

        // Resposta padrão no formato esperado pelo userscript
        const responseData = {
          translations: [
            {
              text: "O que você está fazendo?",
              box: [120, 85, 260, 110],
              confidence: 0.96
            },
            {
              text: "Eu não acredito nisso...",
              box: [580, 220, 310, 130],
              confidence: 0.94
            },
            {
              text: "Espere um momento!",
              box: [180, 520, 280, 95],
              confidence: 0.98
            }
          ],
          image: {
            width: 1000,
            height: 1400
          },
          processing_ms: Math.max(elapsed, 120)
        };

        res.writeHead(200);
        res.end(JSON.stringify(responseData));
        console.log(`[POST /translate] Sucesso: tradução enviada com ${responseData.translations.length} balões (${elapsed}ms)`);
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: `JSON inválido: ${err.message}` }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Endpoint não encontrado' }));
});

server.listen(PORT, HOST, () => {
  console.log('='.repeat(65));
  console.log('   Manga Translator PT-BR — Backend Local Ativo (Porta 8765)');
  console.log('='.repeat(65));
  console.log(` Health check: http://${HOST}:${PORT}/health`);
  console.log(` Endpoint:     http://${HOST}:${PORT}/translate`);
  console.log('='.repeat(65));
});
