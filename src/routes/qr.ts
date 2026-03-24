import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate, authorize } from '../middleware/auth';
import { qrCodeService } from '../services/qr';
import { successResponse, errorResponse } from '../utils/response';

const router = Router();
const prisma = new PrismaClient();

// Generate QR code for pickup or delivery
router.post('/generate/:jobId', authenticate, async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const { type } = req.body; // 'PICKUP' or 'DELIVERY'
    const userId = req.user!.id;

    if (!type || (type !== 'PICKUP' && type !== 'DELIVERY')) {
      return errorResponse(res, 'Type must be PICKUP or DELIVERY', 400);
    }

    const result = await qrCodeService.generateQRCode(jobId, type);

    if (result.success) {
      successResponse(res, {
        qrCode: result.qrCode,
        dataUrl: result.dataUrl,
      }, result.message);
    } else {
      errorResponse(res, result.message, 400);
    }
  } catch (error) {
    console.error('Generate QR error:', error);
    errorResponse(res, 'Failed to generate QR code', 500);
  }
});

// Get QR code for a job
router.get('/:jobId', authenticate, async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const { type } = req.query;
    const userId = req.user!.id;

    if (!type || (type !== 'PICKUP' && type !== 'DELIVERY')) {
      return errorResponse(res, 'Type must be PICKUP or DELIVERY', 400);
    }

    const result = await qrCodeService.getQRCode(jobId, type as 'PICKUP' | 'DELIVERY', userId);

    if (result.success) {
      successResponse(res, {
        qrCode: result.qrCode,
        dataUrl: result.dataUrl,
      }, result.message);
    } else {
      errorResponse(res, result.message, 400);
    }
  } catch (error) {
    console.error('Get QR error:', error);
    errorResponse(res, 'Failed to get QR code', 500);
  }
});

// Regenerate QR code
router.post('/regenerate/:jobId', authenticate, async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const { type } = req.body;
    const userId = req.user!.id;

    if (!type || (type !== 'PICKUP' && type !== 'DELIVERY')) {
      return errorResponse(res, 'Type must be PICKUP or DELIVERY', 400);
    }

    const result = await qrCodeService.regenerateQRCode(jobId, type, userId);

    if (result.success) {
      successResponse(res, {
        qrCode: result.qrCode,
        dataUrl: result.dataUrl,
      }, result.message);
    } else {
      errorResponse(res, result.message, 400);
    }
  } catch (error) {
    console.error('Regenerate QR error:', error);
    errorResponse(res, 'Failed to regenerate QR code', 500);
  }
});

// Verify QR code (scan endpoint)
router.post('/verify', authenticate, async (req: Request, res: Response) => {
  try {
    const { qrData } = req.body; // Base64 encoded QR data
    const userId = req.user!.id;
    const { lat, lng } = req.body; // Optional location

    if (!qrData) {
      return errorResponse(res, 'QR data is required', 400);
    }

    const result = await qrCodeService.verifyQRCode(
      qrData,
      userId,
      lat && lng ? { lat, lng } : undefined
    );

    if (result.valid) {
      successResponse(res, {
        jobId: result.jobId,
        type: result.type,
        job: result.job,
      }, result.message);
    } else {
      errorResponse(res, result.message, 400);
    }
  } catch (error) {
    console.error('Verify QR error:', error);
    errorResponse(res, 'Failed to verify QR code', 500);
  }
});

// Get QR code status
router.get('/status/:jobId', authenticate, async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const userId = req.user!.id;

    const job = await prisma.freightJob.findUnique({
      where: { id: jobId },
      include: {
        freightPost: {
          include: {
            shipper: true,
          },
        },
      },
    });

    if (!job) {
      return errorResponse(res, 'Job not found', 404);
    }

    // Check authorization
    const isShipper = job.freightPost.shipper.userId === userId;
    const isDriver = job.driverId === userId;

    if (!isShipper && !isDriver) {
      return errorResponse(res, 'Not authorized', 403);
    }

    successResponse(res, {
      pickupConfirmed: job.pickupConfirmed,
      deliveryConfirmed: job.deliveryConfirmed,
      pickupQrCode: isShipper ? !!job.pickupQrCode : undefined,
      deliveryQrCode: isShipper ? !!job.deliveryQrCode : undefined,
    }, 'QR code status retrieved');
  } catch (error) {
    console.error('Get QR status error:', error);
    errorResponse(res, 'Failed to get QR code status', 500);
  }
});

export default router;
