import { Response } from 'express';
import { ApiResponse } from '../types';

export const successResponse = <T>(
  res: Response,
  data: T,
  message: string = 'Success',
  statusCode: number = 200,
  meta?: ApiResponse['meta']
): void => {
  const response: ApiResponse<T> = {
    success: true,
    message,
    data,
    meta,
  };
  res.status(statusCode).json(response);
};

export const errorResponse = (
  res: Response,
  message: string = 'An error occurred',
  statusCode: number = 500,
  error?: string
): void => {
  const response: ApiResponse = {
    success: false,
    message,
    error,
  };
  res.status(statusCode).json(response);
};
