# Loja de pedidos: do sintoma ao post-mortem

Entrega do desafio **Do sintoma ao post-mortem** (MBA Arquitetura Full Cycle, módulos de Observabilidade e de DevOps e SRE).

A aplicação (uma api e um worker em TypeScript, com Postgres e uma fila no Redis) veio com a instrumentação pela metade. Este fork completa essa instrumentação: liga o log ao trace, cria spans de negócio, faz o contexto de trace atravessar a fila, corrige a cardinalidade do histograma HTTP, cria as métricas de negócio, monta o dashboard, declara o SLO e cria o alerta derivado dele. Depois usa tudo isso para investigar a queixa do financeiro. O resultado está em [`reports/post-mortem.md`](reports/post-mortem.md), com as saídas brutas de cada fonte em [`reports/evidencias/`](reports/evidencias/).

O defeito da aplicação **não foi corrigido**, de propósito: ele é o objeto de estudo.

## Como rodar

Pré-requisitos: Docker, Docker Compose v2 e `curl`. O `jq` é opcional e só serve para deixar a leitura dos logs mais confortável.

```sh
git clone https://github.com/verner-becker/mba-arch-desafio-observabilidade.git
cd mba-arch-desafio-observabilidade
cp .env.example .env
docker compose up -d
curl -s localhost:8080/health        # {"status":"ok"}
```

A primeira subida constrói a imagem e leva cerca de 1 minuto. O `seed` popula o Postgres, e a `api` e o `worker` só sobem depois dele.

| Ferramenta | Endereço | Observação |
| --- | --- | --- |
| api | http://localhost:8080 | `/produtos`, `/pedidos`, `/health`, `/metrics` |
| worker | http://localhost:8081 | `/health` e `/metrics` |
| Grafana, dashboard **Pedidos** | http://localhost:3000/d/pedidos | usuário e senha vêm do `.env` (`admin` / `admin` no exemplo). Provisionado por arquivo, sem nenhum clique |
| Jaeger | http://localhost:16686 | serviços `api` e `worker` |
| Prometheus | http://localhost:9090 | `/targets`, `/rules`, `/alerts` |
| Alertmanager | http://localhost:9093 | |
| Receptor de alertas | http://localhost:9099 | mostra o que recebe no próprio log: `docker compose logs receptor-alertas` |

**Carga:**

```sh
docker compose run --rm -d carga normal       # tráfego saudável
docker compose run --rm -d carga cenario-a    # reproduz a queixa do financeiro
docker stop $(docker ps -q --filter name=carga-run)   # para a carga que está em segundo plano
```

**Conferências rápidas:**

```sh
# todo log em JSON, com trace_id e span_id (vazios fora de um span)
docker compose logs --no-log-prefix api worker | tail -20

# um pedido atravessa a fila no mesmo trace: api e worker com o mesmo trace_id
curl -s -XPOST localhost:8080/pedidos -H 'content-type: application/json' \
  -d '{"cliente_id":"cli-0001","itens":[{"produto_id":1,"quantidade":1}]}'
docker compose logs --no-log-prefix api worker | grep '"pedido_id":<id devolvido>'
docker compose logs api worker | grep <trace_id de uma dessas linhas>   # linhas dos dois processos

# métricas de negócio já existem na subida, zeradas
curl -s localhost:8080/metrics localhost:8081/metrics | grep -E '^(pedidos_|cobrancas_)'

# alerta: com cenario-a rodando, em cerca de 2 min aparece aqui
docker compose logs receptor-alertas | grep FalhaEmCobrancas
```

**Desenvolvimento:**
- A pasta `src/` é montada como volume. Depois de editar, rode `docker compose restart api worker`.
- Mudanças no `package.json` exigem `docker compose up -d --build`.
- Para checar os tipos sem instalar nada: `docker compose run --rm --no-deps api npm run tipos`.
- Para voltar ao zero: `docker compose down -v`.

**Onde está cada peça da instrumentação:**

