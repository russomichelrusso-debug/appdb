// Relatório do gerente ("Análise de Resultados e Oportunidades", lido por
// lerRelatorioGerente em importadores.js) -> objetivos por grupo do app.
//
// Chave do grupo = a mesma do classificatório: COALESCE(matriz_grupo, nome);
// cliente Rede usa a própria chave "#<id>" (a rede é a cooperativa inteira,
// o faturamento do card de Rede é só do cliente - ver ehRede no status).
//
// - Q4 (objetivo do trimestre, por código do ERP): soma por grupo e vai pra
//   `configuracoes.objetivos_trimestrais`, o mesmo formato do importador
//   antigo (o card já mostra "faltam R$ X pro objetivo do trimestre" com a
//   entrada ao vivo). Rede entra pela loja ("#<id>"): a planilha traz o
//   objetivo de cada unidade, e a entrada de Rede no status já é só da loja
//   (o importador antigo pulava as redes - 32 lojas na planilha de 06/11/2026).
// - Anual (sem código na planilha: Cidade + Razão Social): o cliente é achado
//   1) pelo código, cruzando nome cortado em 30 letras + cidade com as abas
//   que têm código (`codigosPorNome`) - o nome do cadastro às vezes é outro;
//   2) pelo nome inteiro (sem acento/pontuação), desempatando pela cidade.
//   Decisão do usuário (11/2026): o objetivo anual vale pro GRUPO (matriz).
//   Na planilha de 06/11/2026 as 328 linhas acharam cliente (298 pelo nome,
//   30 pelo código).

function normalizarNome(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/\\/g, '/').replace(/[.,\s]+/g, ' ').trim();
}
const nomeCurto = (s) => normalizarNome(String(s ?? '').slice(0, 30));

// mesma régua do status (calcularEntradaTrimestralPeriodo: tipo === 'Rede')
const ehRede = (c) => c.classificatorio_tipo === 'Rede';
// Chave onde o objetivo do cliente é somado. Só quem tem matriz_grupo (e não
// é Rede) soma no grupo - é o único caso em que o faturado/entrada do status
// também é do grupo. Rede e cliente sem grupo usam "#<id>": filiais com o
// mesmo nome e sem grupo (COFEBRAL, GRACIOSA...) teriam os objetivos somados
// e comparados com o faturado de uma loja só (achado do revisor-cortag).
function chaveDoGrupo(c) {
  return !ehRede(c) && c.matriz_grupo ? c.matriz_grupo : `#${c.id}`;
}
// Chaves onde o objetivo de um cliente entra: a dele e, pra loja Rede dentro
// de um grupo com lojas que não são Rede, também o grupo (a soma do grupo no
// status conta as vendas dela).
function chavesDoObjetivo(c, gruposComNaoRede) {
  const chaves = [chaveDoGrupo(c)];
  if (ehRede(c) && c.matriz_grupo && gruposComNaoRede.has(c.matriz_grupo)) chaves.push(c.matriz_grupo);
  return chaves;
}
// Chaves que o status procura, na ordem: a do relatório do gerente e a do
// importador antigo (COALESCE(matriz_grupo, nome) - grava o que já existe).
// Rede só pela loja: o importador antigo pulava as redes, e o matriz_grupo da
// loja Rede é o objetivo do grupo inteiro (comparado com o faturado da loja).
function chavesDoStatus(c) {
  if (ehRede(c)) return [chaveDoGrupo(c)];
  return [...new Set([chaveDoGrupo(c), c.matriz_grupo || c.nome])];
}
const somar = (obj, k, v) => { obj[k] = Math.round(((obj[k] || 0) + Number(v)) * 100) / 100; };

// clientes: [{ id, nome, codigo_oficial, matriz_grupo, classificatorio_tipo, cidade }]
function planejarObjetivosGerente({ clientes, q4 = [], anual = [], codigosPorNome = [] }) {
  const gruposComNaoRede = new Set(clientes.filter(c => c.matriz_grupo && !ehRede(c)).map(c => c.matriz_grupo));
  const porCodigo = new Map();
  const porNome = new Map();
  for (const c of clientes) {
    if (c.codigo_oficial) porCodigo.set(String(c.codigo_oficial), c);
    const k = normalizarNome(c.nome);
    if (!porNome.has(k)) porNome.set(k, []);
    porNome.get(k).push(c);
  }

  // ---- Q4 ----
  const objetivosQ4 = {};
  const q4Stats = { linhas: q4.length, clientes: 0, semCliente: [], rede: 0 };
  for (const it of q4) {
    const c = porCodigo.get(String(it.codigo));
    if (!c) { q4Stats.semCliente.push(String(it.codigo)); continue; }
    if (ehRede(c)) q4Stats.rede++;
    for (const k of chavesDoObjetivo(c, gruposComNaoRede)) somar(objetivosQ4, k, it.objetivo);
    q4Stats.clientes++;
  }

  // ---- Anual ----
  const codigoPeloNome = new Map();
  for (const x of codigosPorNome) {
    const k = `${nomeCurto(x.razao)}|${normalizarNome(x.cidade)}`;
    if (!codigoPeloNome.has(k)) codigoPeloNome.set(k, String(x.codigo));
  }
  const objetivosAnuais = {};
  const anualStats = { linhas: anual.length, peloCodigo: 0, peloNome: 0, ambiguos: 0, naoAchados: [] };
  for (const it of anual) {
    let cliente = null;
    const cod = codigoPeloNome.get(`${nomeCurto(it.razao)}|${normalizarNome(it.cidade)}`);
    if (cod && porCodigo.get(cod)) {
      cliente = porCodigo.get(cod);
      anualStats.peloCodigo++;
    } else {
      let cands = porNome.get(normalizarNome(it.razao)) || [];
      if (cands.length > 1) {
        const naCidade = cands.filter(c => normalizarNome(c.cidade) === normalizarNome(it.cidade));
        if (naCidade.length) cands = naCidade;
      }
      // mesmo nome em lojas diferentes e a cidade não desempata: não chuta
      // (iria pra filial errada) - fica em naoAchados e conta como ambíguo
      if (cands.length > 1 && new Set(cands.map(chaveDoGrupo)).size > 1) {
        anualStats.ambiguos++;
      } else if (cands.length) {
        cliente = cands[0];
        anualStats.peloNome++;
      }
    }
    if (!cliente) { anualStats.naoAchados.push(`${it.razao} (${it.cidade})`); continue; }
    for (const k of chavesDoObjetivo(cliente, gruposComNaoRede)) somar(objetivosAnuais, k, it.objetivo);
  }
  return { objetivosQ4, q4Stats, objetivosAnuais, anualStats };
}

module.exports = { planejarObjetivosGerente, chaveDoGrupo, chavesDoStatus, normalizarNome };
