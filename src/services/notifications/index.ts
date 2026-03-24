import { PrismaClient, NotificationType, NotificationChannel } from '@prisma/client';

const prisma = new PrismaClient();

// Firebase Admin is loaded dynamically
let admin: any = null;
let firebaseInitialized = false;

export function initializeFirebase() {
  if (!firebaseInitialized && process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      admin = require('firebase-admin');
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      firebaseInitialized = true;
      console.log('Firebase Admin initialized for push notifications');
    } catch (error) {
      console.warn('Firebase Admin not available - push notifications disabled');
    }
  }
}

// Notification preferences interface
interface NotificationPreferences {
  bidAlerts: boolean;
  auctionAlerts: boolean;
  jobAlerts: boolean;
  paymentAlerts: boolean;
  fraudAlerts: boolean;
  messageAlerts: boolean;
  rentalAlerts: boolean;
  systemAlerts: boolean;
  pushEnabled: boolean;
  emailEnabled: boolean;
  smsEnabled: boolean;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
}

// Default preferences
const defaultPreferences: NotificationPreferences = {
  bidAlerts: true,
  auctionAlerts: true,
  jobAlerts: true,
  paymentAlerts: true,
  fraudAlerts: true,
  messageAlerts: true,
  rentalAlerts: true,
  systemAlerts: true,
  pushEnabled: true,
  emailEnabled: true,
  smsEnabled: false,
  quietHoursStart: null,
  quietHoursEnd: null,
};

// Check if notification should be sent based on user preferences and quiet hours
function shouldSendNotification(
  type: NotificationType,
  preferences: NotificationPreferences,
  channel: NotificationChannel
): boolean {
  // Check quiet hours
  if (channel === NotificationChannel.PUSH && preferences.quietHoursStart !== null && preferences.quietHoursEnd !== null) {
    const currentHour = new Date().getHours();
    const start = preferences.quietHoursStart;
    const end = preferences.quietHoursEnd;

    if (start < end) {
      // Same day quiet hours (e.g., 22:00 to 07:00)
      if (currentHour >= start && currentHour < end) {
        return false;
      }
    } else {
      // Overnight quiet hours (e.g., 22:00 to 07:00)
      if (currentHour >= start || currentHour < end) {
        return false;
      }
    }
  }

  // Check channel enabled
  if (channel === NotificationChannel.PUSH && !preferences.pushEnabled) return false;
  if (channel === NotificationChannel.EMAIL && !preferences.emailEnabled) return false;
  if (channel === NotificationChannel.SMS && !preferences.smsEnabled) return false;

  // Check notification type enabled
  const typeMap: Record<NotificationType, keyof NotificationPreferences> = {
    [NotificationType.BID_PLACED]: 'bidAlerts',
    [NotificationType.BID_ACCEPTED]: 'bidAlerts',
    [NotificationType.BID_REJECTED]: 'bidAlerts',
    [NotificationType.OUTBID_ALERT]: 'auctionAlerts',
    [NotificationType.AUCTION_WON]: 'auctionAlerts',
    [NotificationType.AUCTION_ENDING_SOON]: 'auctionAlerts',
    [NotificationType.JOB_ASSIGNED]: 'jobAlerts',
    [NotificationType.PICKUP_REMINDER]: 'jobAlerts',
    [NotificationType.DELIVERY_REMINDER]: 'jobAlerts',
    [NotificationType.DELIVERY_CONFIRMED]: 'jobAlerts',
    [NotificationType.PAYMENT_RECEIVED]: 'paymentAlerts',
    [NotificationType.PAYMENT_SENT]: 'paymentAlerts',
    [NotificationType.FRAUD_ALERT]: 'fraudAlerts',
    [NotificationType.SYSTEM]: 'systemAlerts',
    [NotificationType.MESSAGE]: 'messageAlerts',
    [NotificationType.RENTAL_BOOKING]: 'rentalAlerts',
    [NotificationType.RENTAL_CONFIRMED]: 'rentalAlerts',
  };

  const prefValue = preferences[typeMap[type]];
  return typeof prefValue === 'boolean' ? prefValue : true;
}

// Create and send notification
export async function sendNotification({
  userId,
  type,
  title,
  body,
  data,
  channels = [NotificationChannel.IN_APP, NotificationChannel.PUSH],
}: {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, any>;
  channels?: NotificationChannel[];
}) {
  try {
    // Get user preferences
    let preferences = await prisma.notificationPreference.findUnique({
      where: { userId },
    });

    // Use default preferences if none exist
    if (!preferences) {
      preferences = await prisma.notificationPreference.create({
        data: { userId, ...defaultPreferences },
      });
    }

    const notifications: any[] = [];

    // Send through each channel
    for (const channel of channels) {
      if (!shouldSendNotification(type, preferences, channel)) {
        continue;
      }

      // Create in-app notification
      if (channel === NotificationChannel.IN_APP) {
        const notification = await prisma.notification.create({
          data: {
            userId,
            type,
            channel,
            title,
            body,
            data: data || {},
          },
        });
        notifications.push(notification);
      }

      // Send push notification
      if (channel === NotificationChannel.PUSH) {
        await sendPushNotification(userId, title, body, data);
      }

      // TODO: Implement email and SMS notifications
    }

    return { success: true, notifications };
  } catch (error) {
    console.error('Failed to send notification:', error);
    return { success: false, error };
  }
}

