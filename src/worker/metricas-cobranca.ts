import client from 'prom-client';
import { registro } from '../telemetria/metricas';

export const pedidosConfirmados = new client.Counter({
  name: 'pedidos_confirmados_total',
  help: 'Pedidos gravados com status confirmado',
  registers: [registro],
});

export const RESULTADOS_DE_COBRANCA = ['aprovada', 'recusada', 'falha'] as const;

export const cobrancasProcessadas = new client.Counter({
  name: 'cobrancas_processadas_total',
  help: 'Cobrancas processadas, por resultado do processador de pagamento',
  labelNames: ['resultado'],
  registers: [registro],
});

// Cada valor do label nasce em zero na subida, para a serie existir antes do primeiro evento.
for (const resultado of RESULTADOS_DE_COBRANCA) {
  cobrancasProcessadas.inc({ resultado }, 0);
}
