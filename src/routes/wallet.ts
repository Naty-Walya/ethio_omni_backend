import { Router, Request, Response } from 'express';
import { body } from 'express-validator';
import { prisma } from '../prisma/client';
import { successResponse, errorResponse } from '../utils/response';
import { authenticate } from '../middleware/auth';

const router = Router();

// Get Wallet Balance
router.get('/balance', authenticate, async (req: Request, res: Response) => {
  try {
    const wallet = await prisma.wallet.findUnique({
      where: { userId: req.user!.id },
      include: {
        _count: {
          select: {
            transactions: true,
          },
        },
      },
    });

    if (!wallet) {
      errorResponse(res, 'Wallet not found', 404);
      return;
    }

    successResponse(res, {
      balance: wallet.balance,
      currency: wallet.currency,
    });
  } catch (error) {
    console.error('Get wallet error:', error);
    errorResponse(res, 'Failed to retrieve wallet', 500);
  }
});

// Get Transaction History
router.get('/transactions', authenticate, async (req: Request, res: Response) => {
  try {
    const { page = '1', limit = '20' } = req.query;

    const wallet = await prisma.wallet.findUnique({
      where: { userId: req.user!.id },
    });

    if (!wallet) {
      errorResponse(res, 'Wallet not found', 404);
      return;
    }

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.transaction.count({
        where: { walletId: wallet.id },
      }),
    ]);

    successResponse(res, transactions, 'Transactions retrieved', 200, {
      page: parseInt(page as string),
      limit: take,
      total,
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    errorResponse(res, 'Failed to retrieve transactions', 500);
  }
});

// Deposit (Simulated - would integrate with Telebirr/CBE)
router.post(
  '/deposit',
  authenticate,
  [
    body('amount').isFloat({ min: 10 }).withMessage('Minimum deposit is 10 ETB'),
    body('method').isIn(['telebirr', 'cbe_birr']).withMessage('Invalid payment method'),
  ],
  async (req: Request, res: Response) => {
    try {
      const { amount, method } = req.body;

      const wallet = await prisma.wallet.findUnique({
        where: { userId: req.user!.id },
      });

      if (!wallet) {
        errorResponse(res, 'Wallet not found', 404);
        return;
      }

      // TODO: Integrate with actual payment provider
      // For now, simulate successful deposit
      const reference = `DEP-${Date.now()}`;

      const [updatedWallet, transaction] = await prisma.$transaction([
        prisma.wallet.update({
          where: { id: wallet.id },
          data: {
            balance: { increment: amount },
          },
        }),
        prisma.transaction.create({
          data: {
            walletId: wallet.id,
            type: 'DEPOSIT',
            amount,
            description: `Deposit via ${method}`,
            reference,
            status: 'COMPLETED',
          },
        }),
      ]);

      successResponse(res, {
        wallet: updatedWallet,
        transaction,
      }, 'Deposit successful');
    } catch (error) {
      console.error('Deposit error:', error);
      errorResponse(res, 'Failed to process deposit', 500);
    }
  }
);

// Withdraw (Simulated)
router.post(
  '/withdraw',
  authenticate,
  [
    body('amount').isFloat({ min: 100 }).withMessage('Minimum withdrawal is 100 ETB'),
    body('accountNumber').notEmpty().withMessage('Account number required'),
    body('accountName').notEmpty().withMessage('Account name required'),
  ],
  async (req: Request, res: Response) => {
    try {
      const { amount, accountNumber, accountName } = req.body;

      const wallet = await prisma.wallet.findUnique({
        where: { userId: req.user!.id },
      });

      if (!wallet) {
        errorResponse(res, 'Wallet not found', 404);
        return;
      }

      if (wallet.balance < amount) {
        errorResponse(res, 'Insufficient balance', 400);
        return;
      }

      // TODO: Integrate with actual payment provider
      const reference = `WDR-${Date.now()}`;

      const [updatedWallet, transaction] = await prisma.$transaction([
        prisma.wallet.update({
          where: { id: wallet.id },
          data: {
            balance: { decrement: amount },
          },
        }),
        prisma.transaction.create({
          data: {
            walletId: wallet.id,
            type: 'WITHDRAWAL',
            amount: -amount,
            description: `Withdrawal to ${accountName}`,
            reference,
            status: 'PENDING',
          },
        }),
      ]);

      successResponse(res, {
        wallet: updatedWallet,
        transaction,
      }, 'Withdrawal request submitted');
    } catch (error) {
      console.error('Withdrawal error:', error);
      errorResponse(res, 'Failed to process withdrawal', 500);
    }
  }
);

// Transfer to another user
router.post(
  '/transfer',
  authenticate,
  [
    body('phone').notEmpty().withMessage('Recipient phone required'),
    body('amount').isFloat({ min: 1 }).withMessage('Valid amount required'),
  ],
  async (req: Request, res: Response) => {
    try {
      const { phone, amount, description } = req.body;

      const senderWallet = await prisma.wallet.findUnique({
        where: { userId: req.user!.id },
      });

      if (!senderWallet) {
        errorResponse(res, 'Wallet not found', 404);
        return;
      }

      if (senderWallet.balance < amount) {
        errorResponse(res, 'Insufficient balance', 400);
        return;
      }

      const recipient = await prisma.user.findUnique({
        where: { phone },
        include: { wallet: true },
      });

      if (!recipient || !recipient.wallet) {
        errorResponse(res, 'Recipient not found', 404);
        return;
      }

      const reference = `TRF-${Date.now()}`;

      await prisma.$transaction([
        prisma.wallet.update({
          where: { id: senderWallet.id },
          data: { balance: { decrement: amount } },
        }),
        prisma.wallet.update({
          where: { id: recipient.wallet.id },
          data: { balance: { increment: amount } },
        }),
        prisma.transaction.create({
          data: {
            walletId: senderWallet.id,
            type: 'PAYMENT',
            amount: -amount,
            description: description || `Transfer to ${phone}`,
            reference,
            status: 'COMPLETED',
          },
        }),
        prisma.transaction.create({
          data: {
            walletId: recipient.wallet.id,
            type: 'DEPOSIT',
            amount,
            description: description || `Transfer from ${req.user!.phone}`,
            reference,
            status: 'COMPLETED',
          },
        }),
      ]);

      successResponse(res, null, 'Transfer successful');
    } catch (error) {
      console.error('Transfer error:', error);
      errorResponse(res, 'Failed to process transfer', 500);
    }
  }
);

export default router;
