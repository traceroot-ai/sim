'use client'

import { useState } from 'react'
import { authClient } from '@/lib/auth-client'

export function TestCheckout() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>([])

  const addLog = (message: string) => {
    console.log(message)
    setLogs((prev) => [...prev, `${new Date().toLocaleTimeString()}: ${message}`])
  }

  const testCheckout = async (planId: 'pro' | 'team') => {
    setLoading(true)
    setError(null)
    setLogs([])

    try {
      addLog(`Starting checkout for ${planId} plan...`)

      const { data, error } = await authClient.subscription.createCheckoutSession({
        planId,
        referenceId: 'QhDnszzxNv7TlCYz7U6aPySr26WnJMEK', // Your user ID from the logs
      })

      addLog(`Response received - Error: ${error}, Data: ${JSON.stringify(data)}`)

      if (error) {
        setError(error.message || 'Unknown error')
        addLog(`Error: ${error.message}`)
        return
      }

      if (data?.url) {
        addLog(`Checkout URL received: ${data.url}`)
        addLog(`Redirecting to Stripe...`)
        window.location.href = data.url
      } else {
        const errorMsg = 'No checkout URL in response'
        setError(errorMsg)
        addLog(errorMsg)
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      setError(errorMsg)
      addLog(`Exception: ${errorMsg}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className='max-w-2xl rounded-lg bg-gray-100 p-6'>
      <h2 className='mb-4 font-bold text-xl'>Checkout Test</h2>

      <div className='mb-4 space-x-4'>
        <button
          onClick={() => testCheckout('pro')}
          disabled={loading}
          className='rounded bg-blue-600 px-4 py-2 text-white disabled:bg-gray-400'
        >
          {loading ? 'Loading...' : 'Test Pro Plan ($20/mo)'}
        </button>

        <button
          onClick={() => testCheckout('team')}
          disabled={loading}
          className='rounded bg-green-600 px-4 py-2 text-white disabled:bg-gray-400'
        >
          {loading ? 'Loading...' : 'Test Team Plan ($50/mo)'}
        </button>
      </div>

      {error && (
        <div className='mb-4 rounded border border-red-400 bg-red-100 p-4 text-red-700'>
          <strong>Error:</strong> {error}
        </div>
      )}

      {logs.length > 0 && (
        <div className='rounded bg-black p-4 font-mono text-green-400 text-sm'>
          <h3 className='mb-2 font-bold'>Debug Logs:</h3>
          {logs.map((log, i) => (
            <div key={i}>{log}</div>
          ))}
        </div>
      )}
    </div>
  )
}
