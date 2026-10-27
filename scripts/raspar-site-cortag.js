#!/usr/bin/env node
// Lê as páginas de produto do site oficial (cortag.com, só /pt-br/produto/) e
// tira de cada uma o texto de venda, os benefícios, o "Indicado para", a tabela
// por medida e o bloco SKU/EAN/Embalagem. Roda fora do servidor, à mão, de vez
// em quando (o layout do site muda e o erro não pode chegar ao vendedor sem
// ninguém ver) - ver "Ficha técnica pelo site oficial" no CLAUDE.md.
//
// Uso:
//   NODE_USE_ENV_PROXY=1 node scripts/raspar-site-cortag.js --saida <pasta> [--catalogo catalogo.json]
//
// <pasta>/html/ guarda cada página baixada (rodar de novo não baixa outra vez;
// apagar a pasta pra pegar o site atualizado). Saídas:
//   paginas.json       tudo o que foi lido, uma entrada por página
//   site-por-sku.json  {sku: {...}} - só SKU impresso na página, nunca pelo nome
//   relatorio.md       (com --catalogo) quantos códigos do catálogo casam e o que
//                      ficou de fora. catalogo.json = [{c: codigo, e: ean13}, ...]
'use strict';

const fs = require('fs');
const path = require('path');

const SITEMAP_INDEX = 'https://cortag.com/sitemap_index.xml';
const PREFIXO = 'https://cortag.com/pt-br/produto/';
const PAUSA_MS = 1200;
const USER_AGENT = 'CortagRevolutionTools-ficha-tecnica/1.0 (representante comercial; leitura ocasional)';

function args() {
  const a = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--saida') out.saida = a[++i];
    else if (a[i] === '--catalogo') out.catalogo = a[++i];
  }
  if (!out.saida) {
    console.error('Uso: node scripts/raspar-site-cortag.js --saida <pasta> [--catalogo catalogo.json]');
    process.exit(1);
  }
  return out;
}

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

async function baixar(url) {
  for (let tentativa = 1; ; tentativa++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      if (tentativa >= 3) throw new Error(`${url}: ${e.message}`);
      await esperar(5000 * tentativa);
    }
  }
}

// ---- leitura do HTML (sem dependência: o layout é o do Elementor/ACF do site) ----

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', times: '×' };
function texto(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTIDADES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function meta(html, prop) {
  const m = html.match(new RegExp(`<meta[^>]+property="${prop}"[^>]+content="([^"]*)"`, 'i'));
  return m ? texto(m[1]) : '';
}

// Bloco da descrição: o widget theme-post-content (aba "Descrição").
function blocoDescricao(html) {
  const i = html.indexOf('elementor-widget-theme-post-content');
  if (i < 0) return '';
  const ini = html.indexOf('<div class="elementor-widget-container">', i);
  if (ini < 0) return '';
  // termina no próximo painel de aba (a aba "Especificações Técnicas")
  const fim = html.indexOf('role="tabpanel"', ini);
  return html.slice(ini, fim > 0 ? fim : ini + 20000);
}

function lerDescricao(html) {
  const bloco = blocoDescricao(html);
  const paragrafos = [];
  const beneficios = [];
  let indicado = '';
  let acompanha = '';
  const re = /<(p|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(bloco))) {
    const t = texto(m[2]);
    if (!t) continue;
    if (m[1].toLowerCase() === 'li') beneficios.push(t);
    else if (/^indicad[oa]s?\b/i.test(t)) indicado = indicado ? `${indicado} ${t}` : t;
    else if (/^acompanha/i.test(t)) acompanha = t.replace(/^acompanha[m]?\s*:?\s*/i, '');
    else paragrafos.push(t);
  }
  return { texto: paragrafos.join('\n'), beneficios: [...new Set(beneficios)], indicado, acompanha };
}

