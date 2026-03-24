import { Router, Request, Response } from 'express';
import { body } from 'express-validator';
import { prisma } from '../prisma/client';
import { successResponse, errorResponse } from '../utils/response';
import { authenticate, authorize } from '../middleware/auth';
import crypto from 'crypto';

const router = Router();

// Get Job Details
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user!;

    const job = await prisma.freightJob.findUnique({
      where: { id },
      include: {
        freightPost: {
          include: {
            shipper: {
              include: {
                user: {
                  select: {
                    firstName: true,
                    lastName: true,
                    phone: true,
                    email: true,
                  },
                },
              },
            },
          },
        },
        bid: true,
        driver: {
          include: {
            user: {
              select: {
                firstName: true,
                lastName: true,
                phone: true,
                avatar: true,
              },
            },
          },
        },
      },
    });

    if (!job) {
      errorResponse(res, 'Job not found', 404);
      return;
    }

    // Check authorization
    const driverUserId = job.driver?.userId;
    const shipperUserId = job.freightPost?.shipper?.userId;

    if (user.role === 'DRIVER' && driverUserId !== user.id) {
      errorResponse(res, 'Not authorized to view this job', 403);
      return;
    }

    if (user.role === 'SHIPPER' && shipperUserId !== user.id) {
      errorResponse(res, 'Not authorized to view this job', 403);
      return;
    }

    successResponse(res, job);
  } catch (error) {
    console.error('Get job error:', error);
    errorResponse(res, 'Failed to retrieve job', 500);
  }
});

// Get My Jobs (Driver or Shipper)
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { status, page = '1', limit = '20' } = req.query;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    let where: any = {};

    if (user.role === 'DRIVER') {
      const driver = await prisma.driverProfile.findUnique({
        where: { userId: user.id },
      });

      if (!driver) {
        errorResponse(res, 'Driver profile not found', 404);
        return;
      }

      where.driverId = driver.id;
    } else if (user.role === 'SHIPPER') {
      const shipper = await prisma.shipperProfile.findUnique({
        where: { userId: user.id },
      });

      if (!shipper) {
        errorResponse(res, 'Shipper profile not found', 404);
        return;
      }

      where.freightPost = {
        shipperId: shipper.id,
      };
    }

    if (status) {
      where.status = status;
    }

    const [jobs, total] = await Promise.all([
      prisma.freightJob.findMany({
        where,
        include: {
          freightPost: {
            select: {
              id: true,
              title: true,
              pickupLocation: true,
              deliveryLocation: true,
              pickupDate: true,
              preferredDeliveryDate: true,
              weight: true,
              cargoType: true,
            },
          },
          bid: {
            select: {
              amount: true,
              currency: true,
            },
          },
          driver: user.role === 'SHIPPER' ? {
            include: {
              user: {
                select: {
                  firstName: true,
                  lastName: true,
                  phone: true,
                  avatar: true,
                },
              },
            },
          } : false,
        },
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.freightJob.count({ where }),
    ]);

    successResponse(res, jobs, 'Jobs retrieved successfully', 200, {
      page: parseInt(page as string),
      limit: take,
      total,
    });
  } catch (error) {
    console.error('Get jobs error:', error);
    errorResponse(res, 'Failed to retrieve jobs', 500);
  }
});

