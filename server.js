import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { config } from './config/index.js';
import { openApiSpec } from './config/swagger.js';
import { ensureTempDirs } from './config/storage.js';
import { apiRateLimiter, errorHandler } from './middleware/index.js';
import apiRoutes from './routes/index.js';

export async function createApp() {
  await ensureTempDirs();

  const app = express();

  // CORS configuration for local and remote frontend-backend development
  app.use(
    cors({
      origin: config.corsOrigins.includes('*') ? '*' : config.corsOrigins,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      exposedHeaders: ['Content-Disposition', 'X-Document-SHA256'],
    })
  );

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Basic rate limiting on API routes
  app.use('/api', apiRateLimiter);

  // Raw OpenAPI 3.0 specification JSON endpoint
  app.get('/api/openapi.json', (_req, res) => {
    res.status(200).json(openApiSpec);
  });

  // Mount REST API routes
  app.use('/api', apiRoutes);

  // Interactive Swagger UI documentation at /api-docs AND root /
  const swaggerUiOptions = {
    customSiteTitle: 'DocShield – Smart Document Privacy Protector API Docs',
    customCss: `
      .swagger-ui .topbar { background-color: #0f172a; border-bottom: 2px solid #10b981; }
      .swagger-ui .info .title { color: #0f172a; }
    `,
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      docExpansion: 'list',
      defaultModelsExpandDepth: 1,
    },
  };

  app.use('/api-docs', swaggerUi.serveFiles(openApiSpec, swaggerUiOptions), swaggerUi.setup(openApiSpec, swaggerUiOptions));

  // Redirect root '/' to '/api-docs' so visiting the server immediately opens the interactive Swagger API explorer
  app.get('/', (_req, res) => {
    res.redirect('/api-docs');
  });

  // 404 handler for unknown API routes
  app.use((req, res) => {
    res.status(404).json({
      success: false,
      error: 'ENDPOINT_NOT_FOUND',
      message: `Route ${req.method} ${req.originalUrl} does not exist. Visit /api-docs for interactive API documentation.`,
    });
  });

  // Global error handler
  app.use(errorHandler);

  return app;
}

// Start server if run directly
const isMain = process.argv[1] && process.argv[1].endsWith('server.js');
if (isMain) {
  createApp()
    .then((app) => {
      app.listen(config.port, '0.0.0.0', () => {
        console.log(`DocShield Backend running on http://0.0.0.0:${config.port}`);
        console.log(`Swagger OpenAPI 3.0 Docs available at http://0.0.0.0:${config.port}/api-docs`);
      });
    })
    .catch((err) => {
      console.error('Failed to start DocShield backend:', err);
      process.exit(1);
    });
}
