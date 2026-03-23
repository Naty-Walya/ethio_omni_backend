import { Router, Request, Response } from 'express';
import { body, query } from 'express-validator';
import { prisma } from '../prisma/client';
import { successResponse, errorResponse } from '../utils/response';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

// Create Freight Post (Shipper only)
router.post(
  '/',
  authenticate,
  authorize('SHIPPER'),
  [
    body('title').notEmpty().withMessage('Title is required'),
    body('cargoType').notEmpty().withMessage('Cargo type is required'),
    body('weight').isFloat({ min: 0 }).withMessage('Weight must be positive'),
    body('pickupLocation').notEmpty().withMessage('Pickup location is required'),
    body('pickupDate').isISO8601().withMessage('Valid pickup date required'),
    body('deliveryLocation').notEmpty().withMessage('Delivery location is required'),
  ],
  async (req: Request, res: Response) => {
    try {
      const shipper = await prisma.shipperProfile.findUnique({
        where: { userId: req.user!.id },
      });

      if (!shipper) {
        errorResponse(res, 'Shipper profile not found', 404);
        return;
      }

      const {
        title,
        description,
        cargoType,
        weight,
        dimensions,
        pickupLocation,
        pickupLat,
        pickupLng,
        pickupDate,
        deliveryLocation,
        deliveryLat,
        deliveryLng,
        preferredDeliveryDate,
        requiredVehicleType,
        specialRequirements,
        budget,
        auctionEnabled,
        auctionDuration,
        startingBid,
      } = req.body;

      const freightPost = await prisma.freightPost.create({
        data: {
          shipperId: shipper.id,
          title,
          description,
          cargoType,
          weight,
          dimensions,
          pickupLocation,
          pickupLat,
          pickupLng,
          pickupDate: new Date(pickupDate),
          deliveryLocation,
          deliveryLat,
          deliveryLng,
          preferredDeliveryDate: preferredDeliveryDate ? new Date(preferredDeliveryDate) : null,
          requiredVehicleType,
          specialRequirements,
          budget,
          auctionEnabled: auctionEnabled ?? true,
          startingBid,
          status: auctionEnabled ? 'AUCTION' : 'POSTED',
        },
      });

      // If auction enabled, create auction record
      if (auctionEnabled) {
        const now = new Date();
        const endTime = new Date(now.getTime() + (auctionDuration || 60) * 60 * 1000);

        await prisma.auction.create({
          data: {
            freightPostId: freightPost.id,
            startTime: now,
            endTime,
            startingBid: startingBid || budget || 10000,
            status: 'ACTIVE',
          },
        });
      }

      successResponse(res, freightPost, 'Freight post created successfully', 201);
    } catch (error) {
      console.error('Create freight post error:', error);
      errorResponse(res, 'Failed to create freight post', 500);
    }
  }
);

