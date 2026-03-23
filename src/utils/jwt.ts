import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import { TokenPayload } from '../types';

const JWT_SECRET: Secret = process.env.JWT_SECRET || 'fallback-secret-key';
const JWT_EXPIRES_IN: SignOptions['expiresIn'] = '7d';

export const generateToken = (payload: TokenPayload): string => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
};

export const verifyToken = (token: string): TokenPayload => {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
};