| Arquivo | O que tem |
| --- | --- |
| `src/telemetria/log.ts` | Logger JSON. Lê `trace_id` e `span_id` do span ativo, e o `pedido_id` dos campos passados ou do contexto |
| `src/telemetria/otel.ts` | Bootstrap do SDK do OpenTelemetry, como já vinha no projeto base |
| `src/api/metricas-http.ts` | Histograma HTTP, com a cardinalidade corrigida |
| `src/api/metricas-pedidos.ts` e `src/worker/metricas-cobranca.ts` | Métricas de negócio |
| `src/api/rotas.ts` | Span `pedido.criar` |
| `src/worker/index.ts` | Span `pedido.processar` (consumer) |
| `src/fila/fila.ts` | `inject` e `extract` do contexto de trace na mensagem |
| `src/worker/conciliacao.ts` | Registro da falha de cobrança: métrica, span e log |
| `grafana/provisioning/dashboards/pedidos.json` | Dashboard |
| `prometheus/regras/cobrancas.yml` | Regra `FalhaEmCobrancas` |

## Equivalências com o curso

| Aspecto | No curso (Java / Spring) | Nesta entrega (TypeScript / Node) |
| --- | --- | --- |
| **Métricas** | Spring Boot **Actuator** expõe `/actuator/prometheus`, e os medidores são criados com **Micrometer** (`Counter`, `Timer`/`DistributionSummary` e `MeterRegistry` com o registry Prometheus) | **`prom-client`**: um `Registry` compartilhado, `collectDefaultMetrics`, `Histogram` para HTTP e `Counter` para negócio, expostos em `/metrics` por uma rota Express (api) e pelo `node:http` (worker). Os contadores são inicializados em zero com `.inc(labels, 0)` |
| **Tracing** | **Micrometer Tracing** com o **bridge do OpenTelemetry** (`micrometer-tracing-bridge-otel`) e exportação OTLP. Spans manuais com `Observation`/`@Observed` ou `Tracer` | **OpenTelemetry JS**: `@opentelemetry/sdk-node` com `@opentelemetry/auto-instrumentations-node` (http, express, pg, ioredis) e `OTLPTraceExporter` para o Jaeger. Spans manuais com `trace.getTracer(...).startActiveSpan('pedido.criar' / 'pedido.processar')`, `setAttributes`, `recordException` e `setStatus(ERROR)`, usando `@opentelemetry/api` |
| **Logs estruturados** | SLF4J/Logback com saída JSON, e o **MDC** preenchido pelo Micrometer Tracing com `traceId` e `spanId` do span corrente | Logger próprio (`src/telemetria/log.ts`) que escreve uma linha JSON no stdout. Ele lê o span ativo com `trace.getSpan(context.active()).spanContext()` para preencher `trace_id` e `span_id`, sempre presentes e vazios sem span. O `pedido_id` vem dos campos passados ou de uma chave de contexto (`createContextKey`), que faz o papel do MDC |
| **Propagação de contexto** | Automática nos clientes instrumentados (RestTemplate/WebClient, mensageria com Observation): o bridge injeta e extrai o header W3C **`traceparent`** | Automática em HTTP pela auto-instrumentação. **Na fila Redis é manual**, com `propagation.inject(context.active(), carregador)` na publicação (o `traceparent` vai num campo `contexto_trace` da mensagem) e `propagation.extract(ROOT_CONTEXT, carregador)` no consumo. O span `pedido.processar` (`SpanKind.CONSUMER`) nasce filho do `pedido.criar`, no mesmo trace |

## Decisões técnicas

### O erro de cardinalidade

O histograma `http_request_duration_seconds` usava `requisicao.path` no label `route`, então cada URL concreta virava uma série. A correção usa `requisicao.route?.path`, que é o template casado pelo Express (`/produtos/:id`), e um valor fixo, `nao_encontrada`, quando nenhuma rota casa. O fallback nunca é o caminho digitado.

> **Por que derrubaria o Prometheus:** cada identificador distinto na URL (`/produtos/42`, `/pedidos/1234`, ou qualquer caminho inventado por um scanner) cria um novo conjunto de cerca de 12 séries, contando os buckets, o `_sum` e o `_count`. Como os ids crescem sem limite, as séries ativas crescem sem limite, e a memória e o índice do Prometheus crescem junto até ele cair por falta de memória (OOM).

A mesma regra vale para as métricas de negócio: nenhum label carrega `pedido_id` ou `cliente_id`. Os identificadores ficam no log e nos atributos de span, onde são baratos.

### Métricas de negócio

