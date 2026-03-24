import { PrismaClient, TransactionType, TransactionStatus, PaymentMethod } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

// TeleBirr API Configuration
const TELEBIRR_CONFIG = {
  baseUrl: process.env.TELEBIRR_API_URL || 'https://api.telebirr.com',
  merchantId: process.env.TELEBIRR_MERCHANT_ID || '',
  merchantCode: process.env.TELEBIRR_MERCHANT_CODE || '',
  apiKey: process.env.TELEBIRR_API_KEY || '',
  apiSecret: process.env.TELEBIRR_API_SECRET || '',
  callbackUrl: process.env.TELEBIRR_CALLBACK_URL || 'http://localhost:3002/api/payments/webhook/telebirr',
};

// Payment initiation request interface
interface TeleBirrPaymentRequest {
  phoneNumber: string;
  amount: number;
  description: string;
  reference: string;
  callbackUrl?: string;
}

// Payment response interface
interface TeleBirrPaymentResponse {
  success: boolean;
  transactionId?: string;
  ussdCode?: string;
  message: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
}

// Webhook payload interface
interface TeleBirrWebhookPayload {
  transactionId: string;
  reference: string;
  phoneNumber: string;
  amount: number;
  status: 'SUCCESS' | 'FAILED' | 'CANCELLED';
  timestamp: string;
  signature: string;
}