// Tabelas "acf-fields-table": de um produto (linhas rótulo | valor) ou de
// várias medidas (1ª coluna rótulo, uma coluna por medida, com o nome em <strong>).
function lerTabelas(html) {
  const tabelas = [];
  const re = /<table class="acf-fields-table">([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = re.exec(html))) {
    const linhas = [];
    const reTr = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr;
    while ((tr = reTr.exec(m[1]))) {
      const celulas = [];
      const reTd = /<td([^>]*)>([\s\S]*?)<\/td>/gi;
      let td;
      while ((td = reTd.exec(tr[1]))) {
        const img = td[2].match(/<img[^>]+src="([^"]+)"/i);
        celulas.push({ t: texto(td[2]), img: img ? img[1] : '', classe: td[1] });
      }
      if (celulas.length) linhas.push(celulas);
    }
    if (linhas.length) tabelas.push(linhas);
  }
  return tabelas;
}

const ROTULO_SKU = /^(sku|c[oó]digo|ref\.?|refer[eê]ncia)$/i;
const ROTULO_EAN = /^ean(-?13)?$/i;
const ROTULO_EMB = /^(embalagem|qtd\.? ?embalagem|emb\.?)$/i;

// Devolve uma "variação" por coluna: {nome, sku, ean, emb, foto, specs{rotulo: valor}}.
function variacoesDasTabelas(tabelas) {
  const variacoes = [];
  for (const linhas of tabelas) {
    const largura = Math.max(...linhas.map(l => l.length));
    if (largura <= 2) {
      // rótulo | valor - um produto só
      const v = { nome: '', sku: '', ean: '', emb: '', foto: '', specs: {} };
      for (const [rot, val] of linhas) {
        if (!rot || !val) continue;
        if (ROTULO_SKU.test(rot.t)) v.sku = val.t;
        else if (ROTULO_EAN.test(rot.t)) v.ean = val.t;
        else if (ROTULO_EMB.test(rot.t)) v.emb = val.t;
        else if (rot.t && val.t) v.specs[rot.t] = val.t;
      }
      variacoes.push(v);
      continue;
    }
    const cols = [];
    for (let c = 1; c < largura; c++) cols.push({ nome: '', sku: '', ean: '', emb: '', foto: '', specs: {} });
    for (const linha of linhas) {
      const rot = linha[0] ? linha[0].t : '';
      for (let c = 1; c < linha.length; c++) {
        const v = cols[c - 1];
        const cel = linha[c];
        if (!rot) {
          if (cel.img && !v.foto) v.foto = cel.img;
          else if (cel.t && !v.nome) v.nome = cel.t;
        } else if (ROTULO_SKU.test(rot)) v.sku = cel.t;
        else if (ROTULO_EAN.test(rot)) v.ean = cel.t;
        else if (ROTULO_EMB.test(rot)) v.emb = cel.t;
        else if (cel.t) v.specs[rot] = cel.t;
      }
    }
    variacoes.push(...cols);
  }
  // um mesmo SKU pode aparecer em várias colunas/tabelas - junta
  return variacoes.filter(v => v.sku || Object.keys(v.specs).length);
}

function categoriaDaPagina(html) {
  // breadcrumb "Início › Produtos › Categoria › Nome"
  const m = html.match(/<nav[^>]*breadcrumb[\s\S]*?<\/nav>/i) || html.match(/class="[^"]*breadcrumb[^"]*"[\s\S]{0,4000}?<\/(ul|ol|div|p)>/i);
  if (!m) return '';
  const partes = [...m[0].matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map(x => texto(x[1])).filter(Boolean);
  return partes.filter(p => !/^(in[ií]cio|produtos|home)$/i.test(p)).pop() || '';
}

function lerPagina(url, html) {
  const titulo = meta(html, 'og:title').replace(/\s*[-–|]\s*Cortag.*$/i, '');
  const desc = lerDescricao(html);
  const variacoes = variacoesDasTabelas(lerTabelas(html));
  return {
    url,
    titulo,
    categoria: categoriaDaPagina(html),
    foto: meta(html, 'og:image'),
    ...desc,
    variacoes,
  };
}

// ---- execução ----

async function listarUrls() {
  const indice = await baixar(SITEMAP_INDEX);
  const sitemaps = [...indice.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]).filter(u => /produto-sitemap\d*\.xml$/.test(u));
  const urls = new Set();
  for (const sm of sitemaps) {
    const xml = await baixar(sm);
    if (xml == null) { console.warn(`404: ${sm}`); continue; }
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) if (m[1].startsWith(PREFIXO)) urls.add(m[1]);
    await esperar(PAUSA_MS);
  }
  return [...urls].sort();
}

