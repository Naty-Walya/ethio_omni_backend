import { Router, Request, Response } from 'express';
import { body } from 'express-validator';
import { prisma } from '../prisma/client';
import { successResponse, errorResponse } from '../utils/response';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

// Create Asset (Fleet Owner only)
router.post(
  '/',
  authenticate,
  authorize('FLEET_OWNER'),
  [
    body('name').notEmpty().withMessage('Asset name is required'),
    body('type').isIn(['TRUCK', 'MACHINERY', 'CAR', 'VAN']).withMessage('Valid asset type required'),
    body('capacity').optional().isFloat({ min: 0 }).withMessage('Capacity must be positive'),
    body('year').optional().isInt({ min: 1990, max: new Date().getFullYear() }).withMessage('Valid year required'),
    body('plateNumber').optional().isString().withMessage('Plate number must be a string'),
    body('dailyRate').optional().isFloat({ min: 0 }).withMessage('Daily rate must be positive'),
  ],
  async (req: Request, res: Response) => {
    try {
      const fleetOwner = await prisma.fleetOwnerProfile.findUnique({
        where: { userId: req.user!.id },
      });

      if (!fleetOwner) {
        errorResponse(res, 'Fleet owner profile not found', 404);
        return;
      }

      const {
        name,
        type,
        capacity,
        year,
        plateNumber,
        currentLocation,
        dailyRate,
      } = req.body;

      const asset = await prisma.asset.create({
        data: {
          ownerId: fleetOwner.id,
          name,
          type,
          capacity,
          year,
          plateNumber,
          currentLocation,
          dailyRate,
          status: 'AVAILABLE',
        },
      });

      // Update fleet size
      await prisma.fleetOwnerProfile.update({
        where: { id: fleetOwner.id },
        data: { fleetSize: { increment: 1 } },
      });

      successResponse(res, asset, 'Asset registered successfully', 201);
    } catch (error) {
      console.error('Create asset error:', error);
      errorResponse(res, 'Failed to register asset', 500);
    }
  }
);

// List My Assets (Fleet Owner)
router.get('/my', authenticate, authorize('FLEET_OWNER'), async (req: Request, res: Response) => {
  try {
    const fleetOwner = await prisma.fleetOwnerProfile.findUnique({
      where: { userId: req.user!.id },
    });

    if (!fleetOwner) {
      errorResponse(res, 'Fleet owner profile not found', 404);
      return;
    }

    const { status, type, page = '1', limit = '20' } = req.query;

    const where: any = { ownerId: fleetOwner.id };
    if (status) where.status = status;
    if (type) where.type = type;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const [assets, total] = await Promise.all([
      prisma.asset.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.asset.count({ where }),
    ]);

    successResponse(res, assets, 'Assets retrieved successfully', 200, {
      page: parseInt(page as string),
      limit: take,
      total,
    });
  } catch (error) {
    console.error('List assets error:', error);
    errorResponse(res, 'Failed to retrieve assets', 500);
  }
});

// Get Asset Details
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const asset = await prisma.asset.findUnique({
      where: { id },
      include: {
        owner: {
          include: {
            user: {
              select: {
                firstName: true,
                lastName: true,
                phone: true,
                isFaydaVerified: true,
              },
            },
          },
        },
      },
    });

    if (!asset) {
      errorResponse(res, 'Asset not found', 404);
      return;
    }

    successResponse(res, asset);
  } catch (error) {
    console.error('Get asset error:', error);
    errorResponse(res, 'Failed to retrieve asset', 500);
  }
});

// Update Asset (Fleet Owner only)
router.put(
  '/:id',
  authenticate,
  authorize('FLEET_OWNER'),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const fleetOwner = await prisma.fleetOwnerProfile.findUnique({
        where: { userId: req.user!.id },
      });

      if (!fleetOwner) {
        errorResponse(res, 'Fleet owner profile not found', 404);
        return;
      }

      const asset = await prisma.asset.findFirst({
        where: {
          id,
          ownerId: fleetOwner.id,
        },
      });

      if (!asset) {
        errorResponse(res, 'Asset not found or access denied', 404);
        return;
      }

      const {
        name,
        capacity,
        year,
        plateNumber,
        currentLocation,
        dailyRate,
        status,
      } = req.body;

      const updatedAsset = await prisma.asset.update({
        where: { id },
        data: {
          name,
          capacity,
          year,
          plateNumber,
          currentLocation,
          dailyRate,
          status,
        },
      });

      successResponse(res, updatedAsset, 'Asset updated successfully');
    } catch (error) {
      console.error('Update asset error:', error);
      errorResponse(res, 'Failed to update asset', 500);
    }
  }
);