export class PaymentService {
  /**
   * Initiate a TeleBirr payment
   * User will receive a USSD prompt to confirm the payment
   */
  async initiateTeleBirrPayment(
    userId: string,
    phoneNumber: string,
    amount: number,
    description: string,
    relatedType?: string,
    relatedId?: string
  ): Promise<{
    success: boolean;
    transactionId?: string;
    ussdCode?: string;
    message: string;
  }> {
    try {
      // Validate phone number (Ethiopian format)
      const formattedPhone = this.formatPhoneNumber(phoneNumber);
      if (!formattedPhone) {
        return {
          success: false,
          message: 'Invalid phone number. Please use format: 09xxxxxxxx or +2519xxxxxxxx',
        };
      }

      // Check if user has a wallet
      let wallet = await prisma.wallet.findUnique({
        where: { userId },
      });

      if (!wallet) {
        // Create wallet if it doesn't exist
        wallet = await prisma.wallet.create({
          data: {
            userId,
            balance: 0,
            currency: 'ETB',
          },
        });
      }

      // Generate unique reference
      const reference = `TB${Date.now()}${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

      // Create pending transaction
      const transaction = await prisma.transaction.create({
        data: {
          walletId: wallet.id,
          type: TransactionType.DEPOSIT,
          amount,
          currency: 'ETB',
          description,
          reference,
          status: TransactionStatus.PENDING,
          relatedId,
          relatedType,
          paymentMethod: PaymentMethod.TELEBIRR,
          paymentPhone: formattedPhone,
        },
      });

      // In development mode, simulate TeleBirr API call
      // In production, this would call the actual TeleBirr API
      if (process.env.NODE_ENV === 'development') {
        // Simulate USSD code for testing
        const ussdCode = `*127*${amount}#`;

        return {
          success: true,
          transactionId: transaction.id,
          ussdCode,
          message: 'Payment initiated. Please dial the USSD code to confirm payment.',
        };
      }

      // Production: Call TeleBirr API
      const telebirrResponse = await this.callTeleBirrAPI({
        phoneNumber: formattedPhone,
        amount,
        description,
        reference,
      });

      if (telebirrResponse.success) {
        return {
          success: true,
          transactionId: transaction.id,
          ussdCode: telebirrResponse.ussdCode,
          message: telebirrResponse.message,
        };
      } else {
        // Update transaction as failed
        await prisma.transaction.update({
          where: { id: transaction.id },
          data: { status: TransactionStatus.FAILED },
        });

        return {
          success: false,
          message: telebirrResponse.message || 'Payment initiation failed',
        };
      }
    } catch (error) {
      console.error('TeleBirr payment initiation error:', error);
      return {
        success: false,
        message: 'Failed to initiate payment. Please try again.',
      };
    }
  }

  /**
   * Process TeleBirr webhook callback
   * This is called when the user completes the USSD payment
   */
  async processTeleBirrWebhook(payload: TeleBirrWebhookPayload): Promise<boolean> {
    try {
      // Verify webhook signature
      if (!this.verifyWebhookSignature(payload)) {
        console.error('Invalid webhook signature');
        return false;
      }

      // Find the transaction
      const transaction = await prisma.transaction.findFirst({
        where: {
          reference: payload.reference,
          paymentMethod: PaymentMethod.TELEBIRR,
        },
        include: {
          wallet: true,
        },
      });

      if (!transaction) {
        console.error('Transaction not found:', payload.reference);
        return false;
      }

      // Already processed
      if (transaction.status !== TransactionStatus.PENDING) {
        return true;
      }

      if (payload.status === 'SUCCESS') {
        // Complete the transaction
        await prisma.$transaction(async (tx) => {
          // Update transaction status
          await tx.transaction.update({
            where: { id: transaction.id },
            data: {
              status: TransactionStatus.COMPLETED,
              externalReference: payload.transactionId,
              completedAt: new Date(),
            },
          });

          // Update wallet balance
          await tx.wallet.update({
            where: { id: transaction.walletId },
            data: {
              balance: {
                increment: transaction.amount,
              },
            },
          });
        });

        // Send notification to user
        await this.sendPaymentNotification(transaction.wallet.userId, {
          type: 'PAYMENT_COMPLETED',
          title: 'Payment Successful',
          message: `ETB ${transaction.amount} has been added to your wallet.`,
          amount: transaction.amount,
        });

        return true;
      } else {
        // Mark as failed
        await prisma.transaction.update({
          where: { id: transaction.id },
          data: { status: TransactionStatus.FAILED },
        });

        return true;
      }
    } catch (error) {
      console.error('TeleBirr webhook processing error:', error);
      return false;
    }
  }

  /**
   * Check payment status
   */
  async checkPaymentStatus(transactionId: string): Promise<{
    success: boolean;
    status: TransactionStatus;
    message: string;
  }> {
    try {
      const transaction = await prisma.transaction.findUnique({
        where: { id: transactionId },
      });

      if (!transaction) {
        return {
          success: false,
          status: TransactionStatus.FAILED,
          message: 'Transaction not found',
        };
      }

      return {
        success: true,
        status: transaction.status,
        message: this.getStatusMessage(transaction.status),
      };
    } catch (error) {
      console.error('Check payment status error:', error);
      return {
        success: false,
        status: TransactionStatus.FAILED,
        message: 'Failed to check payment status',
      };
    }
  }

  /**
   * Create escrow payment for freight job
   * Holds payment until delivery is confirmed
   */
  async createEscrowPayment(
    shipperId: string,
    jobId: string,
    amount: number
  ): Promise<{
    success: boolean;
    transactionId?: string;
    message: string;
  }> {
    try {
      const wallet = await prisma.wallet.findUnique({
        where: { userId: shipperId },
      });

      if (!wallet) {
        return {
          success: false,
          message: 'Wallet not found',
        };
      }

      if (wallet.balance < amount) {
        return {
          success: false,
          message: 'Insufficient balance. Please top up your wallet.',
        };
      }

      const reference = `ESC${Date.now()}${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

      // Create escrow transaction
      const transaction = await prisma.$transaction(async (tx) => {
        // Deduct from shipper wallet
        await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            balance: {
              decrement: amount,
            },
          },
        });

        // Create escrow hold transaction
        return await tx.transaction.create({
          data: {
            walletId: wallet.id,
            type: TransactionType.ESCROW_HOLD,
            amount,
            currency: 'ETB',
            description: `Escrow payment for job ${jobId}`,
            reference,
            status: TransactionStatus.IN_ESCROW,
            relatedId: jobId,
            relatedType: 'FREIGHT_JOB',
          },
        });
      });

      return {
        success: true,
        transactionId: transaction.id,
        message: 'Escrow payment created successfully',
      };
    } catch (error) {
      console.error('Create escrow payment error:', error);
      return {
        success: false,
        message: 'Failed to create escrow payment',
      };
    }
  }

  /**
   * Release escrow payment to driver
   * Called when delivery is confirmed
   */
  async releaseEscrowPayment(
    jobId: string,
    driverId: string
  ): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      // Find the escrow transaction
      const escrowTransaction = await prisma.transaction.findFirst({
        where: {
          relatedId: jobId,
          relatedType: 'FREIGHT_JOB',
          type: TransactionType.ESCROW_HOLD,
          status: TransactionStatus.IN_ESCROW,
        },
      });

      if (!escrowTransaction) {
        return {
          success: false,
          message: 'Escrow transaction not found',
        };
      }

      // Get driver's wallet
      const driverWallet = await prisma.wallet.findUnique({
        where: { userId: driverId },
      });

      if (!driverWallet) {
        return {
          success: false,
          message: 'Driver wallet not found',
        };
      }

      await prisma.$transaction(async (tx) => {
        // Mark escrow as released
        await tx.transaction.update({
          where: { id: escrowTransaction.id },
          data: {
            status: TransactionStatus.COMPLETED,
            completedAt: new Date(),
          },
        });

        // Create earning transaction for driver
        await tx.transaction.create({
          data: {
            walletId: driverWallet.id,
            type: TransactionType.EARNING,
            amount: escrowTransaction.amount,
            currency: 'ETB',
            description: `Payment for completed job ${jobId}`,
            reference: `REL${Date.now()}${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
            status: TransactionStatus.COMPLETED,
            relatedId: jobId,
            relatedType: 'FREIGHT_JOB',
            completedAt: new Date(),
          },
        });

        // Credit driver wallet
        await tx.wallet.update({
          where: { id: driverWallet.id },
          data: {
            balance: {
              increment: escrowTransaction.amount,
            },
          },
        });
      });

      // Send notification to driver
      await this.sendPaymentNotification(driverId, {
        type: 'PAYMENT_RECEIVED',
        title: 'Payment Received',
        message: `ETB ${escrowTransaction.amount} has been credited to your wallet for job completion.`,
        amount: escrowTransaction.amount,
      });

      return {
        success: true,
        message: 'Payment released successfully',
      };
    } catch (error) {
      console.error('Release escrow payment error:', error);
      return {
        success: false,
        message: 'Failed to release payment',
      };
    }
  }

  /**
   * Withdraw funds to TeleBirr
   */
  async withdrawToTeleBirr(
    userId: string,
    phoneNumber: string,
    amount: number
  ): Promise<{
    success: boolean;
    transactionId?: string;
    message: string;
  }> {
    try {
      const wallet = await prisma.wallet.findUnique({
        where: { userId },
      });

      if (!wallet) {
        return {
          success: false,
          message: 'Wallet not found',
        };
      }

      if (wallet.balance < amount) {
        return {
          success: false,
          message: 'Insufficient balance',
        };
      }

      const formattedPhone = this.formatPhoneNumber(phoneNumber);
      if (!formattedPhone) {
        return {
          success: false,
          message: 'Invalid phone number',
        };
      }

      const reference = `WD${Date.now()}${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

      // Create withdrawal transaction
      const transaction = await prisma.$transaction(async (tx) => {
        // Deduct from wallet
        await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            balance: {
              decrement: amount,
            },
          },
        });

        return await tx.transaction.create({
          data: {
            walletId: wallet.id,
            type: TransactionType.WITHDRAWAL,
            amount,
            currency: 'ETB',
            description: `Withdrawal to ${formattedPhone}`,
            reference,
            status: TransactionStatus.PENDING,
            paymentMethod: PaymentMethod.TELEBIRR,
            paymentPhone: formattedPhone,
          },
        });
      });

      // In production, call TeleBirr API for disbursement
      // For now, mark as completed for demo
      if (process.env.NODE_ENV === 'development') {
        setTimeout(async () => {
          await prisma.transaction.update({
            where: { id: transaction.id },
            data: {
              status: TransactionStatus.COMPLETED,
              completedAt: new Date(),
            },
          });
        }, 5000);
      }

      return {
        success: true,
        transactionId: transaction.id,
        message: 'Withdrawal initiated. Funds will be sent to your TeleBirr account.',
      };
    } catch (error) {
      console.error('Withdrawal error:', error);
      return {
        success: false,
        message: 'Failed to process withdrawal',
      };
    }
  }

  /**
   * Get user's payment history
   */
  async getPaymentHistory(
    userId: string,
    options: {
      limit?: number;
      offset?: number;
      type?: TransactionType;
    } = {}
  ): Promise<{
    success: boolean;
    transactions: any[];
    total: number;
  }> {
    try {
      const { limit = 20, offset = 0, type } = options;

      const wallet = await prisma.wallet.findUnique({
        where: { userId },
      });

      if (!wallet) {
        return {
          success: true,
          transactions: [],
          total: 0,
        };
      }

      const where: any = { walletId: wallet.id };
      if (type) {
        where.type = type;
      }

      const [transactions, total] = await Promise.all([
        prisma.transaction.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        prisma.transaction.count({ where }),
      ]);

      return {
        success: true,
        transactions,
        total,
      };
    } catch (error) {
      console.error('Get payment history error:', error);
      return {
        success: false,
        transactions: [],
        total: 0,
      };
    }
  }

  /**
   * Call TeleBirr API (production implementation)
   */
  private async callTeleBirrAPI(
    request: TeleBirrPaymentRequest
  ): Promise<TeleBirrPaymentResponse> {
    try {
      // This would make an actual HTTP call to TeleBirr API
      // For now, return a simulated response
      // In production, use axios or fetch to call the actual API

      /*
      const response = await axios.post(
        `${TELEBIRR_CONFIG.baseUrl}/payment/initiate`,
        {
          merchantId: TELEBIRR_CONFIG.merchantId,
          merchantCode: TELEBIRR_CONFIG.merchantCode,
          phoneNumber: request.phoneNumber,
          amount: request.amount,
          description: request.description,
          reference: request.reference,
          callbackUrl: request.callbackUrl || TELEBIRR_CONFIG.callbackUrl,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.generateTeleBirrToken()}`,
            'Content-Type': 'application/json',
          },
        }
      );
      */

      // Simulated response
      return {
        success: true,
        transactionId: request.reference,
        ussdCode: `*127*${Math.floor(request.amount)}#`,
        message: 'Payment request sent. Please confirm on your phone.',
        status: 'PENDING',
      };
    } catch (error) {
      console.error('TeleBirr API call error:', error);
      return {
        success: false,
        message: 'Failed to connect to TeleBirr',
        status: 'FAILED',
      };
    }
  }

  /**
   * Generate TeleBirr API token
   */
  private generateTeleBirrToken(): string {
    // In production, implement proper JWT or OAuth token generation
    const timestamp = Date.now().toString();
    const signature = crypto
      .createHmac('sha256', TELEBIRR_CONFIG.apiSecret)
      .update(`${TELEBIRR_CONFIG.merchantId}:${timestamp}`)
      .digest('hex');

    return `${TELEBIRR_CONFIG.merchantId}:${timestamp}:${signature}`;
  }

  /**
   * Verify webhook signature
   */
  private verifyWebhookSignature(payload: TeleBirrWebhookPayload): boolean {
    const expectedSignature = crypto
      .createHmac('sha256', TELEBIRR_CONFIG.apiSecret)
      .update(`${payload.transactionId}:${payload.reference}:${payload.amount}:${payload.status}`)
      .digest('hex');

    return payload.signature === expectedSignature;
  }

  /**
   * Format phone number to standard format
   */
  private formatPhoneNumber(phone: string): string | null {
    // Remove all non-digit characters
    const digits = phone.replace(/\D/g, '');

    // Ethiopian phone number validation
    if (digits.length === 10 && digits.startsWith('09')) {
      return `+251${digits.substring(1)}`;
    }

    if (digits.length === 12 && digits.startsWith('251')) {
      return `+${digits}`;
    }

    if (digits.length === 13 && digits.startsWith('+251')) {
      return digits;
    }

    return null;
  }

  /**
   * Get status message
   */
  private getStatusMessage(status: TransactionStatus): string {
    const messages: Record<TransactionStatus, string> = {
      PENDING: 'Payment is being processed',
      COMPLETED: 'Payment completed successfully',
      FAILED: 'Payment failed',
      CANCELLED: 'Payment was cancelled',
      IN_ESCROW: 'Payment held in escrow',
    };
    return messages[status] || 'Unknown status';
  }

  /**
   * Send payment notification to user
   */
  private async sendPaymentNotification(
    userId: string,
    notification: {
      type: string;
      title: string;
      message: string;
      amount: number;
    }
  ): Promise<void> {
    try {
      // Import notification service dynamically to avoid circular dependency
      const { sendNotification } = await import('../notifications');
      const { NotificationType } = await import('@prisma/client');

      await sendNotification({
        userId,
        type: NotificationType.PAYMENT_RECEIVED,
        title: notification.title,
        body: notification.message,
        data: {
          type: notification.type,
          amount: notification.amount,
        },
      });
    } catch (error) {
      console.error('Failed to send payment notification:', error);
    }
  }
}

// Export singleton instance
export const paymentService = new PaymentService();