function nomeDoArquivo(url) {
  return url.slice(PREFIXO.length).replace(/[^a-z0-9-]+/gi, '_').replace(/^_+|_+$/g, '') + '.html';
}

const so = (s) => String(s || '').replace(/\D/g, '');

function porSku(paginas) {
  const mapa = {};
  for (const p of paginas) {
    for (const v of p.variacoes) {
      const sku = String(v.sku || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{3,10}$/.test(sku)) continue;
      const atual = mapa[sku];
      const entrada = {
        url: p.url,
        titulo: p.titulo,
        nomeNaPagina: v.nome || p.titulo,
        categoria: p.categoria,
        texto: p.texto,
        beneficios: p.beneficios,
        indicado: p.indicado,
        acompanha: p.acompanha,
        specs: v.specs,
        ean: so(v.ean),
        emb: v.emb,
        foto: v.foto || p.foto,
        outrasPaginas: atual ? [...(atual.outrasPaginas || []), atual.url] : [],
      };
      // o mesmo SKU em duas páginas: fica a que tem mais texto, a outra vai em outrasPaginas
      if (!atual || (entrada.texto.length + entrada.beneficios.length * 50) > (atual.texto.length + atual.beneficios.length * 50)) {
        mapa[sku] = entrada;
      } else {
        atual.outrasPaginas.push(p.url);
      }
    }
  }
  return mapa;
}

