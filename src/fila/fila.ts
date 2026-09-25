import { ROOT_CONTEXT, context, propagation, type Context } from '@opentelemetry/api';
import Redis from 'ioredis';

export const NOME_DA_FILA = 'pedidos';

export type MensagemPedido = {
  pedido_id: number;
  cliente_id: string;
  valor_total: number;
};

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';

export function criarConexaoRedis(): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export async function publicarPedido(
  redis: Redis,
  mensagem: MensagemPedido
): Promise<void> {
  // O contexto de trace viaja dentro da mensagem (W3C traceparent) para o worker continuar o mesmo trace.
  const contextoDeTrace: Record<string, string> = {};
  propagation.inject(context.active(), contextoDeTrace);

  await redis.lpush(NOME_DA_FILA, JSON.stringify({ ...mensagem, contexto_trace: contextoDeTrace }));
}

// Extrai sobre o contexto raiz: o span do consumo depende so do que veio na mensagem,
// nunca de um span que por acaso esteja ativo no worker.
export function contextoDaMensagem(mensagem: Record<string, unknown>): Context {
  const contextoDeTrace = (mensagem.contexto_trace ?? {}) as Record<string, string>;
  return propagation.extract(ROOT_CONTEXT, contextoDeTrace);
}

export async function consumirPedido(
  redis: Redis,
  segundosDeEspera = 5
): Promise<Record<string, unknown> | null> {
  const resposta = await redis.brpop(NOME_DA_FILA, segundosDeEspera);

  if (!resposta) {
    return null;
  }

  return JSON.parse(resposta[1]) as Record<string, unknown>;
}
