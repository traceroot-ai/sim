import { eq } from 'drizzle-orm'
import type Stripe from 'stripe'
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
    // Only reset on successful payment to avoid granting a new period while in dunning
    if (invoice.subscription) {
      // Filter to subscription-cycle renewals; ignore updates/off-cycle charges
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

/**
 * Handle invoice finalized webhook
 * This is triggered when a usage billing invoice is finalized and ready for payment
 * For subscription renewals, this is where we calculate and create overage charges
 */
export async function handleInvoiceFinalized(event: Stripe.Event) {
  try {
    const invoice = event.data.object as Stripe.Invoice

    // Handle overage billing invoices
    if (invoice.metadata?.type === 'overage_billing') {
      const customerId = invoice.customer as string
      const invoiceAmount = invoice.amount_due / 100
      const billingPeriod = invoice.metadata?.billingPeriod || 'unknown'
      logger.info('Overage billing invoice finalized', {
        invoiceId: invoice.id,
        customerId,
        invoiceAmount,
        billingPeriod,
      })
      return
    }

    // Handle subscription renewal invoices - calculate overages for the ending period
    if (invoice.subscription && invoice.billing_reason === 'subscription_cycle') {
      const stripeSubscriptionId = String(invoice.subscription)
      const records = await db
        .select()
        .from(subscriptionTable)
        .where(eq(subscriptionTable.stripeSubscriptionId, stripeSubscriptionId))
        .limit(1)

      if (records.length === 0) {
        logger.warn('No matching internal subscription for finalized subscription invoice', {
          invoiceId: invoice.id,
          stripeSubscriptionId,
        })
        return
      }

      const sub = records[0]

      // Calculate and create overage charges before the new period begins
      logger.info('Processing overage billing for subscription cycle', {
        invoiceId: invoice.id,
        subscriptionId: sub.id,
        referenceId: sub.referenceId,
        plan: sub.plan,
      })

      try {
        if (sub.plan === 'team' || sub.plan === 'enterprise') {
          // Organization overage billing
          const { processOrganizationOverageBilling } = await import('@/lib/billing/core/billing')
          const result = await processOrganizationOverageBilling(sub.referenceId)

          if (result.success) {
            logger.info('Successfully processed organization overage billing', {
              invoiceId: invoice.id,
              organizationId: sub.referenceId,
              chargedAmount: result.chargedAmount,
            })
          } else {
            logger.error('Failed to process organization overage billing', {
              invoiceId: invoice.id,
              organizationId: sub.referenceId,
              error: result.error,
            })
          }
        } else {
          // Individual user overage billing
          const { processUserOverageBilling } = await import('@/lib/billing/core/billing')
          const result = await processUserOverageBilling(sub.referenceId)

          if (result.success) {
            logger.info('Successfully processed user overage billing', {
              invoiceId: invoice.id,
              userId: sub.referenceId,
              chargedAmount: result.chargedAmount,
            })
          } else {
            logger.error('Failed to process user overage billing', {
              invoiceId: invoice.id,
              userId: sub.referenceId,
              error: result.error,
            })
          }
        }
      } catch (overageBillingError) {
        logger.error('Exception during overage billing processing', {
          invoiceId: invoice.id,
          subscriptionId: sub.id,
          referenceId: sub.referenceId,
          plan: sub.plan,
          error: overageBillingError,
        })
        // Don't throw - let the subscription renewal proceed even if overage billing fails
      }

      return
    }

    logger.info('Ignoring non-subscription-cycle invoice finalization', {
      invoiceId: invoice.id,
      billingReason: invoice.billing_reason,
      hasSubscription: !!invoice.subscription,
    })
  } catch (error) {
    logger.error('Failed to handle invoice finalized', {
      eventId: event.id,
      error,
    })
    throw error // Re-throw to signal webhook failure
  }
}
