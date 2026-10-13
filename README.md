# Manga Translator PT-BR — Userscript Tampermonkey & Backend Local

Userscript para **Tampermonkey** focado em traduzir mangás em inglês diretamente para **Português Brasileiro (pt-BR)** usando um backend local em Python.

A tradução é desenhada **diretamente sobre os balões originais**, aplicando caixas brancas limpas e responsivas com o texto em português, sem alterar ou corromper os arquivos originais da página.

---

## 📁 Estrutura do Projeto

- **[`manga-translator-ptbr.user.js`](file:///c:/Users/user/Documents/mangar%20translator/manga-translator-ptbr.user.js)**: Userscript completo pronto para instalar no Tampermonkey.
- **[`test_backend.py`](file:///c:/Users/user/Documents/mangar%20translator/test_backend.py)**: Servidor backend Python de referência com health check e endpoint de tradução (apenas biblioteca padrão, sem dependências externas).
- **[`test_backend.js`](file:///c:/Users/user/Documents/mangar%20translator/test_backend.js)**: Servidor alternativo em Node.js com o mesmo contrato de API.
- **[`test_reader.html`](file:///c:/Users/user/Documents/mangar%20translator/test_reader.html)**: Página de teste com leitor simulado para validar o userscript sem depender de sites externos.

---

## 🚀 1. Como Instalar no Tampermonkey

1. Abra seu navegador (Chrome, Firefox, Edge, Brave, etc.) com a extensão **Tampermonkey** instalada.
2. Clique no ícone do Tampermonkey e selecione **"Criar novo script..."** (ou **"Dashboard"** -> aba **"Utilitários"** / **"+"**).
3. Apague qualquer código gerado automaticamente no editor.
4. Copie todo o conteúdo do arquivo [`manga-translator-ptbr.user.js`](file:///c:/Users/user/Documents/mangar%20translator/manga-translator-ptbr.user.js) e cole no editor do Tampermonkey.
5. Pressione **Ctrl + S** (ou clique em **Arquivo -> Salvar**).

---

## 🌐 2. Como Ajustar o Domínio em `@match`

Por padrão de segurança e compatibilidade, o script vem configurado com:
```javascript
// @match        *://*/*
```

Para restringir o script **apenas aos leitores de mangá que você realmente utiliza**, edite o cabeçalho no topo do script:

### Exemplos comuns:
```javascript
// ==UserScript==
// @name         Manga Translator PT-BR
// ...
// @match        https://mangadex.org/chapter/*
// @match        https://chapmanganelo.com/manga-*/*
// @match        https://ww6.manganelo.tv/chapter/*
// @match        https://mangakakalot.com/chapter/*
// @match        http://localhost:*/*
// @match        http://127.0.0.1:*/*
// ...
```
> **Dica:** Mantenha `http://localhost:*/*` e `http://127.0.0.1:*/*` no `@match` se quiser testar páginas de validação locais como o [`test_reader.html`](file:///c:/Users/user/Documents/mangar%20translator/test_reader.html).

---

## 🐍 3. Como Iniciar e Testar o Backend Python

### A. Iniciando o servidor de teste
Abra o prompt de comando (PowerShell ou Terminal) na pasta do projeto e execute:

```powershell
python test_backend.py
```
*(Se estiver em ambiente sem Python no momento, você também pode usar `node test_backend.js`)*.

O terminal exibirá:
```text
=================================================================
   Manga Translator PT-BR — Backend Local em Execução
=================================================================
 Endpoints ativos:
   - Health Check: http://127.0.0.1:8765/health
   - Tradução:     http://127.0.0.1:8765/translate
 Aguardando requisições do Userscript Tampermonkey...
=================================================================
```

### B. Testando a conectividade manualmente
Abra outro terminal e execute:

```powershell
# 1. Health check
curl http://127.0.0.1:8765/health

# 2. Teste de tradução
curl -X POST http://127.0.0.1:8765/translate -H "Content-Type: application/json" -d "{\"image\":\"data:image/jpeg;base64,/9j/4AAQSkZJRg==\"}"
```

---

## 🔒 4. Questão de Segurança: HTTPS da Página vs HTTP do Localhost

Quando você acessa um site de mangá via HTTPS (ex.: `https://mangadex.org`), o navegador normalmente bloqueia conexões normais via `fetch()` ou `XMLHttpRequest` para `http://127.0.0.1` devido à política de **Mixed Content** e restrições de **Private Network Access (PNA)**.

### Como o Userscript resolve isso com segurança:
- O script utiliza exclusivamente a API privilegiada **`GM_xmlhttpRequest`** do Tampermonkey, declarando no cabeçalho:
  ```javascript
  // @grant        GM_xmlhttpRequest
  // @connect      127.0.0.1
  // @connect      localhost
  ```
- O `GM_xmlhttpRequest` executa no contexto em segundo plano da extensão (background context do Tampermonkey), onde a política de Mixed Content não restringe conexões com `127.0.0.1`.
- **Importante:** Na primeira vez que você abrir uma página com o script, o Tampermonkey poderá exibir um popup de confirmação perguntando se você permite a conexão para `127.0.0.1:8765`. Selecione **"Sempre permitir este domínio"**.
- **Nunca desative as proteções globais de segurança do seu navegador**. O uso de `@connect 127.0.0.1` garante que nenhuma imagem ou dado saia da sua máquina local.

---

## 🧪 5. Lista de Verificações para Validar o Funcionamento

- [ ] **Backend Ativo:** O servidor Python está rodando na porta 8765.
- [ ] **Health Check no Painel:** O painel flutuante no canto inferior direito mostra a bolinha verde **🟢 Online**.
- [ ] **Detecção de Imagens:** O contador "Detectadas" no painel incrementa conforme as imagens de mangá são identificadas no DOM.
- [ ] **Fila e Concorrência:** O número de requisições ativas respeita o limite (padrão: 2 simultâneas com intervalo de 350ms).
- [ ] **Sobreposição e Alinhamento:** As caixas brancas cobrem o texto em inglês e ficam perfeitamente centralizadas dentro dos balões.
- [ ] **Responsividade:** Ao redimensionar a janela ou dar zoom, as caixas acompanham o redimensionamento da imagem sem sair do lugar (`ResizeObserver`).
- [ ] **Interatividade Livre:** Cliques na página continuam funcionando normalmente (as caixas usam `pointer-events: none`).
- [ ] **Controles da UI:**
  - Botão **⏸ Pausar / ▶ Retomar** pausa e despausa a fila.
  - Botão **👁 Ocultar / Mostrar** esconde e exibe as traduções instantaneamente.
  - Botões **- / + Escala Fonte** ajustam o tamanho do texto.
  - Botões **- / + Margem da Caixa** expandem ou reduzem a cobertura branca.
  - Botão **− Minimizar** encolhe o painel para um badge discreto.

---

## 🛠️ 6. Diagnóstico de Problemas Comuns

| Sintoma | Causa Mais Provável | Solução Recomendada |
| :--- | :--- | :--- |
| **Status "Desconectado" no painel** | Backend Python não iniciado ou porta 8765 ocupada por outro processo. | Verifique se o `test_backend.py` está rodando no terminal. Teste `http://127.0.0.1:8765/health` no navegador. |
| **Palavras coladas ou traduções truncadas** | OCR sem detecção de espaço entre caracteres em caixa alta. | Atualizado na v2.1.0 com `wordninja` e dehyphenation automático. |
| **Erro "Canvas em cache sem CORS" (K Manga)** | Navegador servindo tiles em cache de antes da instalação do hook. | Pressione **Ctrl + F5** ou clique em **🔄 Recarregar sem Cache** no painel flutuante. |
| **Popup do Tampermonkey bloqueando** | Permissão do `@connect` não autorizada pelo usuário. | No popup do Tampermonkey, clique em *"Sempre permitir este domínio"*. |
| **Caixas desalinhadas após rolagem** | O site usa contêineres internos com rolagem CSS ou `object-fit: contain`. | O script recalcula dinamicamente `object-fit` e escuta `scroll` e `resize` via viewport fixo. |
| **Tradução com texto cortado** | Balão pequeno para o comprimento da frase em português. | Clique no botão **"-"** em *Escala Fonte* no painel para reduzir o tamanho da tipografia. |
