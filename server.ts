import './server.js';
import { createApp } from './server.js';
import { config } from './config/index.js';

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
