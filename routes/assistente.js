const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Obtem a chave da API do Gemini via variavel de ambiente ou tabela de configuracoes
async function getGeminiApiKey() {
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) {
    return process.env.GEMINI_API_KEY.trim();
  }
  try {
    const res = await pool.query("SELECT valor FROM configuracoes WHERE chave = 'gemini_api_key'");
    if (res.rows.length > 0 && res.rows[0].valor) {
      const val = res.rows[0].valor;
      return typeof val === 'string' ? val : (val.key || '');
    }
  } catch (e) {
    console.error('Erro ao buscar gemini_api_key nas configuracoes:', e.message);
  }
  return '';
}

// Endpoint de pergunta livre (com ou sem contexto de um SKU especifico)
router.post('/perguntar', async (req, res) => {
  const { pergunta, skuContexto } = req.body || {};
  if (!pergunta || typeof pergunta !== 'string' || !pergunta.trim()) {
    return res.status(400).json({ erro: 'Envie o campo "pergunta" em texto.' });
  }

  const apiKey = await getGeminiApiKey();
  if (!apiKey) {
    return res.status(400).json({
      erro: 'Chave do Gemini nao configurada. Defina a variavel de ambiente GEMINI_API_KEY no servidor.'
    });
  }

  try {
    let contextoFichas = [];
    let produtoAtual = null;

    // Se temos um SKU de contexto atual (ex: tela ou modal de um produto especifico)
    if (skuContexto) {
      const prodRes = await pool.query(
        `SELECT ft.codigo_sku, ft.nome, ft.descricao, ft.specs, ft.foto,
                p.categoria, pe.saldo AS estoque_saldo, pe.previsao AS estoque_previsao
         FROM fichas_tecnicas ft
         LEFT JOIN produtos p ON p.codigo_sku = ft.codigo_sku
         LEFT JOIN previsao_estoque pe ON pe.codigo_sku = ft.codigo_sku
         WHERE ft.codigo_sku = $1`,
        [String(skuContexto).trim()]
      );
      if (prodRes.rows.length > 0) {
        produtoAtual = prodRes.rows[0];
        contextoFichas.push(produtoAtual);
      }
    }

    // Busca fichas tecnicas relacionadas por palavras-chave da pergunta
    const palavras = pergunta
      .toLowerCase()
      .replace(/[^\w\s\d]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2)
      .slice(0, 6);

    if (palavras.length > 0) {
      const condicoes = palavras.map((_, i) => `(ft.nome ILIKE $${i + 1} OR ft.descricao ILIKE $${i + 1} OR ft.codigo_sku ILIKE $${i + 1})`);
      const params = palavras.map(w => `%${w}%`);
      const buscaRes = await pool.query(
        `SELECT ft.codigo_sku, ft.nome, ft.descricao, ft.specs, p.categoria
         FROM fichas_tecnicas ft
         LEFT JOIN produtos p ON p.codigo_sku = ft.codigo_sku
         WHERE ${condicoes.join(' OR ')}
         LIMIT 8`,
        params
      );

      for (const row of buscaRes.rows) {
        if (!contextoFichas.some(c => c.codigo_sku === row.codigo_sku)) {
          contextoFichas.push(row);
        }
      }
    }

    // Se nao encontrou fichas especificas e nao tem contexto, traz do catalogo
    if (contextoFichas.length === 0) {
      const topRes = await pool.query(
        `SELECT ft.codigo_sku, ft.nome, ft.descricao, ft.specs
         FROM fichas_tecnicas ft
         LIMIT 10`
      );
      contextoFichas = topRes.rows;
    }

    // Monta o contexto para o prompt da IA
    const contextoFormatado = contextoFichas.map(f => {
      let specsTxt = '';
      if (f.specs && typeof f.specs === 'object') {
        specsTxt = Object.entries(f.specs)
          .map(([k, v]) => `${k}: ${v}`)
          .join('; ');
      }
      return `SKU ${f.codigo_sku}: ${f.nome}\nDescricao: ${f.descricao || 'N/D'}\nEspecificacoes: ${specsTxt || 'N/D'}`;
    }).join('\n---\n');

    // Inicializa o SDK oficial do Google Gemini (@google/genai)
    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });

    const systemPrompt = `Voce e o Assistente Especialista de Produtos da Cortag Revolution Tools.
Sua funcao e tirar duvidas de vendedores e clientes sobre ferramentas, cortadores de piso, discos diamantados, niveladores e acessorios Cortag com base nas fichas tecnicas fornecidas.

DIRETRIZES CRITICAS PARA A RESPOSTA:
1. Responda em portugues brasileiro de maneira direta, profissional e amigavel.
2. IMPORTANTE: Sua resposta sera lida em voz alta atraves de sintetizador de voz (TTS). Portanto, gere um texto fluido e natural para ser ouvido:
   - Evite asteriscos (*), tabelas, simbolos estranhos ou blocos de codigo.
   - Seja conciso (de 2 a 4 frases, no maximo 6 frases se a pergunta for comparativa ou complexa).
   - Fale numeros e dimensoes de forma clara (ex: "ate 125 centimetros de comprimento e 15 milimetros de espessura").
3. Use prioritariamente as informacoes das fichas tecnicas abaixo. Se a informacao nao constar ou se for sobre outra marca, informe educadamente que possui dados dos produtos Cortag.`;

    const promptFinal = `FICHAS TECNICAS DISPONIVEIS:
${contextoFormatado}

${produtoAtual ? `PRODUTO EM FOCO NA TELA: SKU ${produtoAtual.codigo_sku} - ${produtoAtual.nome}` : ''}

PERGUNTA DO USUARIO: "${pergunta.trim()}"`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: promptFinal,
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.3,
      }
    });

    const respostaTexto = (response.text || '').trim();

    res.json({
      ok: true,
      resposta: respostaTexto,
      produtoContexto: produtoAtual ? { sku: produtoAtual.codigo_sku, nome: produtoAtual.nome } : null,
      fichasConsultadas: contextoFichas.map(f => ({ sku: f.codigo_sku, nome: f.nome }))
    });

  } catch (e) {
    console.error('Erro no assistente de voz:', e);
    res.status(500).json({ erro: 'Erro ao processar resposta com o assistente: ' + e.message });
  }
});

