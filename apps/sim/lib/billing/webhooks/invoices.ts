import { eq } from 'drizzle-orm'
import type Stripe from 'stripe'
import { getUserUsageData } from '@/lib/billing/core/usage'
import { requireStripeClient } from '@/lib/billing/stripe-client'
import { createLogger } from '@/lib/logs/console/logger'
import { db } from '@/db'
import { member, subscription as subscriptionTable, userStats } from '@/db/schema'

const logger = createLogger('StripeInvoiceWebhooks')

async function resetUsageForSubscription(sub: { plan: string | null; referenceId: string }) {
  if (sub.plan === 'team' || sub.plan === 'enterprise') {
    const membersRows = await db
      .select({ userId: member.userId })
      .from(member)
      .where(eq(member.organizationId, sub.referenceId))

    for (const m of membersRows) {
      const currentStats = await db
        .select({ current: userStats.currentPeriodCost })
        .from(userStats)
        .where(eq(userStats.userId, m.userId))
        .limit(1)
      if (currentStats.length > 0) {
        const current = currentStats[0].current || '0'
        await db
          .update(userStats)
          .set({ lastPeriodCost: current, currentPeriodCost: '0' })
          .where(eq(userStats.userId, m.userId))
      }
    }
  } else {
    const currentStats = await db
      .select({ current: userStats.currentPeriodCost })
      .from(userStats)
      .where(eq(userStats.userId, sub.referenceId))
      .limit(1)
    if (currentStats.length > 0) {
      const current = currentStats[0].current || '0'
      await db
        .update(userStats)
        .set({ lastPeriodCost: current, currentPeriodCost: '0' })
        .where(eq(userStats.userId, sub.referenceId))
    }
  }
}

/**
 * Handle invoice payment succeeded webhook
 * We unblock any previously blocked users for this subscription.
 */
export async function handleInvoicePaymentSucceeded(event: Stripe.Event) {
  try {
    const invoice = event.data.object as Stripe.Invoice

    if (!invoice.subscription) return
    const stripeSubscriptionId = String(invoice.subscription)
    const records = await db
      .select()
      .from(subscriptionTable)
      .where(eq(subscriptionTable.stripeSubscriptionId, stripeSubscriptionId))
      .limit(1)

    if (records.length === 0) return
    const sub = records[0]

    // Only reset usage here if the tenant was previously blocked; otherwise invoice.created already reset it
    let wasBlocked = false
    if (sub.plan === 'team' || sub.plan === 'enterprise') {
      const membersRows = await db
        .select({ userId: member.userId })
        .from(member)
        .where(eq(member.organizationId, sub.referenceId))
      for (const m of membersRows) {
        const row = await db
          .select({ blocked: userStats.billingBlocked })
          .from(userStats)
          .where(eq(userStats.userId, m.userId))
          .limit(1)
        if (row.length > 0 && row[0].blocked) {
          wasBlocked = true
          break
        }
      }
    } else {
      const row = await db
        .select({ blocked: userStats.billingBlocked })
        .from(userStats)
        .where(eq(userStats.userId, sub.referenceId))
        .limit(1)
      wasBlocked = row.length > 0 ? !!row[0].blocked : false
    }

    if (sub.plan === 'team' || sub.plan === 'enterprise') {
      const members = await db
        .select({ userId: member.userId })
        .from(member)
        .where(eq(member.organizationId, sub.referenceId))
      for (const m of members) {
        await db
          .update(userStats)
          .set({ billingBlocked: false })
          .where(eq(userStats.userId, m.userId))
      }
    } else {
      await db
        .update(userStats)
        .set({ billingBlocked: false })
        .where(eq(userStats.userId, sub.referenceId))
    }

    if (wasBlocked) {
      await resetUsageForSubscription({ plan: sub.plan, referenceId: sub.referenceId })
    }
  } catch (error) {
    logger.error('Failed to handle invoice payment succeeded', { eventId: event.id, error })
    throw error
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
    if (attemptCount >= 1) {
      logger.error('Multiple payment failures for overage billing', {
        invoiceId: invoice.id,
        customerId,
        attemptCount,
      })
      // Block all users under this customer (org members or individual)
      const stripeSubscriptionId = String(invoice.subscription || '')
      if (stripeSubscriptionId) {
        const records = await db
          .select()
          .from(subscriptionTable)
          .where(eq(subscriptionTable.stripeSubscriptionId, stripeSubscriptionId))
          .limit(1)

        if (records.length > 0) {
          const sub = records[0]
          if (sub.plan === 'team' || sub.plan === 'enterprise') {
            const members = await db
              .select({ userId: member.userId })
              .from(member)
              .where(eq(member.organizationId, sub.referenceId))
            for (const m of members) {
              await db
                .update(userStats)
                .set({ billingBlocked: true })
                .where(eq(userStats.userId, m.userId))
            }
          } else {
            await db
              .update(userStats)
              .set({ billingBlocked: true })
              .where(eq(userStats.userId, sub.referenceId))
          }
        }
      }
    }
  } catch (error) {
    logger.error('Failed to handle invoice payment failed', {
      eventId: event.id,
      error,
    })
    throw error // Re-throw to signal webhook failure
  }
}

export async function handleInvoiceCreated(event: Stripe.Event) {
  try {
    const invoice = event.data.object as Stripe.Invoice

    // Only handle subscription renewal invoices (start of new period)
    if (!invoice.subscription || invoice.billing_reason !== 'subscription_cycle') return

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
      const periodEnd = invoice.lines?.data?.[0]?.period?.end || Math.floor(Date.now() / 1000)
      const billingPeriod = new Date(periodEnd * 1000).toISOString().slice(0, 7)
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
      }
      // Reset usage for the new period
      await resetUsageForSubscription({ plan: sub.plan, referenceId: sub.referenceId })
    } else {
      const usage = await getUserUsageData(sub.referenceId)
      const { getPlanPricing } = await import('@/lib/billing/core/billing')
      const { basePrice } = getPlanPricing(sub.plan, sub)
      const overage = Math.max(0, usage.currentUsage - basePrice)

      if (overage > 0) {
        await addOverageItem(invoice.customer as string, stripeSubscriptionId, overage, {
          userId: sub.referenceId,
        })
      }

      // Reset usage for the new period
      await resetUsageForSubscription({ plan: sub.plan, referenceId: sub.referenceId })
    }
  } catch (error) {
    logger.error('Failed to handle invoice created', { error })
    throw error
  }
}
