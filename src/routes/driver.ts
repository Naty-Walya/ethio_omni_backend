import { Router, Request, Response } from 'express';
import { body } from 'express-validator';
import { prisma } from '../prisma/client';
import { successResponse, errorResponse } from '../utils/response';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

// Get Driver Profile
router.get('/profile', authenticate, authorize('DRIVER'), async (req: Request, res: Response) => {
  try {
    const driver = await prisma.driverProfile.findUnique({
      where: { userId: req.user!.id },
      include: {
        user: {
          select: {
            firstName: true,
            lastName: true,
            phone: true,
            email: true,
            avatar: true,
            isPhoneVerified: true,
            isFaydaVerified: true,
          },
        },
      },
    });

    if (!driver) {
      errorResponse(res, 'Driver profile not found', 404);
      return;
    }

    successResponse(res, driver);
  } catch (error) {
    console.error('Get driver profile error:', error);
    errorResponse(res, 'Failed to retrieve driver profile', 500);
  }
});

// Update Driver Profile
router.put(
  '/profile',
  authenticate,
  authorize('DRIVER'),
  [
    body('licenseNumber').optional().isString(),
    body('licenseType').optional().isString(),
    body('vehicleType').optional().isIn(['SMALL_TRUCK', 'MEDIUM_TRUCK', 'LARGE_TRUCK', 'HEAVY_TRUCK', 'REFRIGERATED', 'FLATBED', 'TANKER']),
    body('vehicleCapacity').optional().isFloat({ min: 0 }),
    body('vehiclePlate').optional().isString(),
    body('currentLocation').optional().isString(),
  ],
  async (req: Request, res: Response) => {
    try {
      const driver = await prisma.driverProfile.findUnique({
        where: { userId: req.user!.id },
      });

      if (!driver) {
        errorResponse(res, 'Driver profile not found', 404);
        return;
      }

      const {
        licenseNumber,
        licenseExpiry,
        licenseType,
        vehicleType,
        vehicleCapacity,
        vehiclePlate,
        currentLocation,
      } = req.body;

      const updatedDriver = await prisma.driverProfile.update({
        where: { id: driver.id },
        data: {
          licenseNumber,
          licenseExpiry: licenseExpiry ? new Date(licenseExpiry) : undefined,
          licenseType,
          vehicleType,
          vehicleCapacity,
          vehiclePlate,
          currentLocation,
        },
        include: {
          user: {
            select: {
              firstName: true,
              lastName: true,
              phone: true,
              email: true,
              avatar: true,
            },
          },
        },
      });

      successResponse(res, updatedDriver, 'Driver profile updated successfully');
    } catch (error) {
      console.error('Update driver profile error:', error);
      errorResponse(res, 'Failed to update driver profile', 500);
    }
  }
);

// Update Availability Status
router.patch(
  '/availability',
  authenticate,
  authorize('DRIVER'),
  [
    body('isAvailable').isBoolean().withMessage('isAvailable must be a boolean'),
  ],
  async (req: Request, res: Response) => {
    try {
      const { isAvailable } = req.body;

      const driver = await prisma.driverProfile.findUnique({
        where: { userId: req.user!.id },
      });

      if (!driver) {
        errorResponse(res, 'Driver profile not found', 404);
        return;
      }

      const updatedDriver = await prisma.driverProfile.update({
        where: { id: driver.id },
        data: { isAvailable },
      });

      successResponse(res, {
        isAvailable: updatedDriver.isAvailable,
      }, `Driver is now ${isAvailable ? 'available' : 'unavailable'}`);
    } catch (error) {
      console.error('Update availability error:', error);
      errorResponse(res, 'Failed to update availability', 500);
    }
  }
);

