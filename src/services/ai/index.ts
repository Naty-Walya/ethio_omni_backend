import { prisma } from '../../prisma/client';
import { MarketAnalytics, AIPrediction, FraudAlert, Prisma } from '@prisma/client';

// AI Service Configuration
const CONFIG = {
  // Demand prediction weights
  DEMAND_WEIGHTS: {
    historicalVolume: 0.3,
    seasonalFactor: 0.2,
    dayOfWeek: 0.15,
    priceSensitivity: 0.15,
    regionActivity: 0.2,
  },
  // Fraud detection thresholds
  FRAUD_THRESHOLDS: {
    LOW: 0.3,
    MEDIUM: 0.6,
    HIGH: 0.8,
    CRITICAL: 0.95,
  },
  // Price recommendation margins
  PRICE_MARGINS: {
    MIN: 0.85,    // 15% below market avg
    OPTIMAL: 1.0, // Market average
    MAX: 1.25,    // 25% above market avg
  },
};

// Demand Prediction Service
export class DemandPredictionService {
  /**
   * Predict freight demand for a specific region/route and time period
   */
  async predictDemand(
    region: string,
    route: string | null,
    daysAhead: number = 7
  ): Promise<{
    demandIndex: number;
    confidence: number;
    factors: Record<string, number>;
    recommendation: string;
  }> {
    try {
      // Get historical data
      const historicalData = await this.getHistoricalData(region, route);

      // Calculate factors
      const factors = await this.calculateDemandFactors(
        region,
        route,
        historicalData
      );

      // Calculate demand index (0-100)
      const demandIndex = this.calculateDemandIndex(factors);

      // Calculate confidence based on data quality
      const confidence = this.calculateConfidence(historicalData);

      // Generate recommendation
      const recommendation = this.generateDemandRecommendation(
        demandIndex,
        factors
      );

      // Store prediction
      await this.storePrediction({
        modelType: 'DEMAND_FORECAST',
        prediction: {
          demandIndex,
          daysAhead,
          region,
          route,
        },
        confidence,
        features: factors,
        region,
        route,
      });

      return {
        demandIndex,
        confidence,
        factors,
        recommendation,
      };
    } catch (error) {
      console.error('Demand prediction error:', error);
      return {
        demandIndex: 50,
        confidence: 0.5,
        factors: {},
        recommendation: 'Insufficient data for prediction',
      };
    }
  }

  /**
   * Get historical freight data for a region/route
   */
  private async getHistoricalData(
    region: string,
    route: string | null
  ): Promise<{
    posts: number;
    bids: number;
    completed: number;
    avgPrice: number;
  }> {
    // Get data from last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const where: Prisma.FreightPostWhereInput = {
      createdAt: { gte: thirtyDaysAgo },
      pickupLocation: route
        ? { contains: route.split(' - ')[0] || '', mode: 'insensitive' }
        : undefined,
    };

    const [posts, bids, completed] = await Promise.all([
      prisma.freightPost.count({ where }),
      prisma.bid.count({
        where: {
          createdAt: { gte: thirtyDaysAgo },
        },
      }),
      prisma.freightJob.count({
        where: {
          createdAt: { gte: thirtyDaysAgo },
          status: { in: ['COMPLETED', 'DELIVERED'] },
        },
      }),
    ]);

    // Calculate average price
    const avgPriceResult = await prisma.bid.aggregate({
      where: { createdAt: { gte: thirtyDaysAgo } },
      _avg: { amount: true },
    });