// Update Job Status (Driver)
router.patch(
  '/:id/status',
  authenticate,
  authorize('DRIVER'),
  [
    body('status').isIn(['PICKUP_READY', 'IN_TRANSIT', 'NEAR_DELIVERY', 'DELIVERED']).withMessage('Valid status required'),
  ],
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { status, notes } = req.body;

      const driver = await prisma.driverProfile.findUnique({
        where: { userId: req.user!.id },
      });

      if (!driver) {
        errorResponse(res, 'Driver profile not found', 404);
        return;
      }

      const job = await prisma.freightJob.findFirst({
        where: {
          id,
          driverId: driver.id,
        },
        include: {
          freightPost: true,
        },
      });

      if (!job) {
        errorResponse(res, 'Job not found', 404);
        return;
      }

      // Validate status transition
      const validTransitions: Record<string, string[]> = {
        'ASSIGNED': ['PICKUP_READY'],
        'PICKUP_READY': ['IN_TRANSIT'],
        'IN_TRANSIT': ['NEAR_DELIVERY', 'DELIVERED'],
        'NEAR_DELIVERY': ['DELIVERED'],
      };

      const allowedNextStatuses = validTransitions[job.status] || [];
      if (!allowedNextStatuses.includes(status)) {
        errorResponse(res, `Cannot transition from ${job.status} to ${status}`, 400);
        return;
      }

      const updateData: any = { status };

      if (status === 'PICKUP_READY') {
        updateData.pickupTime = new Date();
        // Generate pickup QR code
        updateData.pickupQrCode = crypto.randomBytes(32).toString('hex');
      }

      if (status === 'IN_TRANSIT') {
        updateData.pickupConfirmed = true;
      }

      if (status === 'NEAR_DELIVERY') {
        // Generate delivery QR code
        updateData.deliveryQrCode = crypto.randomBytes(32).toString('hex');
      }

      if (status === 'DELIVERED') {
        updateData.deliveryTime = new Date();
        updateData.notes = notes;
      }

      const updatedJob = await prisma.freightJob.update({
        where: { id },
        data: updateData,
        include: {
          freightPost: true,
        },
      });

      // Update freight post status
      if (status === 'DELIVERED') {
        await prisma.freightPost.update({
          where: { id: job.freightPostId },
          data: { status: 'DELIVERED' },
        });
      } else if (status === 'IN_TRANSIT') {
        await prisma.freightPost.update({
          where: { id: job.freightPostId },
          data: { status: 'IN_PROGRESS' },
        });
      }

      successResponse(res, updatedJob, `Job status updated to ${status}`);
    } catch (error) {
      console.error('Update job status error:', error);
      errorResponse(res, 'Failed to update job status', 500);
    }
  }
);

// Update Location (Driver)
router.patch(
  '/:id/location',
  authenticate,
  authorize('DRIVER'),
  [
    body('lat').isFloat().withMessage('Valid latitude required'),
    body('lng').isFloat().withMessage('Valid longitude required'),
  ],
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { lat, lng } = req.body;

      const driver = await prisma.driverProfile.findUnique({
        where: { userId: req.user!.id },
      });

      if (!driver) {
        errorResponse(res, 'Driver profile not found', 404);
        return;
      }

      const job = await prisma.freightJob.findFirst({
        where: {
          id,
          driverId: driver.id,
          status: {
            in: ['ASSIGNED', 'PICKUP_READY', 'IN_TRANSIT', 'NEAR_DELIVERY'],
          },
        },
      });

      if (!job) {
        errorResponse(res, 'Active job not found', 404);
        return;
      }

      const updatedJob = await prisma.freightJob.update({
        where: { id },
        data: {
          currentLat: lat,
          currentLng: lng,
          lastLocationUpdate: new Date(),
        },
      });

      successResponse(res, {
        lat: updatedJob.currentLat,
        lng: updatedJob.currentLng,
        lastUpdate: updatedJob.lastLocationUpdate,
      }, 'Location updated');
    } catch (error) {
      console.error('Update location error:', error);
      errorResponse(res, 'Failed to update location', 500);
    }
  }
);

// Get Job Location (Shipper)
router.get('/:id/location', authenticate, authorize('SHIPPER'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const shipper = await prisma.shipperProfile.findUnique({
      where: { userId: req.user!.id },
    });

    if (!shipper) {
      errorResponse(res, 'Shipper profile not found', 404);
      return;
    }

    const job = await prisma.freightJob.findFirst({
      where: {
        id,
        freightPost: {
          shipperId: shipper.id,
        },
      },
      include: {
        driver: {
          select: {
            currentLocation: true,
          },
        },
      },
    });

    if (!job) {
      errorResponse(res, 'Job not found', 404);
      return;
    }

    successResponse(res, {
      lat: job.currentLat,
      lng: job.currentLng,
      lastUpdate: job.lastLocationUpdate,
      driverLocation: job.driver?.currentLocation,
    });
  } catch (error) {
    console.error('Get location error:', error);
    errorResponse(res, 'Failed to get location', 500);
  }
});

