const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

// Por usuário (não por IP - vários vendedores podem estar atrás do mesmo IP
// de rede móvel/wifi da loja) - protege a cota paga do Gemini contra um
// usuário logado que aperte o botão em loop.
const interpretarLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.usuario?.id || req.ip),
  message: { erro: 'Muitas perguntas em pouco tempo — espera um pouco e tenta de novo.' },
});

// Interpreta uma pergunta falada (já transcrita pelo navegador) e devolve a
// intenção (preço / ficha técnica / cliente) + o termo de busca. O Gemini
// NUNCA responde o preço/ficha/dado em si - só entende a pergunta. O dado
// real vem sempre do banco do próprio app, pra nunca arriscar inventar um
// preço ou informação errada.
// Chama o Gemini uma vez; se vier 503 (sobrecarga temporária do lado do
// Google), tenta de novo automaticamente antes de desistir - poupa o
// vendedor de precisar apertar o botão de novo por um problema que passa
// sozinho na maioria das vezes.
async function chamarGemini(partes, apiKey, modelo, tentativasRestantes = 2, prazoMs = 8000) {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
    {
      method: 'POST',
      // chave vai no header, não na URL - evita que fique gravada em logs de
      // proxy/CDN que registram a query string das requisições.
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: typeof partes === 'string' ? [{ text: partes }] : partes }],
        // só ler/classificar: sem "raciocínio" do 2.5 flash (deixava a resposta lenta); o pro e os antigos não aceitam desligar
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json', ...(/2\.5-flash/.test(modelo) ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
      }),
      signal: AbortSignal.timeout(prazoMs),
    }
  );
  if (resp.status === 503 && tentativasRestantes > 0) {
    await new Promise((r) => setTimeout(r, 1200));
    return chamarGemini(partes, apiKey, modelo, tentativasRestantes - 1, prazoMs);
  }
  return resp;
}

const modeloGemini = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';

function mensagemErroGemini(status, modelo) {
  if (status === 401 || status === 403) {
    return 'A chave do Gemini (GEMINI_API_KEY) foi rejeitada — confira se foi copiada certinho, sem espaço extra, ou gere uma chave nova em aistudio.google.com.';
  }
  if (status === 404) {
    return `O modelo "${modelo}" não foi encontrado — pode ter sido descontinuado. Configure a variável GEMINI_MODEL no Render com um nome de modelo atual.`;
  }
  if (status === 429) return 'Limite de uso do Gemini atingido por agora — espera um pouco e tenta de novo.';
  if (status === 503) return 'O Gemini está sobrecarregado nesse momento (problema temporário do lado do Google) — tenta de novo em alguns segundos.';
  return `Erro ao consultar o Gemini (${status}).`;
}

