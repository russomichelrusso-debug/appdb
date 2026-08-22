// Autenticação simples por chave compartilhada - suficiente pra uma ferramenta
// interna de uso da equipe. Cada aparelho manda a mesma chave (guardada no app)
// no cabeçalho "X-API-Key". Pra revogar acesso, troca essa chave nas variáveis
// de ambiente do Render e reenvia a nova chave pro app.
function requireApiKey(req, res, next) {
  const key = req.header('X-API-Key');
  if (!process.env.API_KEY) {
    // se ninguém configurou uma chave ainda, não bloqueia (fica só no aviso) -
    // assim que a variável de ambiente API_KEY for definida no Render, passa
    // a exigir de verdade.
    console.warn('Aviso: API_KEY não configurada - endpoint aberto sem autenticação.');
    return next();
  }
  if (key !== process.env.API_KEY) {
    return res.status(401).json({ erro: 'Chave de API inválida ou ausente.' });
  }
  next();
}

module.exports = { requireApiKey };
