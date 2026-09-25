# Post-mortem: pedidos confirmados sem cobrança

| | |
| --- | --- |
| **Status** | Causa identificada. Correção definitiva descrita, **não aplicada** (o defeito é mantido como objeto de estudo) |
| **Severidade** | Alta: perda financeira direta, invisível ao cliente e ao monitoramento existente |
| **Período reproduzido** | 25/09/2026, 15:50:32 a 15:55:31 (BRT, -03), 5 minutos de `cenario-a` depois de 3 minutos de `normal` |
| **Evidências brutas** | [`reports/evidencias/`](evidencias/) |

## Resumo

Quando o processador de pagamento falha com exceção, em vez de aprovar ou recusar, o worker grava o pedido como **confirmado** mesmo sem ter cobrado nada. O cliente recebe sucesso e o pedido aparece confirmado, e toda a telemetria de caixa preta (HTTP 2xx, latência, disponibilidade) fica verde. Na reprodução, **228 pedidos (R$ 227.523,15)** foram confirmados sem cobrança em 5 minutos. A nova instrumentação passou a expor o problema, e o alerta `FalhaEmCobrancas`, derivado do SLO, detectou o problema em cerca de **2 minutos**, enquanto hoje ele só é descoberto no fechamento do mês.

## Impacto

No período reproduzido (5 minutos de `cenario-a`, pedidos 421 a 964):

| Grandeza | Valor | Fonte | Precisão |
| --- | --- | --- | --- |
| Pedidos confirmados sem cobrança | **228** | Log: linhas `level=error` "falha ao processar pagamento", 228 `pedido_id` distintos ([log.txt](evidencias/log.txt) §2) | Exata |
| Pedidos confirmados sem cobrança | **228** | Banco: os 228 `pedido_id` do log estão todos com `status = 'confirmado'` ([banco.txt](evidencias/banco.txt) §1) | Exata |
| Pedidos confirmados sem cobrança | **228** | Jaeger: 228 traces com `pedido.processar` marcado como erro no período ([jaeger.txt](evidencias/jaeger.txt) §4) | Exata |
| Pedidos confirmados sem cobrança | **228** | Prometheus: valor bruto de `cobrancas_processadas_total{resultado="falha"}`, de 0 no fim da linha de base para 228 no fim ([prometheus.txt](evidencias/prometheus.txt) §2) | Exata: é a leitura do contador, com o processo estável e a última raspagem já depois do último evento |
| Pedidos confirmados sem cobrança | **≈ 226,3** | Prometheus: `sum by (resultado) (increase(cobrancas_processadas_total[5m]))` ([prometheus.txt](evidencias/prometheus.txt) §1) | **Estimativa**: o `increase()` extrapola as amostras para as bordas da janela, e por isso diverge em cerca de 2 pedidos |
| **Valor não cobrado** | **R$ 227.523,15** | Soma de `valor_total` nas linhas de erro do log, igual à soma de `pedidos.valor_total` desses 228 ids no banco | Exata. **A métrica não responde isso**: os contadores medem quantos pedidos, não quanto dinheiro |
| Contexto | 544 pedidos criados, 507 confirmados (R$ 511.160,80) e 37 recusados legitimamente | Banco, ids 421 a 964 ([banco.txt](evidencias/banco.txt) §2) | Exata |

- **45% dos pedidos confirmados no período (228 de 507)** e 44,5% do valor "confirmado" (R$ 227.523,15 de R$ 511.160,80) **não tiveram cobrança**.
- **Nenhum erro visível para o cliente:** 0 respostas 5xx no período, e todos os `POST /pedidos` responderam 202. Consultado depois, o pedido responde `"status":"confirmado"` ([jaeger.txt](evidencias/jaeger.txt) §3).
- **A métrica e o valor em dinheiro:** a métrica responde *quantos* pedidos foram afetados, e agora em tempo real. Ela não responde *quanto dinheiro* nem *quais pedidos*. Essas duas respostas vieram do log (que carrega `pedido_id` e `valor_total`) e do banco. É a divisão de trabalho esperada: identificador e valor são alta cardinalidade, que é barata no log e no trace e proibitiva em label de métrica.
- **O mês que o financeiro fechou:** não é quantificável retroativamente com a telemetria. Antes desta instrumentação, o único registro da falha era um buffer em memória (`registrarFalhaLegado`), perdido a cada reinício. No banco, os pedidos anteriores à reprodução não têm a assinatura observada (confirmado e cliente com id terminado em 7: 0 pedidos, [banco.txt](evidencias/banco.txt) §3). A reconciliação do mês real precisa cruzar os pedidos confirmados com o extrato do processador de pagamento (item de ação 2).

