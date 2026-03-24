import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';

// Load environment variables
dotenv.config();

// Import routes
import authRoutes from './routes/auth';
import freightRoutes from './routes/freight';
import auctionRoutes from './routes/auction';
import walletRoutes from './routes/wallet';
import assetRoutes from './routes/assets';
import driverRoutes from './routes/driver';
import jobsRoutes from './routes/jobs';
import rentalRoutes from './routes/rentals';
import aiRoutes from './routes/ai';

// Import middleware
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

// Import socket service
import { initializeSocket } from './services/socket';

// Import logger
import logger from './utils/logger';

// Create Express app
const app = express();
const httpServer = createServer(app);

// Initialize Socket.IO
const io = initializeSocket(httpServer);

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    query: req.query,
    body: req.body,
    ip: req.ip,
  });
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/freight', freightRoutes);
app.use('/api/auctions', auctionRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/driver', driverRoutes);
app.use('/api/jobs', jobsRoutes);
app.use('/api/rentals', rentalRoutes);
app.use('/api/ai', aiRoutes);

// API documentation
app.get('/api', (req, res) => {
  res.json({
    name: 'Ethio-Omni Freight Exchange API',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      freight: '/api/freight',
      auctions: '/api/auctions',
      wallet: '/api/wallet',
      assets: '/api/assets',
      driver: '/api/driver',
      jobs: '/api/jobs',
      rentals: '/api/rentals',
      ai: '/api/ai',
    },
    websocket: {
      events: [
        'join-auction',
        'leave-auction',
        'place-bid',
        'new-bid',
        'outbid-alert',
        'auction-won',
        'auction-ended',
        'location-update',
        'track-job',
      ],
    },
  });
});

// 404 handler
app.use(notFoundHandler);

// Error handler
app.use(errorHandler);

// Start server
const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  logger.info(`🚀 Ethio-Omni Server running on port ${PORT}`);
  logger.info(`📚 API Documentation: http://localhost:${PORT}/api`);
  logger.info(`🔌 WebSocket server initialized`);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

export { app, io };
