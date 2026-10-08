import express from 'express';
import { config } from './config.js';
import { pool } from './db.js';
import { errorHandler, notFound } from './http.js';
import { routes } from './routes.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(routes);
app.use(notFound);
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`express-auth listening on http://localhost:${config.port}`);
});

// What `enableShutdownHooks` and DrizzleModule's onApplicationShutdown do in
// the Nest services: stop accepting, let requests finish, close the pool.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  });
}