## Detecção

- **Como foi descoberto hoje:** pelo financeiro, no fechamento do mês, ao cruzar os pedidos confirmados com o que efetivamente entrou.
  - O Grafana foi consultado e não mostrou nada, porque só havia sinais de caixa preta: tráfego, latência e status HTTP, todos normais.
  - Sem dado que apontasse outra coisa, circulou a hipótese "deve ser problema do banco".
  - **Tempo até a detecção: até cerca de 30 dias.**
- **Quanto o alerta leva, medido na reprodução** ([timeline-reproducao.txt](evidencias/timeline-reproducao.txt)):

  | Marco | Horário | Desde o início do `cenario-a` |
  | --- | --- | --- |
  | Início do `cenario-a`, primeira falha às 15:50:33 | 15:50:32 | 0 s |
  | A proporção de falhas cruza 14,4% (regra `pending`) | 15:51:26 | +56 s |
  | Condição mantida pelo `for: 1m` (regra `firing`) | 15:52:26 | +116 s |
  | Webhook `alerta=FalhaEmCobrancas status=firing` no `receptor-alertas` | 15:52:37 | **+127 s** |

  - O maior componente é a **diluição da janela**: o `rate(...[2m])` ainda carregava 2 minutos de tráfego saudável da linha de base, e a proporção precisou subir até 14,4% (no disparo ela estava em 43%).
  - Depois vêm o `for` de 1 minuto e o `group_wait` de 10 segundos do Alertmanager.
  - Nos 3 minutos de `normal` anteriores, **nenhum alerta** foi recebido.
- **O que essa diferença significa:**
  - **O custo é proporcional ao tempo de detecção.** No ritmo da reprodução, cerca de 46 pedidos e R$ 45 mil por minuto sem cobrança, 2 minutos de detecção limitam a exposição a algo na ordem de R$ 100 mil, contra um mês inteiro acumulando.
  - **Muda quem descobre.** Antes era o financeiro, depois do fato, sem ter como agir. Agora é quem está de plantão, durante o incidente, com o trace e o log apontando o pedido e a linha de código.
  - **A lição de fundo:** o problema nunca foi falta de dado. O código sabia de cada falha e não contava a ninguém.

## Causa raiz

**Arquivo:** `src/worker/conciliacao.ts`. **Função:** `decidirStatusDoPedido`.

Trecho original, do projeto base e sem a instrumentação:

```ts
export async function decidirStatusDoPedido(
  clienteId: string,
  valorTotal: number
): Promise<StatusDoPedido> {
  let recusado = false;

  try {
    const resultado = await processarPagamento(clienteId, valorTotal);
    recusado = !resultado.aprovado;
  } catch (erro) {
    registrarFalhaLegado(erro);
  }

  return recusado ? 'recusado' : 'confirmado';
}
```

- **O mecanismo:** o estado padrão é de sucesso (`recusado = false`), e o `catch` engole a exceção.
  - A decisão só é tomada no caminho feliz. Quando `processarPagamento` lança, `recusado` continua `false`, e a função devolve `'confirmado'`: o sistema falha aberto.
  - O `catch` não relança, não muda o status e não deixa rastro observável. `registrarFalhaLegado` guarda a ocorrência num array em memória de no máximo 500 posições, que nenhuma rota expõe e que se perde a cada reinício.
  - O tipo `StatusDoPedido` só tem `'confirmado' | 'recusado'`, então não existe no modelo um estado para "cobrança não concluída".
