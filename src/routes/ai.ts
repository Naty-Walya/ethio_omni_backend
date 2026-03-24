import { Router, Request, Response } from 'express';
import { body, query } from 'express-validator';
import { prisma } from '../prisma/client';
import { successResponse, errorResponse } from '../utils/response';
import { authenticate, authorize } from '../middleware/auth';
import {
  demandPredictionService,
  fraudDetectionService,
  priceRecommendationService,
  analyticsService,
} from '../services/ai';

const router = Router();

// Get Demand Prediction
router.get(
  '/demand-prediction',
  authenticate,
  [
    query('region').notEmpty().withMessage('Region is required'),
    query('daysAhead').optional().isInt({ min: 1, max: 30 }),
  ],
  async (req: Request, res: Response) => {
    try {
      const { region, route, daysAhead } = req.query;

      const prediction = await demandPredictionService.predictDemand(
        region as string,
        route as string | null,
        daysAhead ? parseInt(daysAhead as string) : 7
      );

      successResponse(res, prediction);
    } catch (error) {
      console.error('Demand prediction error:', error);
      errorResponse(res, 'Failed to generate demand prediction', 500);
    }
  }
);

// Get Price Recommendation
router.get(
  '/price-recommendation',
  authenticate,
  [
    query('pickupLocation').notEmpty().withMessage('Pickup location required'),
    query('deliveryLocation').notEmpty().withMessage('Delivery location required'),
    query('weight').optional().isFloat({ min: 0 }),
    query('cargoType').optional().isString(),
  ],
  async (req: Request, res: Response) => {
    try {
      const { pickupLocation, deliveryLocation, weight, cargoType } = req.query;

      const recommendation = await priceRecommendationService.getPriceRecommendation(
        pickupLocation as string,
        deliveryLocation as string,
        weight ? parseFloat(weight as string) : 1000,
        (cargoType as string) || 'GENERAL'
      );

      successResponse(res, recommendation);
    } catch (error) {
      console.error('Price recommendation error:', error);
      errorResponse(res, 'Failed to generate price recommendation', 500);
    }
  }
);

// Check Fraud
router.post(
  '/fraud-check',
  authenticate,
  [
    body('entityType').isIn(['TRANSACTION', 'BID', 'USER']).withMessage('Valid entity type required'),
    body('entityId').notEmpty().withMessage('Entity ID required'),
    body('data').isObject().withMessage('Data object required'),
  ],
  async (req: Request, res: Response) => {
    try {
      const { entityType, entityId, data } = req.body;

      // Add user ID to data
      const checkData = {
        ...data,
        userId: req.user!.id,
      };

      const fraudCheck = await fraudDetectionService.checkForFraud(
        entityType,
        entityId,
        checkData
      );

      successResponse(res, fraudCheck);
    } catch (error) {
      console.error('Fraud check error:', error);
      errorResponse(res, 'Failed to perform fraud check', 500);
    }
  }
);

// Get Fraud Alerts (Admin only)
router.get(
  '/fraud-alerts',
  authenticate,
  authorize('ADMIN'),
  [
    query('status').optional().isIn(['OPEN', 'UNDER_REVIEW', 'CONFIRMED_FRAUD', 'FALSE_POSITIVE', 'RESOLVED']),
    query('severity').optional().isIn(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  async (req: Request, res: Response) => {
    try {
      const { status, severity, page = '1', limit = '20' } = req.query;

      const where: any = {};
      if (status) where.status = status;
      if (severity) where.severity = severity;

      const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
      const take = parseInt(limit as string);

      const [alerts, total] = await Promise.all([
        prisma.fraudAlert.findMany({
          where,
          include: {
            user: {
              select: {
                firstName: true,
                lastName: true,
                phone: true,
              },
            },
          },
          skip,
          take,
          orderBy: { createdAt: 'desc' },
        }),
        prisma.fraudAlert.count({ where }),
      ]);

      successResponse(res, alerts, 'Fraud alerts retrieved', 200, {
        page: parseInt(page as string),
        limit: take,
        total,
      });
    } catch (error) {
      console.error('Get fraud alerts error:', error);
      errorResponse(res, 'Failed to retrieve fraud alerts', 500);
    }
  }
);

// Update Fraud Alert (Admin only)
router.patch(
  '/fraud-alerts/:id',
  authenticate,
  authorize('ADMIN'),
  [
    body('status').isIn(['UNDER_REVIEW', 'CONFIRMED_FRAUD', 'FALSE_POSITIVE', 'RESOLVED']).withMessage('Valid status required'),
    body('resolution').optional().isString(),
  ],
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { status, resolution } = req.body;

      const alert = await prisma.fraudAlert.update({
        where: { id },
        data: {
          status,
          resolution,
          reviewedBy: req.user!.id,
          reviewedAt: new Date(),
        },
      });

      successResponse(res, alert, 'Fraud alert updated');
    } catch (error) {
      console.error('Update fraud alert error:', error);
      errorResponse(res, 'Failed to update fraud alert', 500);
    }
  }
);

// Get Market Analytics
router.get(
  '/market-analytics',
  authenticate,
  [
    query('region').optional().isString(),
    query('period').optional().isString(),
    query('periodType').optional().isIn(['DAY', 'WEEK', 'MONTH']),
  ],
  async (req: Request, res: Response) => {
    try {
      const { region, period, periodType = 'DAY' } = req.query;

      const where: any = {};
      if (region) where.region = region;
      if (period) where.period = period;
      if (periodType) where.periodType = periodType;

      const analytics = await prisma.marketAnalytics.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 30,
      });

      successResponse(res, analytics);
    } catch (error) {
      console.error('Get market analytics error:', error);
      errorResponse(res, 'Failed to retrieve market analytics', 500);
    }
  }
);