function relatorio(paginas, mapa, catalogo) {
  const codigos = new Map(catalogo.map(r => [String(r.c).toUpperCase(), r]));
  const porEan = new Map(catalogo.filter(r => r.e).map(r => [so(r.e), r]));
  const casados = new Map(); // codigo do catálogo -> {sku do site, como}
  const eanDiferente = [];
  for (const [sku, s] of Object.entries(mapa)) {
    const doCatalogo = codigos.get(sku);
    if (doCatalogo) {
      casados.set(sku, { sku, como: 'SKU' });
      if (s.ean && doCatalogo.e && so(doCatalogo.e) !== s.ean) eanDiferente.push({ sku, site: s.ean, catalogo: so(doCatalogo.e) });
      continue;
    }
    const peloEan = s.ean && porEan.get(s.ean);
    if (peloEan && !casados.has(String(peloEan.c).toUpperCase())) casados.set(String(peloEan.c).toUpperCase(), { sku, como: 'EAN' });
  }
  const skusCasados = new Set([...casados.values()].map(x => x.sku));
  const paginasSemCasar = paginas.filter(p => !p.variacoes.some(v => skusCasados.has(String(v.sku || '').trim().toUpperCase())));
  const semSku = paginas.filter(p => !p.variacoes.some(v => v.sku));
  const comTexto = [...casados.values()].filter(x => { const s = mapa[x.sku]; return s.texto || s.beneficios.length || s.indicado; });
  const comBeneficios = [...casados.values()].filter(x => mapa[x.sku].beneficios.length);
  const comIndicado = [...casados.values()].filter(x => mapa[x.sku].indicado);
  const comMedida = [...casados.values()].filter(x => Object.keys(mapa[x.sku].specs).length);
  const familias = new Map();
  for (const r of catalogo) {
    const f = r.f || '(sem família)';
    const st = familias.get(f) || { total: 0, casados: 0 };
    st.total++;
    if (casados.has(String(r.c).toUpperCase())) st.casados++;
    familias.set(f, st);
  }

  const l = [];
  l.push(`# Raspagem do cortag.com × catálogo`, '');
  l.push(`- Páginas de produto em português lidas: **${paginas.length}**`);
  l.push(`- SKUs diferentes impressos nas páginas: **${Object.keys(mapa).length}**`);
  l.push(`- Páginas sem nenhum SKU na tabela: **${semSku.length}**`);
  l.push(`- Códigos do catálogo: **${catalogo.length}**`);
  l.push(`- Códigos do catálogo que casam com uma página: **${casados.size}** (${[...casados.values()].filter(x => x.como === 'SKU').length} pelo SKU, ${[...casados.values()].filter(x => x.como === 'EAN').length} pelo EAN)`);
  l.push(`  - com algum texto do site: ${comTexto.length} · com benefícios em tópicos: ${comBeneficios.length} · com "Indicado para": ${comIndicado.length} · com tabela da medida: ${comMedida.length}`);
  l.push(`- SKUs do site que não estão no catálogo: **${Object.keys(mapa).filter(s => !codigos.has(s) && ![...casados.values()].some(x => x.sku === s)).length}** (fora de linha na Lista de Preços, exportação ou código trocado)`);
  l.push(`- EAN do site diferente do EAN do catálogo, mesmo SKU: **${eanDiferente.length}**`, '');
  l.push('## Por família do catálogo', '', '| Família | Casam | Total |', '|---|---:|---:|');
  for (const [f, st] of [...familias.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt', { numeric: true }))) l.push(`| ${f} | ${st.casados} | ${st.total} |`);
  l.push('', `## Páginas sem SKU do catálogo (${paginasSemCasar.length})`, '');
  for (const p of paginasSemCasar) {
    const skus = p.variacoes.map(v => v.sku).filter(Boolean);
    l.push(`- [${p.titulo || p.url}](${p.url})${skus.length ? ` — SKU na página: ${skus.join(', ')}` : ' — sem SKU na página'}`);
  }
  if (eanDiferente.length) {
    l.push('', '## EAN diferente (mesmo SKU)', '', '| SKU | EAN no site | EAN no catálogo |', '|---|---|---|');
    for (const x of eanDiferente) l.push(`| ${x.sku} | ${x.site} | ${x.catalogo} |`);
  }
  return { md: l.join('\n') + '\n', casados };
}

async function main() {
  const { saida, catalogo } = args();
  const pastaHtml = path.join(saida, 'html');
  fs.mkdirSync(pastaHtml, { recursive: true });

  const urls = await listarUrls();
  console.log(`${urls.length} páginas de produto em /pt-br/`);
  const paginas = [];
  let baixadas = 0;
  for (const [i, url] of urls.entries()) {
    const arq = path.join(pastaHtml, nomeDoArquivo(url));
    let html = fs.existsSync(arq) ? fs.readFileSync(arq, 'utf8') : null;
    if (html == null) {
      html = await baixar(url);
      baixadas++;
      if (html == null) { console.warn(`404: ${url}`); continue; }
      fs.writeFileSync(arq, html);
      await esperar(PAUSA_MS);
    }
    paginas.push(lerPagina(url, html));
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${urls.length} (${baixadas} baixadas agora)`);
  }

  const mapa = porSku(paginas);
  fs.writeFileSync(path.join(saida, 'paginas.json'), JSON.stringify(paginas, null, 1));
  fs.writeFileSync(path.join(saida, 'site-por-sku.json'), JSON.stringify(mapa, null, 1));
  console.log(`${Object.keys(mapa).length} SKUs lidos de ${paginas.length} páginas`);

  if (catalogo) {
    const cat = JSON.parse(fs.readFileSync(catalogo, 'utf8'));
    const { md, casados } = relatorio(paginas, mapa, cat);
    fs.writeFileSync(path.join(saida, 'relatorio.md'), md);
    console.log(`${casados.size} de ${cat.length} códigos do catálogo casam - ver relatorio.md`);
  }
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { lerPagina, porSku, relatorio };
