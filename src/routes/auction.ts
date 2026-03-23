import { Router, Request, Response } from 'express';
import { prisma } from '../prisma/client';
import { successResponse, errorResponse } from '../utils/response';
import { authenticate } from '../middleware/auth';

const router = Router();

// Get Active Auctions
router.get('/active', authenticate, async (req: Request, res: Response) => {
  try {
    const auctions = await prisma.auction.findMany({
      where: {
        status: 'ACTIVE',
        endTime: {
          gt: new Date(),
        },
      },
      orderBy: { endTime: 'asc' },
    });

    // Get freight post details for each auction
    const auctionsWithDetails = await Promise.all(
      auctions.map(async (auction) => {
        const freightPost = await prisma.freightPost.findUnique({
          where: { id: auction.freightPostId },
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
            _count: {
              select: {
                bids: true,
              },
            },
          },
        });

        const bidCount = await prisma.auctionBid.count({
          where: { auctionId: auction.id },
        });

        return {
          ...auction,
          freightPost,
          _count: { bids: bidCount },
        };
      })
    );

    successResponse(res, auctionsWithDetails);
  } catch (error) {
    console.error('Get active auctions error:', error);
    errorResponse(res, 'Failed to retrieve auctions', 500);
  }
});

// Get Auction Details
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const auction = await prisma.auction.findUnique({
      where: { id },
    });

    if (!auction) {
      errorResponse(res, 'Auction not found', 404);
      return;
    }

    // Get related data
    const freightPost = await prisma.freightPost.findUnique({
      where: { id: auction.freightPostId },
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
    });

    const bids = await prisma.auctionBid.findMany({
      where: { auctionId: id },
      orderBy: { amount: 'asc' },
    });

    // Get driver details for each bid
    const bidsWithDrivers = await Promise.all(
      bids.map(async (bid) => {
        const driver = await prisma.driverProfile.findUnique({
          where: { id: bid.driverId },
          include: {
            user: {
              select: {
                firstName: true,
                lastName: true,
              },
            },
          },
        });
        return { ...bid, driver };
      })
    );

    successResponse(res, {
      ...auction,
      freightPost,
      bids: bidsWithDrivers,
    });
  } catch (error) {
    console.error('Get auction error:', error);
    errorResponse(res, 'Failed to retrieve auction', 500);
  }
});

// Get My Auctions (Shipper)
router.get('/my/auctions', authenticate, async (req: Request, res: Response) => {
  try {
    const shipper = await prisma.shipperProfile.findUnique({
      where: { userId: req.user!.id },
    });

    if (!shipper) {
      errorResponse(res, 'Shipper profile not found', 404);
      return;
    }

    // Get freight posts for this shipper
    const freightPosts = await prisma.freightPost.findMany({
      where: { shipperId: shipper.id },
      select: { id: true },
    });

    const freightPostIds = freightPosts.map((fp) => fp.id);

    const auctions = await prisma.auction.findMany({
      where: {
        freightPostId: { in: freightPostIds },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Get freight post details for each auction
    const auctionsWithDetails = await Promise.all(
      auctions.map(async (auction) => {
        const freightPost = await prisma.freightPost.findUnique({
          where: { id: auction.freightPostId },
        });

        const bids = await prisma.auctionBid.findMany({
          where: { auctionId: auction.id },
          orderBy: { amount: 'asc' },
          take: 5,
        });

        return {
          ...auction,
          freightPost,
          bids,
        };
      })
    );

    successResponse(res, auctionsWithDetails);
  } catch (error) {
    console.error('Get my auctions error:', error);
    errorResponse(res, 'Failed to retrieve auctions', 500);
  }
});

export default router;