// Submit AI Feedback
router.post(
  '/feedback',
  authenticate,
  [
    body('predictionId').notEmpty().withMessage('Prediction ID required'),
    body('feedbackType').isIn(['CORRECT', 'INCORRECT', 'USEFUL', 'NOT_USEFUL', 'ACCURATE', 'INACCURATE']).withMessage('Valid feedback type required'),
    body('rating').optional().isInt({ min: 1, max: 5 }),
    body('comment').optional().isString(),
    body('expectedOutcome').optional().isObject(),
    body('actualOutcome').optional().isObject(),
  ],
  async (req: Request, res: Response) => {
    try {
      const { predictionId, feedbackType, rating, comment, expectedOutcome, actualOutcome } = req.body;

      // Verify prediction exists
      const prediction = await prisma.aIPrediction.findUnique({
        where: { id: predictionId },
      });

      if (!prediction) {
        errorResponse(res, 'Prediction not found', 404);
        return;
      }

      // Create feedback
      const feedback = await prisma.aIFeedback.create({
        data: {
          predictionId,
          feedbackType,
          rating,
          comment,
          expectedOutcome,
          actualOutcome,
          userId: req.user!.id,
        },
      });

      // Update prediction status based on feedback
      if (feedbackType === 'ACCURATE' || feedbackType === 'CORRECT') {
        await prisma.aIPrediction.update({
          where: { id: predictionId },
          data: { status: 'CONFIRMED' },
        });
      } else if (feedbackType === 'INACCURATE' || feedbackType === 'INCORRECT') {
        await prisma.aIPrediction.update({
          where: { id: predictionId },
          data: { status: 'DISPROVEN' },
        });
      }

      successResponse(res, feedback, 'Feedback submitted successfully', 201);
    } catch (error) {
      console.error('Submit feedback error:', error);
      errorResponse(res, 'Failed to submit feedback', 500);
    }
  }
);

// Get Prediction History (Admin)
router.get(
  '/predictions',
  authenticate,
  authorize('ADMIN'),
  [
    query('modelType').optional().isIn(['DEMAND_FORECAST', 'PRICE_RECOMMENDATION', 'FRAUD_DETECTION', 'ROUTE_OPTIMIZATION', 'DRIVER_MATCH', 'ETA_PREDICTION', 'USER_BEHAVIOR']),
    query('status').optional().isIn(['ACTIVE', 'CONFIRMED', 'DISPROVEN', 'EXPIRED', 'SHADOW']),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  async (req: Request, res: Response) => {
    try {
      const { modelType, status, page = '1', limit = '20' } = req.query;

      const where: any = {};
      if (modelType) where.modelType = modelType;
      if (status) where.status = status;

      const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
      const take = parseInt(limit as string);

      const [predictions, total] = await Promise.all([
        prisma.aIPrediction.findMany({
          where,
          include: {
            user: {
              select: {
                firstName: true,
                lastName: true,
              },
            },
          },
          skip,
          take,
          orderBy: { createdAt: 'desc' },
        }),
        prisma.aIPrediction.count({ where }),
      ]);

      successResponse(res, predictions, 'Predictions retrieved', 200, {
        page: parseInt(page as string),
        limit: take,
        total,
      });
    } catch (error) {
      console.error('Get predictions error:', error);
      errorResponse(res, 'Failed to retrieve predictions', 500);
    }
  }
);

// Get Model Performance Metrics (Admin)
router.get(
  '/metrics',
  authenticate,
  authorize('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      // Calculate metrics for each model type
      const [demandMetrics, fraudMetrics] = await Promise.all([
        // Demand forecast accuracy
        prisma.aIPrediction.groupBy({
          by: ['status'],
          where: { modelType: 'DEMAND_FORECAST' },
          _count: { id: true },
        }),
        // Fraud detection stats
        prisma.fraudAlert.groupBy({
          by: ['status'],
          _count: { id: true },
        }),
      ]);

      const totalPredictions = demandMetrics.reduce((sum, m) => sum + m._count.id, 0);
      const confirmedPredictions = demandMetrics
        .find((m) => m.status === 'CONFIRMED')?._count.id || 0;
      const accuracy = totalPredictions > 0
        ? (confirmedPredictions / totalPredictions) * 100
        : 0;

      const metrics = {
        demandForecast: {
          totalPredictions,
          accuracy: Math.round(accuracy * 100) / 100,
          byStatus: demandMetrics,
        },
        fraudDetection: {
          totalAlerts: fraudMetrics.reduce((sum, m) => sum + m._count.id, 0),
          byStatus: fraudMetrics,
        },
      };

      successResponse(res, metrics);
    } catch (error) {
      console.error('Get metrics error:', error);
      errorResponse(res, 'Failed to retrieve metrics', 500);
    }
  }
);

// Trigger Analytics Update (Admin only - can be scheduled)
router.post(
  '/update-analytics',
  authenticate,
  authorize('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      await analyticsService.updateMarketAnalytics();

      successResponse(res, { updated: true }, 'Analytics updated successfully');
    } catch (error) {
      console.error('Update analytics error:', error);
      errorResponse(res, 'Failed to update analytics', 500);
    }
  }
);

export default router;
