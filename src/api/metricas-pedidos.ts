import client from 'prom-client';
import { registro } from '../telemetria/metricas';

export const pedidosCriados = new client.Counter({
  name: 'pedidos_criados_total',
  help: 'Pedidos aceitos pela api e publicados na fila',
  registers: [registro],
});
