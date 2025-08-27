import { eq } from 'drizzle-orm'
import type Stripe from 'stripe'
import { getUserUsageData } from '@/lib/billing/core/usage'
import { requireStripeClient } from '@/lib/billing/stripe-client'
import { createLogger } from '@/lib/logs/console/logger'
import { db } from '@/db'
import { member, subscription as subscriptionTable, userStats } from '@/db/schema'

const logger = createLogger('StripeInvoiceWebhooks')

/**
 * Handle invoice payment succeeded webhook
 * This is triggered when a user successfully pays a usage billing invoice
 */
export async function handleInvoicePaymentSucceeded(event: Stripe.Event) {
  try {
    const invoice = event.data.object as Stripe.Invoice

    // Case 1: Overage invoices (metadata.type === 'overage_billing')
    if (invoice.metadata?.type === 'overage_billing') {
      const customerId = invoice.customer as string
      const chargedAmount = invoice.amount_paid / 100
      const billingPeriod = invoice.metadata?.billingPeriod || 'unknown'

      logger.info('Overage billing invoice payment succeeded', {
        invoiceId: invoice.id,
        customerId,
        chargedAmount,
        billingPeriod,
        customerEmail: invoice.customer_email,
        hostedInvoiceUrl: invoice.hosted_invoice_url,
      })

      return
    }

    // Case 2: Subscription renewal invoice paid (primary period rollover)
    // Compute overage at payment time, then reset usage
    if (invoice.subscription) {
      // Filter to subscription-cycle renewals only; ignore updates/off-cycle charges
      const reason = invoice.billing_reason
      const isCycle = reason === 'subscription_cycle'
      if (!isCycle) {
        logger.info('Ignoring non-cycle subscription invoice on payment_succeeded', {
          invoiceId: invoice.id,
          billingReason: reason,
        })
        return
      }

      const stripeSubscriptionId = String(invoice.subscription)
      const records = await db
        .select()
        .from(subscriptionTable)
        .where(eq(subscriptionTable.stripeSubscriptionId, stripeSubscriptionId))
        .limit(1)

      if (records.length === 0) {
        logger.warn('No matching internal subscription for paid Stripe invoice', {
          invoiceId: invoice.id,
          stripeSubscriptionId,
        })
        return
      }

      const sub = records[0]

      // Reset usage counters
      if (sub.plan === 'team' || sub.plan === 'enterprise') {
        // Reset billing period for all organization members
        const members = await db
          .select({ userId: member.userId })
          .from(member)
          .where(eq(member.organizationId, sub.referenceId))

        for (const memberRecord of members) {
          const currentStats = await db
            .select({ currentPeriodCost: userStats.currentPeriodCost })
            .from(userStats)
            .where(eq(userStats.userId, memberRecord.userId))
            .limit(1)

          if (currentStats.length > 0) {
            const currentPeriodCost = currentStats[0].currentPeriodCost || '0'
            await db
              .update(userStats)
              .set({
                lastPeriodCost: currentPeriodCost,
                currentPeriodCost: '0',
              })
              .where(eq(userStats.userId, memberRecord.userId))
          }
        }

        logger.info('Reset organization billing period on subscription invoice payment', {
          invoiceId: invoice.id,
          organizationId: sub.referenceId,
          plan: sub.plan,
          memberCount: members.length,
        })
      } else {
        // Reset billing period for individual user
        const currentStats = await db
          .select({ currentPeriodCost: userStats.currentPeriodCost })
          .from(userStats)
          .where(eq(userStats.userId, sub.referenceId))
          .limit(1)

        if (currentStats.length > 0) {
          const currentPeriodCost = currentStats[0].currentPeriodCost || '0'
          await db
            .update(userStats)
            .set({
              lastPeriodCost: currentPeriodCost,
              currentPeriodCost: '0',
            })
            .where(eq(userStats.userId, sub.referenceId))
        }

        logger.info('Reset user billing period on subscription invoice payment', {
          invoiceId: invoice.id,
          userId: sub.referenceId,
          plan: sub.plan,
        })
      }

      return
    }

    logger.info('Ignoring non-subscription invoice payment', { invoiceId: invoice.id })
  } catch (error) {
    logger.error('Failed to handle invoice payment succeeded', {
      eventId: event.id,
      error,
    })
    throw error // Re-throw to signal webhook failure
  }
}

/**
 * Handle invoice payment failed webhook
 * This is triggered when a user's payment fails for a usage billing invoice
 */