// Endpoint rapido para narrar o resumo da ficha tecnica de um SKU
router.post('/resumir-ficha', async (req, res) => {
  const { sku } = req.body || {};
  if (!sku) {
    return res.status(400).json({ erro: 'Envie o campo "sku".' });
  }

  const apiKey = await getGeminiApiKey();
  if (!apiKey) {
    return res.status(400).json({
      erro: 'Chave do Gemini nao configurada. Defina a variavel de ambiente GEMINI_API_KEY no servidor.'
    });
  }

  try {
    const result = await pool.query(
      `SELECT ft.codigo_sku, ft.nome, ft.descricao, ft.specs, ft.foto, p.categoria
       FROM fichas_tecnicas ft
       LEFT JOIN produtos p ON p.codigo_sku = ft.codigo_sku
       WHERE ft.codigo_sku = $1`,
      [String(sku).trim()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Ficha tecnica nao encontrada para este SKU.' });
    }

    const ficha = result.rows[0];
    let specsTxt = '';
    if (ficha.specs && typeof ficha.specs === 'object') {
      specsTxt = Object.entries(ficha.specs)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ');
    }

    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });

    const systemPrompt = `Voce e o narrador tecnico da Cortag.
Gere um resumo falado de 2 a 3 frases, dinamico e natural para ser lido em voz alta (sem markdown, sem asteriscos).
Mencione o nome do produto, para que serve e seus 2 ou 3 principais diferenciais tecnicos (ex: capacidade de corte, espessura, material ou forca).`;

    const prompt = `Ficha tecnica:
SKU: ${ficha.codigo_sku}
Nome: ${ficha.nome}
Descricao: ${ficha.descricao || ''}
Especificacoes: ${specsTxt}`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.2,
      }
    });

    res.json({
      ok: true,
      sku: ficha.codigo_sku,
      nome: ficha.nome,
      resumoFalado: (response.text || '').trim()
    });

  } catch (e) {
    console.error('Erro ao resumir ficha tecnica:', e);
    res.status(500).json({ erro: 'Erro ao gerar resumo da ficha: ' + e.message });
  }
});

module.exports = router;