| Métrica | Onde incrementa | Que pergunta responde |
| --- | --- | --- |
| `pedidos_criados_total` (contador, api) | `POST /pedidos`, depois de gravar e publicar na fila | Quanta demanda está entrando? |
| `pedidos_confirmados_total` (contador, worker) | Depois de gravar o status, somente quando for `confirmado` | Quantos pedidos a loja **prometeu** ao cliente? |
| `cobrancas_processadas_total{resultado}` (contador, worker) | Em `decidirStatusDoPedido`: `aprovada` e `recusada` pelo retorno do processador, `falha` quando ele lança exceção | O que o meio de pagamento **de fato** fez? É a base do SLI |

Os três nascem em zero na subida, inclusive os três valores de `resultado`, para a série existir antes do primeiro evento e o alerta e os painéis não ficarem cegos.

Lidas juntas, elas contam a história do incidente: em operação saudável, `pedidos_confirmados ≈ cobrancas{aprovada}`. Quando os confirmados passam a crescer mais que as aprovadas, há pedidos prometidos sem dinheiro correspondente.

**Limite conhecido:** as métricas contam pedidos, não reais. O valor envolvido vem do log (`valor_total` na linha de erro) e do banco. Uma métrica de valor está entre os itens de ação do post-mortem.

### Dashboard Pedidos: qual pergunta cada painel responde

| Painel | Pergunta | Query (resumo) |
| --- | --- | --- |
| **Cobranças com falha (% do total)** | **O sistema está com erro?** Erro de negócio, que só o código conhece | `falha / total` de `cobrancas_processadas_total` com `rate[2m]`, e a linha do limiar do alerta (14,4%) desenhada no gráfico |
| **Requisições HTTP com erro 5xx (% do total)** | **O sistema está com erro?** Erro visto de fora (caixa preta) | `5xx / total` de `http_request_duration_seconds_count`, com `or vector(0)` para mostrar 0 em vez de "No data" |
| **Latência p95 por rota (segundos)** | **O sistema está lento?** | `histogram_quantile(0.95, sum by (le, route) (rate(..._bucket[2m])))`, sem `/health` e `/metrics` |
| **Pedidos confirmados vs. cobranças aprovadas (por minuto)** | **O dinheiro está entrando?** | As duas taxas (`rate * 60`) e a diferença entre elas, "Confirmados sem cobrança", em vermelho |

Os dois painéis de erro ficam lado a lado de propósito. No incidente, o de 5xx fica em 0% enquanto o de cobranças passa de 40%, e é exatamente por isso que o Grafana antigo "não mostrou nada".

Na diferença do painel de dinheiro pode aparecer um resíduo pequeno, cerca de 0,5 pedido por minuto, mesmo sem nenhuma falha. É efeito do `rate()`: os dois contadores sobem com milissegundos de diferença e cada um é extrapolado separadamente. A contagem exata nesses períodos é zero.

### Outras decisões

- **Propagação pela fila.** O `extract` parte do `ROOT_CONTEXT`, e não do contexto ativo do worker. Assim o span de consumo depende só do que veio na mensagem, nunca de um span que por acaso esteja ativo. Uma mensagem sem `traceparent` inicia um trace novo, em vez de ser pendurada num pai errado.
- **`pedido_id` na linha de erro da cobrança.** A função `decidirStatusDoPedido` não recebe o id, e mudar a assinatura dela seria alterar o fluxo. O span `pedido.processar` grava o id no contexto, e o logger lê de lá.
- **Exceções.** Toda exceção capturada passa a ser registrada no span (`recordException`, status `ERROR`) e a gerar `log.error` com o motivo. No `POST /pedidos` o erro é relançado depois de registrado, para preservar o comportamento original do Express 4.
- **O fluxo não muda.** O `git diff -w` contra o projeto base, em `src/`, só mostra linhas de instrumentação.

## SLO e alerta

### SLI

**A proporção das cobranças que o processador de pagamento conclui com uma resposta, aprovada ou recusada, sem falhar.**

```promql
sum(rate(cobrancas_processadas_total{resultado=~"aprovada|recusada"}[2m]))
/
sum(rate(cobrancas_processadas_total[2m]))
```