    return {
      posts,
      bids,
      completed,
      avgPrice: avgPriceResult._avg.amount || 0,
    };
  }

  /**
   * Calculate various demand factors
   */
  private async calculateDemandFactors(
    region: string,
    route: string | null,
    historicalData: { posts: number; bids: number; completed: number }
  ): Promise<Record<string, number>> {
    const factors: Record<string, number> = {};

    // Historical volume factor (0-1)
    factors.historicalVolume = Math.min(historicalData.posts / 100, 1);

    // Seasonal factor (current month)
    const currentMonth = new Date().getMonth();
    const seasonalMultipliers = [
      0.8, 0.9, 1.0, 1.1, 1.2, 1.0, // Jan-Jun
      0.9, 0.8, 1.1, 1.2, 1.0, 0.9, // Jul-Dec
    ];
    factors.seasonalFactor = seasonalMultipliers[currentMonth];

    // Day of week factor
    const dayOfWeek = new Date().getDay();
    factors.dayOfWeek = dayOfWeek === 0 || dayOfWeek === 6 ? 0.7 : 1.0; // Lower on weekends

    // Supply/demand ratio
    const supplyDemandRatio =
      historicalData.bids > 0 ? historicalData.posts / historicalData.bids : 1;
    factors.supplyDemandRatio = Math.min(supplyDemandRatio, 2) / 2;

    // Region activity
    const regionActivity = await this.getRegionActivity(region);
    factors.regionActivity = regionActivity;

    return factors;
  }

  /**
   * Get activity level for a region
   */
  private async getRegionActivity(region: string): Promise<number> {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const count = await prisma.freightPost.count({
      where: {
        pickupLocation: { contains: region, mode: 'insensitive' },
        createdAt: { gte: sevenDaysAgo },
      },
    });

    // Normalize to 0-1
    return Math.min(count / 50, 1);
  }

  /**
   * Calculate overall demand index
   */
  private calculateDemandIndex(factors: Record<string, number>): number {
    const weights = CONFIG.DEMAND_WEIGHTS;

    let index = 0;
    index += (factors.historicalVolume || 0) * weights.historicalVolume * 100;
    index += (factors.seasonalFactor || 0) * weights.seasonalFactor * 100;
    index += (factors.dayOfWeek || 0) * weights.dayOfWeek * 100;
    index += (factors.supplyDemandRatio || 0) * weights.priceSensitivity * 100;
    index += (factors.regionActivity || 0) * weights.regionActivity * 100;

    return Math.round(Math.min(Math.max(index, 0), 100));
  }

  /**
   * Calculate confidence based on data quality
   */
  private calculateConfidence(historicalData: {
    posts: number;
    bids: number;
  }): number {
    // More data = higher confidence
    const dataVolume = historicalData.posts + historicalData.bids;
    const confidence = Math.min(dataVolume / 200, 1);
    return Math.round(confidence * 100) / 100;
  }

  /**
   * Generate recommendation based on demand index
   */
  private generateDemandRecommendation(
    demandIndex: number,
    factors: Record<string, number>
  ): string {
    if (demandIndex >= 80) {
      return 'Very high demand - consider posting immediately for best rates';
    } else if (demandIndex >= 60) {
      return 'High demand - good time to post freight';
    } else if (demandIndex >= 40) {
      return 'Moderate demand - competitive pricing recommended';
    } else {
      return 'Low demand - may need to wait or adjust pricing';
    }
  }

  /**
   * Store prediction in database
   */
  private async storePrediction(data: {
    modelType: string;
    prediction: any;
    confidence: number;
    features: any;
    region?: string;
    route?: string | null;
    userId?: string;
  }): Promise<void> {
    try {
      await prisma.aIPrediction.create({
        data: {
          modelType: data.modelType as any,
          prediction: data.prediction,
          confidence: data.confidence,
          features: data.features,
          region: data.region,
          route: data.route || undefined,
          userId: data.userId,
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
        },
      });
    } catch (error) {
      console.error('Store prediction error:', error);
    }
  }
}

