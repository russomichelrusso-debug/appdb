// Funções auxiliares de autenticação. Login é feito com "Entrar com Google" -
// o token de sessão do próprio app continua sendo gerado aqui (crypto.randomBytes,
// sem depender de pacote externo), mas quem confirma a identidade agora é o
// Google, verificando o ID token que o frontend recebe do Google Identity
// Services.

const crypto = require('crypto');

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Confere o ID token (JWT) que o Google Identity Services devolve no
// frontend após o login. Em vez de validar a assinatura localmente (exigiria
// buscar e cachear as chaves públicas do Google), usa o endpoint oficial de
// tokeninfo do Google, que já confere assinatura, validade e o "aud" (só
// aceita token emitido pro nosso GOOGLE_CLIENT_ID) - simples e seguro o
// bastante pro volume de logins desse app.
async function verificarGoogleIdToken(idToken, clientId) {
  if (!idToken || typeof idToken !== 'string') return null;
  const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!resp.ok) return null;
  const dados = await resp.json();
  if (dados.aud !== clientId) return null;
  if (!dados.email || dados.email_verified !== 'true') return null;
  return { email: dados.email.toLowerCase(), sub: dados.sub, nome: dados.name || dados.email };
}

module.exports = { generateToken, verificarGoogleIdToken };
