# Brag Plan (versão longa): Cortag Revolution Tools

Pedido do usuário: "uma versão mais longa mostrando mais recursos, alertas, gráficos". Passa de propósito da janela de 15–25 s do /brag: 44,5 s, landscape 1920×1080, mesmo tom, trilha (vol-1, 120 BPM) e identidade da versão curta (`brag-plan.md`). Composição: `composition-longa/`.

## Storyboard
| # | Tempo | Cena | Fonte no projeto |
|---|---|---|---|
| 1 | 0–3,0 | Gancho: tabela impressa / planilha / calculadora riscadas → "Um app só." | CLAUDE.md |
| 2 | 3,0–5,2 | Logo + "O app de vendas em campo." | logo do `index.html` |
| 3 | 5,5–9,5 | Preço: busca "cortador hd", 4 cortadores, "+ Adicionar" | `catalogo-embutido.js` |
| 4 | 9,5–14,0 | Levantamento sem internet, 3 leituras, "Comprados e não contados" | CLAUDE.md (PR #129) |
| 5 | 14,0–17,5 | Card do cliente, meta do trimestre, sugestões de recompra | `.clienteCard`, PR #118 |
| 6 | 17,5–22,0 | **Recompra da semana**: atrasado / fora do ritmo / prevista, "Montar proposta · 4 itens" | `renderRecompraItem`/`seloRecompra` |
| 7 | 22,0–27,8 | **Alertas**: push "Relatório oficial atualizado · Pedidos até 03/10", faixa "2 novidades · Relatório, Preços", pedido bloqueado · Limite Crédito, "À vista · aguardando pagamento", "Saldo abaixo do mínimo de R$ 300,00" | CLAUDE.md (novidades, e-mails, saldo mínimo) |
| 8 | 28,0–33,9 | **Dashboard**: Valor Entrada de Pedidos Mês, Qtde. Pedidos Mês, Qtde. Clientes Mês, Ticket médio; gráfico "Qtde. Clientes Mês"; Curva ABC | `curva-abc.html` |
| 9 | 34,0–38,5 | **Calculadora**: peça 60×60, 12 m² → 134 espaçadores, "Adicionar ao orçamento" | `calculadora-materiais.html` (exemplo calibrado no próprio código) |
| 10 | 38,5–40,75 | "Enviar no WhatsApp" → "Enviado" | CLAUDE.md (CSV direto pro WhatsApp) |
| 11 | 41,0–44,5 | Logo + "Um passo a menos pra quem está na rua vendendo." | CLAUDE.md |

Beat-locks: 3,02 · 15,02 · 20,49 · 36,97 · 39,46 · 40,96 (logo final).

## Dados fictícios / ilustrativos (sem dado real de cliente)
Clientes (DEPÓSITO SÃO JOSÉ, CASA DO CONSTRUTOR LUZ, MATERIAIS BELA VISTA), números de pedido, valores de pedido, datas da recompra e todos os números do Dashboard (KPIs, barras, percentuais da Curva ABC) são ilustrativos. Produtos, códigos, EANs, preços de lista, textos de tela, regra de R$ 300 e o resultado da calculadora (134) vêm do projeto.
