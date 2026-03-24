import { PrismaClient, JobStatus } from '@prisma/client';
import QRCode from 'qrcode';
import crypto from 'crypto';

const prisma = new PrismaClient();

// QR Code Configuration
const QR_CONFIG = {
  // Secret key for signing QR codes (should be in env vars)
  secretKey: process.env.QR_SECRET_KEY || 'your-qr-secret-key-change-in-production',
  // QR code expiration time (24 hours)
  expirationHours: 24,
  // Signature algorithm
  algorithm: 'sha256',
};

// QR Code data interface
interface QRCodeData {
  jobId: string;
  type: 'PICKUP' | 'DELIVERY';
  timestamp: number;
  signature: string;
}

// QR verification result
interface QRVerificationResult {
  valid: boolean;
  jobId?: string;
  type?: 'PICKUP' | 'DELIVERY';
  message: string;
}

export class QRCodeService {
  /**
   * Generate QR code for pickup or delivery
   */
  async generateQRCode(
    jobId: string,
    type: 'PICKUP' | 'DELIVERY'
  ): Promise<{ success: boolean; qrCode?: string; dataUrl?: string; message: string }> {
    try {
      // Get job details
      const job = await prisma.freightJob.findUnique({
        where: { id: jobId },
        include: {
          freightPost: {
            include: {
              shipper: {
                include: { user: true },
              },
            },
          },
          driver: {
            include: { user: true },
          },
        },
      });

      if (!job) {
        return { success: false, message: 'Job not found' };
      }

      // Check if already confirmed
      if (type === 'PICKUP' && job.pickupConfirmed) {
        return { success: false, message: 'Pickup already confirmed' };
      }
      if (type === 'DELIVERY' && job.deliveryConfirmed) {
        return { success: false, message: 'Delivery already confirmed' };
      }

      // Generate QR code data
      const timestamp = Date.now();
      const qrData: Omit<QRCodeData, 'signature'> = {
        jobId,
        type,
        timestamp,
      };

      // Create signature
      const signature = this.createSignature(qrData);
      const fullQRData: QRCodeData = { ...qrData, signature };

      // Encode to base64 string
      const qrCodeString = Buffer.from(JSON.stringify(fullQRData)).toString('base64');

      // Generate QR code image (data URL)
      const dataUrl = await QRCode.toDataURL(qrCodeString, {
        width: 400,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF',
        },
      });

      // Save QR code to database
      if (type === 'PICKUP') {
        await prisma.freightJob.update({
          where: { id: jobId },
          data: { pickupQrCode: qrCodeString },
        });
      } else {
        await prisma.freightJob.update({
          where: { id: jobId },
          data: { deliveryQrCode: qrCodeString },
        });
      }

      return {
        success: true,
        qrCode: qrCodeString,
        dataUrl,
        message: `${type} QR code generated successfully`,
      };
    } catch (error) {
      console.error('Generate QR code error:', error);
      return { success: false, message: 'Failed to generate QR code' };
    }
  }

  /**
   * Verify and process QR code scan
   */
  async verifyQRCode(
    scannedData: string,
    scannedBy: string,
    location?: { lat: number; lng: number }
  ): Promise<QRVerificationResult & { job?: any }> {
    try {
      // Decode QR data
      let qrData: QRCodeData;
      try {
        const decoded = Buffer.from(scannedData, 'base64').toString('utf-8');
        qrData = JSON.parse(decoded);
      } catch (e) {
        return { valid: false, message: 'Invalid QR code format' };
      }

      // Validate structure
      if (!qrData.jobId || !qrData.type || !qrData.timestamp || !qrData.signature) {
        return { valid: false, message: 'Invalid QR code data' };
      }

      // Check expiration
      const age = Date.now() - qrData.timestamp;
      const maxAge = QR_CONFIG.expirationHours * 60 * 60 * 1000;
      if (age > maxAge) {
        return { valid: false, message: 'QR code has expired' };
      }

      // Verify signature
      const expectedSignature = this.createSignature({
        jobId: qrData.jobId,
        type: qrData.type,
        timestamp: qrData.timestamp,
      });

      if (qrData.signature !== expectedSignature) {
        return { valid: false, message: 'Invalid QR code signature' };
      }

      // Get job details
      const job = await prisma.freightJob.findUnique({
        where: { id: qrData.jobId },
        include: {
          freightPost: {
            include: {
              shipper: {
                include: { user: true },
              },
            },
          },
          driver: {
            include: { user: true },
          },
        },
      });

      if (!job) {
        return { valid: false, message: 'Job not found' };
      }

      // Check if already confirmed
      if (qrData.type === 'PICKUP' && job.pickupConfirmed) {
        return { valid: false, message: 'Pickup already confirmed' };
      }
      if (qrData.type === 'DELIVERY' && job.deliveryConfirmed) {
        return { valid: false, message: 'Delivery already confirmed' };
      }

      // Verify scanner is authorized (driver for pickup, shipper for delivery)
      if (qrData.type === 'PICKUP') {
        if (job.driver.userId !== scannedBy) {
          return { valid: false, message: 'Only the assigned driver can confirm pickup' };
        }
      } else {
        // For delivery, either shipper or driver can scan
        if (job.freightPost.shipper.userId !== scannedBy && job.driver.userId !== scannedBy) {
          return { valid: false, message: 'Not authorized to confirm this delivery' };
        }
      }

      // Update job status
      const updateData: any = {
        currentLat: location?.lat,
        currentLng: location?.lng,
        lastLocationUpdate: new Date(),
      };

      if (qrData.type === 'PICKUP') {
        updateData.pickupConfirmed = true;
        updateData.pickupTime = new Date();
        updateData.status = JobStatus.IN_TRANSIT;
      } else {
        updateData.deliveryConfirmed = true;
        updateData.deliveryTime = new Date();
        updateData.status = JobStatus.DELIVERED;
      }

      const updatedJob = await prisma.freightJob.update({
        where: { id: qrData.jobId },
        data: updateData,
        include: {
          freightPost: {
            include: {
              shipper: {
                include: { user: true },
              },
            },
          },
          driver: {
            include: { user: true },
          },
        },
      });

      // Send notifications
      await this.sendConfirmationNotifications(updatedJob, qrData.type);

      return {
        valid: true,
        jobId: qrData.jobId,
        type: qrData.type,
        message: `${qrData.type} confirmed successfully`,
        job: updatedJob,
      };
    } catch (error) {
      console.error('Verify QR code error:', error);
      return { valid: false, message: 'Failed to verify QR code' };
    }
  }

  /**
   * Get QR code for a job
   */
  async getQRCode(
    jobId: string,
    type: 'PICKUP' | 'DELIVERY',
    userId: string
  ): Promise<{ success: boolean; qrCode?: string; dataUrl?: string; message: string }> {
    try {
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
        return { success: false, message: 'Job not found' };
      }

      // Check authorization
      const isShipper = job.freightPost.shipper.userId === userId;
      const isDriver = job.driver.userId === userId;

      if (!isShipper && !isDriver) {
        return { success: false, message: 'Not authorized' };
      }

      // Return existing QR code if available
      const existingQr = type === 'PICKUP' ? job.pickupQrCode : job.deliveryQrCode;
      if (existingQr) {
        const dataUrl = await QRCode.toDataURL(existingQr, {
          width: 400,
          margin: 2,
        });
        return {
          success: true,
          qrCode: existingQr,
          dataUrl,
          message: 'QR code retrieved',
        };
      }

      // Generate new QR code
      return this.generateQRCode(jobId, type);
    } catch (error) {
      console.error('Get QR code error:', error);
      return { success: false, message: 'Failed to get QR code' };
    }
  }

  /**
   * Regenerate QR code (if expired or lost)
   */
  async regenerateQRCode(
    jobId: string,
    type: 'PICKUP' | 'DELIVERY',
    userId: string
  ): Promise<{ success: boolean; qrCode?: string; dataUrl?: string; message: string }> {
    try {
      const job = await prisma.freightJob.findUnique({
        where: { id: jobId },
        include: {
          freightPost: {
            include: {
              shipper: true,
            },
          },
        },
      });

      if (!job) {
        return { success: false, message: 'Job not found' };
      }

      // Only shipper can regenerate QR codes
      if (job.freightPost.shipper.userId !== userId) {
        return { success: false, message: 'Only shipper can regenerate QR codes' };
      }

      // Check if already confirmed
      if (type === 'PICKUP' && job.pickupConfirmed) {
        return { success: false, message: 'Pickup already confirmed' };
      }
      if (type === 'DELIVERY' && job.deliveryConfirmed) {
        return { success: false, message: 'Delivery already confirmed' };
      }

      // Clear existing QR code
      if (type === 'PICKUP') {
        await prisma.freightJob.update({
          where: { id: jobId },
          data: { pickupQrCode: null },
        });
      } else {
        await prisma.freightJob.update({
          where: { id: jobId },
          data: { deliveryQrCode: null },
        });
      }

      // Generate new QR code
      return this.generateQRCode(jobId, type);
    } catch (error) {
      console.error('Regenerate QR code error:', error);
      return { success: false, message: 'Failed to regenerate QR code' };
    }
  }

  /**
   * Create signature for QR code
   */
  private createSignature(data: Omit<QRCodeData, 'signature'>): string {
    const payload = `${data.jobId}:${data.type}:${data.timestamp}`;
    return crypto
      .createHmac(QR_CONFIG.algorithm, QR_CONFIG.secretKey)
      .update(payload)
      .digest('hex');
  }

  /**
   * Send confirmation notifications
   */
  private async sendConfirmationNotifications(job: any, type: 'PICKUP' | 'DELIVERY'): Promise<void> {
    try {
      const { sendNotification } = await import('../notifications');
      const { NotificationType } = await import('@prisma/client');

      if (type === 'PICKUP') {
        // Notify shipper
        await sendNotification({
          userId: job.freightPost.shipper.userId,
          type: NotificationType.PICKUP_REMINDER,
          title: 'Cargo Picked Up',
          body: `Your cargo has been picked up by the driver.`,
          data: { jobId: job.id, type: 'PICKUP_CONFIRMED' },
        });
      } else {
        // Notify both shipper and driver
        await Promise.all([
          sendNotification({
            userId: job.freightPost.shipper.userId,
            type: NotificationType.DELIVERY_CONFIRMED,
            title: 'Delivery Confirmed',
            body: `Your cargo has been delivered successfully!`,
            data: { jobId: job.id, type: 'DELIVERY_CONFIRMED' },
          }),
          sendNotification({
            userId: job.driver.userId,
            type: NotificationType.DELIVERY_CONFIRMED,
            title: 'Job Completed',
            body: `Delivery confirmed. Payment will be released to your wallet.`,
            data: { jobId: job.id, type: 'DELIVERY_CONFIRMED' },
          }),
        ]);

        // Release escrow payment if exists
        try {
          const { paymentService } = await import('../payments');
          await paymentService.releaseEscrowPayment(job.id, job.driver.userId);
        } catch (e) {
          console.error('Failed to release escrow:', e);
        }
      }
    } catch (error) {
      console.error('Send notification error:', error);
    }
  }
}

// Export singleton instance
export const qrCodeService = new QRCodeService();
