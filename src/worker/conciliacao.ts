import { SpanStatusCode, trace } from '@opentelemetry/api';
import { log } from '../telemetria/log';
import { cobrancasProcessadas } from './metricas-cobranca';
import { processarPagamento } from './pagamento';
import { registrarFalhaLegado } from './registro-legado';

export type StatusDoPedido = 'confirmado' | 'recusado';

export async function decidirStatusDoPedido(
  clienteId: string,
  valorTotal: number
): Promise<StatusDoPedido> {
  let recusado = false;

  try {
    const resultado = await processarPagamento(clienteId, valorTotal);
    recusado = !resultado.aprovado;
    cobrancasProcessadas.inc({ resultado: resultado.aprovado ? 'aprovada' : 'recusada' });
    trace.getActiveSpan()?.setAttribute('cobranca.resultado', resultado.aprovado ? 'aprovada' : 'recusada');
  } catch (erro) {
    cobrancasProcessadas.inc({ resultado: 'falha' });
    const span = trace.getActiveSpan();
    span?.recordException(erro as Error);
    span?.setStatus({ code: SpanStatusCode.ERROR, message: (erro as Error).message });
    span?.setAttribute('cobranca.resultado', 'falha');
    log.error('falha ao processar pagamento: ' + (erro as Error).message, {
      cliente_id: clienteId,
      valor_total: valorTotal,
    });
    registrarFalhaLegado(erro);
  }

  return recusado ? 'recusado' : 'confirmado';
}
