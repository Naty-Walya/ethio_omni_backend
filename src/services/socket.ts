import { Server as SocketServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import { prisma } from '../prisma/client';
import logger from '../utils/logger';

interface AuctionRoom {
  auctionId: string;
  users: Map<string, { userId: string; role: string; socketId: string }>;
  currentBid: number | null;
  bidCount: number;
}

const auctionRooms = new Map<string, AuctionRoom>();

export const initializeSocket = (httpServer: HttpServer): SocketServer => {
  const io = new SocketServer(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id}`);

    // Join auction room
    socket.on('join-auction', async (data: { auctionId: string; userId: string; role: string }) => {
      try {
        const { auctionId, userId, role } = data;

        // Verify auction exists and is active
        const auction = await prisma.auction.findUnique({
          where: { id: auctionId },
          include: { freightPost: true },
        });

        if (!auction) {
          socket.emit('auction-error', { message: 'Auction not found' });
          return;
        }

        if (auction.status !== 'ACTIVE') {
          socket.emit('auction-error', { message: 'Auction is not active' });
          return;
        }

        // Create room if doesn't exist
        if (!auctionRooms.has(auctionId)) {
          auctionRooms.set(auctionId, {
            auctionId,
            users: new Map(),
            currentBid: auction.currentBid,
            bidCount: auction.bidCount,
          });
        }

        const room = auctionRooms.get(auctionId)!;
        room.users.set(socket.id, { userId, role, socketId: socket.id });

        socket.join(auctionId);

        // Send current auction state
        socket.emit('auction-state', {
          auctionId,
          currentBid: room.currentBid,
          bidCount: room.bidCount,
          endTime: auction.endTime,
          startingBid: auction.startingBid,
        });

        // Notify others that someone joined
        socket.to(auctionId).emit('user-joined', {
          userId,
          role,
          participantCount: room.users.size,
        });

        logger.info(`User ${userId} joined auction ${auctionId}`);
      } catch (error) {
        logger.error('Join auction error:', error);
        socket.emit('auction-error', { message: 'Failed to join auction' });
      }
    });

    // Place bid
    socket.on('place-bid', async (data: { auctionId: string; amount: number; userId: string }) => {
      try {
        const { auctionId, amount, userId } = data;

        const room = auctionRooms.get(auctionId);
        if (!room) {
          socket.emit('auction-error', { message: 'Auction room not found' });
          return;
        }

        // Get auction details
        const auction = await prisma.auction.findUnique({
          where: { id: auctionId },
          include: {
            freightPost: {
              include: {
                shipper: {
                  include: {
                    user: true,
                  },
                },
              },
            },
          },
        });

        if (!auction || auction.status !== 'ACTIVE') {
          socket.emit('auction-error', { message: 'Auction is not active' });
          return;
        }

        // Check if auction has ended
        if (new Date() > auction.endTime) {
          socket.emit('auction-error', { message: 'Auction has ended' });
          return;
        }

        // Validate bid amount (must be lower than current bid for reverse auction)
        const currentBestBid = room.currentBid || auction.startingBid;
        if (amount >= currentBestBid) {
          socket.emit('auction-error', {
            message: `Bid must be lower than current best bid: ${currentBestBid}`,
          });
          return;
        }

        // Get driver details
        const driver = await prisma.driverProfile.findUnique({
          where: { userId },
          include: { user: true },
        });

        if (!driver) {
          socket.emit('auction-error', { message: 'Driver profile not found' });
          return;
        }

        // Save bid to database
        const bid = await prisma.auctionBid.create({
          data: {
            auctionId,
            driverId: driver.id,
            amount,
          },
        });

        // Update auction
        await prisma.auction.update({
          where: { id: auctionId },
          data: {
            currentBid: amount,
            bidCount: { increment: 1 },
          },
        });

        // Update room state
        room.currentBid = amount;
        room.bidCount += 1;

        // Broadcast new bid to all participants
        const bidData = {
          auctionId,
          driverId: driver.id,
          driverName: `${driver.user.firstName || ''} ${driver.user.lastName || ''}`.trim() || driver.user.phone,
          amount,
          timestamp: bid.createdAt,
          bidCount: room.bidCount,
        };

        io.to(auctionId).emit('new-bid', bidData);

        // Send outbid notification to previous bidders
        const previousBids = await prisma.auctionBid.findMany({
          where: {
            auctionId,
            driverId: { not: driver.id },
          },
          distinct: ['driverId'],
        });

        previousBids.forEach((prevBid) => {
          const prevBidderSocket = Array.from(room.users.values()).find(
            (u) => u.userId === prevBid.driverId
          );
          if (prevBidderSocket) {
            io.to(prevBidderSocket.socketId).emit('outbid-alert', {
              auctionId,
              newAmount: amount,
              message: `You have been outbid! New lowest bid: ${amount} ETB`,
            });
          }
        });

        logger.info(`New bid placed in auction ${auctionId}: ${amount} ETB by driver ${driver.id}`);
      } catch (error) {
        logger.error('Place bid error:', error);
        socket.emit('auction-error', { message: 'Failed to place bid' });
      }
    });

    // Leave auction room
    socket.on('leave-auction', (data: { auctionId: string }) => {
      const { auctionId } = data;
      const room = auctionRooms.get(auctionId);

      if (room) {
        room.users.delete(socket.id);
        socket.leave(auctionId);

        socket.to(auctionId).emit('user-left', {
          participantCount: room.users.size,
        });

        // Clean up empty rooms
        if (room.users.size === 0) {
          auctionRooms.delete(auctionId);
        }
      }
    });

    // Location tracking for active jobs
    socket.on('location-update', async (data: { jobId: string; lat: number; lng: number }) => {
      try {
        const { jobId, lat, lng } = data;

        // Update job location in database
        await prisma.freightJob.update({
          where: { id: jobId },
          data: {
            currentLat: lat,
            currentLng: lng,
            lastLocationUpdate: new Date(),
          },
        });

        // Broadcast to shipper
        socket.to(`job-${jobId}`).emit('driver-location', {
          jobId,
          lat,
          lng,
          timestamp: new Date(),
        });
      } catch (error) {
        logger.error('Location update error:', error);
      }
    });

    // Join job tracking room
    socket.on('track-job', (data: { jobId: string; role: string }) => {
      const { jobId, role } = data;
      socket.join(`job-${jobId}`);
      logger.info(`${role} started tracking job ${jobId}`);
    });

    // Stop tracking job
    socket.on('stop-tracking', (data: { jobId: string }) => {
      const { jobId } = data;
      socket.leave(`job-${jobId}`);
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      logger.info(`Socket disconnected: ${socket.id}`);

      // Clean up from all rooms
      auctionRooms.forEach((room, auctionId) => {
        if (room.users.has(socket.id)) {
          room.users.delete(socket.id);
          socket.to(auctionId).emit('user-left', {
            participantCount: room.users.size,
          });

          if (room.users.size === 0) {
            auctionRooms.delete(auctionId);
          }
        }
      });
    });
  });

  // Check for ended auctions periodically
  setInterval(async () => {
    try {
      const endedAuctions = await prisma.auction.findMany({
        where: {
          status: 'ACTIVE',
          endTime: { lte: new Date() },
        },
        include: {
          bids: {
            orderBy: { amount: 'asc' },
            take: 1,
          },
          freightPost: true,
        },
      });

      for (const auction of endedAuctions) {
        // Update auction status
        await prisma.auction.update({
          where: { id: auction.id },
          data: { status: 'ENDED' },
        });

        // Notify room if exists
        const room = auctionRooms.get(auction.id);
        if (room) {
          if (auction.bids.length > 0) {
            const winningBid = auction.bids[0];
            io.to(auction.id).emit('auction-won', {
              auctionId: auction.id,
              winnerId: winningBid.driverId,
              winningAmount: winningBid.amount,
            });
          } else {
            io.to(auction.id).emit('auction-ended', {
              auctionId: auction.id,
              message: 'Auction ended with no bids',
            });
          }

          // Clean up room
          auctionRooms.delete(auction.id);
        }

        // If there's a winning bid, create the job
        if (auction.bids.length > 0) {
          const winningBid = auction.bids[0];

          await prisma.$transaction([
            prisma.bid.create({
              data: {
                freightPostId: auction.freightPostId,
                driverId: winningBid.driverId,
                amount: winningBid.amount,
                status: 'ACCEPTED',
              },
            }),
            prisma.freightPost.update({
              where: { id: auction.freightPostId },
              data: { status: 'ASSIGNED' },
            }),
            prisma.freightJob.create({
              data: {
                freightPostId: auction.freightPostId,
                bidId: winningBid.id,
                driverId: winningBid.driverId,
                status: 'ASSIGNED',
                paymentStatus: 'IN_ESCROW',
              },
            }),
          ]);
        }
      }
    } catch (error) {
      logger.error('Auction cleanup error:', error);
    }
  }, 30000); // Check every 30 seconds

  return io;
};
