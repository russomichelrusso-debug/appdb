const express = require('express');
const router = express.Router();

// Interpreta uma pergunta falada (já transcrita pelo navegador) e devolve a
// intenção (preço / ficha técnica / cliente) + o termo de busca. O Gemini
// NUNCA responde o preço/ficha/dado em si - só entende a pergunta. O dado
// real vem sempre do banco do próprio app, pra nunca arriscar inventar um
// preço ou informação errada.
router.post('/interpretar', async (req, res) => {
  const { texto } = req.body;
  if (!texto || typeof texto !== 'string') return res.status(400).json({ erro: 'Envie { texto: "..." }' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ erro: 'Assistente de voz não configurado — falta GEMINI_API_KEY no servidor.' });

  const modelo = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

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
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
        }),
      }
    );
    if (!resp.ok) {
      const erroTexto = await resp.text();
      console.error('Erro do Gemini:', resp.status, erroTexto);
      let mensagem;
      if (resp.status === 401 || resp.status === 403) {
        mensagem = 'A chave do Gemini (GEMINI_API_KEY) foi rejeitada — confira se foi copiada certinho, sem espaço extra, ou gere uma chave nova em aistudio.google.com.';
      } else if (resp.status === 404) {
        mensagem = `O modelo "${modelo}" não foi encontrado — pode ter sido descontinuado. Configure a variável GEMINI_MODEL no Render com um nome de modelo atual.`;
      } else if (resp.status === 429) {
        mensagem = 'Limite de uso do Gemini atingido por agora — espera um pouco e tenta de novo.';
      } else {
        mensagem = `Erro ao consultar o Gemini (${resp.status}).`;
      }
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
    res.status(500).json({ erro: 'Erro ao interpretar pergunta: ' + e.message });
  }
});

module.exports = router;
