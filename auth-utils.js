// Funções auxiliares de autenticação - sem depender de pacote externo (bcrypt
// etc.), usando só o módulo "crypto" que já vem com o Node. Senha guardada
// como "salt:hash" (scrypt), nunca em texto puro.

const crypto = require('crypto');

function hashPassword(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(senha, senha_hash) {
  if (!senha_hash || !senha_hash.includes(':')) return false;
  const [salt, hashGuardado] = senha_hash.split(':');
  const hashTentativa = crypto.scryptSync(senha, salt, 64).toString('hex');
  // timingSafeEqual exige mesmo tamanho - se não bater, já é senha errada
  const bufGuardado = Buffer.from(hashGuardado, 'hex');
  const bufTentativa = Buffer.from(hashTentativa, 'hex');
  if (bufGuardado.length !== bufTentativa.length) return false;
  return crypto.timingSafeEqual(bufGuardado, bufTentativa);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { hashPassword, verifyPassword, generateToken };