// Update Current Location
router.patch(
  '/location',
  authenticate,
  authorize('DRIVER'),
  [
    body('lat').isFloat().withMessage('Valid latitude required'),
    body('lng').isFloat().withMessage('Valid longitude required'),
    body('location').optional().isString(),
  ],
  async (req: Request, res: Response) => {
    try {
      const { lat, lng, location } = req.body;

      const driver = await prisma.driverProfile.findUnique({
        where: { userId: req.user!.id },
      });

      if (!driver) {
        errorResponse(res, 'Driver profile not found', 404);
        return;
      }

      const currentLocation = location || `${lat},${lng}`;

      const updatedDriver = await prisma.driverProfile.update({
        where: { id: driver.id },
        data: { currentLocation },
      });

      successResponse(res, {
        currentLocation: updatedDriver.currentLocation,
      }, 'Location updated successfully');
    } catch (error) {
      console.error('Update location error:', error);
      errorResponse(res, 'Failed to update location', 500);
    }
  }
);

// Get Driver Stats
router.get('/stats', authenticate, authorize('DRIVER'), async (req: Request, res: Response) => {
  try {
    const driver = await prisma.driverProfile.findUnique({
      where: { userId: req.user!.id },
    });

    if (!driver) {
      errorResponse(res, 'Driver profile not found', 404);
      return;
    }

    // Get active jobs count
    const activeJobs = await prisma.freightJob.count({
      where: {
        driverId: driver.id,
        status: {
          in: ['ASSIGNED', 'PICKUP_READY', 'IN_TRANSIT', 'NEAR_DELIVERY'],
        },
      },
    });

    // Get completed jobs count
    const completedJobs = await prisma.freightJob.count({
      where: {
        driverId: driver.id,
        status: {
          in: ['DELIVERED', 'COMPLETED'],
        },
      },
    });

    // Get total earnings
    const earnings = await prisma.transaction.aggregate({
      where: {
        walletId: driver.userId,
        type: 'EARNING',
        status: 'COMPLETED',
      },
      _sum: {
        amount: true,
      },
    });

    successResponse(res, {
      totalDeliveries: driver.totalDeliveries,
      rating: driver.rating,
      totalReviews: driver.totalReviews,
      onTimeRate: driver.onTimeRate,
      isAvailable: driver.isAvailable,
      activeJobs,
      completedJobs,
      totalEarnings: earnings._sum.amount || 0,
    });
  } catch (error) {
    console.error('Get driver stats error:', error);
    errorResponse(res, 'Failed to retrieve driver stats', 500);
  }
});

// Get Available Loads (Nearby/Suitable)
router.get('/available-loads', authenticate, authorize('DRIVER'), async (req: Request, res: Response) => {
  try {
    const { location, maxDistance, vehicleType, page = '1', limit = '20' } = req.query;

    const driver = await prisma.driverProfile.findUnique({
      where: { userId: req.user!.id },
    });

    if (!driver) {
      errorResponse(res, 'Driver profile not found', 404);
      return;
    }

    const where: any = {
      status: {
        in: ['POSTED', 'AUCTION'],
      },
    };

    // Filter by vehicle type if driver's vehicle type is set
    if (driver.vehicleType) {
      where.OR = [
        { requiredVehicleType: driver.vehicleType },
        { requiredVehicleType: null },
      ];
    }

    // Filter by location if provided
    if (location) {
      where.pickupLocation = {
        contains: location as string,
        mode: 'insensitive',
      };
    }

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const [loads, total] = await Promise.all([
      prisma.freightPost.findMany({
        where,
        include: {
          shipper: {
            include: {
              user: {
                select: {
                  firstName: true,
                  lastName: true,
                  isFaydaVerified: true,
                },
              },
            },
          },
          _count: {
            select: {
              bids: true,
            },
          },
        },
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.freightPost.count({ where }),
    ]);

    successResponse(res, loads, 'Available loads retrieved successfully', 200, {
      page: parseInt(page as string),
      limit: take,
      total,
    });
  } catch (error) {
    console.error('Get available loads error:', error);
    errorResponse(res, 'Failed to retrieve available loads', 500);
  }
});

export default router;
