import { DEFAULT_FREE_CREDITS } from '@/lib/billing/constants'
import { env } from '@/lib/env'

export interface BillingPlan {
  name: string
  priceId: string
  limits: {
    cost: number
  }
}

/**
 * Get the billing plans configuration for Better Auth Stripe plugin
 */
export function getPlans(): BillingPlan[] {
  return [
    {
      name: 'free',
      priceId: env.STRIPE_FREE_PRICE_ID || '',
      limits: {
        cost: env.FREE_TIER_COST_LIMIT ?? DEFAULT_FREE_CREDITS,
      },
    },
    {
      name: 'pro',
      priceId: env.STRIPE_PRO_PRICE_ID || '',
      limits: {
        cost: env.PRO_TIER_COST_LIMIT ?? 20,
      },
    },
    {
      name: 'team',
      priceId: env.STRIPE_TEAM_PRICE_ID || '',
      limits: {
        cost: env.TEAM_TIER_COST_LIMIT ?? 40, // $40 per seat
      },
    },
  ]
}

/**
 * Get a specific plan by name
 */
export function getPlanByName(planName: string): BillingPlan | undefined {
  return getPlans().find((plan) => plan.name === planName)
}

/**
 * Get plan limits for a given plan name
 */
export function getPlanLimits(planName: string): number {
  const plan = getPlanByName(planName)
  return plan?.limits.cost ?? DEFAULT_FREE_CREDITS
}