// List Freight Posts (with filters)
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const {
      status,
      cargoType,
      pickupLocation,
      deliveryLocation,
      minWeight,
      maxWeight,
      auctionEnabled,
      page = '1',
      limit = '20',
    } = req.query;

    const where: any = {};

    if (status) where.status = status;
    if (cargoType) where.cargoType = cargoType;
    if (pickupLocation) where.pickupLocation = { contains: pickupLocation as string, mode: 'insensitive' };
    if (deliveryLocation) where.deliveryLocation = { contains: deliveryLocation as string, mode: 'insensitive' };
    if (minWeight || maxWeight) {
      where.weight = {};
      if (minWeight) where.weight.gte = parseFloat(minWeight as string);
      if (maxWeight) where.weight.lte = parseFloat(maxWeight as string);
    }
    if (auctionEnabled !== undefined) where.auctionEnabled = auctionEnabled === 'true';

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const [posts, total] = await Promise.all([
      prisma.freightPost.findMany({
        where,
        include: {
          shipper: {
            include: {
              user: {
                select: {
                  firstName: true,
                  lastName: true,
                },
              },
            },
          },
          bids: {
            select: {
              id: true,
              amount: true,
              status: true,
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

    successResponse(res, posts, 'Freight posts retrieved successfully', 200, {
      page: parseInt(page as string),
      limit: take,
      total,
    });
  } catch (error) {
    console.error('List freight posts error:', error);
    errorResponse(res, 'Failed to retrieve freight posts', 500);
  }
});

// Get Freight Post Details
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const post = await prisma.freightPost.findUnique({
      where: { id },
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
        bids: {
          include: {
            driver: {
              include: {
                user: {
                  select: {
                    firstName: true,
                    lastName: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
        job: true,
      },
    });

    // Get auction separately if needed
    const auction = await prisma.auction.findUnique({
      where: { freightPostId: id },
    });

    if (!post) {
      errorResponse(res, 'Freight post not found', 404);
      return;
    }

    successResponse(res, post);
  } catch (error) {
    console.error('Get freight post error:', error);
    errorResponse(res, 'Failed to retrieve freight post', 500);
  }
});

// Place Bid (Driver only)
router.post(
  '/:id/bids',
  authenticate,
  authorize('DRIVER'),
  [body('amount').isFloat({ min: 0 }).withMessage('Valid bid amount required')],
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { amount, estimatedPickupDate, estimatedDeliveryDate, message } = req.body;

      const driver = await prisma.driverProfile.findUnique({
        where: { userId: req.user!.id },
      });

      if (!driver) {
        errorResponse(res, 'Driver profile not found', 404);
        return;
      }

      const freightPost = await prisma.freightPost.findUnique({
        where: { id },
      });

      if (!freightPost) {
        errorResponse(res, 'Freight post not found', 404);
        return;
      }

      if (freightPost.status !== 'POSTED' && freightPost.status !== 'AUCTION') {
        errorResponse(res, 'Bidding is closed for this post', 400);
        return;
      }

      // Check if driver already bid
      const existingBid = await prisma.bid.findFirst({
        where: {
          freightPostId: id,
          driverId: driver.id,
        },
      });

      if (existingBid) {
        errorResponse(res, 'You have already placed a bid on this post', 400);
        return;
      }

      const bid = await prisma.bid.create({
        data: {
          freightPostId: id,
          driverId: driver.id,
          amount,
          estimatedPickupDate: estimatedPickupDate ? new Date(estimatedPickupDate) : null,
          estimatedDeliveryDate: estimatedDeliveryDate ? new Date(estimatedDeliveryDate) : null,
          message,
        },
      });

      // Update auction if exists
      const auction = await prisma.auction.findUnique({
        where: { freightPostId: id },
      });

      if (auction) {
        await prisma.auction.update({
          where: { id: auction.id },
          data: {
            currentBid: amount,
            bidCount: { increment: 1 },
          },
        });
      }

      successResponse(res, bid, 'Bid placed successfully', 201);
    } catch (error) {
      console.error('Place bid error:', error);
      errorResponse(res, 'Failed to place bid', 500);
    }
  }
);

// Accept Bid (Shipper only)
router.post(
  '/:postId/bids/:bidId/accept',
  authenticate,
  authorize('SHIPPER'),
  async (req: Request, res: Response) => {
    try {
      const { postId, bidId } = req.params;

      const shipper = await prisma.shipperProfile.findUnique({
        where: { userId: req.user!.id },
      });

      if (!shipper) {
        errorResponse(res, 'Shipper profile not found', 404);
        return;
      }

      const freightPost = await prisma.freightPost.findFirst({
        where: {
          id: postId,
          shipperId: shipper.id,
        },
      });

      if (!freightPost) {
        errorResponse(res, 'Freight post not found', 404);
        return;
      }

      const bid = await prisma.bid.findFirst({
        where: {
          id: bidId,
          freightPostId: postId,
        },
      });

      if (!bid) {
        errorResponse(res, 'Bid not found', 404);
        return;
      }

      // Update bid status
      await prisma.bid.update({
        where: { id: bidId },
        data: { status: 'ACCEPTED' },
      });

      // Reject other bids
      await prisma.bid.updateMany({
        where: {
          freightPostId: postId,
          id: { not: bidId },
        },
        data: { status: 'REJECTED' },
      });

      // Update freight post status
      await prisma.freightPost.update({
        where: { id: postId },
        data: { status: 'ASSIGNED' },
      });

      // Create freight job
      const job = await prisma.freightJob.create({
        data: {
          freightPostId: postId,
          bidId: bidId,
          driverId: bid.driverId,
          status: 'ASSIGNED',
          paymentStatus: 'IN_ESCROW',
        },
      });

      successResponse(res, job, 'Bid accepted and job created');
    } catch (error) {
      console.error('Accept bid error:', error);
      errorResponse(res, 'Failed to accept bid', 500);
    }
  }
);

// Get My Posts (Shipper)
router.get('/my/posts', authenticate, authorize('SHIPPER'), async (req, res) => {
  try {
    const shipper = await prisma.shipperProfile.findUnique({
      where: { userId: req.user!.id },
    });

    if (!shipper) {
      errorResponse(res, 'Shipper profile not found', 404);
      return;
    }

    const posts = await prisma.freightPost.findMany({
      where: { shipperId: shipper.id },
      include: {
        bids: {
          include: {
            driver: {
              include: {
                user: {
                  select: {
                    firstName: true,
                    lastName: true,
                  },
                },
              },
            },
          },
        },
        job: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    successResponse(res, posts);
  } catch (error) {
    console.error('Get my posts error:', error);
    errorResponse(res, 'Failed to retrieve posts', 500);
  }
});

// Get My Bids (Driver)
router.get('/my/bids', authenticate, authorize('DRIVER'), async (req, res) => {
  try {
    const driver = await prisma.driverProfile.findUnique({
      where: { userId: req.user!.id },
    });

    if (!driver) {
      errorResponse(res, 'Driver profile not found', 404);
      return;
    }

    const bids = await prisma.bid.findMany({
      where: { driverId: driver.id },
      include: {
        freightPost: {
          include: {
            shipper: {
              include: {
                user: {
                  select: {
                    firstName: true,
                    lastName: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    successResponse(res, bids);
  } catch (error) {
    console.error('Get my bids error:', error);
    errorResponse(res, 'Failed to retrieve bids', 500);
  }
});

// Get Active Jobs
router.get('/jobs/active', authenticate, async (req, res) => {
  try {
    const user = req.user!;
    let jobs;

    if (user.role === 'DRIVER') {
      const driver = await prisma.driverProfile.findUnique({
        where: { userId: user.id },
      });

      if (!driver) {
        errorResponse(res, 'Driver profile not found', 404);
        return;
      }

      jobs = await prisma.freightJob.findMany({
        where: {
          driverId: driver.id,
          status: {
            in: ['ASSIGNED', 'PICKUP_READY', 'IN_TRANSIT', 'NEAR_DELIVERY'],
          },
        },
        include: {
          freightPost: true,
          bid: true,
        },
        orderBy: { createdAt: 'desc' },
      });
    } else if (user.role === 'SHIPPER') {
      const shipper = await prisma.shipperProfile.findUnique({
        where: { userId: user.id },
      });

      if (!shipper) {
        errorResponse(res, 'Shipper profile not found', 404);
        return;
      }

      jobs = await prisma.freightJob.findMany({
        where: {
          freightPost: {
            shipperId: shipper.id,
          },
          status: {
            in: ['ASSIGNED', 'PICKUP_READY', 'IN_TRANSIT', 'NEAR_DELIVERY'],
          },
        },
        include: {
          freightPost: true,
          bid: true,
          driver: {
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
        orderBy: { createdAt: 'desc' },
      });
    } else {
      errorResponse(res, 'Invalid role', 403);
      return;
    }

    successResponse(res, jobs);
  } catch (error) {
    console.error('Get active jobs error:', error);
    errorResponse(res, 'Failed to retrieve active jobs', 500);
  }
});

// Update Job Status
router.patch('/jobs/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, location } = req.body;

    const updateData: any = { status };

    if (location) {
      updateData.currentLat = location.lat;
      updateData.currentLng = location.lng;
      updateData.lastLocationUpdate = new Date();
    }

    if (status === 'PICKUP_READY') {
      updateData.pickupTime = new Date();
      updateData.pickupConfirmed = true;
    }

    if (status === 'DELIVERED') {
      updateData.deliveryTime = new Date();
      updateData.deliveryConfirmed = true;
    }

    const job = await prisma.freightJob.update({
      where: { id },
      data: updateData,
      include: {
        freightPost: true,
        bid: true,
      },
    });

    // Update freight post status if delivered
    if (status === 'DELIVERED') {
      await prisma.freightPost.update({
        where: { id: job.freightPostId },
        data: { status: 'DELIVERED' },
      });
    }

    successResponse(res, job);
  } catch (error) {
    console.error('Update job error:', error);
    errorResponse(res, 'Failed to update job', 500);
  }
});

export default router;