// Fraud Detection Service
export class FraudDetectionService {
  /**
   * Check a transaction/bid for fraud indicators
   */
  async checkForFraud(
    entityType: string,
    entityId: string,
    data: any
  ): Promise<{
    isFraudulent: boolean;
    riskScore: number;
    alerts: string[];
    severity: string;
  }> {
    const indicators: string[] = [];
    let riskScore = 0;

    // Check various fraud patterns
    const checks = await Promise.all([
      this.checkUnusualAmount(data),
      this.checkRapidTransactions(data),
      this.checkLocationAnomaly(data),
      this.checkAccountAge(data),
      this.checkBehaviorPattern(data),
    ]);

    // Aggregate results
    checks.forEach((check) => {
      if (check.triggered) {
        indicators.push(check.reason);
        riskScore += check.score;
      }
    });

    // Normalize risk score
    riskScore = Math.min(riskScore / 100, 1);

    // Determine severity
    const severity = this.determineSeverity(riskScore);
    const isFraudulent = riskScore >= CONFIG.FRAUD_THRESHOLDS.MEDIUM;

    // Store fraud alert if medium+ risk
    if (riskScore >= CONFIG.FRAUD_THRESHOLDS.LOW) {
      await this.storeFraudAlert({
        entityType,
        entityId,
        riskScore,
        indicators,
        severity,
        data,
      });
    }

    return {
      isFraudulent,
      riskScore,
      alerts: indicators,
      severity,
    };
  }

  /**
   * Check for unusual transaction amounts
   */
  private async checkUnusualAmount(data: any): Promise<{
    triggered: boolean;
    score: number;
    reason: string;
  }> {
    const amount = data.amount || 0;

    // Check if amount is unusually high
    if (amount > 100000) {
      // 100k ETB
      return {
        triggered: true,
        score: 25,
        reason: 'Unusually high transaction amount',
      };
    }

    return { triggered: false, score: 0, reason: '' };
  }

  /**
   * Check for rapid transaction patterns
   */
  private async checkRapidTransactions(data: any): Promise<{
    triggered: boolean;
    score: number;
    reason: string;
  }> {
    const userId = data.userId;
    if (!userId) return { triggered: false, score: 0, reason: '' };

    // Count transactions in last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const recentCount = await prisma.transaction.count({
      where: {
        wallet: { userId },
        createdAt: { gte: oneHourAgo },
      },
    });

    if (recentCount > 5) {
      return {
        triggered: true,
        score: 30,
        reason: 'Unusual number of recent transactions',
      };
    }

    return { triggered: false, score: 0, reason: '' };
  }

  /**
   * Check for location anomalies
   */
  private async checkLocationAnomaly(data: any): Promise<{
    triggered: boolean;
    score: number;
    reason: string;
  }> {
    // Simplified - in production would check IP geolocation
    const location = data.location;
    if (!location) return { triggered: false, score: 0, reason: '' };

    // Check if location changed drastically
    return { triggered: false, score: 0, reason: '' };
  }

  /**
   * Check account age
   */
  private async checkAccountAge(data: any): Promise<{
    triggered: boolean;
    score: number;
    reason: string;
  }> {
    const userId = data.userId;
    if (!userId) return { triggered: false, score: 0, reason: '' };

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { createdAt: true },
    });

    if (!user) return { triggered: false, score: 0, reason: '' };

    const accountAge = Date.now() - user.createdAt.getTime();
    const hoursOld = accountAge / (1000 * 60 * 60);

    if (hoursOld < 24) {
      return {
        triggered: true,
        score: 15,
        reason: 'Account created less than 24 hours ago',
      };
    }

    return { triggered: false, score: 0, reason: '' };
  }

  /**
   * Check behavior patterns
   */
  private async checkBehaviorPattern(data: any): Promise<{
    triggered: boolean;
    score: number;
    reason: string;
  }> {
    // Simplified behavior check
    return { triggered: false, score: 0, reason: '' };
  }

  /**
   * Determine severity level from risk score
   */
  private determineSeverity(riskScore: number): string {
    if (riskScore >= CONFIG.FRAUD_THRESHOLDS.CRITICAL) return 'CRITICAL';
    if (riskScore >= CONFIG.FRAUD_THRESHOLDS.HIGH) return 'HIGH';
    if (riskScore >= CONFIG.FRAUD_THRESHOLDS.MEDIUM) return 'MEDIUM';
    return 'LOW';
  }

  /**
   * Store fraud alert
   */
  private async storeFraudAlert(data: {
    entityType: string;
    entityId: string;
    riskScore: number;
    indicators: string[];
    severity: string;
    data: any;
  }): Promise<void> {
    try {
      await prisma.fraudAlert.create({
        data: {
          alertType: this.mapAlertType(data.entityType),
          severity: data.severity as any,
          riskScore: data.riskScore,
          relatedId: data.entityId,
          relatedType: data.entityType,
          evidence: data.indicators,
          features: data.data,
          userId: data.data.userId,
          status: 'OPEN',
        },
      });
    } catch (error) {
      console.error('Store fraud alert error:', error);
    }
  }

  /**
   * Map entity type to alert type
   */
  private mapAlertType(entityType: string): string {
    switch (entityType) {
      case 'TRANSACTION':
        return 'TRANSACTION';
      case 'BID':
        return 'BID_MANIPULATION';
      default:
        return 'TRANSACTION';
    }
  }
}

