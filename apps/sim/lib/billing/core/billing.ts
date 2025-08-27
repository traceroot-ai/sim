import { and, eq } from 'drizzle-orm'
import { getHighestPrioritySubscription } from '@/lib/billing/core/subscription'
import { getUserUsageData } from '@/lib/billing/core/usage'
import { requireStripeClient } from '@/lib/billing/stripe-client'
import {
  getEnterpriseTierLimitPerSeat,
  getFreeTierLimit,
  getProTierLimit,
  getTeamTierLimitPerSeat,
} from '@/lib/billing/subscriptions/utils'
import type { EnterpriseSubscriptionMetadata } from '@/lib/billing/types'
import { createLogger } from '@/lib/logs/console/logger'
import { db } from '@/db'
import { member, organization, subscription, user } from '@/db/schema'

const logger = createLogger('Billing')

/**
 * Get organization subscription directly by organization ID
 */
export async function getOrganizationSubscription(organizationId: string) {
  try {
    const orgSubs = await db
      .select()
      .from(subscription)
      .where(and(eq(subscription.referenceId, organizationId), eq(subscription.status, 'active')))
      .limit(1)

    return orgSubs.length > 0 ? orgSubs[0] : null
  } catch (error) {
    logger.error('Error getting organization subscription', { error, organizationId })
    return null
  }
}

interface BillingResult {
  success: boolean
  chargedAmount?: number
  invoiceId?: string
  error?: string
}

/**
 * BILLING MODEL:
 * 1. User purchases $20 Pro plan → Gets charged $20 immediately via Stripe subscription
 * 2. User uses $15 during the month → No additional charge (covered by $20)
 * 3. User uses $35 during the month → Gets charged $15 overage at month end
 * 4. Usage resets, next month they pay $20 again + any overages
 */

/**
 * Get plan pricing information
 */
export function getPlanPricing(
  plan: string,
  subscription?: any
): {
  basePrice: number // What they pay upfront via Stripe subscription (per seat for team/enterprise)
} {
  switch (plan) {
    case 'free':
      return { basePrice: 0 } // Free plan has no charges
    case 'pro':
      return { basePrice: getProTierLimit() }
    case 'team':
      return { basePrice: getTeamTierLimitPerSeat() }
    case 'enterprise':
      // Enterprise uses per-seat pricing like Team plans
      // Custom per-seat price can be set in metadata
      if (subscription?.metadata) {
        const metadata: EnterpriseSubscriptionMetadata =
          typeof subscription.metadata === 'string'
            ? JSON.parse(subscription.metadata)
            : subscription.metadata

        const perSeatPrice = metadata.perSeatPrice
          ? Number.parseFloat(String(metadata.perSeatPrice))
          : undefined
        if (perSeatPrice && perSeatPrice > 0 && !Number.isNaN(perSeatPrice)) {
          return { basePrice: perSeatPrice }
        }
      }
      // Default enterprise per-seat pricing
      return { basePrice: getEnterpriseTierLimitPerSeat() }
    default:
      return { basePrice: 0 }
  }
}

/**
 * Get Stripe customer ID for a user or organization
 */
async function getStripeCustomerId(referenceId: string): Promise<string | null> {
  try {
    // First check if it's a user
    const userRecord = await db
      .select({ stripeCustomerId: user.stripeCustomerId })
      .from(user)
      .where(eq(user.id, referenceId))
      .limit(1)

    if (userRecord.length > 0 && userRecord[0].stripeCustomerId) {
      return userRecord[0].stripeCustomerId
    }

    // Check if it's an organization
    const orgRecord = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, referenceId))
      .limit(1)

    if (orgRecord.length > 0) {
      // Organizations don't have their own Stripe customers
      // Pattern: subscriptions stay with user, referenceId = orgId
      const ownerRecord = await db
        .select({
          stripeCustomerId: user.stripeCustomerId,
          userId: user.id,
        })
        .from(user)
        .innerJoin(member, eq(member.userId, user.id))
        .where(and(eq(member.organizationId, referenceId), eq(member.role, 'owner')))
        .limit(1)

      if (ownerRecord.length > 0 && ownerRecord[0].stripeCustomerId) {
        logger.debug('Using organization owner Stripe customer for billing', {
          organizationId: referenceId,
          ownerId: ownerRecord[0].userId,
          stripeCustomerId: ownerRecord[0].stripeCustomerId,
        })
        return ownerRecord[0].stripeCustomerId
      }

      logger.warn('No Stripe customer found for organization or its owner', {
        organizationId: referenceId,
      })
    }

    return null
  } catch (error) {
    logger.error('Failed to get Stripe customer ID', { referenceId, error })
    return null
  }
}