router.post('/interpretar', interpretarLimiter, async (req, res) => {
  const { texto } = req.body;
  if (!texto || typeof texto !== 'string') return res.status(400).json({ erro: 'Envie { texto: "..." }' });
  if (texto.length > 500) return res.status(400).json({ erro: 'Pergunta muito longa (máximo 500 caracteres).' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ erro: 'Assistente de voz não configurado — falta GEMINI_API_KEY no servidor.' });

  const modelo = modeloGemini();

  const prompt = `Você ajuda a interpretar perguntas faladas por um vendedor de ferramentas de construção civil (marca Cortag), usando um app de consulta.

Pergunta do vendedor: "${texto}"

Classifique em uma destas categorias:
- "preco": pergunta sobre preço, valor, custo, quanto custa um produto
- "ficha_tecnica": pergunta sobre especificações, características, medidas, capacidade de um produto
- "cliente": pergunta sobre um cliente (classificatório, quanto comprou, situação de pedido)
- "desconhecido": não deu pra entender do que se trata

Extraia também o termo principal (nome do produto ou do cliente mencionado, sem palavras de pergunta como "qual", "quanto custa", etc).

Responda SOMENTE com um JSON válido, sem texto antes ou depois, exatamente neste formato:
{"intencao": "preco", "termo": "nome extraído aqui"}`;

  try {
    const resp = await chamarGemini(prompt, apiKey, modelo);
    if (!resp.ok) {
      const erroTexto = await resp.text();
      console.error('Erro do Gemini:', resp.status, erroTexto);
      const mensagem = mensagemErroGemini(resp.status, modelo);
      return res.status(502).json({ erro: mensagem });
    }
    const data = await resp.json();
    const textoResposta = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textoResposta) return res.status(502).json({ erro: 'Resposta vazia do Gemini.' });

    let resultado;
    try {
      resultado = JSON.parse(textoResposta);
    } catch (e) {
      return res.status(502).json({ erro: 'Gemini não devolveu um JSON válido.' });
    }
    if (!['preco', 'ficha_tecnica', 'cliente', 'desconhecido'].includes(resultado.intencao)) {
      resultado.intencao = 'desconhecido';
    }
    res.json({ intencao: resultado.intencao, termo: resultado.termo || '' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao interpretar pergunta.' });
  }
});

// Foto (ou página de PDF escaneado) de uma lista/orçamento que o cliente mandou no WhatsApp
// -> as linhas de produto com a quantidade, como estão escritas (10/2026, "Lista colada do
// WhatsApp"). A IA só LÊ a imagem: o produto do catálogo e o preço saem do app, que confere
// cada linha pela busca e mostra ao vendedor antes de pôr no orçamento. Texto colado e PDF com
// texto são lidos no próprio aparelho, sem passar por aqui.
const imagemLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.usuario?.id || req.ip),
  message: { erro: 'Muitas fotos lidas em pouco tempo — espera uns minutos e tenta de novo.' },
});
// Etiqueta (Levantamento: uma foto por produto) tem limite próprio, maior: 25 produtos de uma gôndola
// estourariam o da lista (achado do revisor-cortag). A cota do Gemini grátis é o teto de verdade.
const etiquetaLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.usuario?.id || req.ip),
  message: { erro: 'Muitas etiquetas lidas em pouco tempo — espera uns minutos ou use o código de barras.' },
});
// O modo vem do app: o teto de 60 vale pra todo pedido do usuário (lista e etiqueta juntas), e a lista
// do cliente ainda tem o dela, de 20 (mandar modo 'etiqueta' não passa do teto)
const limiteDaImagem = (req, res, next) => etiquetaLimiter(req, res, (erro) => {
  if (erro || (req.body && req.body.modo === 'etiqueta')) return next(erro);
  imagemLimiter(req, res, next);
});
const MAX_IMAGENS = 3;
const MAX_BASE64_POR_IMAGEM = 4 * 1024 * 1024; // ~3 MB de imagem; o app manda ~300 KB
const MAX_ITENS_DA_IMAGEM = 80;
const TIPOS_IMAGEM = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Resposta do Gemini -> [{ texto, quantidade, unidade }] limpo (nada além disso passa). Com
// candidatos (etiqueta), "codigo" só passa se for um deles: código inventado não entra.
function itensDaRespostaGemini(resultado, codigosPermitidos = new Set()) {
  const lista = Array.isArray(resultado) ? resultado : (resultado && Array.isArray(resultado.itens) ? resultado.itens : []);
  const itens = [];
  for (const it of lista) {
    if (!it || typeof it !== 'object') continue;
    const texto = String(it.texto ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!/[a-zA-ZÀ-ÿ]{2}|\d{5,}/.test(texto)) continue;
    const q = Number(String(it.quantidade ?? '').replace(',', '.'));
    const quantidade = q > 0 && q <= 99999 ? Math.round(q * 1000) / 1000 : null;
    const unidade = ['un', 'cx', 'pct'].includes(it.unidade) ? it.unidade : null;
    const codigo = codigosPermitidos.has(String(it.codigo ?? '')) ? String(it.codigo) : null;
    itens.push(codigo ? { texto, quantidade, unidade, codigo } : { texto, quantidade, unidade });
    if (itens.length >= MAX_ITENS_DA_IMAGEM) break;
  }
  return itens;
}

const PROMPT_ETIQUETA = `As imagens são fotos tiradas numa loja da EMBALAGEM (cartela, blister, caixa ou etiqueta) de produtos de ferramentas para construção civil, quase sempre da marca Cortag.

Para cada produto cuja embalagem dá pra ler, devolva um item:
- "texto": o que identifica o produto, em português, como está impresso: o tipo (ex.: "disco de corte diamantado", "lâmina de serra circular"), a linha/modelo (ex.: "turbo", "porcelanato", "turbo flex", "segmentado eco", "contínuo"), o material indicado quando faz parte do nome (ex.: "madeira"), a medida principal (ex.: "110 mm") e o número de dentes se houver. Se aparecer impresso um código Cortag de 5 dígitos (começa com 6) ou um código de barras com os números legíveis, inclua no fim. Não inclua furo, rotação (RPM), norma (EN), textos em inglês/espanhol, lote nem frases de uso.
- "quantidade": null
- "unidade": null

Um item por produto diferente (embalagens iguais lado a lado = um item só). Ignore embalagens que não dá pra ler e produtos de outras marcas quando a marca está visível. Não invente o que não está escrito.

Responda SOMENTE com um JSON válido neste formato:
{"itens": [{"texto": "disco de corte diamantado turbo 110 mm", "quantidade": null, "unidade": null}], "cnpj": null}`;

