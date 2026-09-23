// Callback pra usar com router.param(nome, ...) - recusa com 400 antes de
// chegar na rota qualquer valor de :id/:produtoId/etc que não seja um
// inteiro, em vez de deixar subir como "invalid input syntax for integer"
// do Postgres (que vazaria detalhe da query num erro 500 - ver S8 no plano
// de revisão de segurança).
function validarIdInteiro(req, res, next, valor) {
  if (!Number.isInteger(Number(valor))) {
    return res.status(400).json({ erro: 'Id inválido.' });
  }
  next();
}

module.exports = { validarIdInteiro };