/**
 * Create a Stripe invoice for overage billing only
 */
export async function createOverageBillingInvoice(
  customerId: string,
  overageAmount: number,
  description: string,
  metadata: Record<string, string> = {}
): Promise<BillingResult> {
  try {
    if (overageAmount <= 0) {
      logger.info('No overage to bill', { customerId, overageAmount })
      return { success: true, chargedAmount: 0 }
    }

    const stripeClient = requireStripeClient()

    // Check for existing overage invoice for this billing period
    const billingPeriod = metadata.billingPeriod || new Date().toISOString().slice(0, 7)

    // Get the start of the billing period month for filtering
    const periodStart = new Date(`${billingPeriod}-01`)
    const periodStartTimestamp = Math.floor(periodStart.getTime() / 1000)

    // Look for invoices created in the last 35 days to cover month boundaries
    const recentInvoices = await stripeClient.invoices.list({
      customer: customerId,
      created: {
        gte: periodStartTimestamp,
      },
      limit: 100,
    })

    // Check if we already have an overage invoice for this period
    const existingOverageInvoice = recentInvoices.data.find(
      (invoice) =>
        invoice.metadata?.type === 'overage_billing' &&
        invoice.metadata?.billingPeriod === billingPeriod &&
        invoice.status !== 'void' // Ignore voided invoices
    )

    if (existingOverageInvoice) {
      logger.warn('Overage invoice already exists for this billing period', {
        customerId,
        billingPeriod,
        existingInvoiceId: existingOverageInvoice.id,
        existingInvoiceStatus: existingOverageInvoice.status,
        existingAmount: existingOverageInvoice.amount_due / 100,
      })

      // Return success but with no charge to prevent duplicate billing
      return {
        success: true,
        chargedAmount: 0,
        invoiceId: existingOverageInvoice.id,
      }
    }

    // Get customer to ensure they have an email set
    const customer = await stripeClient.customers.retrieve(customerId)
    if (!('email' in customer) || !customer.email) {
      logger.warn('Customer does not have an email set, Stripe will not send automatic emails', {
        customerId,
      })
    }

    const invoiceItem = await stripeClient.invoiceItems.create({
      customer: customerId,
      amount: Math.round(overageAmount * 100), // Convert to cents
      currency: 'usd',
      description,
      metadata: {
        ...metadata,
        type: 'overage_billing',
      },
    })

    logger.info('Created overage invoice item', {
      customerId,
      amount: overageAmount,
      invoiceItemId: invoiceItem.id,
    })

    // Create invoice that will include the invoice item
    const invoice = await stripeClient.invoices.create({
      customer: customerId,
      auto_advance: true, // Automatically finalize
      collection_method: 'charge_automatically', // Charge immediately
      metadata: {
        ...metadata,
        type: 'overage_billing',
      },
      description,
      pending_invoice_items_behavior: 'include', // Explicitly include pending items
      payment_settings: {
        payment_method_types: ['card'], // Accept card payments
      },
    })

    logger.info('Created overage invoice', {
      customerId,
      invoiceId: invoice.id,
      amount: overageAmount,
      status: invoice.status,
    })

    // If invoice is still draft (shouldn't happen with auto_advance), finalize it
    let finalInvoice = invoice
    if (invoice.status === 'draft') {
      logger.warn('Invoice created as draft, manually finalizing', { invoiceId: invoice.id })
      finalInvoice = await stripeClient.invoices.finalizeInvoice(invoice.id)
      logger.info('Manually finalized invoice', {
        invoiceId: finalInvoice.id,
        status: finalInvoice.status,
      })
    }

    // If invoice is open (finalized but not paid), attempt to pay it
    if (finalInvoice.status === 'open') {
      try {
        logger.info('Attempting to pay open invoice', { invoiceId: finalInvoice.id })
        const paidInvoice = await stripeClient.invoices.pay(finalInvoice.id)
        logger.info('Successfully paid invoice', {
          invoiceId: paidInvoice.id,
          status: paidInvoice.status,
          amountPaid: paidInvoice.amount_paid / 100,
        })
        finalInvoice = paidInvoice
      } catch (paymentError) {
        logger.error('Failed to automatically pay invoice', {
          invoiceId: finalInvoice.id,
          error: paymentError,
        })
        // Don't fail the whole operation if payment fails
        // Stripe will retry and send payment failure notifications
      }
    }

    // Log final invoice status
    logger.info('Invoice processing complete', {
      customerId,
      invoiceId: finalInvoice.id,
      chargedAmount: overageAmount,
      description,
      status: finalInvoice.status,
      paymentAttempted: finalInvoice.status === 'paid' || finalInvoice.attempted,
    })

    return {
      success: true,
      chargedAmount: overageAmount,
      invoiceId: finalInvoice.id,
    }
  } catch (error) {
    logger.error('Failed to create overage billing invoice', {
      customerId,
      overageAmount,
      description,
      error,
    })

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    }
  }
}

