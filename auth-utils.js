// Hash de senha usando só o módulo "crypto" nativo do Node - sem depender de
// pacotes externos (bcrypt, etc.), já que a instalação de pacotes novos pode
// falhar dependendo da rede. scrypt é o algoritmo recomendado pelo próprio
// Node pra isso, e já vem embutido.
const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const hashToCompare = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(hashToCompare, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { hashPassword, verifyPassword, generateToken };
