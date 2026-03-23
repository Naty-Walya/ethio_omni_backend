import { Router, Request, Response } from 'express';
import { body } from 'express-validator';
import bcrypt from 'bcryptjs';
import { prisma } from '../prisma/client';
import { generateToken } from '../utils/jwt';
import { successResponse, errorResponse } from '../utils/response';
import { authenticate } from '../middleware/auth';

const router = Router();

// Register
router.post(
  '/register',
  [
    body('phone').isMobilePhone('any').withMessage('Valid phone number required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('role').isIn(['SHIPPER', 'DRIVER', 'FLEET_OWNER']).withMessage('Invalid role'),
  ],
  async (req: Request, res: Response) => {
    try {
      const { phone, password, role, firstName, lastName } = req.body;

      // Check if user exists
      const existingUser = await prisma.user.findUnique({
        where: { phone },
      });

      if (existingUser) {
        errorResponse(res, 'Phone number already registered', 400);
        return;
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Create user with profile
      const user = await prisma.user.create({
        data: {
          phone,
          password: hashedPassword,
          role,
          firstName,
          lastName,
          ...(role === 'SHIPPER' && {
            shipperProfile: {
              create: {},
            },
          }),
          ...(role === 'DRIVER' && {
            driverProfile: {
              create: {},
            },
          }),
          ...(role === 'FLEET_OWNER' && {
            fleetOwnerProfile: {
              create: {},
            },
          }),
          wallet: {
            create: {
              balance: 0,
            },
          },
        },
        include: {
          shipperProfile: true,
          driverProfile: true,
          fleetOwnerProfile: true,
          wallet: true,
        },
      });

      // Generate token
      const token = generateToken({
        userId: user.id,
        phone: user.phone,
        role: user.role,
      });

      successResponse(
        res,
        {
          user: {
            id: user.id,
            phone: user.phone,
            role: user.role,
            firstName: user.firstName,
            lastName: user.lastName,
            isPhoneVerified: user.isPhoneVerified,
            isFaydaVerified: user.isFaydaVerified,
          },
          token,
        },
        'User registered successfully',
        201
      );
    } catch (error) {
      console.error('Registration error:', error);
      errorResponse(res, 'Failed to register user', 500);
    }
  }
);

// Login
router.post(
  '/login',
  [
    body('phone').notEmpty().withMessage('Phone number required'),
    body('password').notEmpty().withMessage('Password required'),
  ],
  async (req: Request, res: Response) => {
    try {
      const { phone, password } = req.body;

      // Find user
      const user = await prisma.user.findUnique({
        where: { phone },
        include: {
          shipperProfile: true,
          driverProfile: true,
          fleetOwnerProfile: true,
          wallet: true,
        },
      });

      if (!user) {
        errorResponse(res, 'Invalid credentials', 401);
        return;
      }

      // Verify password
      const isValidPassword = await bcrypt.compare(password, user.password);

      if (!isValidPassword) {
        errorResponse(res, 'Invalid credentials', 401);
        return;
      }

      if (!user.isActive) {
        errorResponse(res, 'Account is deactivated', 403);
        return;
      }

      // Generate token
      const token = generateToken({
        userId: user.id,
        phone: user.phone,
        role: user.role,
      });

      successResponse(res, {
        user: {
          id: user.id,
          phone: user.phone,
          role: user.role,
          firstName: user.firstName,
          lastName: user.lastName,
          isPhoneVerified: user.isPhoneVerified,
          isFaydaVerified: user.isFaydaVerified,
          wallet: user.wallet ? { balance: user.wallet.balance } : null,
        },
        token,
      });
    } catch (error) {
      console.error('Login error:', error);
      errorResponse(res, 'Failed to login', 500);
    }
  }
);

// Get Profile
router.get('/profile', authenticate, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: {
        shipperProfile: true,
        driverProfile: true,
        fleetOwnerProfile: true,
        wallet: true,
      },
    });

    if (!user) {
      errorResponse(res, 'User not found', 404);
      return;
    }

    successResponse(res, {
      id: user.id,
      phone: user.phone,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      avatar: user.avatar,
      isPhoneVerified: user.isPhoneVerified,
      isFaydaVerified: user.isFaydaVerified,
      faydaId: user.faydaId,
      shipperProfile: user.shipperProfile,
      driverProfile: user.driverProfile,
      fleetOwnerProfile: user.fleetOwnerProfile,
      wallet: user.wallet ? { balance: user.wallet.balance } : null,
    });
  } catch (error) {
    console.error('Profile error:', error);
    errorResponse(res, 'Failed to get profile', 500);
  }
});

// Update Profile
router.put('/profile', authenticate, async (req, res) => {
  try {
    const { firstName, lastName, email, avatar } = req.body;

    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        firstName,
        lastName,
        email,
        avatar,
      },
      include: {
        shipperProfile: true,
        driverProfile: true,
        fleetOwnerProfile: true,
      },
    });

    successResponse(res, {
      id: user.id,
      phone: user.phone,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      avatar: user.avatar,
    }, 'Profile updated successfully');
  } catch (error) {
    console.error('Update profile error:', error);
    errorResponse(res, 'Failed to update profile', 500);
  }
});

// Verify Fayda ID
router.post('/verify-fayda', authenticate, async (req, res) => {
  try {
    const { faydaId } = req.body;

    // TODO: Integrate with actual Fayda API
    // For now, simulate verification
    const isValid = faydaId && faydaId.length >= 10;

    if (!isValid) {
      errorResponse(res, 'Invalid Fayda ID', 400);
      return;
    }

    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        faydaId,
        isFaydaVerified: true,
      },
    });

    successResponse(res, {
      isFaydaVerified: user.isFaydaVerified,
      faydaId: user.faydaId,
    }, 'Fayda ID verified successfully');
  } catch (error) {
    console.error('Fayda verification error:', error);
    errorResponse(res, 'Failed to verify Fayda ID', 500);
  }
});

// Logout (client-side token removal, but we can track if needed)
router.post('/logout', authenticate, async (req, res) => {
  // In a stateless JWT setup, logout is handled client-side
  // We could add token blacklisting here if needed
  successResponse(res, null, 'Logged out successfully');
});

export default router;
