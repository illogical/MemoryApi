import express from 'express';
//import routes from './routes';
import { memoryRouter, initializeMemorySystem } from './qdrantAPI';

const app = express();
app.use(express.json());

// Sample/demo routes
//app.use('/api', routes);

// Memory API routes from qdrantAPI
app.use('/api', memoryRouter);

const PORT = process.env.PORT || 3000;

// Initialize memory system before starting server
initializeMemorySystem()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize memory system:', err);
    process.exit(1);
  });