export async function handleInvoicePaymentFailed(event: Stripe.Event) {
  try {
    const invoice = event.data.object as Stripe.Invoice

    // Check if this is an overage billing invoice
    if (invoice.metadata?.type !== 'overage_billing') {
      logger.info('Ignoring non-overage billing invoice payment failure', { invoiceId: invoice.id })
      return
    }

    const customerId = invoice.customer as string
    const failedAmount = invoice.amount_due / 100 // Convert from cents to dollars
    const billingPeriod = invoice.metadata?.billingPeriod || 'unknown'
    const attemptCount = invoice.attempt_count || 1

    logger.warn('Overage billing invoice payment failed', {
      invoiceId: invoice.id,
      customerId,
      failedAmount,
      billingPeriod,
      attemptCount,
      customerEmail: invoice.customer_email,
      hostedInvoiceUrl: invoice.hosted_invoice_url,
    })

    // Implement dunning management logic here
    // For example: suspend service after multiple failures, notify admins, etc.
    if (attemptCount >= 3) {
      logger.error('Multiple payment failures for overage billing', {
        invoiceId: invoice.id,
        customerId,
        attemptCount,
      })

      // Could implement service suspension here
      // await suspendUserService(customerId)
    }
  } catch (error) {
    logger.error('Failed to handle invoice payment failed', {
      eventId: event.id,
      error,
    })
    throw error // Re-throw to signal webhook failure
  }
}

export async function handleInvoiceUpcoming(event: Stripe.Event) {
  try {
    const invoice = event.data.object as Stripe.Invoice

    if (!invoice.subscription) {
      logger.info('Ignoring upcoming invoice without subscription')
      return
    }

    const stripeSubscriptionId = String(invoice.subscription)
    const records = await db
      .select()
      .from(subscriptionTable)
      .where(eq(subscriptionTable.stripeSubscriptionId, stripeSubscriptionId))
      .limit(1)

    if (records.length === 0) {
      logger.warn('No matching internal subscription for upcoming invoice', {
        stripeSubscriptionId,
      })
      return
    }

    const sub = records[0]

    // Helper to add an overage invoice item with idempotency
    async function addOverageItem(
      customerId: string,
      subscriptionId: string,
      amountDollars: number,
      metadata: Record<string, string>
    ) {
      const stripe = requireStripeClient()
      const billingPeriod = new Date().toISOString().slice(0, 7)
      await stripe.invoiceItems.create(
        {
          customer: customerId,
          subscription: subscriptionId,
          amount: Math.round(amountDollars * 100),
          currency: 'usd',
          description: `Overage for ${billingPeriod}`,
          metadata: { type: 'overage_billing', billingPeriod, ...metadata },
        },
        { idempotencyKey: `${customerId}:${subscriptionId}:${billingPeriod}:overage` }
      )
    }

    // Organization: sum member usage; Individual: single user
    if (sub.plan === 'team' || sub.plan === 'enterprise') {
      const members = await db
        .select({ userId: member.userId })
        .from(member)
        .where(eq(member.organizationId, sub.referenceId))

      let totalTeamUsage = 0
      for (const m of members) {
        const usage = await getUserUsageData(m.userId)
        totalTeamUsage += usage.currentUsage
      }

      const licensedSeats = sub.seats || 1
      const { getPlanPricing } = await import('@/lib/billing/core/billing')
      const { basePrice } = getPlanPricing(sub.plan, sub)
      const baseSubscriptionAmount = licensedSeats * basePrice
      const totalOverage = Math.max(0, totalTeamUsage - baseSubscriptionAmount)

      logger.info('Invoice upcoming overage calculation (org)', {
        organizationId: sub.referenceId,
        totalTeamUsage,
        licensedSeats,
        basePricePerSeat: basePrice,
        baseSubscriptionAmount,
        totalOverage,
      })

      if (totalOverage > 0) {
        await addOverageItem(invoice.customer as string, stripeSubscriptionId, totalOverage, {
          organizationId: sub.referenceId,
        })
        logger.info('Added overage invoice item to upcoming invoice (org)', {
          organizationId: sub.referenceId,
          totalOverage,
        })
      }
    } else {
      const usage = await getUserUsageData(sub.referenceId)
      const { getPlanPricing } = await import('@/lib/billing/core/billing')
      const { basePrice } = getPlanPricing(sub.plan, sub)
      const overage = Math.max(0, usage.currentUsage - basePrice)

      if (overage > 0) {
        await addOverageItem(invoice.customer as string, stripeSubscriptionId, overage, {
          userId: sub.referenceId,
        })
        logger.info('Added overage invoice item to upcoming invoice (user)', {
          userId: sub.referenceId,
          overage,
        })
      }
    }
  } catch (error) {
    logger.error('Failed to handle invoice upcoming', { error })
    throw error
  }
}
