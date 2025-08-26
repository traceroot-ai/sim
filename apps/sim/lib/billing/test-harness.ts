/**
 * Billing Test Harness
 * Utilities for testing billing functionality in development
 */

import { eq } from 'drizzle-orm'
import { requireStripeClient } from '@/lib/billing/stripe-client'
import { db } from '@/db'
import { member, organization, user, userStats } from '@/db/schema'

export interface TestUser {
  id: string
  email: string
  name: string
  stripeCustomerId?: string
}

export interface TestScenario {
  name: string
  description: string
  setup: () => Promise<any>
  verify: () => Promise<boolean>
  cleanup: () => Promise<void>
}

/**
 * Create a test user with Stripe customer
 */
export async function createTestUser(email: string, name: string): Promise<TestUser> {
  const stripe = requireStripeClient()

  // Create Stripe customer
  const customer = await stripe.customers.create({
    email,
    name,
    metadata: { test: 'true' },
  })

  // Create user in database
  const userId = crypto.randomUUID()
  await db.insert(user).values({
    id: userId,
    email,
    name,
    stripeCustomerId: customer.id,
  })

  // Create userStats
  await db.insert(userStats).values({
    id: crypto.randomUUID(),
    userId,
    currentUsageLimit: '10',
    usageLimitUpdatedAt: new Date(),
  })

  return {
    id: userId,
    email,
    name,
    stripeCustomerId: customer.id,
  }
}

/**
 * Create test subscription
 */
export async function createTestSubscription(
  customerId: string,
  priceId: string,
  referenceId: string,
  plan: 'pro' | 'team' | 'enterprise'
) {
  const stripe = requireStripeClient()

  return await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
    metadata: {
      test: 'true',
      plan,
      referenceId,
    },
  })
}

/**
 * Simulate usage for testing overages
 */
export async function simulateUsage(userId: string, amount: number) {
  await db
    .update(userStats)
    .set({
      currentPeriodCost: amount.toString(),
    })
    .where(eq(userStats.userId, userId))
}

/**
 * Test Scenarios
 */
export const testScenarios: TestScenario[] = [
  {
    name: 'User Signup Flow',
    description: 'Test user creation and customer creation',
    setup: async () => {
      return await createTestUser('test-signup@example.com', 'Test Signup User')
    },
    verify: async () => {
      const users = await db.select().from(user).where(eq(user.email, 'test-signup@example.com'))
      return users.length === 1 && users[0].stripeCustomerId !== null
    },
    cleanup: async () => {
      const users = await db.select().from(user).where(eq(user.email, 'test-signup@example.com'))
      if (users.length > 0) {
        await db.delete(userStats).where(eq(userStats.userId, users[0].id))
        await db.delete(user).where(eq(user.id, users[0].id))
      }
    },
  },

  {
    name: 'Team Plan Organization Creation',
    description: 'Test automatic organization creation for team plans',
    setup: async () => {
      const testUser = await createTestUser('test-team@example.com', 'Team Test User')
      // You would trigger a team subscription here
      return testUser
    },
    verify: async () => {
      // Verify organization was created and user is owner
      const users = await db.select().from(user).where(eq(user.email, 'test-team@example.com'))

      if (users.length === 0) return false

      const memberships = await db.select().from(member).where(eq(member.userId, users[0].id))

      return memberships.length > 0 && memberships[0].role === 'owner'
    },
    cleanup: async () => {
      const users = await db.select().from(user).where(eq(user.email, 'test-team@example.com'))

      if (users.length > 0) {
        const userId = users[0].id

        // Clean up memberships
        const memberships = await db.select().from(member).where(eq(member.userId, userId))

        for (const membership of memberships) {
          await db.delete(member).where(eq(member.id, membership.id))
          await db.delete(organization).where(eq(organization.id, membership.organizationId))
        }

        await db.delete(userStats).where(eq(userStats.userId, userId))
        await db.delete(user).where(eq(user.id, userId))
      }
    },
  },
]

/**
 * Run all test scenarios
 */
export async function runTestHarness() {
  console.log('🧪 Running Billing Test Harness...\n')

  for (const scenario of testScenarios) {
    console.log(`📋 Testing: ${scenario.name}`)
    console.log(`   ${scenario.description}`)

    try {
      // Setup
      console.log('   ⚙️  Setting up...')
      await scenario.setup()

      // Wait a bit for webhooks
      await new Promise((resolve) => setTimeout(resolve, 2000))

      // Verify
      console.log('   ✅ Verifying...')
      const passed = await scenario.verify()

      if (passed) {
        console.log('   ✅ PASSED\n')
      } else {
        console.log('   ❌ FAILED\n')
      }

      // Cleanup
      console.log('   🧹 Cleaning up...')
      await scenario.cleanup()
    } catch (error) {
      console.log(`   ❌ ERROR: ${error}\n`)
      await scenario.cleanup()
    }
  }

  console.log('🏁 Test harness complete!')
}

/**
 * Manual webhook trigger for testing
 */
export async function triggerTestWebhook(eventType: string, data: any) {
  const response = await fetch('http://localhost:3000/api/auth/webhook/stripe', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': 'test-signature', // In real tests, you'd generate this properly
    },
    body: JSON.stringify({
      id: `evt_test_${Date.now()}`,
      object: 'event',
      created: Math.floor(Date.now() / 1000),
      data: { object: data },
      type: eventType,
      api_version: '2020-08-27',
    }),
  })

  return response
}
