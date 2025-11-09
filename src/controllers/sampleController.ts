import sampleService from '../services/sampleService';
import { Request, Response } from 'express';

const getSample = (req: Request, res: Response) => {
  const data = sampleService.getSampleData();
  res.json({ message: 'Sample endpoint', data });
};

export default { getSample };
