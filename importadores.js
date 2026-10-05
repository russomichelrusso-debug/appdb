// Leitura das planilhas importadas (relatório oficial Carteira/Faturamento,
// Classificatório do ERP, previsão de estoque/itens em falta) e reconhecimento
// do tipo de arquivo. Arquivo ÚNICO usado nos dois lados:
//  - no navegador (index.html, Painel › Importar arquivo), carregado por
//    <script src="importadores.js"> - expõe window.CortagImportadores;
//  - no servidor (importação automática por e-mail, routes/importacaoEmail.js),
//    por require().
// Assim a importação manual e a automática leem a planilha do mesmo jeito.
// Nenhuma função depende de DOM: quem chama passa a biblioteca SheetJS (XLSX)
// - no navegador a do CDN, no servidor o pacote @e965/xlsx.
(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.CortagImportadores = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ================================================================
  // Importação unificada do relatório oficial (Carteira + Faturamento)
  // ================================================================
  // Única porta de entrada de pedidos oficiais: lê as duas abas da
  // planilha .xlsx exportada do sistema oficial da empresa e manda tudo
  // pronto pro servidor (POST /api/pedidos-oficiais/importar) - não tem
  // mais etapa manual de preparar um JSON à parte. Reduz erro de digitação
  // e permite rodar de novo sempre que sair um relatório novo.
  //
  // ATENÇÃO - nomes de coluna: os nomes abaixo foram inferidos a partir
  // do código existente (aba Faturamento, já usada antes) e dos comentários
  // do schema do banco (ex: "Cod. Cliente"). Ainda NÃO foram conferidos
  // contra um arquivo real de Carteira. Se a planilha oficial usar nomes
  // diferentes dos listados aqui, o import vai parar com um erro claro
  // dizendo qual coluna não foi encontrada e quais colunas existem no
  // arquivo - é só adicionar o nome real na lista de apelidos abaixo.
  const COLUNAS_RELATORIO_OFICIAL = {
    cliente_nome: ['Cliente', 'Nome Cliente', 'Nome do Cliente'],
    cliente_codigo_oficial: ['Cod.Cliente', 'Cod. Cliente', 'Código Cliente', 'Codigo Cliente', 'Cod Cliente', 'Código do Cliente'],
    nr_pedido: ['Nr.Pedido', 'Nr. Pedido', 'Número Pedido', 'Numero Pedido', 'Nº Pedido', 'Pedido'],
    codigo_sku: ['Item', 'Código Item', 'Codigo Item', 'Cod.Item', 'Cód.Item'],
    quantidade: ['Qte.Faturada', 'Qte.Pedida', 'Qt.Pendente', 'Quantidade', 'Qtde', 'Qtd', 'Qte'],
    valor: ['Vlr.Faturado', 'Vl.Pendente', 'Valor Faturado', 'Vlr.Pedido', 'Valor', 'Vlr.'],
    // "Implantação" (aba Carteira) e "Dt.Implant" (aba Faturamento) são os
    // nomes reais confirmados no relatório oficial da empresa - as outras
    // variações abaixo ficam de reserva caso um layout diferente apareça.
    data_implantacao: ['Implantação', 'Dt.Implant', 'Dt.Implantação', 'Dt. Implantação', 'Data Implantação', 'Dt.Implantacao'],
    data_emissao: ['Dt.Emissão', 'Dt. Emissão', 'Data Emissão', 'Dt.Faturamento', 'Data Faturamento'],
    nota_fiscal: ['Nota Fiscal', 'Nº NF', 'Nr.NF', 'NF', 'Numero NF', 'Número NF', 'Nr. Nota Fiscal'],
    transportadora: ['Transportadora', 'Transp.', 'Transp'],
    situacao_pedido: ['Situação', 'Situação do Pedido', 'Sit.Pedido', 'Status Pedido', 'Situação Pedido'],
    classificatorio: ['Classificatório', 'Classificatorio'],
    // nome do item no ERP - dá nome ao produto que saiu da tabela de preços
    descricao: ['Descrição', 'Descricao', 'Descrição Item', 'Desc.Item'],
  };
  // Colunas sem as quais uma linha não pode virar um item de pedido
  // oficial (cliente_codigo_oficial é NOT NULL no banco - ver schema.sql).
  const COLUNAS_OBRIGATORIAS = ['cliente_nome', 'cliente_codigo_oficial', 'nr_pedido', 'codigo_sku'];
  // Transportadora vem SEM cabeçalho na planilha oficial (confirmado com
  // um arquivo real) - é sempre a coluna logo depois de "Venda/Bonific",
  // com valores tipo "TRD", "EXPRESSO S M", "CORREIOS". Por posição, não
  // por nome - só usa esse fallback se a coluna seguinte realmente não
  // tiver título nenhum (senão, na aba Carteira, pegaria "Qt.Alocada" por
  // engano - lá a coluna depois de Venda/Bonific tem nome e é outra coisa).
  const COLUNAS_POSICIONAIS = {
    transportadora: { apos: ['Venda/Bonific', 'Venda / Bonific', 'Venda Bonific'] },
  };

  function normalizarNomeColuna(texto) {
    if (texto == null) return '';
    return String(texto).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]/g, '');
  }
  function acharIndiceColuna(cabecalhos, apelidos) {
    const normalizados = cabecalhos.map(normalizarNomeColuna);
    for (const apelido of apelidos) {
      const idx = normalizados.indexOf(normalizarNomeColuna(apelido));
      if (idx !== -1) return idx;
    }
    return -1;
  }
  // Acha, para cada campo lógico, o ÍNDICE da coluna real na planilha
  // (testando a lista de apelidos contra os cabeçalhos, mais o fallback
  // posicional pra Transportadora). Devolve índices, não nomes, porque a
  // Transportadora não tem nome de coluna nenhum pra usar como chave.
  function mapearColunas(cabecalhos, nomeAba) {
    const indices = {};
    const faltando = [];
    for (const campo of Object.keys(COLUNAS_RELATORIO_OFICIAL)) {
      let idx = acharIndiceColuna(cabecalhos, COLUNAS_RELATORIO_OFICIAL[campo]);
      const posicional = COLUNAS_POSICIONAIS[campo];
      if (idx === -1 && posicional) {
        const idxRef = acharIndiceColuna(cabecalhos, posicional.apos);
        const proximaColuna = idxRef !== -1 ? cabecalhos[idxRef + 1] : undefined;
        const proximaEstaVazia = proximaColuna == null || String(proximaColuna).trim() === '';
        if (idxRef !== -1 && proximaEstaVazia) idx = idxRef + 1;
      }
      indices[campo] = idx;
      if (idx === -1 && COLUNAS_OBRIGATORIAS.includes(campo)) faltando.push(campo);
    }
    if (faltando.length > 0) {
      throw new Error(
        `Aba "${nomeAba}": não encontrei a(s) coluna(s) ${faltando.join(', ')}. ` +
        `Colunas nesta planilha: ${cabecalhos.filter(Boolean).join(', ') || '(nenhuma - aba vazia?)'}.`
      );
    }
    return indices;
  }
  // ---- Datas e valores do relatório oficial ----
  // O ERP exporta data como "05/11/25" (dia/mês/ano) e valor como
  // "1207,296" (vírgula decimal). Se a planilha for aberta e salva num
  // Excel configurado em inglês (EUA), ela chega corrompida - aconteceu
  // com o relatório de 30/11/2025 (09/2026: 1.380 linhas de novembro com
  // data trocada/vazia e valor errado, corrigidas no banco):
  //  - data com dia <= 12 vira data numérica com DIA E MÊS TROCADOS
  //    (05/11 -> 11/05, em formato m/d/yy); dia > 12 fica como texto;
  //  - valor com 3 casas vira número mil vezes maior ("1207,296" ->
  //    1207296), os outros ficam como texto "974,58".
  // Data dá pra consertar com segurança (texto dd/mm é inequívoco, e a
  // presença dele prova que as datas numéricas da coluna foram
  // invertidas). Valor não: um número pode ser inteiro legítimo ou 1000x/
  // 10000x maior - nesse caso a importação recusa o arquivo.
  const RE_DATA_DDMM = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s*$/;
  const RE_VALOR_VIRGULA = /^\s*-?[\d.]*\d,\d+\s*$/;
  function dataTextoDDMMparaISO(texto) {
    const m = RE_DATA_DDMM.exec(String(texto));
    if (!m) return null;
    const dia = Number(m[1]), mes = Number(m[2]);
    let ano = Number(m[3]);
    if (ano < 100) ano += 2000;
    const d = new Date(Date.UTC(ano, mes - 1, dia));
    if (mes < 1 || mes > 12 || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
    return d.toISOString().slice(0, 10);
  }
  // Coluna de data "salva em Excel americano": tem pelo menos um texto
  // dd/mm/aa ao lado de datas numéricas.
  function colunaDataInvertida(dados, idx) {
    if (idx === -1) return false;
    return dados.some(r => typeof r[idx] === 'string' && RE_DATA_DDMM.test(r[idx]));
  }
  function paraDataISO(dataRaw, colunaInvertida) {
    if (dataRaw == null || dataRaw === '') return null;
    if (dataRaw instanceof Date) {
      if (isNaN(dataRaw.getTime())) return null;
      // SheetJS monta a data na meia-noite LOCAL: os campos locais são o
      // dia do calendário da planilha (toISOString voltaria um dia).
      let dia = dataRaw.getDate(), mes = dataRaw.getMonth() + 1;
      if (colunaInvertida && dia <= 12) [dia, mes] = [mes, dia];
      return `${dataRaw.getFullYear()}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    }
    return dataTextoDDMMparaISO(dataRaw);
  }
  function valorParaNumero(valorBruto) {
    if (valorBruto == null || valorBruto === '') return null;
    if (typeof valorBruto === 'number') return valorBruto;
    const texto = String(valorBruto).trim();
    const n = RE_VALOR_VIRGULA.test(texto) ? Number(texto.replace(/\./g, '').replace(',', '.')) : Number(texto);
    return Number.isFinite(n) ? n : null;
  }
  // "00597502" (zeros à esquerda, veio assim na aba Carteira do relatório
  // corrompido) e "597502" são o mesmo pedido - sem isso viravam duas linhas.
  function normalizarNrPedido(nr) {
    const t = String(nr ?? '').trim();
    return /^\d+$/.test(t) ? (t.replace(/^0+(?=\d)/, '')) : t;
  }

  // Lê uma aba (Carteira ou Faturamento) e devolve as linhas já no formato
  // esperado pelo servidor. `status` é 'carteira' pra aba Carteira e
  // 'faturado' pra aba Faturamento - o servidor nunca deixa um pedido
  // "voltar" de faturado pra carteira, então pode reimportar à vontade.
  // Lê em modo posicional (header:1 - array por linha, não objeto por
  // nome de coluna): é o que permite achar a Transportadora, que não tem
  // título de coluna nenhum na planilha oficial.
  function lerAbaRelatorioOficial(XLSX, wb, nomeAba, status, itensFora, classifsFora) {
    const sheet = wb.Sheets[nomeAba];
    if (!sheet) return 0; // aba ausente - só pula (relatório pode vir só com uma das duas)
    const linhas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, range: 2 });
    if (linhas.length < 2) return 0; // só cabeçalho (ou vazia)

    const cabecalhos = linhas[0];
    const dados = linhas.slice(1);
    const col = mapearColunas(cabecalhos, nomeAba);
    const campo = (r, nome) => (col[nome] === -1 ? null : r[col[nome]]);

    // Planilha salva em Excel americano (ver paraDataISO): datas se
    // consertam; valor misturando número e texto "974,58" não - recusa.
    const implInvertida = colunaDataInvertida(dados, col.data_implantacao);
    const emissaoInvertida = colunaDataInvertida(dados, col.data_emissao);
    if (col.valor !== -1) {
      const valores = dados.map(r => r[col.valor]).filter(v => v != null && v !== '');
      const temTextoVirgula = valores.some(v => typeof v === 'string' && RE_VALOR_VIRGULA.test(v));
      const temNumero = valores.some(v => typeof v === 'number');
      if (temTextoVirgula && temNumero) {
        throw new Error(
          `Aba "${nomeAba}": os valores desta planilha estão corrompidos - ela foi aberta e salva num Excel em inglês ` +
          `(parte dos valores virou número sem vírgula, até 10.000x maior, e parte ficou como texto "974,58"). ` +
          `Nada foi importado. Exporte o relatório de novo direto do sistema, sem abrir e salvar no Excel, ou salve com o Excel em português.`
        );
      }
    }

    let gravadas = 0;
    for (const r of dados) {
      const clienteNome = String(campo(r, 'cliente_nome') ?? '').trim();
      const clienteCodigo = String(campo(r, 'cliente_codigo_oficial') ?? '').trim();
      const nrPedido = normalizarNrPedido(campo(r, 'nr_pedido'));
      const codigoItem = String(campo(r, 'codigo_sku') ?? '').trim();
      if (!clienteNome || !clienteCodigo || !nrPedido || !codigoItem) continue; // linha em branco/rodapé

      const dataEmissaoISO = paraDataISO(campo(r, 'data_emissao'), emissaoInvertida);
      const dataImplantISO = paraDataISO(campo(r, 'data_implantacao'), implInvertida);
      const valorBruto = campo(r, 'valor');
      const notaFiscalBruta = campo(r, 'nota_fiscal');
      const classificatorioBruto = campo(r, 'classificatorio');

      itensFora.push({
        cliente_nome: clienteNome,
        cliente_codigo_oficial: clienteCodigo,
        nr_pedido: nrPedido,
        codigo_sku: codigoItem,
        quantidade: Number(campo(r, 'quantidade')) || 0,
        valor: valorParaNumero(valorBruto),
        data_implantacao: dataImplantISO,
        data_faturamento: status === 'faturado' ? dataEmissaoISO : null,
        nota_fiscal: notaFiscalBruta != null ? String(notaFiscalBruta) : null,
        classificatorio: classificatorioBruto ?? null,
        transportadora: campo(r, 'transportadora') ?? null,
        situacao_pedido: campo(r, 'situacao_pedido') ?? null,
        descricao: campo(r, 'descricao') != null ? String(campo(r, 'descricao')).trim() : null,
        status,
      });

      const classi = interpretarClassificatorio(classificatorioBruto);
      // Classificatório oscila - a data que decide qual é "a mais recente"
      // é a do Dt.Implant do pedido (não a de emissão/faturamento), pra
      // bater com a ordem em que os pedidos realmente entraram no sistema.
      if (classi) classifsFora.push({ nome: clienteNome, codigo_oficial: clienteCodigo, tipo: classi.tipo, desconto: classi.desconto, data_referencia: dataImplantISO });
      gravadas++;
    }
    return gravadas;
  }

  // Abas de pagamento à vista pendente do relatório oficial (conferidas
  // com o relatório real de 30/09/2026):
  //  - "Aguardando Pagamento": PEDIDOS ainda não liberados (mesmo layout
  //    da Carteira, Sit.Financeira "Aguardando Aprovacao"; não aparecem na
  //    aba Carteira), uma linha por item;
  //  - "Pendentes à Vista": TÍTULOS em aberto de pedido já faturado
  //    (Vencimento, Título = nº da nota fiscal, Parcela, Valor) - sem
  //    Nr.Pedido.
  // Cada uma é a foto do momento: o servidor troca a lista inteira a cada
  // relatório que traz a aba (sumiu dela = pago); sem a aba, não mexe. O
  // cabeçalho é procurado nas primeiras linhas.
  function ehAbaAguardandoPagamento(nomeAba) {
    const n = normalizarNomeColuna(nomeAba);
    return !n.includes('AVISTA') && /AGUARDANDOPAG|PENDENTESDEPAG|PENDENTEDEPAG|PENDENTESPAG|PENDENTEPAG/.test(n);
  }
  function ehAbaTitulosAvista(nomeAba) {
    return normalizarNomeColuna(nomeAba).includes('AVISTA');
  }
  const COLUNAS_TITULOS_AVISTA = {
    titulo: ['Título', 'Titulo', 'Nr.Título', 'Nº Título', 'Nota Fiscal', 'NF'],
    parcela: ['Parcela', 'Parc.', 'Parc'],
    vencimento: ['Vencimento', 'Dt.Vencimento', 'Dt. Vencimento', 'Data Vencimento', 'Vencto'],
    valor: ['Valor', 'Vlr.Título', 'Valor Título', 'Saldo'],
    cliente_codigo_oficial: COLUNAS_RELATORIO_OFICIAL.cliente_codigo_oficial,
    cliente_nome: COLUNAS_RELATORIO_OFICIAL.cliente_nome,
  };
  // Acha a aba e a linha de cabeçalho (a que tem a coluna-chave). Devolve
  // null sem a aba, { dados: [] } com a aba vazia (ninguém pendente) e
  // recusa aba com dados sem a coluna-chave.
  function lerAbaComCabecalho(XLSX, wb, ehAba, apelidosChave, nomeChave) {
    const nomeAba = wb.SheetNames.find(ehAba);
    if (!nomeAba) return null;
    const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, defval: null });
    const idxCab = linhas.slice(0, 10).findIndex(l => Array.isArray(l) && acharIndiceColuna(l, apelidosChave) !== -1);
    if (idxCab === -1) {
      if (linhas.every(l => !l || l.every(c => c == null || String(c).trim() === ''))) return { cab: [], dados: [] };
      throw new Error(`Aba "${nomeAba}": não encontrei a coluna ${nomeChave}. Nada foi importado.`);
    }
    return { cab: linhas[idxCab], dados: linhas.slice(idxCab + 1).filter(Boolean) };
  }
  const textoOuNull = (v) => (v != null && String(v).trim() !== '' ? String(v).trim() : null);
  function lerAbaAguardandoPagamento(XLSX, wb) {
    const aba = lerAbaComCabecalho(XLSX, wb, ehAbaAguardandoPagamento, COLUNAS_RELATORIO_OFICIAL.nr_pedido, 'do número do pedido (Nr.Pedido)');
    if (!aba) return null;
    const idx = (nome) => acharIndiceColuna(aba.cab, COLUNAS_RELATORIO_OFICIAL[nome]);
    const col = { nr: idx('nr_pedido'), cod: idx('cliente_codigo_oficial'), nome: idx('cliente_nome'), valor: idx('valor'), data: idx('data_implantacao') };
    const dataInvertida = colunaDataInvertida(aba.dados, col.data);
    const campo = (r, i) => (i === -1 ? null : r[i]);
    const pendentes = [];
    for (const r of aba.dados) {
      const nr = normalizarNrPedido(campo(r, col.nr));
      if (!nr || !/\d/.test(nr)) continue; // linha em branco/rodapé ("Total")
      pendentes.push({
        nr_pedido: nr,
        cliente_codigo_oficial: textoOuNull(campo(r, col.cod)),
        cliente_nome: textoOuNull(campo(r, col.nome)),
        valor: valorParaNumero(campo(r, col.valor)),
        data_implantacao: paraDataISO(campo(r, col.data), dataInvertida),
      });
    }
    return pendentes;
  }
  function lerAbaTitulosAvista(XLSX, wb) {
    const aba = lerAbaComCabecalho(XLSX, wb, ehAbaTitulosAvista, COLUNAS_TITULOS_AVISTA.titulo, 'do título (Título)');
    if (!aba) return null;
    const idx = (nome) => acharIndiceColuna(aba.cab, COLUNAS_TITULOS_AVISTA[nome]);
    const col = { titulo: idx('titulo'), parcela: idx('parcela'), venc: idx('vencimento'), valor: idx('valor'), cod: idx('cliente_codigo_oficial'), nome: idx('cliente_nome') };
    const vencInvertido = colunaDataInvertida(aba.dados, col.venc);
    const campo = (r, i) => (i === -1 ? null : r[i]);
    const titulos = [];
    for (const r of aba.dados) {
      const titulo = normalizarNrPedido(campo(r, col.titulo));
      if (!titulo || !/\d/.test(titulo)) continue;
      titulos.push({
        titulo,
        parcela: textoOuNull(campo(r, col.parcela)),
        cliente_codigo_oficial: textoOuNull(campo(r, col.cod)),
        cliente_nome: textoOuNull(campo(r, col.nome)),
        vencimento: paraDataISO(campo(r, col.venc), vencInvertido),
        valor: valorParaNumero(campo(r, col.valor)),
      });
    }
    return titulos;
  }

  // Lê o arquivo .xlsx do relatório oficial (abas "Carteira" e/ou
  // "Faturamento", mais as de pagamento à vista pendente) e devolve
  // { itens, classificacoes, pendentesPagamento, titulosAvista } prontos pra
  // POST /api/pedidos-oficiais/importar.
  function lerRelatorioOficial(XLSX, dados) {
    const wb = XLSX.read(dados, { type: 'array', cellDates: true });

    const itens = [];
    const classificacoesBrutas = []; // pode ter repetição do mesmo cliente entre as duas abas
    const linhasCarteira = lerAbaRelatorioOficial(XLSX, wb, 'Carteira', 'carteira', itens, classificacoesBrutas);
    const linhasFaturamento = lerAbaRelatorioOficial(XLSX, wb, 'Faturamento', 'faturado', itens, classificacoesBrutas);
    const pendentesPagamento = lerAbaAguardandoPagamento(XLSX, wb);
    const titulosAvista = lerAbaTitulosAvista(XLSX, wb);

    if (linhasCarteira === 0 && linhasFaturamento === 0 && pendentesPagamento === null && titulosAvista === null) {
      throw new Error('Não encontrei as abas "Carteira", "Faturamento", "Aguardando Pagamento" ou "Pendentes à Vista" nesta planilha (ou vieram vazias). Abas encontradas: ' + wb.SheetNames.join(', '));
    }

    // dedup de classificação por cliente, ficando com a de data mais
    // recente - chave por codigo_oficial (Cod.Cliente), nunca por nome:
    // dois clientes reais podem ter o mesmo nome com CNPJ/código
    // diferentes, e deduplicar por nome misturaria a classificação de um
    // com a do outro.
    const classificacoesMap = new Map();
    for (const c of classificacoesBrutas) {
      const chave = c.codigo_oficial || c.nome;
      const atual = classificacoesMap.get(chave);
      if (!atual || (c.data_referencia && (!atual.data_referencia || c.data_referencia > atual.data_referencia))) {
        classificacoesMap.set(chave, c);
      }
    }
    return { itens, classificacoes: Array.from(classificacoesMap.values()), pendentesPagamento, titulosAvista };
  }

  // Traduz o texto do classificatório ("Varejo Master (20)", "Rede", "Locação")
  // pro par {tipo, desconto}. "Locação" fica sem classificação de propósito -
  // não é uma categoria de cliente de verdade, é aluguel de ferramenta.
  function interpretarClassificatorio(valor) {
    if (!valor) return null;
    const texto = String(valor).trim();
    if (texto === 'Locação') return { tipo: 'Locação', desconto: 12 }; // vem sem número na planilha
    const comParenteses = texto.match(/^(.*?)\s*\((\d+)\)\s*$/);
    if (comParenteses) return { tipo: comParenteses[1].trim(), desconto: Number(comParenteses[2]) };
    if (texto === 'Rede') return { tipo: 'Rede', desconto: 18 }; // não vem com número na planilha
    return { tipo: texto, desconto: null };
  }

  function acharIndiceColunaClassi(cabecalhos, nomes) {
    const normalizados = cabecalhos.map(h => String(h || '').trim().toLowerCase());
    for (const nome of nomes) {
      const idx = normalizados.indexOf(nome.toLowerCase());
      if (idx !== -1) return idx;
    }
    return -1;
  }
  // Lê a planilha "Classificatorio" exportada do ERP (aba "Cliente") - traz
  // o agrupamento por Matriz/empresas-irmãs e metas individuais (PIC/Vl.Acordo)
  // que não existem no relatório de Carteira/Faturamento. Ignora a maioria das
  // linhas (a maior parte dos clientes não tem classificatório relevante aqui).
  function lerClassificatorio(XLSX, dados) {
    const wb = XLSX.read(dados, { type: 'array', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const linhas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

    let headerIdx = -1;
    for (let i = 0; i < Math.min(linhas.length, 10); i++) {
      if ((linhas[i] || []).some(c => String(c || '').trim().toLowerCase() === 'classificatorio')) { headerIdx = i; break; }
    }
    if (headerIdx === -1) throw new Error('Não encontrei a coluna "Classificatorio" nesta planilha — confira se é o arquivo certo.');
    const cabecalhos = linhas[headerIdx];
    const idxCod = acharIndiceColunaClassi(cabecalhos, ['cod.cliente', 'cod']);
    const idxMatriz = acharIndiceColunaClassi(cabecalhos, ['matriz']);
    const idxClassi = acharIndiceColunaClassi(cabecalhos, ['classificatorio']);
    const idxCnpj = acharIndiceColunaClassi(cabecalhos, ['cnpj']);
    const idxPic = acharIndiceColunaClassi(cabecalhos, ['pic']);
    const idxVlAcordo = acharIndiceColunaClassi(cabecalhos, ['vl.acordo', 'vlacordo']);
    // Números financeiros da apuração do ERP (foto mostrada no card do
    // cliente, aba Clientes). Ano anterior, acumulado e "Faturamento" (12
    // meses) são da MATRIZ inteira no ERP; "Fat.Cliente" é só do cliente.
    const idxFatAnoAnterior = acharIndiceColunaClassi(cabecalhos, ['fat.ano anterior']);
    const idxFatAcumulado = acharIndiceColunaClassi(cabecalhos, ['fat.acumulado']);
    const idxFatCliente = acharIndiceColunaClassi(cabecalhos, ['fat.cliente']);
    const idxFatMatriz = acharIndiceColunaClassi(cabecalhos, ['faturamento']);
    const idxDiferenca = acharIndiceColunaClassi(cabecalhos, ['diferenca', 'diferença']);
    const idxGestor = acharIndiceColunaClassi(cabecalhos, ['gestor']);
    const idxSituacao = acharIndiceColunaClassi(cabecalhos, ['situacao', 'situação']);
    const idxCidade = acharIndiceColunaClassi(cabecalhos, ['cidade']);
    const idxUf = acharIndiceColunaClassi(cabecalhos, ['uf']);
    const idxCadastro = acharIndiceColunaClassi(cabecalhos, ['dt.cadastro']);
    const idxUltCompra = acharIndiceColunaClassi(cabecalhos, ['ult.compra']);
    const col = (r, idx) => (idx !== -1 ? r[idx] : null);
    const textoCol = (r, idx) => { const v = col(r, idx); return v == null || String(v).trim() === '' ? null : String(v).trim(); };
    if (idxCod === -1 || idxClassi === -1 || idxCnpj === -1) {
      throw new Error('Colunas esperadas não encontradas (Cod.Cliente/Classificatorio/CNPJ) — confira o arquivo.');
    }

    const itens = [];
    for (let i = headerIdx + 1; i < linhas.length; i++) {
      const r = linhas[i];
      if (!r) continue;
      const interpretado = interpretarClassificatorio(r[idxClassi]);
      if (!interpretado) continue;
      itens.push({
        codigoOficial: r[idxCod] != null ? String(r[idxCod]) : null,
        cnpj: r[idxCnpj] != null ? String(r[idxCnpj]) : null,
        matrizGrupo: idxMatriz !== -1 && r[idxMatriz] ? String(r[idxMatriz]).trim() : null,
        classificatorioTipo: interpretado.tipo,
        classificatorioDesconto: interpretado.desconto,
        pic: idxPic !== -1 ? !!r[idxPic] : false,
        vlAcordo: idxVlAcordo !== -1 && r[idxVlAcordo] ? Number(r[idxVlAcordo]) : null,
        fatAnoAnterior: valorParaNumero(col(r, idxFatAnoAnterior)),
        fatAcumulado: valorParaNumero(col(r, idxFatAcumulado)),
        fat12mCliente: valorParaNumero(col(r, idxFatCliente)),
        fat12mMatriz: valorParaNumero(col(r, idxFatMatriz)),
        diferenca: valorParaNumero(col(r, idxDiferenca)),
        gestor: textoCol(r, idxGestor),
        situacao: textoCol(r, idxSituacao),
        cidade: textoCol(r, idxCidade),
        uf: textoCol(r, idxUf),
        clienteDesde: paraDataISO(col(r, idxCadastro)),
        ultimaCompra: paraDataISO(col(r, idxUltCompra)),
      });
    }
    if (itens.length === 0) throw new Error('Nenhuma linha com classificatório encontrada nesta planilha.');
    return itens;
  }
  // Data do relatório pelo nome do arquivo exportado do ERP
  // ("02.10.2026_RUSSOS_..._Classificatorio.xlsx"); sem data no nome, vale
  // a de hoje (quem importa costuma subir o relatório do dia).
  function dataRelatorioClassificatorio(nomeArquivo) {
    const m = String(nomeArquivo || '').match(/(\d{2})[.\-_](\d{2})[.\-_](\d{4})/);
    if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[1]) >= 1 && Number(m[1]) <= 31) return `${m[3]}-${m[2]}-${m[1]}`;
    const hoje = new Date();
    return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
  }

  // Lê a planilha de previsão de estoque (relatório tipo ESCE007) e monta um
  // mapa código → dados de previsão. Aceita qualquer nome de arquivo, só
  // espera as colunas: Item, Qt. Disp., Qt. Carteira, Qt. Compra, Previsão, Saldo.
  function lerPrevisao(XLSX, dados) {
    const wb = XLSX.read(dados, { type: 'array', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const linhas = XLSX.utils.sheet_to_json(sheet, { defval: null });
    const mapa = {};
    linhas.forEach(r => {
      const codigo = String(r['Item'] ?? '').trim();
      if (!codigo) return;
      let previsaoISO = null;
      const previsaoRaw = r['Previsão'];
      if (previsaoRaw && previsaoRaw !== 'Sem Previsão') {
        // texto "05/11/2026" é dia/mês (new Date lia como americano: 11 de maio;
        // "15/10/2026" virava data inválida) - mesma leitura das outras planilhas
        const texto = typeof previsaoRaw === 'string' ? previsaoRaw.trim() : '';
        previsaoISO = /^\d{4}-\d{2}-\d{2}/.test(texto) ? texto.slice(0, 10) : paraDataISO(previsaoRaw);
      }
      mapa[codigo] = {
        qtDisponivel: Number(r['Qt. Disp.']) || 0,
        qtCarteira: Number(r['Qt. Carteira']) || 0,
        qtCompra: Number(r['Qt. Compra']) || 0,
        previsao: previsaoISO,
        saldo: Number(r['Saldo']) || 0,
      };
    });
    return mapa;
  }

  // ---- Reconhecimento do tipo de planilha ----
  // Pelas abas e colunas (as mesmas marcas que cada leitor exige), do mais
  // específico pro mais genérico. Devolve 'precos' | 'relatorio' |
  // 'objetivos' | 'classificatorio' | 'previsao' | 'videos' | 'linkSite' | null.
  function normalizarRotuloImport(v) {
    return String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
  }
  function detectarTipoPlanilha(XLSX, dados) {
    // sheetRows: só as primeiras linhas de cada aba - basta pra achar o
    // cabeçalho, e não pesa com a planilha de preços (milhares de linhas).
    const wb = XLSX.read(dados, { type: 'array', sheetRows: 12 });
    const abas = wb.SheetNames.map(normalizarRotuloImport);
    if (abas.includes('PRECIFICACAO') && abas.includes('TRIBUTACAO')) return 'precos';
    if (abas.includes('CARTEIRA') || abas.includes('FATURAMENTO') || wb.SheetNames.some(n => ehAbaAguardandoPagamento(n) || ehAbaTitulosAvista(n))) return 'relatorio';

    const nomeAba = wb.SheetNames.includes('Export') ? 'Export' : wb.SheetNames[0];
    const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, defval: null });
    const celulas = new Set(linhas.slice(0, 10).flat().filter(c => c != null).map(normalizarRotuloImport));
    const tem = (rotulo) => celulas.has(rotulo);

    if (tem('MATRIZ') && [...celulas].some(c => c.startsWith('OBJETIVO'))) return 'objetivos';
    if (tem('CLASSIFICATORIO')) return 'classificatorio';
    if (tem('ITEM') && tem('QT. DISP.')) return 'previsao';
    if (tem('CODIGO') && (tem('YOUTUBE') || tem('INSTAGRAM'))) return 'videos';
    if (tem('CODIGO') && tem('LINK')) return 'linkSite';
    return null;
  }

  return {
    detectarTipoPlanilha, lerRelatorioOficial, lerClassificatorio, lerPrevisao, dataRelatorioClassificatorio,
    interpretarClassificatorio, paraDataISO, valorParaNumero, normalizarNrPedido,
  };
});
