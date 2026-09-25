import { context, createContextKey, isSpanContextValid, trace } from '@opentelemetry/api';
import { NOME_DO_SERVICO } from './servico';

type Nivel = 'info' | 'warn' | 'error';

type CamposExtras = {
  pedido_id?: number;
  [campo: string]: unknown;
};

// Chave de contexto para o pedido em processamento: quem abre o span de um
// pedido grava o id aqui, e toda linha escrita dentro dele herda o pedido_id.
export const CHAVE_PEDIDO_ID = createContextKey('pedido_id');

function identificadoresDoTrace(): { trace_id: string; span_id: string } {
  const span = trace.getSpan(context.active());
  const contextoDoSpan = span?.spanContext();

  if (!contextoDoSpan || !isSpanContextValid(contextoDoSpan)) {
    return { trace_id: '', span_id: '' };
  }

  return { trace_id: contextoDoSpan.traceId, span_id: contextoDoSpan.spanId };
}

function escrever(level: Nivel, msg: string, campos?: CamposExtras): void {
  const pedidoDoContexto = context.active().getValue(CHAVE_PEDIDO_ID) as number | undefined;
  const pedidoId = campos?.pedido_id ?? pedidoDoContexto;

  const linha = {
    timestamp: new Date().toISOString(),
    level,
    service: NOME_DO_SERVICO,
    msg,
    ...identificadoresDoTrace(),
    ...campos,
    ...(pedidoId !== undefined ? { pedido_id: pedidoId } : {}),
  };

  process.stdout.write(JSON.stringify(linha) + '\n');
}

export const log = {
  info(msg: string, campos?: CamposExtras): void {
    escrever('info', msg, campos);
  },
  warn(msg: string, campos?: CamposExtras): void {
    escrever('warn', msg, campos);
  },
  error(msg: string, campos?: CamposExtras): void {
    escrever('error', msg, campos);
  },
};
