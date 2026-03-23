import { Request, Response, NextFunction } from 'express';
import { errorResponse } from '../utils/response';
import logger from '../utils/logger';

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  logger.error('Error:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  if (err.name === 'PrismaClientKnownRequestError') {
    errorResponse(res, 'Database error', 400, err.message);
    return;
  }

  if (err.name === 'ValidationError') {
    errorResponse(res, 'Validation error', 400, err.message);
    return;
  }

  errorResponse(res, 'Internal server error', 500, process.env.NODE_ENV === 'development' ? err.message : undefined);
};

export const notFoundHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  errorResponse(res, `Route ${req.method} ${req.path} not found`, 404);
};
