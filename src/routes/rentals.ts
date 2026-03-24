import { Router, Request, Response } from 'express';
import { body, query } from 'express-validator';
import { prisma } from '../prisma/client';
import { successResponse, errorResponse } from '../utils/response';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

// Create Booking Request (Any authenticated user)
router.post(
  '/',
  authenticate,
  [
    body('assetId').notEmpty().withMessage('Asset ID is required'),
    body('startDate').isISO8601().withMessage('Valid start date required'),
    body('endDate').isISO8601().withMessage('Valid end date required'),
    body('pickupLocation').optional().isString(),
    body('notes').optional().isString(),
  ],
  async (req: Request, res: Response) => {
    try {
      const { assetId, startDate, endDate, pickupLocation, notes } = req.body;

      const asset = await prisma.asset.findUnique({
        where: { id: assetId },
        include: {
          owner: {
            include: {
              user: {
                select: {
                  id: true,
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

      if (asset.status !== 'AVAILABLE') {
        errorResponse(res, 'Asset is not available for rental', 400);
        return;
      }

      // Prevent booking own asset
      if (asset.owner.user?.id === req.user!.id) {
        errorResponse(res, 'Cannot book your own asset', 400);
        return;
      }

      if (!asset.dailyRate) {
        errorResponse(res, 'Asset does not have a daily rate set', 400);
        return;
      }

      const start = new Date(startDate);
      const end = new Date(endDate);

      if (start >= end) {
        errorResponse(res, 'End date must be after start date', 400);
        return;
      }

      // Calculate total days and amount
      const diffTime = Math.abs(end.getTime() - start.getTime());
      const totalDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      const totalAmount = totalDays * asset.dailyRate;

      // Check for overlapping bookings
      const overlappingBooking = await prisma.rentalBooking.findFirst({
        where: {
          assetId,
          status: {
            in: ['CONFIRMED', 'ACTIVE'],
          },
          OR: [
            {
              startDate: { lte: end },
              endDate: { gte: start },
            },
          ],
        },
      });

      if (overlappingBooking) {
        errorResponse(res, 'Asset is not available for the selected dates', 400);
        return;
      }

      const booking = await prisma.rentalBooking.create({
        data: {
          assetId,
          renterId: req.user!.id,
          startDate: start,
          endDate: end,
          totalDays,
          dailyRate: asset.dailyRate,
          totalAmount,
          pickupLocation,
          notes,
        },
        include: {
          asset: {
            include: {
              owner: {
                include: {
                  user: {
                    select: {
                      firstName: true,
                      lastName: true,
                      phone: true,
                    },
                  },
                },
              },
            },
          },
          renter: {
            select: {
              firstName: true,
              lastName: true,
              phone: true,
            },
          },
        },
      });

      successResponse(res, booking, 'Booking request created successfully', 201);
    } catch (error) {
      console.error('Create booking error:', error);
      errorResponse(res, 'Failed to create booking', 500);
    }
  }
);

// Get My Bookings (as Renter)
router.get('/my', authenticate, async (req: Request, res: Response) => {
  try {
    const { status, page = '1', limit = '20' } = req.query;

    const where: any = { renterId: req.user!.id };
    if (status) where.status = status;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const [bookings, total] = await Promise.all([
      prisma.rentalBooking.findMany({
        where,
        include: {
          asset: {
            select: {
              id: true,
              name: true,
              type: true,
              capacity: true,
              year: true,
              plateNumber: true,
            },
          },
        },
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.rentalBooking.count({ where }),
    ]);

    successResponse(res, bookings, 'Bookings retrieved successfully', 200, {
      page: parseInt(page as string),
      limit: take,
      total,
    });
  } catch (error) {
    console.error('Get my bookings error:', error);
    errorResponse(res, 'Failed to retrieve bookings', 500);
  }
});

// Get Bookings for My Assets (as Fleet Owner)
router.get('/incoming', authenticate, authorize('FLEET_OWNER'), async (req: Request, res: Response) => {
  try {
    const fleetOwner = await prisma.fleetOwnerProfile.findUnique({
      where: { userId: req.user!.id },
    });

    if (!fleetOwner) {
      errorResponse(res, 'Fleet owner profile not found', 404);
      return;
    }

    const { status, page = '1', limit = '20' } = req.query;

    const where: any = {
      asset: {
        ownerId: fleetOwner.id,
      },
    };
    if (status) where.status = status;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const [bookings, total] = await Promise.all([
      prisma.rentalBooking.findMany({
        where,
        include: {
          asset: {
            select: {
              id: true,
              name: true,
              type: true,
              dailyRate: true,
            },
          },
          renter: {
            select: {
              firstName: true,
              lastName: true,
              phone: true,
              isFaydaVerified: true,
            },
          },
        },
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.rentalBooking.count({ where }),
    ]);

    successResponse(res, bookings, 'Incoming bookings retrieved successfully', 200, {
      page: parseInt(page as string),
      limit: take,
      total,
    });
  } catch (error) {
    console.error('Get incoming bookings error:', error);
    errorResponse(res, 'Failed to retrieve incoming bookings', 500);
  }
});

// Get Booking Details
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const booking = await prisma.rentalBooking.findUnique({
      where: { id },
      include: {
        asset: {
          include: {
            owner: {
              include: {
                user: {
                  select: {
                    firstName: true,
                    lastName: true,
                    phone: true,
                  },
                },
              },
            },
          },
        },
        renter: {
          select: {
            firstName: true,
            lastName: true,
            phone: true,
            isFaydaVerified: true,
          },
        },
      },
    });

    if (!booking) {
      errorResponse(res, 'Booking not found', 404);
      return;
    }

    // Check authorization
    const fleetOwner = await prisma.fleetOwnerProfile.findUnique({
      where: { userId: req.user!.id },
    });

    const isRenter = booking.renterId === req.user!.id;
    const isOwner = fleetOwner && booking.asset.ownerId === fleetOwner.id;

    if (!isRenter && !isOwner) {
      errorResponse(res, 'Not authorized to view this booking', 403);
      return;
    }

    successResponse(res, booking);
  } catch (error) {
    console.error('Get booking error:', error);
    errorResponse(res, 'Failed to retrieve booking', 500);
  }
});

// Update Booking Status (Fleet Owner)
router.patch(
  '/:id/status',
  authenticate,
  authorize('FLEET_OWNER'),
  [
    body('status').isIn(['CONFIRMED', 'REJECTED', 'CANCELLED']).withMessage('Valid status required'),
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

      const booking = await prisma.rentalBooking.findFirst({
        where: {
          id,
          asset: {
            ownerId: fleetOwner.id,
          },
        },
      });

      if (!booking) {
        errorResponse(res, 'Booking not found', 404);
        return;
      }

      const updatedBooking = await prisma.rentalBooking.update({
        where: { id },
        data: { status },
        include: {
          asset: {
            select: {
              name: true,
            },
          },
        },
      });

      // Update asset status if confirmed
      if (status === 'CONFIRMED') {
        await prisma.asset.update({
          where: { id: booking.assetId },
          data: { status: 'RENTED' },
        });
      }

      successResponse(res, updatedBooking, `Booking ${status.toLowerCase()}`);
    } catch (error) {
      console.error('Update booking status error:', error);
      errorResponse(res, 'Failed to update booking status', 500);
    }
  }
);

// Cancel Booking (Renter)
router.patch(
  '/:id/cancel',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const booking = await prisma.rentalBooking.findFirst({
        where: {
          id,
          renterId: req.user!.id,
        },
      });

      if (!booking) {
        errorResponse(res, 'Booking not found', 404);
        return;
      }

      if (booking.status === 'CANCELLED') {
        errorResponse(res, 'Booking is already cancelled', 400);
        return;
      }

      const updatedBooking = await prisma.rentalBooking.update({
        where: { id },
        data: { status: 'CANCELLED' },
      });

      // Free up the asset if it was confirmed
      if (booking.status === 'CONFIRMED' || booking.status === 'ACTIVE') {
        await prisma.asset.update({
          where: { id: booking.assetId },
          data: { status: 'AVAILABLE' },
        });
      }

      successResponse(res, updatedBooking, 'Booking cancelled successfully');
    } catch (error) {
      console.error('Cancel booking error:', error);
      errorResponse(res, 'Failed to cancel booking', 500);
    }
  }
);

// Mark Booking as Active (Fleet Owner - when asset is picked up)
router.patch(
  '/:id/start',
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

      const booking = await prisma.rentalBooking.findFirst({
        where: {
          id,
          asset: {
            ownerId: fleetOwner.id,
          },
          status: 'CONFIRMED',
        },
      });

      if (!booking) {
        errorResponse(res, 'Booking not found or not confirmed', 404);
        return;
      }

      const updatedBooking = await prisma.rentalBooking.update({
        where: { id },
        data: { status: 'ACTIVE' },
        include: {
          asset: {
            select: {
              name: true,
            },
          },
        },
      });

      successResponse(res, updatedBooking, 'Rental started successfully');
    } catch (error) {
      console.error('Start rental error:', error);
      errorResponse(res, 'Failed to start rental', 500);
    }
  }
);

// Mark Booking as Completed (Fleet Owner - when asset is returned)
router.patch(
  '/:id/complete',
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

      const booking = await prisma.rentalBooking.findFirst({
        where: {
          id,
          asset: {
            ownerId: fleetOwner.id,
          },
          status: 'ACTIVE',
        },
      });

      if (!booking) {
        errorResponse(res, 'Booking not found or not active', 404);
        return;
      }

      const updatedBooking = await prisma.rentalBooking.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          paymentStatus: 'COMPLETED',
        },
        include: {
          asset: {
            select: {
              name: true,
            },
          },
        },
      });

      // Update asset status back to available
      await prisma.asset.update({
        where: { id: booking.assetId },
        data: { status: 'AVAILABLE' },
      });

      successResponse(res, updatedBooking, 'Rental completed successfully');
    } catch (error) {
      console.error('Complete rental error:', error);
      errorResponse(res, 'Failed to complete rental', 500);
    }
  }
);

export default router;
