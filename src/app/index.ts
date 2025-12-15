import express from 'express';
import path from 'path';
//import routes from './routes';
import { memoryRouter, initializeMemorySystem } from './qdrantAPI';
import { reviewRouter } from './reviewAPI';

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

// Sample/demo routes
//app.use('/api', routes);

// Memory API routes from qdrantAPI
app.use('/api', memoryRouter);
app.use('/api', reviewRouter);

const PORT = process.env.PORT || 3000;

// Initialize memory system before starting server
initializeMemorySystem()
  .then(() => {
    console.log('Memory system initialized successfully.');
  })
  .catch(err => {
    console.error('Failed to initialize memory system:', err);
    console.log('Server starting despite initialization failure (Degraded Mode).');
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  });