/**
 * Calculate overage billing for a user
 * Returns only the amount that exceeds their subscription base price
 */
export async function calculateUserOverage(userId: string): Promise<{
  basePrice: number
  actualUsage: number
  overageAmount: number
  plan: string
} | null> {
  try {
    // Get user's subscription and usage data
    const [subscription, usageData, userRecord] = await Promise.all([
      getHighestPrioritySubscription(userId),
      getUserUsageData(userId),
      db.select().from(user).where(eq(user.id, userId)).limit(1),
    ])

    if (userRecord.length === 0) {
      logger.warn('User not found for overage calculation', { userId })
      return null
    }

    const plan = subscription?.plan || 'free'
    const { basePrice } = getPlanPricing(plan, subscription)
    const actualUsage = usageData.currentUsage

    // Calculate overage: any usage beyond what they already paid for
    const overageAmount = Math.max(0, actualUsage - basePrice)

    return {
      basePrice,
      actualUsage,
      overageAmount,
      plan,
    }
  } catch (error) {
    logger.error('Failed to calculate user overage', { userId, error })
    return null
  }
}

/**
 * Process overage billing for an individual user
 */
export async function processUserOverageBilling(userId: string): Promise<BillingResult> {
  try {
    const overageInfo = await calculateUserOverage(userId)

    if (!overageInfo) {
      return { success: false, error: 'Failed to calculate overage information' }
    }

    // Skip billing for free plan users
    if (overageInfo.plan === 'free') {
      logger.info('Skipping overage billing for free plan user', { userId })
      return { success: true, chargedAmount: 0 }
    }

    // Skip if no overage
    if (overageInfo.overageAmount <= 0) {
      logger.info('No overage to bill for user', {
        userId,
        basePrice: overageInfo.basePrice,
        actualUsage: overageInfo.actualUsage,
      })
      return { success: true, chargedAmount: 0 }
    }

    // Get Stripe customer ID
    const stripeCustomerId = await getStripeCustomerId(userId)
    if (!stripeCustomerId) {
      logger.error('No Stripe customer ID found for user', { userId })
      return { success: false, error: 'No Stripe customer ID found' }
    }

    // Get user email to ensure Stripe customer has it set
    const userRecord = await db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1)

    if (userRecord[0]?.email) {
      // Update Stripe customer with email if needed
      const stripeClient = requireStripeClient()
      try {
        await stripeClient.customers.update(stripeCustomerId, {
          email: userRecord[0].email,
        })
        logger.info('Updated Stripe customer with email', {
          userId,
          stripeCustomerId,
          email: userRecord[0].email,
        })
      } catch (updateError) {
        logger.warn('Failed to update Stripe customer email', {
          userId,
          stripeCustomerId,
          error: updateError,
        })
      }
    }

    const description = `Usage overage for ${overageInfo.plan} plan - $${overageInfo.overageAmount.toFixed(2)} above $${overageInfo.basePrice} base`
    const metadata = {
      userId,
      plan: overageInfo.plan,
      basePrice: overageInfo.basePrice.toString(),
      actualUsage: overageInfo.actualUsage.toString(),
      overageAmount: overageInfo.overageAmount.toString(),
      billingPeriod: new Date().toISOString().slice(0, 7), // YYYY-MM format
    }

    const result = await createOverageBillingInvoice(
      stripeCustomerId,
      overageInfo.overageAmount,
      description,
      metadata
    )

    // Do not reset here. Reset only happens in invoice.payment_succeeded handler.

    return result
  } catch (error) {
    logger.error('Failed to process user overage billing', { userId, error })
    return { success: false, error: 'Failed to process overage billing' }
  }
}

