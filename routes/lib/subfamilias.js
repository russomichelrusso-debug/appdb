'use strict';

// Subfamília de marketing (Sub-Fam MKT do ERP) por código de produto. A Lista de
// Preços só traz a família ("16 - COLHERES DE PEDREIRO"); a subfamília vem de
// planilhas avulsas de "DE x PARA" da Cortag e é mantida aqui, à mão (sem tela
// no Painel, decisão do usuário). Vai junto no GET /api/catalogo-precos e o
// modo Catálogo do app mostra os chips dela dentro da família.
//
// Planilha "CORREÇÃO SUBFAMÍLIAS COLHERES DE PEDREIRO" (10/2026), coluna PARA.
// `curto` é o rótulo do chip (sem repetir o nome da família).
const SUBFAMILIAS = [
  { codigo: 'S265', nome: 'Colheres de pedreiro cabo emborrachado', curto: 'Cabo emborrachado',
    produtos: '60160 60162 60163 60256 60651 60671 60702 60707' },
  { codigo: 'S42', nome: 'Colheres de pedreiro cabo plástico', curto: 'Cabo plástico',
    produtos: '62535 62536 62537 62538 62539 62540 62645 62646' },
  { codigo: 'S171', nome: 'Colheres de pedreiro cabo de madeira', curto: 'Cabo de madeira',
    produtos: '60716 60720 60721 60745 60746 60750 60777 61860' },
  { codigo: 'S266', nome: 'Colheres de pedreiro forjadas cabo de madeira', curto: 'Forjadas',
    produtos: '63586 63587 63588 63589 63590 63591 63592 63593' },
  { codigo: 'S173', nome: 'Colheres para azulejista', curto: 'Azulejista',
    produtos: '62327 62330 62331 62523 62550 62560 62561 62584 62585 62586 62587 62588 62589 62590' },
  { codigo: 'S188', nome: 'Colheres inglesas', curto: 'Inglesas',
    produtos: '62552 62553 62554 62555 62556 62557 62558 62559' },
];

const POR_CODIGO = new Map();
SUBFAMILIAS.forEach((s, ordem) => {
  const info = { codigo: s.codigo, nome: s.nome, curto: s.curto, ordem };
  for (const c of s.produtos.split(/\s+/)) POR_CODIGO.set(c, info);
});

// código do produto (o promocional P/P1/P2 cai no base, como em codigoBase de
// skuNormalizacao.js) -> subfamília ou null
function subfamiliaDoProduto(codigo) {
  const c = String(codigo == null ? '' : codigo).trim().toUpperCase();
  if (POR_CODIGO.has(c)) return POR_CODIGO.get(c);
  const m = /^P[12]?(.+)$/.exec(c);
  return (m && POR_CODIGO.get(m[1])) || null;
}

// linhas com codigo_sku (Curva ABC) -> as mesmas, com `subfamilia` nas que têm
function comSubfamilia(linhas) {
  return linhas.map(l => {
    const sub = subfamiliaDoProduto(l.codigo_sku);
    return sub ? { ...l, subfamilia: sub } : l;
  });
}

module.exports = { SUBFAMILIAS, subfamiliaDoProduto, comSubfamilia };
