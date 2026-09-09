import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { ApiError } from './errors.js';
import { loggerOptions } from './logger.js';
import { metrics } from './metrics.js';
import { registerRoutes } from './routes.js';

const CORRELATION_HEADER = 'x-correlation-id';

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: loggerOptions,
    // Fastify's own two-line-per-request logging is replaced by the single structured
    // `http.request` line emitted in the onResponse hook below, which carries the route,
    // the status, the duration and the correlation id together.
    disableRequestLogging: true,
    requestIdHeader: false,
    requestIdLogLabel: 'correlation_id',

    /**
     * Correlation id: honour an inbound X-Correlation-Id / X-Request-Id so a burst script or
     * an upstream proxy can name the trace itself, and mint a UUID otherwise. Fastify then
     * threads this id through `request.log`, so every domain event logged while handling the
     * request -- transfer created, debited, credited, declined, replayed -- carries it
     * without any explicit plumbing.
     */
    genReqId: (req) => {
      const supplied =
        firstHeader(req.headers[CORRELATION_HEADER]) ?? firstHeader(req.headers['x-request-id']);
      if (typeof supplied === 'string' && supplied.trim() !== '') {
        return supplied.trim().slice(0, 128);
      }
      return randomUUID();
    },

    // Deployed behind the platform's TLS terminator, so client IP and proto come from
    // X-Forwarded-*.
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  app.addHook('onRequest', async (request, reply) => {
    // Echoed before anything can fail, so even a 500 is traceable from the client side.
    void reply.header('X-Correlation-Id', String(request.id));
  });

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const status = String(reply.statusCode);
    const seconds = reply.elapsedTime / 1000;

    metrics.httpRequests.inc({ method: request.method, route, status });
    metrics.httpDuration.observe({ method: request.method, route, status }, seconds);
    metrics.httpDurationSummary.observe({ method: request.method, route }, seconds);

    request.log.info(
      {
        event: 'http.request',
        method: request.method,
        route,
        path: request.url,
        status: reply.statusCode,
        duration_ms: Math.round(reply.elapsedTime * 1000) / 1000,
      },
      'request completed',
    );
  });

  app.setNotFoundHandler(async (request, reply) => {
    await reply.code(404).send({
      error: { code: 'route_not_found', message: `no route for ${request.method} ${request.url}` },
    });
  });

  app.setErrorHandler(async (err, request, reply) => {
    if (err instanceof ApiError) {
      request.log.warn(
        { event: 'http.client_error', error_code: err.code, status: err.statusCode },
        err.message,
      );
      await reply.code(err.statusCode).send(err.toBody());
      return;
    }

    // Fastify's own 4xx (malformed JSON, unsupported content type, body too large).
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status < 500) {
      request.log.warn({ event: 'http.client_error', status }, err.message);
      await reply.code(status).send({ error: { code: 'bad_request', message: err.message } });
      return;
    }

    request.log.error({ event: 'http.server_error', err }, 'unhandled error');
    await reply.code(500).send({
      error: {
        code: 'internal_error',
        message: 'internal error',
        details: { correlation_id: String(request.id) },
      },
    });
  });

  registerRoutes(app);
  return app;
}