// Update Asset Status (Fleet Owner only)
router.patch(
  '/:id/status',
  authenticate,
  authorize('FLEET_OWNER'),
  [
    body('status').isIn(['AVAILABLE', 'RENTED', 'MAINTENANCE', 'IN_USE', 'UNAVAILABLE']).withMessage('Valid status required'),
  ],
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      const fleetOwner = await prisma.fleetOwnerProfile.findUnique({
        where: { userId: req.user!.id },
      });

      if (!fleetOwner) {
        errorResponse(res, 'Fleet owner profile not found', 404);
        return;
      }

      const asset = await prisma.asset.findFirst({
        where: {
          id,
          ownerId: fleetOwner.id,
        },
      });

      if (!asset) {
        errorResponse(res, 'Asset not found or access denied', 404);
        return;
      }

      const updatedAsset = await prisma.asset.update({
        where: { id },
        data: { status },
      });

      successResponse(res, updatedAsset, 'Asset status updated successfully');
    } catch (error) {
      console.error('Update asset status error:', error);
      errorResponse(res, 'Failed to update asset status', 500);
    }
  }
);

// Delete Asset (Fleet Owner only)
router.delete(
  '/:id',
  authenticate,
  authorize('FLEET_OWNER'),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const fleetOwner = await prisma.fleetOwnerProfile.findUnique({
        where: { userId: req.user!.id },
      });

      if (!fleetOwner) {
        errorResponse(res, 'Fleet owner profile not found', 404);
        return;
      }

      const asset = await prisma.asset.findFirst({
        where: {
          id,
          ownerId: fleetOwner.id,
        },
      });

      if (!asset) {
        errorResponse(res, 'Asset not found or access denied', 404);
        return;
      }

      await prisma.asset.delete({
        where: { id },
      });

      // Update fleet size
      await prisma.fleetOwnerProfile.update({
        where: { id: fleetOwner.id },
        data: { fleetSize: { decrement: 1 } },
      });

      successResponse(res, null, 'Asset deleted successfully');
    } catch (error) {
      console.error('Delete asset error:', error);
      errorResponse(res, 'Failed to delete asset', 500);
    }
  }
);

// List All Available Assets (Public with filters)
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const {
      type,
      status = 'AVAILABLE',
      minCapacity,
      maxCapacity,
      location,
      page = '1',
      limit = '20',
    } = req.query;

    const where: any = {};

    if (status) where.status = status;
    if (type) where.type = type;
    if (minCapacity || maxCapacity) {
      where.capacity = {};
      if (minCapacity) where.capacity.gte = parseFloat(minCapacity as string);
      if (maxCapacity) where.capacity.lte = parseFloat(maxCapacity as string);
    }
    if (location) {
      where.currentLocation = {
        contains: location as string,
        mode: 'insensitive',
      };
    }

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const [assets, total] = await Promise.all([
      prisma.asset.findMany({
        where,
        include: {
          owner: {
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
        },
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.asset.count({ where }),
    ]);

    successResponse(res, assets, 'Assets retrieved successfully', 200, {
      page: parseInt(page as string),
      limit: take,
      total,
    });
  } catch (error) {
    console.error('List all assets error:', error);
    errorResponse(res, 'Failed to retrieve assets', 500);
  }
});

// Get Fleet by Owner (Public)
router.get('/owner/:ownerId', authenticate, async (req: Request, res: Response) => {
  try {
    const { ownerId } = req.params;
    const { status, page = '1', limit = '20' } = req.query;

    const where: any = { ownerId };
    if (status) where.status = status;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const [assets, total] = await Promise.all([
      prisma.asset.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.asset.count({ where }),
    ]);

    successResponse(res, assets, 'Fleet retrieved successfully', 200, {
      page: parseInt(page as string),
      limit: take,
      total,
    });
  } catch (error) {
    console.error('Get fleet error:', error);
    errorResponse(res, 'Failed to retrieve fleet', 500);
  }
});

export default router;
