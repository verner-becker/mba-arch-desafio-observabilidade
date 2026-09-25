import { SpanStatusCode, trace } from '@opentelemetry/api';
import { Router } from 'express';
import type Redis from 'ioredis';
import {
  buscarPedido,
  buscarProduto,
  buscarProdutosPorIds,
  criarPedido,
  listarProdutos,
  type ItemNovoPedido,
} from '../db/consultas';
import { publicarPedido } from '../fila/fila';
import { log } from '../telemetria/log';
import { pedidosCriados } from './metricas-pedidos';
import { TIPO_DE_CONTEUDO, coletar } from '../telemetria/metricas';

const tracer = trace.getTracer('loja-pedidos');

export function criarRotas(redis: Redis): Router {
  const rotas = Router();

  rotas.get('/health', (_requisicao, resposta) => {
    resposta.status(200).json({ status: 'ok' });
  });

  rotas.get('/metrics', async (_requisicao, resposta) => {
    resposta.set('content-type', TIPO_DE_CONTEUDO);
    resposta.status(200).send(await coletar());
  });

  rotas.get('/produtos', async (_requisicao, resposta) => {
    const produtos = await listarProdutos();
    resposta.status(200).json(produtos);
  });

  rotas.get('/produtos/:id', async (requisicao, resposta) => {
    const id = Number(requisicao.params.id);

    if (!Number.isInteger(id)) {
      resposta.status(400).json({ erro: 'id invalido' });
      return;
    }

    const produto = await buscarProduto(id);

    if (!produto) {
      resposta.status(404).json({ erro: 'produto nao encontrado' });
      return;
    }

    resposta.status(200).json(produto);
  });

  rotas.post('/pedidos', async (requisicao, resposta) => {
    await tracer.startActiveSpan('pedido.criar', async (span) => {
      try {
        const clienteId = requisicao.body?.cliente_id;
        const itens: ItemNovoPedido[] = requisicao.body?.itens;

        if (typeof clienteId !== 'string' || !Array.isArray(itens) || itens.length === 0) {
          span.setAttribute('pedido.rejeitado', 'cliente_id e itens sao obrigatorios');
          resposta.status(400).json({ erro: 'cliente_id e itens sao obrigatorios' });
          return;
        }

        span.setAttributes({ 'cliente.id': clienteId, 'pedido.quantidade_itens': itens.length });

        const produtos = await buscarProdutosPorIds(itens.map((item) => item.produto_id));
        const precoPorProduto = new Map(produtos.map((produto) => [produto.id, produto.preco]));

        const faltando = itens.filter((item) => !precoPorProduto.has(item.produto_id));
        if (faltando.length > 0) {
          span.setAttribute('pedido.rejeitado', 'produto inexistente no pedido');
          resposta.status(400).json({ erro: 'produto inexistente no pedido' });
          return;
        }

        const pedido = await criarPedido(clienteId, itens, precoPorProduto);
        span.setAttributes({ 'pedido.id': pedido.id, 'pedido.valor_total': pedido.valor_total });

        await publicarPedido(redis, {
          pedido_id: pedido.id,
          cliente_id: clienteId,
          valor_total: pedido.valor_total,
        });

        pedidosCriados.inc();
        log.info('pedido ' + pedido.id + ' criado para ' + clienteId, { pedido_id: pedido.id });

        resposta.status(202).json({ pedido_id: pedido.id, status: 'pendente' });
      } catch (erro) {
        span.recordException(erro as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (erro as Error).message });
        log.error('erro ao criar pedido: ' + (erro as Error).message);
        throw erro;
      } finally {
        span.end();
      }
    });
  });

  rotas.get('/pedidos/:id', async (requisicao, resposta) => {
    const id = Number(requisicao.params.id);

    if (!Number.isInteger(id)) {
      resposta.status(400).json({ erro: 'id invalido' });
      return;
    }

    const pedido = await buscarPedido(id);

    if (!pedido) {
      resposta.status(404).json({ erro: 'pedido nao encontrado' });
      return;
    }

    resposta.status(200).json(pedido);
  });

  return rotas;
}
