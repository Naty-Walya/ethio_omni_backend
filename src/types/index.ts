// Express Request Extensions
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        phone: string;
        role: string;
      };
    }
  }
}

// API Response Types
export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
  };
}

// Auth Types
export interface LoginRequest {
  phone: string;
  password: string;
}

export interface RegisterRequest {
  phone: string;
  password: string;
  role: 'SHIPPER' | 'DRIVER' | 'FLEET_OWNER';
  firstName?: string;
  lastName?: string;
}

export interface TokenPayload {
  userId: string;
  phone: string;
  role: string;
}

// Freight Types
export interface CreateFreightPostRequest {
  title: string;
  description?: string;
  cargoType: string;
  weight: number;
  dimensions?: string;
  pickupLocation: string;
  pickupLat?: number;
  pickupLng?: number;
  pickupDate: string;
  deliveryLocation: string;
  deliveryLat?: number;
  deliveryLng?: number;
  preferredDeliveryDate?: string;
  requiredVehicleType?: string;
  specialRequirements?: string;
  budget?: number;
  auctionEnabled?: boolean;
  auctionDuration?: number; // in minutes
  startingBid?: number;
}

export interface CreateBidRequest {
  freightPostId: string;
  amount: number;
  estimatedPickupDate?: string;
  estimatedDeliveryDate?: string;
  message?: string;
}

export interface UpdateJobStatusRequest {
  status: string;
  location?: {
    lat: number;
    lng: number;
  };
}

// Socket.IO Event Types
export interface AuctionEvents {
  'join-auction': { auctionId: string };
  'leave-auction': { auctionId: string };
  'place-bid': { auctionId: string; amount: number };
  'new-bid': { auctionId: string; driverId: string; driverName: string; amount: number; timestamp: Date };
  'outbid-alert': { auctionId: string; newAmount: number };
  'auction-won': { auctionId: string; winningAmount: number };
  'auction-ended': { auctionId: string };
  'auction-error': { message: string };
}

// Wallet Types
export interface DepositRequest {
  amount: number;
  method: 'telebirr' | 'cbe_birr';
}

export interface WithdrawRequest {
  amount: number;
  accountNumber: string;
  accountName: string;
}

// Tracking Types
export interface LocationUpdate {
  jobId: string;
  lat: number;
  lng: number;
  timestamp: Date;
}

// Query Types
export interface FreightPostFilters {
  status?: string;
  cargoType?: string;
  pickupLocation?: string;
  deliveryLocation?: string;
  minWeight?: number;
  maxWeight?: number;
  auctionEnabled?: boolean;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}
