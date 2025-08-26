import { and, eq } from 'drizzle-orm'
import { syncUsageLimitsFromSubscription } from '@/lib/billing/core/usage'
import { createLogger } from '@/lib/logs/console/logger'
import { db } from '@/db'
import * as schema from '@/db/schema'

const logger = createLogger('BillingOrganization')

type SubscriptionData = {
  id: string
  plan: string
  referenceId: string
  status: string
  seats?: number
}

/**
 * Create organization for team plan upgrade (called proactively during upgrade)
 */
export async function createOrganizationForTeamPlan(
  userId: string,
  userName?: string,
  userEmail?: string,
  organizationSlug?: string
): Promise<string> {
  try {
    // Check if user already owns an organization
    const existingMemberships = await db
      .select({ organizationId: schema.member.organizationId })
      .from(schema.member)
      .where(and(eq(schema.member.userId, userId), eq(schema.member.role, 'owner')))
      .limit(1)

    if (existingMemberships.length > 0) {
      // User already has an organization, return its ID
      const [existingOrg] = await db
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, existingMemberships[0].organizationId))
        .limit(1)

      if (existingOrg) {
        return existingOrg.id
      }
    }

    // Create new organization with org_ prefix
    const organizationName = userName || `${userEmail || 'User'}'s Team`
    const orgId = `org_${crypto.randomUUID()}`

    const [newOrg] = await db
      .insert(schema.organization)
      .values({
        id: orgId,
        name: organizationName,
        slug: organizationSlug || `${userId}-team-${Date.now()}`,
        metadata: {
          createdForTeamPlan: true,
          originalUserId: userId,
        },
      })
      .returning({ id: schema.organization.id })

    // Add user as owner/admin of the organization
    await db.insert(schema.member).values({
      id: crypto.randomUUID(),
      userId: userId,
      organizationId: newOrg.id,
      role: 'owner',
    })

    // Note: Organization activation must be handled by the client-side
    // after this function returns the organizationId

    logger.info('Created organization for team plan', {
      userId,
      organizationId: newOrg.id,
      organizationName,
    })

    return newOrg.id
  } catch (error) {
    logger.error('Failed to create organization for team plan', {
      userId,
      error,
    })
    throw error
  }
}

/**
 * Auto-create organization for team/enterprise plans if user doesn't have one
 * @deprecated - Use createOrganizationForTeamPlan instead for proactive creation
 */
export async function autoCreateOrganizationForTeamPlan(subscription: SubscriptionData) {
  if (
    (subscription.plan === 'team' || subscription.plan === 'enterprise') &&
    subscription.referenceId
  ) {
    try {
      // Check if referenceId is a user (not already an organization)
      const users = await db
        .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
        .from(schema.user)
        .where(eq(schema.user.id, subscription.referenceId))
        .limit(1)

      if (users.length > 0) {
        const user = users[0]

        // Check if user already owns an organization
        const existingMemberships = await db
          .select({ organizationId: schema.member.organizationId })
          .from(schema.member)
          .where(and(eq(schema.member.userId, user.id), eq(schema.member.role, 'owner')))
          .limit(1)

        if (existingMemberships.length === 0) {
          // Create organization for the user with org_ prefix
          const organizationName = `${user.name || user.email}'s Team`
          const orgId = `org_${crypto.randomUUID()}`
          const [newOrg] = await db
            .insert(schema.organization)
            .values({
              id: orgId,
              name: organizationName,
              slug: `${user.id}-team-${Date.now()}`,
              metadata: {
                createdFromTeamPlan: true,
                subscriptionId: subscription.id,
              },
            })
            .returning({ id: schema.organization.id })

          // Add user as owner/admin of the organization
          await db.insert(schema.member).values({
            id: crypto.randomUUID(),
            userId: user.id,
            organizationId: newOrg.id,
            role: 'owner',
          })

          // Update subscription to reference the organization instead of the user
          await db
            .update(schema.subscription)
            .set({
              referenceId: newOrg.id,
              metadata: {
                originalUserId: user.id,
                convertedToOrganization: true,
              },
            })
            .where(eq(schema.subscription.id, subscription.id))

          logger.info('Auto-created organization for team plan subscription', {
            userId: user.id,
            organizationId: newOrg.id,
            organizationName,
            subscriptionId: subscription.id,
          })

          // Update subscription reference for usage limit syncing
          subscription.referenceId = newOrg.id
        }
      }
    } catch (error) {
      logger.error('Failed to auto-create organization for team plan', {
        subscriptionId: subscription.id,
        referenceId: subscription.referenceId,
        error,
      })
    }
  }
}

/**
 * Sync usage limits for subscription members
 * Updates usage limits for all users associated with the subscription
 */
export async function syncSubscriptionUsageLimits(subscription: SubscriptionData) {
  try {
    logger.info('Syncing subscription usage limits', {
      subscriptionId: subscription.id,
      referenceId: subscription.referenceId,
      plan: subscription.plan,
    })

    // Check if this is a user or organization subscription
    const users = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.id, subscription.referenceId))
      .limit(1)

    if (users.length > 0) {
      // Individual user subscription - sync their usage limits
      await syncUsageLimitsFromSubscription(subscription.referenceId)

      logger.info('Synced usage limits for individual user subscription', {
        userId: subscription.referenceId,
        subscriptionId: subscription.id,
        plan: subscription.plan,
      })
    } else {
      // Organization subscription - sync usage limits for all members
      const members = await db
        .select({ userId: schema.member.userId })
        .from(schema.member)
        .where(eq(schema.member.organizationId, subscription.referenceId))

      if (members.length > 0) {
        for (const member of members) {
          try {
            await syncUsageLimitsFromSubscription(member.userId)
          } catch (memberError) {
            logger.error('Failed to sync usage limits for organization member', {
              userId: member.userId,
              organizationId: subscription.referenceId,
              subscriptionId: subscription.id,
              error: memberError,
            })
          }
        }

        logger.info('Synced usage limits for organization members', {
          organizationId: subscription.referenceId,
          memberCount: members.length,
          subscriptionId: subscription.id,
          plan: subscription.plan,
        })
      }
    }
  } catch (error) {
    logger.error('Failed to sync subscription usage limits', {
      subscriptionId: subscription.id,
      referenceId: subscription.referenceId,
      error,
    })
    throw error
  }
}