// Price Recommendation Service
export class PriceRecommendationService {
  /**
   * Get price recommendation for a freight route
   */
  async getPriceRecommendation(
    pickupLocation: string,
    deliveryLocation: string,
    cargoWeight: number,
    cargoType: string
  ): Promise<{
    minPrice: number;
    optimalPrice: number;
    maxPrice: number;
    marketAverage: number;
    confidence: number;
    factors: string[];
  }> {
    try {
      // Get historical prices for similar routes
      const marketData = await this.getMarketData(
        pickupLocation,
        deliveryLocation
      );

      // Calculate distance factor (simplified)
      const distanceFactor = this.estimateDistanceFactor(
        pickupLocation,
        deliveryLocation
      );

      // Weight factor
      const weightFactor = Math.sqrt(cargoWeight / 1000); // Normalize to tons

      // Cargo type multiplier
      const cargoMultiplier = this.getCargoMultiplier(cargoType);

      // Calculate base price
      const basePrice = marketData.avgPrice || 5000;
      const adjustedPrice =
        basePrice * distanceFactor * weightFactor * cargoMultiplier;

      // Apply margins
      const minPrice = Math.round(adjustedPrice * CONFIG.PRICE_MARGINS.MIN);
      const optimalPrice = Math.round(
        adjustedPrice * CONFIG.PRICE_MARGINS.OPTIMAL
      );
      const maxPrice = Math.round(adjustedPrice * CONFIG.PRICE_MARGINS.MAX);

      // Calculate confidence
      const confidence = marketData.sampleSize > 10 ? 0.85 : 0.6;

      return {
        minPrice,
        optimalPrice,
        maxPrice,
        marketAverage: Math.round(marketData.avgPrice),
        confidence,
        factors: [
          `Route: ${pickupLocation} - ${deliveryLocation}`,
          `Weight: ${cargoWeight}kg`,
          `Cargo type: ${cargoType}`,
          `Sample size: ${marketData.sampleSize}`,
        ],
      };
    } catch (error) {
      console.error('Price recommendation error:', error);

      // Return default values
      return {
        minPrice: 4000,
        optimalPrice: 5000,
        maxPrice: 7000,
        marketAverage: 5000,
        confidence: 0.5,
        factors: ['Insufficient market data'],
      };
    }
  }

  /**
   * Get market data for a route
   */
  private async getMarketData(
    pickupLocation: string,
    deliveryLocation: string
  ): Promise<{ avgPrice: number; sampleSize: number }> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const bids = await prisma.bid.findMany({
      where: {
        createdAt: { gte: thirtyDaysAgo },
        freightPost: {
          pickupLocation: {
            contains: pickupLocation.substring(0, 5),
            mode: 'insensitive',
          },
          deliveryLocation: {
            contains: deliveryLocation.substring(0, 5),
            mode: 'insensitive',
          },
        },
      },
      select: { amount: true },
      take: 100,
    });

