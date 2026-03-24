import { Router, Request, Response } from 'express';
import { PrismaClient, TransactionType } from '@prisma/client';
import { authenticate, authorize } from '../middleware/auth';
import { paymentService } from '../services/payments';
import { successResponse, errorResponse } from '../utils/response';

const router = Router();
const prisma = new PrismaClient();

// Get wallet balance
router.get('/wallet', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    let wallet = await prisma.wallet.findUnique({
      where: { userId },
      include: {
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
    });

    if (!wallet) {
      wallet = await prisma.wallet.create({
        data: {
          userId,
          balance: 0,
          currency: 'ETB',
        },
        include: {
          transactions: {
            orderBy: { createdAt: 'desc' },
            take: 5,
          },
        },
      });
    }

    successResponse(res, {
      balance: wallet.balance,
      currency: wallet.currency,
      recentTransactions: wallet.transactions,
    }, 'Wallet retrieved successfully');
  } catch (error) {
    console.error('Get wallet error:', error);
    errorResponse(res, 'Failed to get wallet', 500);
  }
});

// Initiate TeleBirr deposit
router.post('/deposit/telebirr', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { phoneNumber, amount, description } = req.body;

    if (!phoneNumber || !amount || amount <= 0) {
      return errorResponse(res, 'Phone number and valid amount are required', 400);
    }

    const result = await paymentService.initiateTeleBirrPayment(
      userId,
      phoneNumber,
      amount,
      description || 'Wallet top-up'
    );

    if (result.success) {
      successResponse(res, {
        transactionId: result.transactionId,
        ussdCode: result.ussdCode,
        message: result.message,
      }, result.message);
    } else {
      errorResponse(res, result.message, 400);
    }
  } catch (error) {
    console.error('Deposit error:', error);
    errorResponse(res, 'Failed to initiate deposit', 500);
  }
});

// Check payment status
router.get('/status/:transactionId', authenticate, async (req: Request, res: Response) => {
  try {
    const { transactionId } = req.params;
    const userId = req.user!.id;

    // Verify transaction belongs to user
    const transaction = await prisma.transaction.findFirst({
      where: {
        id: transactionId,
        wallet: {
          userId,
        },
      },
    });

    if (!transaction) {
      return errorResponse(res, 'Transaction not found', 404);
    }

    const result = await paymentService.checkPaymentStatus(transactionId);

    successResponse(res, {
      status: result.status,
      message: result.message,
    }, 'Payment status retrieved');
  } catch (error) {
    console.error('Check status error:', error);
    errorResponse(res, 'Failed to check payment status', 500);
  }
});

// Withdraw to TeleBirr
router.post('/withdraw/telebirr', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { phoneNumber, amount } = req.body;

    if (!phoneNumber || !amount || amount <= 0) {
      return errorResponse(res, 'Phone number and valid amount are required', 400);
    }

    const result = await paymentService.withdrawToTeleBirr(userId, phoneNumber, amount);

    if (result.success) {
      successResponse(res, {
        transactionId: result.transactionId,
        message: result.message,
      }, result.message);
    } else {
      errorResponse(res, result.message, 400);
    }
  } catch (error) {
    console.error('Withdrawal error:', error);
    errorResponse(res, 'Failed to process withdrawal', 500);
  }
});

// Get transaction history
router.get('/history', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { limit = '20', offset = '0', type } = req.query;

    const result = await paymentService.getPaymentHistory(userId, {
      limit: parseInt(limit as string, 10),
      offset: parseInt(offset as string, 10),
      type: type as TransactionType,
    });

    if (result.success) {
      successResponse(res, {
        transactions: result.transactions,
        pagination: {
          total: result.total,
          limit: parseInt(limit as string, 10),
          offset: parseInt(offset as string, 10),
        },
      }, 'Transaction history retrieved');
    } else {
      errorResponse(res, 'Failed to get transaction history', 500);
    }
  } catch (error) {
    console.error('Get history error:', error);
    errorResponse(res, 'Failed to get transaction history', 500);
  }
});