- **O gatilho:** o processador de pagamento responde com erro ("gateway respondeu de forma inesperada") para um subconjunto de clientes. Na reprodução, 100% das 228 falhas foram de clientes com `cliente_id` terminado em 7 ([log.txt](evidencias/log.txt) §3).
  - O gatilho explica **quais** pedidos falham. A causa raiz é o que o sistema faz **com** a falha: qualquer instabilidade do gateway, para qualquer cliente, teria o mesmo efeito.
- **Como chegamos aqui:** pela telemetria, antes de abrir o código.
  1. A métrica mostrou confirmados maior que aprovadas.
  2. O log mostrou a linha de erro com o `pedido_id`.
  3. O trace do mesmo pedido mostrou, no span `pedido.processar`, `cobranca.resultado=falha` junto com `pedido.status=confirmado`.
  4. O evento `exception` do span estava dentro de `decidirStatusDoPedido`.

  O código foi aberto só para confirmar o lugar que a evidência apontou.

## Evidências

**1. Trace no Jaeger: `766470c0bf85b2f23cad5fea83271e00`**, que é o primeiro pedido do `cenario-a`, o pedido 421 (http://localhost:16686/trace/766470c0bf85b2f23cad5fea83271e00):

```
[api]    POST /pedidos
[api]    └─ pedido.criar        pedido.id=421 cliente.id=cli-0367 pedido.valor_total=1108.31
[api]       ├─ lpush            (publicação na fila, com traceparent na mensagem)
[worker]    └─ pedido.processar error=true  cobranca.resultado=falha  pedido.status=confirmado
                                evento exception: Error: gateway respondeu de forma inesperada
[worker]       └─ pg.query:UPDATE
```

Resultado: um único trace, com 20 spans dos serviços `api` e `worker` e um só `trace_id`. O mesmo span registra que a cobrança falhou e que o pedido foi confirmado. No período, a busca `service=worker, operation=pedido.processar, tags error=true` devolveu **228 traces** ([jaeger.txt](evidencias/jaeger.txt); JSON completo do trace em [trace-766470c0.json](evidencias/trace-766470c0.json)).

**2. Query PromQL**, que é o SLI usado pelo alerta:

```promql
sum(rate(cobrancas_processadas_total{resultado="falha"}[2m]))
/
sum(rate(cobrancas_processadas_total[2m]))
```

Resultado: **0** no fim da linha de base (15:50:31) e **0,43** no disparo do alerta (15:52:26). A contagem do período veio de:

```promql
sum by (resultado) (increase(cobrancas_processadas_total[5m]))   # em 15:55:31
```

Resultado: `aprovada=283.16  recusada=35.79  falha=226.32`, uma estimativa por extrapolação, contra 228 exatos no contador bruto ([prometheus.txt](evidencias/prometheus.txt)).

**3. Busca no log:**

```sh
docker compose logs --no-log-prefix api worker | grep 766470c0bf85b2f23cad5fea83271e00
```

Resultado: 4 linhas dos dois processos, que contam a história do pedido 421 em ordem:
```
api     info   pedido 421 criado para cli-0367
worker  info   mensagem do pedido 421 recebida da fila
worker  error  falha ao processar pagamento: gateway respondeu de forma inesperada   valor_total=1108.31
worker  info   pedido 421 ficou confirmado
```

Para o período inteiro:

```sh
docker compose logs --no-log-prefix worker \
  | jq -s '[.[] | select(.level=="error" and (.msg|startswith("falha ao processar pagamento")))]
           | {linhas: length, pedidos_distintos: (map(.pedido_id)|unique|length), valor_total: (map(.valor_total)|add)}'
```

Resultado: `{"linhas": 228, "pedidos_distintos": 228, "valor_total": 227523.15}`. Todos os 228 foram seguidos de "ficou confirmado" ([log.txt](evidencias/log.txt)).

## Lições aprendidas

**O que correu bem**

- **A correlação entre log e trace transformou um número agregado em casos individuais.** A métrica disse "tem diferença", o log deu os `pedido_id` e o `valor_total`, e o trace mostrou o caminho completo do pedido da api ao worker. Foram três sinais apontando o mesmo lugar.
- **As quatro fontes independentes concordaram:** contador, log, traces com erro e banco deram exatamente 228. Onde houve divergência (o `increase()` com 226,3), ela foi explicada.
- **Declarar o SLO antes do limiar funcionou.** O alerta ficou em silêncio no tráfego normal, incluindo as recusas legítimas, e disparou em cerca de 2 minutos no incidente.
- **A investigação foi feita sem corrigir o defeito,** e por isso a evidência pôde ser reproduzida quantas vezes fosse preciso.

**O que correu mal**

- **O sistema falhava aberto.** Uma exceção no pagamento virava sucesso por padrão, e o modelo de status não tinha como representar "não cobrado".
- **A falha era registrada num lugar que ninguém lê:** um buffer em memória, sem log, sem métrica e sem span. O sistema sabia e não contava.
- **O monitoramento era só de caixa preta.** HTTP 2xx e latência estavam normais durante todo o incidente, e ainda estão, conforme os painéis de 5xx e de latência. Não havia nenhuma métrica de negócio que comparasse o prometido (confirmado) com o realizado (cobrado).
- **A detecção dependeu de um processo mensal e manual** do financeiro. Na ausência de dados, a primeira explicação que circulou foi um palpite ("problema do banco"), e não havia como confirmá-lo ou descartá-lo.

**Onde tivemos sorte**

- **O processador de pagamento sinaliza a falha lançando uma exceção,** e não aprovando em silêncio ou demorando indefinidamente. Havia um único ponto no código (o `catch`) onde instrumentar capturou 100% dos casos.
- **A falha se concentra num subconjunto identificável de clientes** (todos os 228 com id terminado em 7). Isso torna a reconciliação e o contato com os clientes viáveis.
- **O pedido guarda `valor_total` no banco.** A perda é quantificável ao centavo a partir do `pedido_id`, mesmo sem uma métrica de valor.

## Itens de ação

| # | Ação | Tipo | Prioridade |
| - | ---- | ---- | ---------- |
| 1 | **Correção definitiva** em `decidirStatusDoPedido`: uma exceção do processador não pode resultar em `confirmado`. Tratar a falha como estado explícito, por exemplo acrescentando `pagamento_pendente` a `StatusDoPedido` com nova tentativa e limite, ou recusando. O estado inicial deixa de ser "sucesso por padrão" e a decisão passa a ser tomada nos três caminhos (aprovada, recusada, falha). *Descrita, não executada neste desafio.* | Evitar | P0 |
| 2 | **Reconciliar os pedidos já afetados:** cruzar os pedidos `confirmado` do mês com o extrato do processador, cobrar novamente ou contatar os clientes, e só então liberar a expedição. Para o período reproduzido, a lista exata está no log (228 `pedido_id`). | Mitigar | P0 |
| 3 | **Levar a regra `FalhaEmCobrancas` e o dashboard Pedidos para produção,** com roteamento para quem está de plantão. Em produção, com mais volume, evoluir para alerta de burn rate em múltiplas janelas (1h/5m e 6h/30m). | Mitigar | P1 |
| 4 | **Alertar sobre o invariante de negócio:** `increase(pedidos_confirmados_total[10m]) - increase(cobrancas_processadas_total{resultado="aprovada"}[10m]) > 0` de forma sustentada. Isso pega qualquer caminho futuro que confirme sem cobrar, e não só exceção do gateway. | Mitigar | P1 |
| 5 | **Persistir a autorização do pagamento no pedido** (o `autorizacao` que o processador já devolve) e rodar uma reconciliação automática diária entre pedidos confirmados e autorizações. O que hoje depende do fechamento mensal passa a ser verificado todo dia. | Evitar | P1 |
| 6 | **Aposentar `registrarFalhaLegado`** em favor do padrão adotado (exceção registrada no span, com status de erro e `log.error`). Adotar regra de revisão ou lint que proíba `catch` que não relança nem registra. | Evitar | P2 |
| 7 | **Abrir análise com o provedor do gateway** sobre as respostas inesperadas para o grupo de clientes afetado (todos com id terminado em 7). | Evitar | P2 |
| 8 | **Criar a métrica de valor** `cobrancas_valor_total{resultado}` (contador em reais, com o mesmo label de baixa cardinalidade). Assim, "quanto dinheiro" também passa a ser respondido pela métrica, sem depender do log. | Mitigar | P2 |

## Timeline

Horários em BRT (-03), 25/09/2026, salvo indicação. Os marcos da reprodução estão em [timeline-reproducao.txt](evidencias/timeline-reproducao.txt), e os da instrumentação nos horários dos commits.

**O incidente (antes desta investigação)**

| Quando | O quê |
| --- | --- |
| Durante o mês | Pedidos de parte dos clientes são confirmados sem cobrança. Nenhum sinal: HTTP 2xx, e a falha fica só no buffer em memória `registrarFalhaLegado`. |
| Fechamento do mês | O financeiro cruza os confirmados com o que entrou e encontra a diferença. O Grafana é consultado e não mostra nada, e circula a hipótese "problema do banco". |

**A investigação**

| Horário | O quê |
| --- | --- |
| ~14:10 | Stack no ar. Levantamento do ponto de partida: log sem `trace_id`, api e worker em traces separados no Jaeger, série `route="/produtos/42"` no `/metrics`. |
| 14:22 | Log ligado ao trace (`trace_id`, `span_id`, `pedido_id`) (commit `05a169e`). |
| 14:24 | Cardinalidade corrigida: o label `route` passa a usar o template da rota (commit `2a85b28`). |
| 15:07:24 a 15:08:30 | Primeiro teste com as métricas de negócio, 60 s de `normal`: confirmados 115 = aprovadas 115, falha 0. |
| 15:08:35 a 15:09:41 | 60 s de `cenario-a`. **Primeiro sinal do problema:** 103 confirmados contra 54 aprovadas, 49 falhas, e **nenhuma linha de log de erro**. Pergunta levantada: que pedidos são esses? |
| 15:09 | Métricas de negócio no commit `162c309`. |
| 15:18 | Spans `pedido.criar` e `pedido.processar`, propagação pela fila e registro de exceções (commit `c699b37`). Um pedido de teste de cliente terminado em 7 (264) produz o primeiro trace com `cobranca.resultado=falha` e `pedido.status=confirmado` no mesmo span. |
| 15:36 | Dashboard Pedidos com os 4 painéis (commit `65d1709`). |
| 15:38 a 15:43 | SLO declarado e regra `FalhaEmCobrancas` criada. Teste: silêncio em 3 min de `normal`, disparo em 118 s de `cenario-a` (commit `0d9c8d8`). |
| 15:46:50 | **Reprodução controlada:** `docker compose down -v`, estado zerado. |
| 15:47:15 | Stack no ar, com 24 pedidos históricos do seed. |
| 15:47:19 a 15:50:29 | Linha de base: `normal` por 3 min, 396 pedidos (25 a 420), 0 falhas, 0 alertas no receptor. |
| 15:50:32 | Início do `cenario-a`. |
| 15:50:33 | Primeira falha: pedido 421, trace `766470c0…`, confirmado sem cobrança. |
| 15:51:26 | `FalhaEmCobrancas` em `pending` (+56 s). |
| 15:52:26 | `FalhaEmCobrancas` em `firing` (+116 s), com o SLI em 43%. |
| 15:52:37 | Alerta recebido no `receptor-alertas` (+127 s). |
| 15:55:30 | Última falha registrada (pedido do fim do período). |
| 15:55:31 | Fim do `cenario-a`: 544 pedidos criados, 228 confirmados sem cobrança. |
| 15:56 em diante | Coleta de evidências: queries no Prometheus, busca no log, trace no Jaeger e conferência no banco. As quatro fontes concordam em 228 pedidos e R$ 227.523,15. Causa raiz localizada a partir do evento `exception` do span `pedido.processar`. |