    if (bids.length === 0) {
      return { avgPrice: 5000, sampleSize: 0 };
    }

    const avgPrice = bids.reduce((sum, b) => sum + b.amount, 0) / bids.length;

    return { avgPrice, sampleSize: bids.length };
  }

  /**
   * Estimate distance factor (simplified)
   */
  private estimateDistanceFactor(
    pickup: string,
    delivery: string
  ): number {
    // Major Ethiopian cities distance estimation
    const majorCities = [
      'Addis Ababa',
      'Hawassa',
      'Dire Dawa',
      'Mekelle',
      'Bahir Dar',
      'Adama',
    ];

    const isMajorPickup = majorCities.some((c) =>
      pickup.toLowerCase().includes(c.toLowerCase())
    );
    const isMajorDelivery = majorCities.some((c) =>
      delivery.toLowerCase().includes(c.toLowerCase())
    );

    // Inter-city routes are longer
    if (isMajorPickup && isMajorDelivery) {
      return 2.5;
    }

    // Local routes
    return 1.0;
  }

  /**
   * Get cargo type price multiplier
   */
  private getCargoMultiplier(cargoType: string): number {
    const multipliers: Record<string, number> = {
      GENERAL: 1.0,
      PERISHABLE: 1.2,
      FRAGILE: 1.15,
      HEAVY: 1.3,
      HAZARDOUS: 1.5,
      LIQUID: 1.1,
      LIVESTOCK: 1.25,
      CONSTRUCTION: 1.2,
    };

    return multipliers[cargoType] || 1.0;
  }
}

// Analytics Service
export class AnalyticsService {
  /**
   * Update market analytics
   */
  async updateMarketAnalytics(): Promise<void> {
    const today = new Date();
    const period = today.toISOString().split('T')[0];

    // Aggregate by region
    const regions = [
      'Addis Ababa',
      'Oromia',
      'Amhara',
      'Tigray',
      'SNNPR',
    ];

    for (const region of regions) {
      const analytics = await this.calculateRegionAnalytics(region, today);

      // Upsert analytics record
      await prisma.marketAnalytics.upsert({
        where: {
          period_periodType_region_route: {
            period,
            periodType: 'DAY',
            region,
            route: null,
          },
        },
        update: analytics,
        create: {
          period,
          periodType: 'DAY',
          region,
          route: null,
          ...analytics,
        },
      });
    }
  }

  /**
   * Calculate analytics for a region
   */
  private async calculateRegionAnalytics(
    region: string,
    date: Date
  ): Promise<Partial<MarketAnalytics>> {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);

    const [posts, bids, completed, avgPrice] = await Promise.all([
      prisma.freightPost.count({
        where: {
          pickupLocation: { contains: region, mode: 'insensitive' },
          createdAt: { gte: startOfDay },
        },
      }),
      prisma.bid.count({
        where: {
          createdAt: { gte: startOfDay },
          freightPost: {
            pickupLocation: { contains: region, mode: 'insensitive' },
          },
        },
      }),
      prisma.freightJob.count({
        where: {
          status: { in: ['COMPLETED', 'DELIVERED'] },
          createdAt: { gte: startOfDay },
        },
      }),
      prisma.bid.aggregate({
        where: {
          createdAt: { gte: startOfDay },
        },
        _avg: { amount: true },
      }),
    ]);

    // Calculate demand/supply indices
    const demandIndex = Math.min(posts * 2, 100);
    const supplyIndex = Math.min(bids * 1.5, 100);

    return {
      avgPrice: avgPrice._avg.amount || 0,
      demandIndex,
      supplyIndex,
      totalPosts: posts,
      totalBids: bids,
      completedJobs: completed,
    };
  }
}

// Export singleton instances
export const demandPredictionService = new DemandPredictionService();
export const fraudDetectionService = new FraudDetectionService();
export const priceRecommendationService = new PriceRecommendationService();
export const analyticsService = new AnalyticsService();