// Create escrow payment for job
router.post('/escrow/create', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { jobId, amount } = req.body;

    if (!jobId || !amount || amount <= 0) {
      return errorResponse(res, 'Job ID and valid amount are required', 400);
    }

    // Verify job exists and belongs to this user
    const job = await prisma.freightJob.findFirst({
      where: {
        id: jobId,
        freightPost: {
          shipper: {
            userId,
          },
        },
      },
    });

    if (!job) {
      return errorResponse(res, 'Job not found', 404);
    }

    const result = await paymentService.createEscrowPayment(userId, jobId, amount);

    if (result.success) {
      // Update job payment status
      await prisma.freightJob.update({
        where: { id: jobId },
        data: { paymentStatus: 'IN_ESCROW' },
      });

      successResponse(res, {
        transactionId: result.transactionId,
        message: result.message,
      }, result.message);
    } else {
      errorResponse(res, result.message, 400);
    }
  } catch (error) {
    console.error('Create escrow error:', error);
    errorResponse(res, 'Failed to create escrow payment', 500);
  }
});

// Release escrow payment (called on delivery confirmation)
router.post('/escrow/release', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { jobId } = req.body;

    if (!jobId) {
      return errorResponse(res, 'Job ID is required', 400);
    }

    // Get job details
    const job = await prisma.freightJob.findUnique({
      where: { id: jobId },
      include: {
        freightPost: {
          include: {
            shipper: true,
          },
        },
        driver: true,
      },
    });

    if (!job) {
      return errorResponse(res, 'Job not found', 404);
    }

    // Verify user is the shipper
    if (job.freightPost.shipper.userId !== userId) {
      return errorResponse(res, 'Only the shipper can release payment', 403);
    }

    // Verify delivery is confirmed
    if (!job.deliveryConfirmed) {
      return errorResponse(res, 'Delivery must be confirmed before releasing payment', 400);
    }

    const result = await paymentService.releaseEscrowPayment(jobId, job.driver.userId);

    if (result.success) {
      // Update job payment status
      await prisma.freightJob.update({
        where: { id: jobId },
        data: { paymentStatus: 'RELEASED' },
      });

      successResponse(res, {
        message: result.message,
      }, result.message);
    } else {
      errorResponse(res, result.message, 400);
    }
  } catch (error) {
    console.error('Release escrow error:', error);
    errorResponse(res, 'Failed to release payment', 500);
  }
});

// TeleBirr webhook (public endpoint)
router.post('/webhook/telebirr', async (req: Request, res: Response) => {
  try {
    const payload = req.body;

    console.log('TeleBirr webhook received:', payload);

    const success = await paymentService.processTeleBirrWebhook(payload);

    if (success) {
      // Return success to TeleBirr
      res.json({
        code: 0,
        msg: 'Success',
      });
    } else {
      res.status(400).json({
        code: 1,
        msg: 'Failed to process webhook',
      });
    }
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({
      code: 1,
      msg: 'Internal server error',
    });
  }
});

// Simulate payment completion (development only)
router.post('/simulate/complete', authenticate, async (req: Request, res: Response) => {
  try {
    if (process.env.NODE_ENV !== 'development') {
      return errorResponse(res, 'Simulation only available in development', 403);
    }

    const { transactionId } = req.body;

    if (!transactionId) {
      return errorResponse(res, 'Transaction ID is required', 400);
    }

    // Simulate webhook payload
    const payload = {
      transactionId: `TB${Date.now()}`,
      reference: transactionId,
      phoneNumber: '+251912345678',
      amount: 100,
      status: 'SUCCESS' as const,
      timestamp: new Date().toISOString(),
      signature: 'dummy-signature',
    };

    const success = await paymentService.processTeleBirrWebhook(payload);

    if (success) {
      successResponse(res, { message: 'Payment simulated as completed' }, 'Simulation successful');
    } else {
      errorResponse(res, 'Simulation failed', 500);
    }
  } catch (error) {
    console.error('Simulation error:', error);
    errorResponse(res, 'Simulation failed', 500);
  }
});

// Get transaction details
router.get('/transaction/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const transaction = await prisma.transaction.findFirst({
      where: {
        id,
        wallet: {
          userId,
        },
      },
    });

    if (!transaction) {
      return errorResponse(res, 'Transaction not found', 404);
    }

    successResponse(res, transaction, 'Transaction retrieved');
  } catch (error) {
    console.error('Get transaction error:', error);
    errorResponse(res, 'Failed to get transaction', 500);
  }
});

export default router;