// Send push notification via Firebase
async function sendPushNotification(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, any>
) {
  if (!firebaseInitialized) {
    console.warn('Firebase not initialized, skipping push notification');
    return;
  }

  try {
    // Get user's active devices
    const devices = await prisma.device.findMany({
      where: {
        userId,
        isActive: true,
      },
    });

    if (devices.length === 0) {
      console.log(`No active devices found for user ${userId}`);
      return;
    }

    const tokens = devices.map(d => d.fcmToken);

    // Send to all devices
    const message = {
      notification: {
        title,
        body,
      },
      data: {
        ...data,
        clickAction: 'FLUTTER_NOTIFICATION_CLICK',
      },
      tokens,
    };

    const response = await admin.messaging().sendMulticast(message);
    console.log(`Push notification sent: ${response.successCount} successful, ${response.failureCount} failed`);

    // Update device status for failed tokens
    if (response.failureCount > 0) {
      const failedTokens: string[] = [];
      response.responses.forEach((resp: any, idx: number) => {
        if (!resp.success) {
          failedTokens.push(tokens[idx]);
          console.error(`Push failed for token ${tokens[idx]}:`, resp.error);
        }
      });

      // Deactivate devices with failed tokens
      if (failedTokens.length > 0) {
        await prisma.device.updateMany({
          where: {
            fcmToken: { in: failedTokens },
          },
          data: {
            isActive: false,
          },
        });
      }
    }

    return response;
  } catch (error) {
    console.error('Failed to send push notification:', error);
  }
}

// Register device for push notifications
export async function registerDevice({
  userId,
  fcmToken,
  deviceType,
  deviceName,
  osVersion,
  appVersion,
}: {
  userId: string;
  fcmToken: string;
  deviceType: string;
  deviceName?: string;
  osVersion?: string;
  appVersion?: string;
}) {
  try {
    const device = await prisma.device.upsert({
      where: {
        userId_fcmToken: {
          userId,
          fcmToken,
        },
      },
      update: {
        isActive: true,
        lastUsedAt: new Date(),
        deviceType,
        deviceName,
        osVersion,
        appVersion,
      },
      create: {
        userId,
        fcmToken,
        deviceType,
        deviceName,
        osVersion,
        appVersion,
        isActive: true,
      },
    });

    return { success: true, device };
  } catch (error) {
    console.error('Failed to register device:', error);
    return { success: false, error };
  }
}

// Unregister device
export async function unregisterDevice(userId: string, fcmToken: string) {
  try {
    await prisma.device.updateMany({
      where: {
        userId,
        fcmToken,
      },
      data: {
        isActive: false,
      },
    });

    return { success: true };
  } catch (error) {
    console.error('Failed to unregister device:', error);
    return { success: false, error };
  }
}

// Get user notifications
export async function getUserNotifications(
  userId: string,
  options: {
    limit?: number;
    offset?: number;
    unreadOnly?: boolean;
    types?: NotificationType[];
  } = {}
) {
  const { limit = 20, offset = 0, unreadOnly = false, types } = options;

  try {
    const where: any = { userId };
    if (unreadOnly) {
      where.isRead = false;
    }
    if (types && types.length > 0) {
      where.type = { in: types };
    }

    const [notifications, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.notification.count({ where: { userId } }),
      prisma.notification.count({
        where: { userId, isRead: false },
      }),
    ]);

    return {
      success: true,
      notifications,
      total,
      unreadCount,
    };
  } catch (error) {
    console.error('Failed to get notifications:', error);
    return { success: false, error };
  }
}

