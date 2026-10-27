// Conteúdo das páginas de produto do site oficial (cortag.com), lido pelo
// scripts/raspar-site-cortag.js e importado pelo Painel (tabela fichas_site).
// Aqui só a limpeza do arquivo: o que vier fora do formato não entra. Endereço
// só do próprio site (página de produto e foto em wp-content/uploads), porque
// o app abre o link e o servidor baixa a foto (rota /api/produto-fotos/:sku/do-site).

const URL_PAGINA = /^https:\/\/cortag\.com\/pt-br\/produto\/[a-z0-9-]+\/?$/;
const URL_FOTO = /^https:\/\/cortag\.com\/wp-content\/uploads\/[A-Za-z0-9._\-/%]+\.jpe?g$/i; // só JPEG: é o que produto_fotos guarda
const CODIGO_SKU = /^[A-Za-z0-9._-]{1,30}$/;
const MAX_PAGINAS = 2000;
const MAX_SKUS_POR_PAGINA = 200;
const MAX_BENEFICIOS = 15;
const MAX_LINHAS_TABELA = 40;

function texto(v, max) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}
// o texto de venda guarda as quebras de parágrafo
function paragrafos(v, max) {
  if (typeof v !== 'string') return '';
  return v.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, max);
}
function urlFoto(v) {
  const s = texto(v, 400);
  return URL_FOTO.test(s) && !s.includes('..') ? s : '';
}
function tabela(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v).slice(0, MAX_LINHAS_TABELA)) {
    const rotulo = texto(k, 60);
    const valor = texto(val, 200);
    if (rotulo && valor) out[rotulo] = valor;
  }
  return out;
}

// { paginas: [{ url, titulo, categoria, texto, beneficios, indicado, acompanha, foto,
//   skus: { sku: { tabela, indicado, foto } } }], lidoEm } -> { paginas, recusadas, erro? }
function limparArquivoDoSite(corpo) {
  const lista = corpo && Array.isArray(corpo.paginas) ? corpo.paginas : null;
  if (!lista) return { erro: 'Envie { paginas: [...] } gerado pelo scripts/raspar-site-cortag.js.' };
  if (lista.length > MAX_PAGINAS) return { erro: `Mais de ${MAX_PAGINAS} páginas no arquivo.` };
  const lidoEm = /^\d{4}-\d{2}-\d{2}$/.test(String(corpo.lidoEm || '')) ? corpo.lidoEm : null;
  const vistas = new Set();
  const paginas = [];
  let recusadas = 0;
  for (const p of lista) {
    const url = p && texto(p.url, 300);
    if (!url || !URL_PAGINA.test(url) || vistas.has(url)) { recusadas++; continue; }
    vistas.add(url);
    const skus = {};
    const entrada = p.skus && typeof p.skus === 'object' && !Array.isArray(p.skus) ? p.skus : {};
    for (const [sku, v] of Object.entries(entrada).slice(0, MAX_SKUS_POR_PAGINA)) {
      const cod = String(sku).trim().toUpperCase();
      if (!CODIGO_SKU.test(cod)) continue;
      skus[cod] = { tabela: tabela(v && v.tabela), indicado: texto(v && v.indicado, 600), foto: urlFoto(v && v.foto) };
    }
    if (!Object.keys(skus).length) { recusadas++; continue; }
    paginas.push({
      url,
      titulo: texto(p.titulo, 200),
      categoria: texto(p.categoria, 100),
      texto: paragrafos(p.texto, 4000),
      beneficios: (Array.isArray(p.beneficios) ? p.beneficios : []).map(b => texto(b, 400)).filter(Boolean).slice(0, MAX_BENEFICIOS),
      indicado: texto(p.indicado, 600),
      acompanha: texto(p.acompanha, 300),
      foto: urlFoto(p.foto),
      skus,
      lidoEm,
    });
  }
  return { paginas, recusadas };
}

// Foto do site pra um SKU: a da coluna dele na tabela (1024 px) ou a da página.
function fotoDoSkuNaPagina(pagina, sku) {
  const doSku = pagina && pagina.skus && pagina.skus[sku];
  return urlFoto(doSku && doSku.foto) || urlFoto(pagina && pagina.foto);
}

module.exports = { limparArquivoDoSite, fotoDoSkuNaPagina, URL_FOTO, URL_PAGINA };