const MAX_CANDIDATOS = 40;
const { CODIGO_SKU_REGEX: CODIGO_CANDIDATO } = require('./lib/vetoresFoto');
// [{ c, n }] -> limpo; ausente = []; não-lista ou mais de 40 = null. Candidato inválido só sai da lista
// (não derruba a leitura da etiqueta)
function candidatosDaEtiqueta(lista) {
  if (lista == null) return [];
  if (!Array.isArray(lista) || lista.length > MAX_CANDIDATOS) return null;
  const vistos = new Set(), out = [];
  for (const x of lista) {
    const c = String((x && x.c) ?? ''), n = String((x && x.n) ?? '').replace(/[\r\n"]+/g, ' ').trim().slice(0, 120);
    if (CODIGO_CANDIDATO.test(c) && n && !vistos.has(c)) { vistos.add(c); out.push({ c, n }); }
  }
  return out;
}
function textoDosCandidatos(candidatos) {
  if (!candidatos.length) return '';
  return `

Pela foto, o produto deve ser um destes do catálogo (código | nome). Se a etiqueta for de um deles, inclua no item "codigo" com o código da lista; se não for nenhum, não inclua "codigo" (o "texto" continua obrigatório). Não escolha só pela aparência: confira o tipo, a linha e a medida impressos.
${candidatos.map(x => `${x.c} | ${x.n}`).join('\n')}`;
}

router.post('/itens-da-imagem', limiteDaImagem, async (req, res) => {
  const imagens = req.body && req.body.imagens;
  if (!Array.isArray(imagens) || !imagens.length || imagens.length > MAX_IMAGENS) {
    return res.status(422).json({ erro: `Envie de 1 a ${MAX_IMAGENS} imagens.` });
  }
  for (const im of imagens) {
    if (!im || !TIPOS_IMAGEM.has(im.tipo) || typeof im.dados !== 'string' || !im.dados || im.dados.length > MAX_BASE64_POR_IMAGEM || !/^[A-Za-z0-9+/=]+$/.test(im.dados)) {
      return res.status(422).json({ erro: 'Imagem inválida ou grande demais.' });
    }
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ erro: 'Leitura de foto não configurada — falta GEMINI_API_KEY no servidor.' });
  const modelo = modeloGemini();
  // "📷 Pela etiqueta" (Pedido e Levantamento, 11/2026): foto da EMBALAGEM de um produto na loja.
  // A IA só lê a etiqueta; o produto sai da busca do app e passa pela mesma conferência da lista.
  const etiqueta = req.body.modo === 'etiqueta';
  // candidatos: os produtos de foto mais parecida, calculados no celular (routes/produtoVetores.js)
  const candidatos = etiqueta ? candidatosDaEtiqueta(req.body.candidatos) : [];
  if (candidatos === null) return res.status(422).json({ erro: 'Lista de produtos parecidos inválida.' });
  const prompt = etiqueta ? PROMPT_ETIQUETA + textoDosCandidatos(candidatos) : `As imagens são de uma lista de compras, pedido ou orçamento de ferramentas para construção civil que um cliente mandou ao vendedor (pode ser foto de papel, print de tela ou PDF escaneado; pode ser de outra marca).

Liste cada linha de PRODUTO, na ordem em que aparece. Para cada uma:
- "texto": a descrição do produto exatamente como está escrita, com medidas e o código se houver (sem preço, sem total)
- "quantidade": o número pedido, ou null se não estiver escrito (o número depois de "Cód.", "Código" ou "Ref." é o código do produto na loja, NÃO é quantidade)
- "unidade": "cx" se a quantidade for em caixas, "pct" se for em pacotes, "un" se for em unidades/peças, ou null

Ignore cabeçalho, dados de cliente, telefone, endereço, preços, totais, prazo, frete, assinatura e observações nas linhas de produto. Não invente linhas que não estão na imagem.

Se aparecer o CNPJ da loja que fez o pedido/orçamento (não o do fornecedor), devolva em "cnpj" (só números); senão null.

Responda SOMENTE com um JSON válido neste formato:
{"itens": [{"texto": "colher de pedreiro 8 cabo madeira", "quantidade": 12, "unidade": "un"}], "cnpj": null}`;
  const partes = [{ text: prompt }, ...imagens.map(im => ({ inline_data: { mime_type: im.tipo, data: im.dados } }))];
  try {
    const resp = await chamarGemini(partes, apiKey, modelo, 1, 45000);
    if (!resp.ok) {
      console.error('Erro do Gemini (imagem):', resp.status, (await resp.text()).slice(0, 500));
      return res.status(502).json({ erro: mensagemErroGemini(resp.status, modelo) });
    }
    const data = await resp.json();
    const textoResposta = data.candidates?.[0]?.content?.parts?.[0]?.text;
    let resultado = null;
    try { resultado = JSON.parse(textoResposta || ''); } catch (e) { }
    if (!resultado) return res.status(502).json({ erro: 'Não deu pra ler a foto agora — tenta de novo.' });
    // CNPJ da loja (o app sugere o cliente por ele); só 14 dígitos passam
    const cnpj = String((resultado && resultado.cnpj) || '').replace(/\D/g, '');
    res.json({ itens: itensDaRespostaGemini(resultado, new Set(candidatos.map(x => x.c))), cnpj: !etiqueta && cnpj.length === 14 ? cnpj : null });
  } catch (e) {
    console.error('Erro ao ler a imagem:', e.message);
    res.status(502).json({ erro: e.name === 'TimeoutError' ? 'A leitura da foto demorou demais — tenta de novo.' : 'Erro ao ler a foto.' });
  }
});

module.exports = router;
module.exports.PROMPT_ETIQUETA = PROMPT_ETIQUETA;