// Mark notification as read
export async function markAsRead(userId: string, notificationId: string) {
  try {
    const notification = await prisma.notification.update({
      where: {
        id: notificationId,
        userId, // Ensure user owns this notification
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    return { success: true, notification };
  } catch (error) {
    console.error('Failed to mark notification as read:', error);
    return { success: false, error };
  }
}

// Mark all notifications as read
export async function markAllAsRead(userId: string) {
  try {
    const result = await prisma.notification.updateMany({
      where: {
        userId,
        isRead: false,
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    return { success: true, count: result.count };
  } catch (error) {
    console.error('Failed to mark all notifications as read:', error);
    return { success: false, error };
  }
}

// Get notification preferences
export async function getNotificationPreferences(userId: string) {
  try {
    let preferences = await prisma.notificationPreference.findUnique({
      where: { userId },
    });

    if (!preferences) {
      preferences = await prisma.notificationPreference.create({
        data: { userId, ...defaultPreferences },
      });
    }

    return { success: true, preferences };
  } catch (error) {
    console.error('Failed to get notification preferences:', error);
    return { success: false, error };
  }
}

// Update notification preferences
export async function updateNotificationPreferences(
  userId: string,
  updates: Partial<NotificationPreferences>
) {
  try {
    const preferences = await prisma.notificationPreference.upsert({
      where: { userId },
      update: updates,
      create: { userId, ...defaultPreferences, ...updates },
    });

    return { success: true, preferences };
  } catch (error) {
    console.error('Failed to update notification preferences:', error);
    return { success: false, error };
  }
}

// Notification helper functions for different events

// Bid notifications
export async function notifyBidPlaced(freightPostId: string, bidId: string, driverName: string) {
  const freightPost = await prisma.freightPost.findUnique({
    where: { id: freightPostId },
    include: { shipper: { include: { user: true } } },
  });

  if (freightPost) {
    await sendNotification({
      userId: freightPost.shipper.user.id,
      type: NotificationType.BID_PLACED,
      title: 'New Bid Received',
      body: `${driverName} placed a bid on your freight: ${freightPost.title}`,
      data: { freightPostId, bidId, type: 'BID_PLACED' },
    });
  }
}

export async function notifyBidAccepted(bidId: string) {
  const bid = await prisma.bid.findUnique({
    where: { id: bidId },
    include: {
      driver: { include: { user: true } },
      freightPost: true,
    },
  });

  if (bid) {
    await sendNotification({
      userId: bid.driver.user.id,
      type: NotificationType.BID_ACCEPTED,
      title: 'Bid Accepted!',
      body: `Your bid on "${bid.freightPost.title}" has been accepted.`,
      data: { bidId, freightPostId: bid.freightPostId, type: 'BID_ACCEPTED' },
    });
  }
}

// Auction notifications
export async function notifyAuctionWon(auctionId: string, driverId: string) {
  const auction = await prisma.auction.findUnique({
    where: { id: auctionId },
    include: {
      freightPost: true,
      bids: {
        where: { driverId },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });

  if (auction) {
    await sendNotification({
      userId: driverId,
      type: NotificationType.AUCTION_WON,
      title: 'Auction Won!',
      body: `Congratulations! You won the auction for "${auction.freightPost.title}".`,
      data: { auctionId, freightPostId: auction.freightPostId, type: 'AUCTION_WON' },
    });
  }
}

// Job notifications
export async function notifyJobAssigned(jobId: string) {
  const job = await prisma.freightJob.findUnique({
    where: { id: jobId },
    include: {
      driver: { include: { user: true } },
      freightPost: true,
    },
  });

  if (job) {
    await sendNotification({
      userId: job.driver.user.id,
      type: NotificationType.JOB_ASSIGNED,
      title: 'New Job Assigned',
      body: `You've been assigned to transport: ${job.freightPost.title}`,
      data: { jobId, freightPostId: job.freightPostId, type: 'JOB_ASSIGNED' },
    });
  }
}

export async function notifyDeliveryConfirmed(jobId: string, userId: string) {
  await sendNotification({
    userId,
    type: NotificationType.DELIVERY_CONFIRMED,
    title: 'Delivery Confirmed',
    body: 'Your freight has been delivered successfully!',
    data: { jobId, type: 'DELIVERY_CONFIRMED' },
  });
}

// Payment notifications
export async function notifyPaymentReceived(userId: string, amount: number, currency: string = 'ETB') {
  await sendNotification({
    userId,
    type: NotificationType.PAYMENT_RECEIVED,
    title: 'Payment Received',
    body: `You've received ${amount.toFixed(2)} ${currency}.`,
    data: { amount, currency, type: 'PAYMENT_RECEIVED' },
  });
}

// Rental notifications
export async function notifyRentalBooking(assetId: string, renterId: string) {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    include: { owner: { include: { user: true } } },
  });

  if (asset) {
    await sendNotification({
      userId: asset.owner.user.id,
      type: NotificationType.RENTAL_BOOKING,
      title: 'New Rental Request',
      body: `Someone requested to rent your ${asset.name}.`,
      data: { assetId, renterId, type: 'RENTAL_BOOKING' },
    });
  }
}

export async function notifyRentalConfirmed(bookingId: string, renterId: string) {
  const booking = await prisma.rentalBooking.findUnique({
    where: { id: bookingId },
    include: { asset: true },
  });

  if (booking) {
    await sendNotification({
      userId: renterId,
      type: NotificationType.RENTAL_CONFIRMED,
      title: 'Rental Confirmed',
      body: `Your rental request for ${booking.asset.name} has been confirmed!`,
      data: { bookingId, assetId: booking.assetId, type: 'RENTAL_CONFIRMED' },
    });
  }
}

// Fraud alert notification (for admins)
export async function notifyFraudAlert(fraudAlertId: string, adminIds: string[]) {
  for (const adminId of adminIds) {
    await sendNotification({
      userId: adminId,
      type: NotificationType.FRAUD_ALERT,
      title: 'Fraud Alert',
      body: 'A new fraud alert requires your attention.',
      data: { fraudAlertId, type: 'FRAUD_ALERT' },
    });
  }
}
