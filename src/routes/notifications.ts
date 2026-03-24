import { Router, Request, Response } from 'express';
import { PrismaClient, NotificationType } from '@prisma/client';
import { authenticate, authorize } from '../middleware/auth';
import {
  registerDevice,
  unregisterDevice,
  getUserNotifications,
  markAsRead,
  markAllAsRead,
  getNotificationPreferences,
  updateNotificationPreferences,
} from '../services/notifications';

const router = Router();
const prisma = new PrismaClient();

// Register device for push notifications
router.post('/devices', authenticate, async (req: Request, res: Response) => {
  try {
    const { fcmToken, deviceType, deviceName, osVersion, appVersion } = req.body;
    const userId = req.user!.id;

    if (!fcmToken || !deviceType) {
      return res.status(400).json({
        success: false,
        message: 'fcmToken and deviceType are required',
      });
    }

    const result = await registerDevice({
      userId,
      fcmToken,
      deviceType,
      deviceName,
      osVersion,
      appVersion,
    });

    if (result.success) {
      res.json({
        success: true,
        message: 'Device registered successfully',
        device: result.device,
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to register device',
      });
    }
  } catch (error) {
    console.error('Register device error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Unregister device
router.delete('/devices/:token', authenticate, async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const userId = req.user!.id;

    const result = await unregisterDevice(userId, token);

    if (result.success) {
      res.json({
        success: true,
        message: 'Device unregistered successfully',
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to unregister device',
      });
    }
  } catch (error) {
    console.error('Unregister device error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get user's devices
router.get('/devices', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const devices = await prisma.device.findMany({
      where: { userId, isActive: true },
      orderBy: { lastUsedAt: 'desc' },
    });

    res.json({
      success: true,
      devices,
    });
  } catch (error) {
    console.error('Get devices error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get user notifications
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { limit = '20', offset = '0', unreadOnly = 'false', types } = req.query;

    const options = {
      limit: parseInt(limit as string, 10),
      offset: parseInt(offset as string, 10),
      unreadOnly: unreadOnly === 'true',
      types: types ? (types as string).split(',') as NotificationType[] : undefined,
    };

    const result = await getUserNotifications(userId, options);

    if (result.success) {
      res.json({
        success: true,
        data: {
          notifications: result.notifications,
          pagination: {
            total: result.total,
            limit: options.limit,
            offset: options.offset,
          },
          unreadCount: result.unreadCount,
        },
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to get notifications',
      });
    }
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Mark notification as read
router.patch('/:id/read', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const result = await markAsRead(userId, id);

    if (result.success) {
      res.json({
        success: true,
        message: 'Notification marked as read',
        notification: result.notification,
      });
    } else {
      res.status(404).json({
        success: false,
        message: 'Notification not found',
      });
    }
  } catch (error) {
    console.error('Mark as read error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Mark all notifications as read
router.patch('/read-all', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const result = await markAllAsRead(userId);

    if (result.success) {
      res.json({
        success: true,
        message: 'All notifications marked as read',
        count: result.count,
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to mark notifications as read',
      });
    }
  } catch (error) {
    console.error('Mark all as read error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get notification preferences
router.get('/preferences', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const result = await getNotificationPreferences(userId);

    if (result.success) {
      res.json({
        success: true,
        preferences: result.preferences,
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to get preferences',
      });
    }
  } catch (error) {
    console.error('Get preferences error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update notification preferences
router.put('/preferences', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const updates = req.body;

    const result = await updateNotificationPreferences(userId, updates);

    if (result.success) {
      res.json({
        success: true,
        message: 'Preferences updated successfully',
        preferences: result.preferences,
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to update preferences',
      });
    }
  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Delete notification
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    await prisma.notification.deleteMany({
      where: {
        id,
        userId,
      },
    });

    res.json({
      success: true,
      message: 'Notification deleted',
    });
  } catch (error) {
    console.error('Delete notification error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get unread notification count
router.get('/unread-count', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const count = await prisma.notification.count({
      where: {
        userId,
        isRead: false,
      },
    });

    res.json({
      success: true,
      count,
    });
  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Admin: Send notification to all users (admin only)
router.post('/broadcast', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
  try {
    const { title, body, data } = req.body;

    if (!title || !body) {
      return res.status(400).json({
        success: false,
        message: 'Title and body are required',
      });
    }

    // Get all active users
    const users = await prisma.user.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    // Create in-app notifications for all users
    const notifications = await Promise.all(
      users.map(user =>
        prisma.notification.create({
          data: {
            userId: user.id,
            type: NotificationType.SYSTEM,
            channel: 'IN_APP',
            title,
            body,
            data: data || {},
          },
        })
      )
    );

    res.json({
      success: true,
      message: `Broadcast sent to ${users.length} users`,
      count: notifications.length,
    });
  } catch (error) {
    console.error('Broadcast error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

export default router;
