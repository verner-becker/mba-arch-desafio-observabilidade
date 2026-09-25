import { SpanStatusCode, trace } from '@opentelemetry/api';
import express, { type NextFunction, type Request, type Response } from 'express';
import { esperarBanco, fecharPool } from '../db/pool';
import { migrar } from '../db/migracao';
import { criarConexaoRedis } from '../fila/fila';
import { log } from '../telemetria/log';
import { medirRequisicoes } from './metricas-http';
import { criarRotas } from './rotas';

const porta = Number(process.env.API_PORT ?? process.env.PORT ?? 8080);

async function iniciar(): Promise<void> {
  await esperarBanco();
  await migrar();

  const redis = criarConexaoRedis();

  const aplicacao = express();
  aplicacao.use(express.json());
  aplicacao.use(medirRequisicoes);
  aplicacao.use(criarRotas(redis));

  aplicacao.use(
    (erro: Error, _requisicao: Request, resposta: Response, _proximo: NextFunction) => {
      const span = trace.getActiveSpan();
      span?.recordException(erro);
      span?.setStatus({ code: SpanStatusCode.ERROR, message: erro.message });
      log.error('erro ao atender requisicao: ' + erro.message);
      resposta.status(500).json({ erro: 'erro interno' });
    }
  );

  const servidor = aplicacao.listen(porta, () => {
    log.info('api ouvindo na porta ' + porta);
  });

  const encerrar = () => {
    servidor.close(async () => {
      redis.disconnect();
      await fecharPool();
      process.exit(0);
    });
  };

  process.on('SIGINT', encerrar);
  process.on('SIGTERM', encerrar);
}

iniciar().catch((erro) => {
  log.error('api nao conseguiu iniciar: ' + erro.message);
  process.exit(1);
});
