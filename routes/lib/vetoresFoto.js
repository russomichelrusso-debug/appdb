// Vetores das fotos ("📷 Pela etiqueta", 11/2026). O modelo roda no celular (index.html,
// <motor-vetores>); aqui só a validação e o formato, que o app e o servidor dividem.
// Trocar o modelo = trocar MODELO_VETOR aqui e no index.html: os vetores do modelo antigo
// deixam de ser servidos (o índice é refeito pelo Painel) e os da loja recomeçam.
const MODELO_VETOR = 'dinov2-small-int8@8b1f705';
const VETOR_DIM = 384; // int8, um byte por dimensão
const CODIGO_SKU_REGEX = /^[A-Za-z0-9._-]{1,30}$/;

// base64 de exatamente VETOR_DIM bytes, nem todo zero -> Buffer; senão null
function vetorValido(v) {
  if (typeof v !== 'string' || v.length > 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return null;
  const buf = Buffer.from(v, 'base64');
  if (buf.length !== VETOR_DIM || buf.every(b => b === 0)) return null;
  return buf;
}

module.exports = { MODELO_VETOR, VETOR_DIM, CODIGO_SKU_REGEX, vetorValido };