/**
 * Process overage billing for an organization (team/enterprise plans)
 */
export async function processOrganizationOverageBilling(
  organizationId: string
): Promise<BillingResult> {
  try {
    // Get organization subscription directly (referenceId = organizationId)
    const subscription = await getOrganizationSubscription(organizationId)

    if (!subscription || !['team', 'enterprise'].includes(subscription.plan)) {
      logger.warn('No team/enterprise subscription found for organization', { organizationId })
      return { success: false, error: 'No valid subscription found' }
    }

    // Get organization's Stripe customer ID
    const stripeCustomerId = await getStripeCustomerId(organizationId)
    if (!stripeCustomerId) {
      logger.error('No Stripe customer ID found for organization', { organizationId })
      return { success: false, error: 'No Stripe customer ID found' }
    }

    // Get organization owner's email for billing
    const orgOwner = await db
      .select({
        userId: member.userId,
        userEmail: user.email,
      })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(and(eq(member.organizationId, organizationId), eq(member.role, 'owner')))
      .limit(1)

    if (orgOwner[0]?.userEmail) {
      // Update Stripe customer with organization owner's email
      const stripeClient = requireStripeClient()
      try {
        await stripeClient.customers.update(stripeCustomerId, {
          email: orgOwner[0].userEmail,
        })
        logger.info('Updated Stripe customer with organization owner email', {
          organizationId,
          stripeCustomerId,
          email: orgOwner[0].userEmail,
        })
      } catch (updateError) {
        logger.warn('Failed to update Stripe customer email for organization', {
          organizationId,
          stripeCustomerId,
          error: updateError,
        })
      }
    }

    // Get all organization members
    const members = await db
      .select({
        userId: member.userId,
        userName: user.name,
        userEmail: user.email,
      })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(eq(member.organizationId, organizationId))

    if (members.length === 0) {
      logger.info('No members found for organization overage billing', { organizationId })
      return { success: true, chargedAmount: 0 }
    }

    // Calculate total team usage across all members
    const { basePrice: basePricePerSeat } = getPlanPricing(subscription.plan, subscription)
    // Use licensed seats from Stripe as source of truth for billing
    const licensedSeats = subscription.seats || 1 // Default to 1 if not set
    const baseSubscriptionAmount = licensedSeats * basePricePerSeat // What Stripe is charging for

    let totalTeamUsage = 0
    const memberUsageDetails = []

    for (const memberInfo of members) {
      const usageData = await getUserUsageData(memberInfo.userId)
      totalTeamUsage += usageData.currentUsage

      memberUsageDetails.push({
        userId: memberInfo.userId,
        name: memberInfo.userName,
        email: memberInfo.userEmail,
        usage: usageData.currentUsage,
      })
    }

    // Calculate team-level overage: total usage beyond what was already paid to Stripe
    const totalOverage = Math.max(0, totalTeamUsage - baseSubscriptionAmount)
    logger.info('Organization overage calculation', {
      organizationId,
      licensedSeats,
      basePricePerSeat,
      baseSubscriptionAmount,
      totalTeamUsage,
      totalOverage,
      memberUsageDetails,
    })

    // Skip if no overage across the organization
    if (totalOverage <= 0) {
      logger.info('No overage to bill for organization', {
        organizationId,
        memberCount: members.length,
        totalTeamUsage,
        baseSubscriptionAmount,
      })
      // Do not reset here. Reset happens only in invoice.payment_succeeded.
      return { success: true, chargedAmount: 0 }
    }

    // Create consolidated overage invoice for the organization
    const description = `Team usage overage for ${subscription.plan} plan - ${licensedSeats} licensed seats, $${totalTeamUsage.toFixed(2)} total usage, $${totalOverage.toFixed(2)} overage`
    const metadata = {
      organizationId,
      plan: subscription.plan,
      licensedSeats: licensedSeats.toString(),
      memberCount: members.length.toString(),
      basePricePerSeat: basePricePerSeat.toString(),
      baseSubscriptionAmount: baseSubscriptionAmount.toString(),
      totalTeamUsage: totalTeamUsage.toString(),
      totalOverage: totalOverage.toString(),
      billingPeriod: new Date().toISOString().slice(0, 7), // YYYY-MM format
      memberDetails: JSON.stringify(memberUsageDetails),
    }

    const result = await createOverageBillingInvoice(
      stripeCustomerId,
      totalOverage,
      description,
      metadata
    )

    // Do not reset here. Reset happens only in invoice.payment_succeeded.

    logger.info('Processed organization overage billing', {
      organizationId,
      memberCount: members.length,
      totalOverage,
      result,
    })

    return result
  } catch (error) {
    logger.error('Failed to process organization overage billing', { organizationId, error })
    return { success: false, error: 'Failed to process organization overage billing' }
  }
}