// Verify Pickup QR Code (Shipper)
router.post(
  '/:id/verify-pickup',
  authenticate,
  authorize('SHIPPER'),
  [
    body('qrCode').notEmpty().withMessage('QR code required'),
  ],
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { qrCode } = req.body;

      const shipper = await prisma.shipperProfile.findUnique({
        where: { userId: req.user!.id },
      });

      if (!shipper) {
        errorResponse(res, 'Shipper profile not found', 404);
        return;
      }

      const job = await prisma.freightJob.findFirst({
        where: {
          id,
          freightPost: {
            shipperId: shipper.id,
          },
        },
      });

      if (!job) {
        errorResponse(res, 'Job not found', 404);
        return;
      }

      if (job.pickupQrCode !== qrCode) {
        errorResponse(res, 'Invalid QR code', 400);
        return;
      }

      // Mark pickup as confirmed
      const updatedJob = await prisma.freightJob.update({
        where: { id },
        data: {
          pickupConfirmed: true,
          status: 'IN_TRANSIT',
        },
        include: {
          freightPost: true,
        },
      });

      // Update freight post status
      await prisma.freightPost.update({
        where: { id: job.freightPostId },
        data: { status: 'IN_PROGRESS' },
      });

      successResponse(res, updatedJob, 'Pickup verified successfully');
    } catch (error) {
      console.error('Verify pickup error:', error);
      errorResponse(res, 'Failed to verify pickup', 500);
    }
  }
);

// Verify Delivery QR Code (Shipper)
router.post(
  '/:id/verify-delivery',
  authenticate,
  authorize('SHIPPER'),
  [
    body('qrCode').notEmpty().withMessage('QR code required'),
  ],
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { qrCode } = req.body;

      const shipper = await prisma.shipperProfile.findUnique({
        where: { userId: req.user!.id },
      });

      if (!shipper) {
        errorResponse(res, 'Shipper profile not found', 404);
        return;
      }

      const job = await prisma.freightJob.findFirst({
        where: {
          id,
          freightPost: {
            shipperId: shipper.id,
          },
        },
      });

      if (!job) {
        errorResponse(res, 'Job not found', 404);
        return;
      }

      if (job.deliveryQrCode !== qrCode) {
        errorResponse(res, 'Invalid QR code', 400);
        return;
      }

      // Mark delivery as confirmed
      const updatedJob = await prisma.freightJob.update({
        where: { id },
        data: {
          deliveryConfirmed: true,
          status: 'COMPLETED',
          deliveryTime: new Date(),
        },
        include: {
          freightPost: true,
        },
      });

      // Update freight post status
      await prisma.freightPost.update({
        where: { id: job.freightPostId },
        data: { status: 'DELIVERED' },
      });

      // Update driver stats
      await prisma.driverProfile.update({
        where: { id: job.driverId },
        data: {
          totalDeliveries: { increment: 1 },
        },
      });

      successResponse(res, updatedJob, 'Delivery verified successfully');
    } catch (error) {
      console.error('Verify delivery error:', error);
      errorResponse(res, 'Failed to verify delivery', 500);
    }
  }
);

// Upload Delivery Proof (Driver)
router.post(
  '/:id/delivery-proof',
  authenticate,
  authorize('DRIVER'),
  [
    body('photos').isArray().withMessage('Photos array required'),
    body('recipientName').optional().isString(),
    body('notes').optional().isString(),
  ],
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { photos, recipientName, notes } = req.body;

      const driver = await prisma.driverProfile.findUnique({
        where: { userId: req.user!.id },
      });

      if (!driver) {
        errorResponse(res, 'Driver profile not found', 404);
        return;
      }

      const job = await prisma.freightJob.findFirst({
        where: {
          id,
          driverId: driver.id,
        },
      });

      if (!job) {
        errorResponse(res, 'Job not found', 404);
        return;
      }

      const updatedJob = await prisma.freightJob.update({
        where: { id },
        data: {
          deliveryPhotos: photos,
          recipientName,
          notes,
        },
      });

      successResponse(res, updatedJob, 'Delivery proof uploaded');
    } catch (error) {
      console.error('Upload delivery proof error:', error);
      errorResponse(res, 'Failed to upload delivery proof', 500);
    }
  }
);

export default router;