A **recusa conta como sucesso**: o sistema funcionou, o banco do cliente é que disse não. Se ela contasse como erro, o alerta dispararia no tráfego normal, que tem recusas legítimas (cerca de 8% no cenário `normal`). O evento ruim é a `falha`: o processador não concluiu, e o pedido fica sem cobrança conhecida.

### SLO e error budget

**SLO: 99% das cobranças sem falha, numa janela móvel de 30 dias.**

**Error budget: 1% das cobranças do período.** No volume do cenário `normal` (cerca de 75 cobranças por minuto, ou cerca de 3,2 milhões em 30 dias), isso equivale a algo como 32 mil cobranças com falha por mês, ou 1 em cada 100.

**Por que 99%.** A falha de cobrança custa dinheiro diretamente, mas tem remediação: uma falha registrada pode ser cobrada novamente ou reconciliada. Um alvo mais apertado, como 99,9%, faria alguém ser acordado por soluços do gateway externo, que a loja não controla. Um alvo mais frouxo, como 95%, toleraria 1 em cada 20 cobranças perdidas, um vazamento que o negócio não aceita.

### Do SLO ao limiar da regra

O alerta não compara a proporção de falhas com um número escolhido no olho. Ele mede o **burn rate**: a velocidade com que o budget está sendo consumido, em múltiplos do ritmo que o esgotaria exatamente no fim da janela.

```
burn rate = (taxa de falha observada) / (error budget) = taxa de falha / 0,01
```

Para acionar alguém, o SRE Workbook do Google recomenda **burn rate 14,4**. É o ritmo em que **1 hora consome 2% do budget do mês**:

```
14,4 × 1 h / 720 h (30 dias) = 0,02  →  2% do budget por hora
                                       (o budget inteiro acaba em ~2 dias)
```

Portanto:

```
limiar = burn rate × error budget = 14,4 × (1 − 0,99) = 14,4 × 0,01 = 0,144
```

**O alerta dispara quando mais de 14,4% das cobranças falham.** A expressão da regra usa a proporção de falhas, que é `1 − SLI`. Então ela dispara quando o SLI, calculado na mesma janela de 2 minutos, cai abaixo de 85,6%.

```yaml
# prometheus/regras/cobrancas.yml
- alert: FalhaEmCobrancas
  expr: |
    sum(rate(cobrancas_processadas_total{resultado="falha"}[2m]))
    /
    sum(rate(cobrancas_processadas_total[2m]))
    > 0.144
  for: 1m
```

### Janela e `for`

- **Janela do `rate` de 2 minutos, e não de 1 hora como no Workbook.** Com 1 hora, um incidente com cerca de 40% de falha precisaria diluir uma hora de tráfego saudável antes de cruzar 14,4%, o que leva cerca de 20 minutos, e o critério do desafio é 5 minutos. Os 2 minutos ainda dão robustez: com cerca de 150 cobranças na janela, uma falha isolada pesa 0,7%, longe do limiar. Disparar exige falha sustentada.
- **`for: 1m`**, dentro do intervalo exigido de 30 s a 1 min. Exige que a condição se mantenha por 4 avaliações seguidas (uma a cada 15 s). Custa 30 segundos a mais que o mínimo e evita disparo por pico de uma única avaliação.
- **Em produção**, com volume maior, a evolução natural é o alerta de burn rate em múltiplas janelas (1h/5m com 14,4× e 6h/30m com 6×). Está nos itens de ação do post-mortem.

### Comportamento medido

| Teste | Resultado |
| --- | --- |
| `normal` por 3 min depois de `docker compose restart receptor-alertas` | Regra `inactive`, nenhum alerta no receptor, SLI de falha em 0 |
| `cenario-a` logo depois do `normal` | `pending` em +56 s, quando a proporção cruzou 14,4%; `firing` em +116 s; **webhook no receptor em +127 s** |

O tempo até o disparo é a soma de:
1. a diluição da janela do `rate`, que é a maior parte;
2. o scrape (15 s);
3. a avaliação da regra (15 s);
4. o `for` de 1 min;
5. o `group_wait` do Alertmanager (10 s).

Se a regra acabou de sair de um `cenario-a`, o receptor também recebe o `status=resolved` alguns minutos depois (`send_resolved: true`). Isso não é um disparo no tráfego normal.