/**
 * Get comprehensive billing and subscription summary
 */
export async function getSimplifiedBillingSummary(
  userId: string,
  organizationId?: string
): Promise<{
  type: 'individual' | 'organization'
  plan: string
  basePrice: number
  currentUsage: number
  overageAmount: number
  totalProjected: number
  usageLimit: number
  percentUsed: number
  isWarning: boolean
  isExceeded: boolean
  daysRemaining: number
  // Subscription details
  isPaid: boolean
  isPro: boolean
  isTeam: boolean
  isEnterprise: boolean
  status: string | null
  seats: number | null
  metadata: any
  stripeSubscriptionId: string | null
  periodEnd: Date | string | null
  // Usage details
  usage: {
    current: number
    limit: number
    percentUsed: number
    isWarning: boolean
    isExceeded: boolean
    billingPeriodStart: Date | null
    billingPeriodEnd: Date | null
    lastPeriodCost: number
    daysRemaining: number
  }
  organizationData?: {
    seatCount: number
    memberCount: number
    totalBasePrice: number
    totalCurrentUsage: number
    totalOverage: number
  }
}> {
  try {
    // Get subscription and usage data upfront
    const [subscription, usageData] = await Promise.all([
      organizationId
        ? getOrganizationSubscription(organizationId)
        : getHighestPrioritySubscription(userId),
      getUserUsageData(userId),
    ])

    // Determine subscription type flags
    const plan = subscription?.plan || 'free'
    const isPaid = plan !== 'free'
    const isPro = plan === 'pro'
    const isTeam = plan === 'team'
    const isEnterprise = plan === 'enterprise'

    if (organizationId) {
      // Organization billing summary
      if (!subscription) {
        return getDefaultBillingSummary('organization')
      }

      // Get all organization members
      const members = await db
        .select({ userId: member.userId })
        .from(member)
        .where(eq(member.organizationId, organizationId))

      const { basePrice: basePricePerSeat } = getPlanPricing(subscription.plan, subscription)
      // Use licensed seats from Stripe as source of truth
      const licensedSeats = subscription.seats || 1
      const totalBasePrice = basePricePerSeat * licensedSeats // Based on Stripe subscription

      let totalCurrentUsage = 0

      // Calculate total team usage across all members
      for (const memberInfo of members) {
        const memberUsageData = await getUserUsageData(memberInfo.userId)
        totalCurrentUsage += memberUsageData.currentUsage
      }

      // Calculate team-level overage: total usage beyond what was already paid to Stripe
      const totalOverage = Math.max(0, totalCurrentUsage - totalBasePrice)

      // Get user's personal limits for warnings
      const percentUsed =
        usageData.limit > 0 ? Math.round((usageData.currentUsage / usageData.limit) * 100) : 0

      // Calculate days remaining in billing period
      const daysRemaining = usageData.billingPeriodEnd
        ? Math.max(
            0,
            Math.ceil((usageData.billingPeriodEnd.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
          )
        : 0

      return {
        type: 'organization',
        plan: subscription.plan,
        basePrice: totalBasePrice,
        currentUsage: totalCurrentUsage,
        overageAmount: totalOverage,
        totalProjected: totalBasePrice + totalOverage,
        usageLimit: usageData.limit,
        percentUsed,
        isWarning: percentUsed >= 80 && percentUsed < 100,
        isExceeded: usageData.currentUsage >= usageData.limit,
        daysRemaining,
        // Subscription details
        isPaid,
        isPro,
        isTeam,
        isEnterprise,
        status: subscription.status || null,
        seats: subscription.seats || null,
        metadata: subscription.metadata || null,
        stripeSubscriptionId: subscription.stripeSubscriptionId || null,
        periodEnd: subscription.periodEnd || null,
        // Usage details
        usage: {
          current: usageData.currentUsage,
          limit: usageData.limit,
          percentUsed,
          isWarning: percentUsed >= 80 && percentUsed < 100,
          isExceeded: usageData.currentUsage >= usageData.limit,
          billingPeriodStart: usageData.billingPeriodStart,
          billingPeriodEnd: usageData.billingPeriodEnd,
          lastPeriodCost: usageData.lastPeriodCost,
          daysRemaining,
        },
        organizationData: {
          seatCount: licensedSeats,
          memberCount: members.length,
          totalBasePrice,
          totalCurrentUsage,
          totalOverage,
        },
      }
    }

    // Individual billing summary
    const { basePrice } = getPlanPricing(plan, subscription)

    // For team and enterprise plans, calculate total team usage instead of individual usage
    let currentUsage = usageData.currentUsage
    if ((isTeam || isEnterprise) && subscription?.referenceId) {
      // Get all team members and sum their usage
      const teamMembers = await db
        .select({ userId: member.userId })
        .from(member)
        .where(eq(member.organizationId, subscription.referenceId))

      let totalTeamUsage = 0
      for (const teamMember of teamMembers) {
        const memberUsageData = await getUserUsageData(teamMember.userId)
        totalTeamUsage += memberUsageData.currentUsage
      }
      currentUsage = totalTeamUsage
    }

    const overageAmount = Math.max(0, currentUsage - basePrice)
    const percentUsed = usageData.limit > 0 ? Math.round((currentUsage / usageData.limit) * 100) : 0

    // Calculate days remaining in billing period
    const daysRemaining = usageData.billingPeriodEnd
      ? Math.max(
          0,
          Math.ceil((usageData.billingPeriodEnd.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        )
      : 0

    return {
      type: 'individual',
      plan,
      basePrice,
      currentUsage: currentUsage,
      overageAmount,
      totalProjected: basePrice + overageAmount,
      usageLimit: usageData.limit,
      percentUsed,
      isWarning: percentUsed >= 80 && percentUsed < 100,
      isExceeded: currentUsage >= usageData.limit,
      daysRemaining,
      // Subscription details
      isPaid,
      isPro,
      isTeam,
      isEnterprise,
      status: subscription?.status || null,
      seats: subscription?.seats || null,
      metadata: subscription?.metadata || null,
      stripeSubscriptionId: subscription?.stripeSubscriptionId || null,
      periodEnd: subscription?.periodEnd || null,
      // Usage details
      usage: {
        current: currentUsage,
        limit: usageData.limit,
        percentUsed,
        isWarning: percentUsed >= 80 && percentUsed < 100,
        isExceeded: currentUsage >= usageData.limit,
        billingPeriodStart: usageData.billingPeriodStart,
        billingPeriodEnd: usageData.billingPeriodEnd,
        lastPeriodCost: usageData.lastPeriodCost,
        daysRemaining,
      },
    }
  } catch (error) {
    logger.error('Failed to get simplified billing summary', { userId, organizationId, error })
    return getDefaultBillingSummary(organizationId ? 'organization' : 'individual')
  }
}

/**
 * Get default billing summary for error cases
 */
function getDefaultBillingSummary(type: 'individual' | 'organization') {
  return {
    type,
    plan: 'free',
    basePrice: 0,
    currentUsage: 0,
    overageAmount: 0,
    totalProjected: 0,
    usageLimit: getFreeTierLimit(),
    percentUsed: 0,
    isWarning: false,
    isExceeded: false,
    daysRemaining: 0,
    // Subscription details
    isPaid: false,
    isPro: false,
    isTeam: false,
    isEnterprise: false,
    status: null,
    seats: null,
    metadata: null,
    stripeSubscriptionId: null,
    periodEnd: null,
    // Usage details
    usage: {
      current: 0,
      limit: getFreeTierLimit(),
      percentUsed: 0,
      isWarning: false,
      isExceeded: false,
      billingPeriodStart: null,
      billingPeriodEnd: null,
      lastPeriodCost: 0,
      daysRemaining: 0,
    },
  }
}
